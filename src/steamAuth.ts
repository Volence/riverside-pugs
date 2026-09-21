const STEAM_OPENID_URL = 'https://steamcommunity.com/openid/login';
const CLAIMED_ID_RE = /^https:\/\/steamcommunity\.com\/openid\/id\/(\d{17})$/;
const REQUIRED_SIGNED = ['return_to', 'claimed_id', 'identity', 'response_nonce'];

type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

const NONCE_TTL_MS = 5 * 60 * 1000;
const seenNonces = new Map<string, number>(); // nonce -> expiry epoch ms

/** Exported for tests only. */
export function _resetNonces(): void {
  seenNonces.clear();
}

function consumeNonce(nonce: string | undefined, now: number = Date.now()): boolean {
  if (!nonce) return false;
  const ts = Date.parse(nonce.slice(0, 20)); // ISO 8601 prefix per OpenID 2.0 spec
  if (Number.isNaN(ts) || now - ts > NONCE_TTL_MS) return false;
  for (const [n, exp] of seenNonces) {
    if (exp < now) seenNonces.delete(n);
  }
  if (seenNonces.has(nonce)) return false;
  seenNonces.set(nonce, now + NONCE_TTL_MS);
  return true;
}

/** Where Steam sends the browser back to. loginUrl asks for it and
 *  verifyLogin demands it, so both must come from here. */
export function steamReturnUrl(publicUrl: string): string {
  return `${publicUrl.replace(/\/+$/, '')}/auth/steam/return`;
}

export function loginUrl(publicUrl: string): string {
  const params = new URLSearchParams({
    'openid.ns': 'http://specs.openid.net/auth/2.0',
    'openid.mode': 'checkid_setup',
    'openid.return_to': steamReturnUrl(publicUrl),
    'openid.realm': publicUrl,
    'openid.identity': 'http://specs.openid.net/auth/2.0/identifier_select',
    'openid.claimed_id': 'http://specs.openid.net/auth/2.0/identifier_select',
  });
  return `${STEAM_OPENID_URL}?${params}`;
}

export async function verifyLogin(
  query: Record<string, string>,
  returnTo: string,
  fetchFn: FetchFn = fetch,
): Promise<string | null> {
  const match = CLAIMED_ID_RE.exec(query['openid.claimed_id'] ?? '');
  if (!match) return null;

  // Steam will vouch for an assertion it issued to ANY site, so is_valid alone
  // says nothing about who it was meant for. return_to does, but only if it is
  // one of the fields the signature covers. A repeated parameter arrives as an
  // array, which the string checks below refuse.
  if (query['openid.return_to'] !== returnTo) return null;
  const signed = query['openid.signed'];
  if (typeof signed !== 'string') return null;
  const signedFields = new Set(signed.split(','));
  for (const f of REQUIRED_SIGNED) {
    if (!signedFields.has(f)) return null;
  }
  const endpoint = query['openid.op_endpoint'];
  if (endpoint !== undefined && endpoint !== STEAM_OPENID_URL) return null;

  if (!consumeNonce(query['openid.response_nonce'])) return null;

  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (k.startsWith('openid.')) params.set(k, v);
  }
  params.set('openid.mode', 'check_authentication');

  const res = await fetchFn(STEAM_OPENID_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  const body = await res.text();
  if (!body.includes('is_valid:true')) return null;
  return match[1];
}

/** Best-effort persona lookup; falls back to the steamid as display name. */
export async function fetchPersona(
  steamid: string,
  apiKey: string | null,
  fetchFn: FetchFn = fetch,
): Promise<{ name: string; avatar: string | null }> {
  if (!apiKey) return { name: steamid, avatar: null };
  try {
    const url = `https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/?key=${apiKey}&steamids=${steamid}`;
    const res = await fetchFn(url);
    const data: any = await res.json();
    const p = data?.response?.players?.[0];
    if (!p) return { name: steamid, avatar: null };
    return { name: p.personaname ?? steamid, avatar: p.avatarfull ?? null };
  } catch {
    return { name: steamid, avatar: null };
  }
}

/** Batch persona lookup. GetPlayerSummaries takes up to 100 ids per call, so
 *  the whole players table is normally a single request. Best effort like its
 *  single-id sibling: a failure yields an empty map, never a throw.
 *
 *  Unlike fetchPersona, this returns name as string | null rather than falling
 *  back to the steamid. The backfill path updates existing rows, so "no name"
 *  must stay distinguishable from "a name that happens to be the steamid". */
export async function fetchPersonas(
  steamids: string[],
  apiKey: string | null,
  fetchFn: FetchFn = fetch,
): Promise<Map<string, { name: string | null; avatar: string | null }>> {
  const out = new Map<string, { name: string | null; avatar: string | null }>();
  if (!apiKey || steamids.length === 0) return out;
  for (let i = 0; i < steamids.length; i += 100) {
    const batch = steamids.slice(i, i + 100);
    try {
      const url = `https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/?key=${apiKey}&steamids=${batch.join(',')}`;
      const res = await fetchFn(url);
      const data: any = await res.json();
      for (const p of data?.response?.players ?? []) {
        if (!p?.steamid) continue;
        out.set(p.steamid, { name: p.personaname ?? null, avatar: p.avatarfull ?? null });
      }
    } catch {
      // Leave this batch out. The caller updates only what came back.
    }
  }
  return out;
}
