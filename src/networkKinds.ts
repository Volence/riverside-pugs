import type { DB } from './db.js';
import { getSetting } from './settings.js';

/**
 * Which networks count as VPN or hosting, for the fingerprint's first second
 * sign. A residential connection is somebody's house; a hosting range is a
 * VPN exit or a rented server, which is how nepmir connected (Datacamp).
 *
 * Two parts: a curated list of AS numbers we have seen evaders use, and a
 * guess from the provider's name. Staff add an ASN by hand through the
 * vpn_asns_extra setting. An unknown network (no lookup) is never a VPN:
 * "we do not know" must not read as a sign against anyone.
 */

export const KNOWN_VPN_ASNS: ReadonlyMap<number, string> = new Map([
  [212238, 'Datacamp'],
  [62240, 'Clouvider'],
  [9009, 'M247'],
  [60068, 'Datacamp / CDN77'],
  [20473, 'Vultr'],
  [14061, 'DigitalOcean'],
  [16509, 'Amazon'],
  [24940, 'Hetzner'],
  [16276, 'OVH'],
]);

const ORG_HINT = /hosting|datacent(er|re)|data cent(er|re)|cloud|vpn|server/i;

export function extraVpnAsns(db: DB): Set<number> {
  try {
    const v: unknown = JSON.parse(getSetting(db, 'vpn_asns_extra') ?? '[]');
    return new Set(Array.isArray(v) ? v.filter((n): n is number => Number.isInteger(n) && n > 0) : []);
  } catch {
    return new Set();
  }
}

export function isVpnNetwork(asn: number | null, asOrg: string | null, extra: ReadonlySet<number>): boolean {
  if (asn === null) return false;
  if (KNOWN_VPN_ASNS.has(asn) || extra.has(asn)) return true;
  return asOrg !== null && ORG_HINT.test(asOrg);
}
