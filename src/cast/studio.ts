import type { DB } from '../db.js';
import {
  defaultElements, defaultStudioState, MAX_CASTERS, SCENES, TEXT_MAX, THEMES,
  type Callout, type CasterLine, type LiveElements, type SceneKey, type StudioState, type TeamOverride, type ThemeKey,
} from './types.js';

/**
 * One producer state per caster (plan ruling 8). Saved whole on every change
 * from the panel, after `cleanState` has pinned every field to its shape: the
 * overlays render this object, so nothing a client sends is trusted as it is.
 */

export interface StudioRow { state: StudioState; keyGen: number; rev: number; updatedAt: string }

interface Raw { state_json: string; key_gen: number; rev: number; updated_at: string }

export function getStudio(db: DB, steamid: string): StudioRow {
  const row = db.prepare('SELECT state_json, key_gen, rev, updated_at FROM cast_studios WHERE caster_steamid = ?')
    .get(steamid) as Raw | undefined;
  if (!row) return { state: defaultStudioState(), keyGen: 1, rev: 0, updatedAt: '' };
  let parsed: unknown = {};
  try { parsed = JSON.parse(row.state_json); } catch { /* a broken row reads as defaults */ }
  return { state: cleanState(parsed), keyGen: row.key_gen, rev: row.rev, updatedAt: row.updated_at };
}

/** Save a whole state (already cleaned or not: it is cleaned again here). */
export function saveStudio(db: DB, steamid: string, state: unknown, now = new Date()): StudioRow {
  const clean = cleanState(state);
  db.prepare(
    `INSERT INTO cast_studios (caster_steamid, state_json, rev, updated_at) VALUES (?, ?, 1, ?)
     ON CONFLICT (caster_steamid) DO UPDATE SET state_json = excluded.state_json, rev = rev + 1, updated_at = excluded.updated_at`,
  ).run(steamid, JSON.stringify(clean), now.toISOString());
  return getStudio(db, steamid);
}

/** Kill every overlay URL this caster has handed out (plan ruling 1). */
export function bumpKeyGen(db: DB, steamid: string, now = new Date()): number {
  db.prepare(
    `INSERT INTO cast_studios (caster_steamid, key_gen, updated_at) VALUES (?, 2, ?)
     ON CONFLICT (caster_steamid) DO UPDATE SET key_gen = key_gen + 1`,
  ).run(steamid, now.toISOString());
  return getStudio(db, steamid).keyGen;
}

const str = (v: unknown, max = TEXT_MAX): string =>
  typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max) : '';

const posInt = (v: unknown): number | null =>
  typeof v === 'number' && Number.isInteger(v) && v > 0 && v < 2 ** 31 ? v : null;

const pct = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 100 ? Math.round(v) : null;

/** #rrggbb only: it goes into CSS. */
const color = (v: unknown): string | undefined =>
  typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v) ? v.toLowerCase() : undefined;

/** http(s) only, for a cam browser source. */
function camUrl(v: unknown): string {
  const s = str(v, 500);
  if (!s) return '';
  try {
    const u = new URL(s);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : '';
  } catch {
    return '';
  }
}

function cleanOverride(v: unknown): TeamOverride {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  const out: TeamOverride = {};
  const name = str(o.name, 40);
  if (name) out.name = name;
  const tag = str(o.tag, 8);
  if (tag) out.tag = tag;
  const c = color(o.color);
  if (c) out.color = c;
  if (typeof o.score === 'number' && Number.isInteger(o.score) && o.score >= 0 && o.score < 100_000) out.score = o.score;
  return out;
}

function cleanCasters(v: unknown): CasterLine[] {
  if (!Array.isArray(v)) return [];
  return v.slice(0, MAX_CASTERS).map((c) => {
    const o = (c && typeof c === 'object' ? c : {}) as Record<string, unknown>;
    return { name: str(o.name, 40), handle: str(o.handle, 40), camUrl: camUrl(o.camUrl) };
  });
}

function cleanTime(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

function cleanElements(v: unknown): LiveElements {
  const d = defaultElements();
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  const pick = (k: keyof LiveElements): boolean => (typeof o[k] === 'boolean' ? o[k] as boolean : d[k]);
  return { survivors: pick('survivors'), infected: pick('infected'), tank: pick('tank'), bosses: pick('bosses') };
}

function cleanCallout(v: unknown): Callout | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const at = cleanTime(o.at);
  const title = str(o.title, 24);
  if (!at || !title) return null;
  return { title, text: str(o.text, 100), team: o.team === 'a' || o.team === 'b' ? o.team : null, at };
}

export function cleanState(v: unknown): StudioState {
  const d = defaultStudioState();
  if (!v || typeof v !== 'object') return d;
  const o = v as Record<string, unknown>;
  const lt = (o.lowerThird && typeof o.lowerThird === 'object' ? o.lowerThird : {}) as Record<string, unknown>;
  const ov = (o.overrides && typeof o.overrides === 'object' ? o.overrides : {}) as Record<string, unknown>;
  const bo = (o.bosses && typeof o.bosses === 'object' ? o.bosses : {}) as Record<string, unknown>;
  return {
    matchId: posInt(o.matchId),
    bookingId: posInt(o.bookingId),
    scene: SCENES.includes(o.scene as SceneKey) ? (o.scene as SceneKey) : d.scene,
    title: typeof o.title === 'string' ? str(o.title) : d.title,
    subtitle: str(o.subtitle),
    lowerThird: { show: lt.show === true, title: str(lt.title), text: str(lt.text, 140) },
    countdownTo: cleanTime(o.countdownTo),
    casters: cleanCasters(o.casters),
    theme: THEMES.includes(o.theme as ThemeKey) ? (o.theme as ThemeKey) : d.theme,
    overrides: { a: cleanOverride(ov.a), b: cleanOverride(ov.b) },
    bosses: { tank: pct(bo.tank), witch: pct(bo.witch), map: str(bo.map, 64) || null },
    elements: cleanElements(o.elements),
    scorebugAt: o.scorebugAt === 'bottom' ? 'bottom' : 'top',
    callout: cleanCallout(o.callout),
  };
}
