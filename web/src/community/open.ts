/**
 * Bring a community HUD's imported files into this browser: the one way a
 * shared import ever reaches the editor or a download.
 *
 * The files are someone else's, headed for this player's addons folder, so
 * they are checked here against the same allowlist the server checked them
 * against (src/hudFiles.ts), and their hudId must be the entry's. That is
 * done whether the files came off the network or out of this browser's own
 * store: a store hit is not a pass, since the same id may have been
 * imported privately, before the allowlist applied to it. Only then are
 * they registered, with the community flag that makes buildHud refuse to
 * emit a path outside the list, and stored with the entry they came from,
 * so a reload registers them with the flag again.
 */
import { readVPK } from '../vpk/read';
import { hudSetProblem, hudId } from '../../../src/hudFiles';
import { registerImport, unregisterImport, hasImport } from '../hud/base';
import { importProblem } from '../hud/importCheck';
import { hudStore } from '../hud/hudStore';
import { safeName } from '../hud/design';

export const SAFETY_FAILED = 'This community HUD failed its safety check, so nothing from it was used.';
export const FILES_GONE = "This community HUD's files are no longer available.";
/** The import flow's own note for a browser that would not store it. */
export const KEPT_FOR_SESSION = ' This browser could not store it, so it is kept only until this page closes.';

export interface CommunityImportEntry { id: number; title: string; importId?: string | null }
export interface OpenedImport { id: string; name: string; kept: boolean }

const HUD_ID = /^[0-9a-f]{64}$/;

async function fetchFiles(id: string): Promise<Map<string, Uint8Array>> {
  const res = await fetch(`/api/community/files/imports/${id}.vpk`);
  if (res.status === 404) throw new Error(FILES_GONE);
  if (!res.ok) throw new Error(`This community HUD's files could not be fetched (${res.status}).`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  const split = new Set<string>();
  let files: Map<string, Uint8Array>;
  try { files = readVPK(bytes, split); } catch { throw new Error(SAFETY_FAILED); }
  // The server stores single-file VPKs only; a split one is not what it served.
  if (split.size) throw new Error(SAFETY_FAILED);
  return files;
}

/**
 * Fetch (or find), verify, register and store an entry's imported HUD.
 * Throws one line on any failure, with nothing registered that was not
 * registered before.
 */
export async function openCommunityImport(entry: CommunityImportEntry): Promise<OpenedImport> {
  const id = entry.importId;
  if (typeof id !== 'string' || !HUD_ID.test(id)) throw new Error(SAFETY_FAILED);
  const stored = await hudStore().get(id).catch(() => undefined);
  const files = stored ? stored.files : await fetchFiles(id);
  if (hudSetProblem(files) !== null || (await hudId(files)) !== id) throw new Error(SAFETY_FAILED);

  // Registered already means these same bytes (an id is its files' hash) are
  // in use on this page, maybe by the open design: a problem then leaves
  // them where they were rather than pulling them out from under it.
  const was = hasImport(id);
  registerImport(id, files, { community: true });
  const problem = importProblem(id);
  if (problem) {
    if (!was) unregisterImport(id);
    throw new Error(`This community HUD cannot be shown: ${problem}`);
  }

  const name = stored?.name ?? safeName(entry.title);
  let kept = true;
  if (!stored?.community) {
    const bytes = [...files.values()].reduce((n, d) => n + d.length, 0);
    try {
      await hudStore().put({
        ...(stored ?? { id, name, bytes, added: Date.now() }),
        files, community: { entryId: entry.id },
      });
    } catch { kept = false; }
  }
  return { id, name, kept };
}
