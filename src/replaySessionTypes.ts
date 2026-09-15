/**
 * Pure shapes describing a replay session on disk.
 *
 * This module has no imports, deliberately. It is loaded by the browser as
 * well as the server (the frontend needs `ReplaySession`'s shape to type the
 * `/api/replays/sessions` response), and `replaySessions.ts` itself imports
 * `node:fs`, which the browser must never see even transitively. Keeping
 * these two interfaces here, importless, is what lets the web project include
 * this file instead of `replaySessions.ts` and stay browser-safe by
 * construction.
 */

export interface ReplayFileInfo {
  filename: string;
  token: string;
  ordinal: number;
  half: number;
  bytes: number;
  mtimeMs: number;
  map: string;
  startedUnix: number;
  frameCount: number;
  playerHz: number;
  version: number;
  /** True when this file is history and may be served whole. False means it
   *  is still being written, and every byte handed out must go through the
   *  anti-ghosting cutoff. */
  closed: boolean;
}

export interface ReplaySession {
  token: string;
  /** Earliest `startedUnix` across the session's files, in seconds. */
  startedUnix: number;
  /** Campaign slug of the session's first map (see src/campaigns.ts), or
   *  null for a map the site does not know. The page titles a session by
   *  this because a 32-character token says nothing to anyone. */
  campaign: string | null;
  files: ReplayFileInfo[];
}
