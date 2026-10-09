import { useState } from 'preact/hooks';
import { Panel } from '../components/bits';

/** The repacked L4D2 campaigns: twelve addon VPKs (l4d/l4d2vpk in the deploy tree) built from
 *  the v3.1e "L4D2 maps for L4D1" pack. Same files and map CRCs as the old left4dead_dlc4
 *  folder install, so players on either one can share a server. */
/** r2 (2026-10-09): the same twelve VPKs renamed zz_ -> 00_. A rebuilt addonlist.txt sorts A to Z
 *  (proven on the owner's client 2026-10-08), so zz_ landed LAST and other campaigns' copies won:
 *  no Dead Center fire, possible crashes. Servers keep the zz_ names (map CRCs are the same). */
export const L4D2_PACK_URL = 'https://assets.riversidepug.com/mappack/Riverside-L4D2-Maps-VPK-v3.1e-r2.zip';
export const L4D2_PACK_SIZE = '3.4 GB';
/** Steam's current left4dead.exe (2024-10-19 build, identical to the SteamCMD copy) with only
 *  the 4 GB (large address aware) flag set: one byte, 000000FE 02 -> 22. Rebuild and re-upload
 *  under a new dated key if Steam ever ships a new exe. */
export const L4D2_EXE_URL = 'https://assets.riversidepug.com/mappack/left4dead-4gb-steam-20241019.exe';

/** One piece of the pack on its own: the shared files, or one campaign. */
export interface L4D2Piece {
  id: string;
  name: string;
  /** Versioned, like every asset key: an updated piece gets a new URL, which is
   *  how a player who downloaded the old one is told it changed. */
  url: string;
  bytes: number;
  /** Whether the all-in-one zip holds this exact version. Set it false when a
   *  piece is updated without rebuilding the full zip. */
  inAll: boolean;
  /** A short line under the name, for a piece whose name alone misleads. */
  note?: string;
}

const PIECE_BASE = 'https://assets.riversidepug.com/mappack/l4d2-v3.1e-r2';
/** Built by l4d2vpk/dist/r2/build.sh from the same twelve VPKs as the full zip. */
export const L4D2_SHARED: L4D2Piece =
  { id: 'shared', name: 'Shared files', url: `${PIECE_BASE}/Riverside-L4D2-Shared-Files.zip`, bytes: 2794800444, inAll: true };
export const L4D2_CAMPAIGNS: L4D2Piece[] = [
  { id: 'c1', name: 'Dead Center', url: `${PIECE_BASE}/Riverside-L4D2-Dead-Center.zip`, bytes: 63252013, inAll: true },
  { id: 'c2', name: 'Dark Carnival', url: `${PIECE_BASE}/Riverside-L4D2-Dark-Carnival.zip`, bytes: 84605510, inAll: true },
  { id: 'c3', name: 'Swamp Fever', url: `${PIECE_BASE}/Riverside-L4D2-Swamp-Fever.zip`, bytes: 79844288, inAll: true },
  { id: 'c4', name: 'Hard Rain', url: `${PIECE_BASE}/Riverside-L4D2-Hard-Rain.zip`, bytes: 105729136, inAll: true },
  { id: 'c5', name: 'The Parish', url: `${PIECE_BASE}/Riverside-L4D2-The-Parish.zip`, bytes: 79281958, inAll: true },
  { id: 'c6', name: 'Passifice', url: `${PIECE_BASE}/Riverside-L4D2-Passifice.zip`, bytes: 31937688, inAll: true,
    note: 'The Passing + The Sacrifice' },
  { id: 'c13', name: 'Cold Stream', url: `${PIECE_BASE}/Riverside-L4D2-Cold-Stream.zip`, bytes: 113772999, inAll: true },
  // c14 is L4D2's The Last Stand (c14m1_junkyard, c14m2_lighthouse). The VPK is still named
  // 00_l4d2maps_c14_thesacrifice (zz_ on the servers) after a build.py mislabel. The Sacrifice's maps are inside Passifice.
  { id: 'c14', name: 'The Last Stand', url: `${PIECE_BASE}/Riverside-L4D2-The-Last-Stand.zip`, bytes: 32037327, inAll: true },
];

/** What this browser has downloaded, as piece id (or 'all') to the URL it got.
 *  A convenience only: private windows and cleared storage just show nothing. */
const STORE_KEY = 'l4d2-downloads';
type Got = Record<string, string>;
function readGot(): Got {
  try {
    const v = JSON.parse(localStorage.getItem(STORE_KEY) ?? '{}');
    return v && typeof v === 'object' ? v as Got : {};
  } catch { return {}; }
}

/** The r2 zips hold the same files as the v3.1e ones under new names, and the page tells
 *  older installs how to rename, so an old download still counts as having the piece. */
function sameFilesUrl(url: string): string {
  return url
    .replace('/mappack/l4d2-v3.1e/', '/mappack/l4d2-v3.1e-r2/')
    .replace('/mappack/Riverside-L4D2-Maps-VPK-v3.1e.zip', '/mappack/Riverside-L4D2-Maps-VPK-v3.1e-r2.zip');
}

/** 'have' when this browser downloaded this exact version, alone or inside the
 *  full zip; 'updated' when it downloaded an older one; otherwise null. */
export function pieceStatus(p: L4D2Piece, got: Got, allUrl = L4D2_PACK_URL): 'have' | 'updated' | null {
  got = { ...got };
  for (const k of Object.keys(got)) got[k] = sameFilesUrl(got[k]);
  if (got[p.id] === p.url || (p.inAll && got.all === allUrl)) return 'have';
  if (got[p.id] || got.all) return 'updated';
  return null;
}

function mb(bytes: number): string {
  const m = bytes / 1024 / 1024;
  return m >= 1024 ? `${(m / 1024).toFixed(1)} GB` : `${Math.round(m)} MB`;
}

/** One-byte LAA patch for the player's own exe. Offset 0xFE, 02 to 22 on the current Steam
 *  build; the script finds the PE header rather than trusting the offset. */
const LAA_SCRIPT = `& {
  $ErrorActionPreference = 'Stop'
  $exe = Join-Path (Get-Location) 'left4dead.exe'
  if (-not (Test-Path $exe)) { throw 'No left4dead.exe here. Run this in the Left 4 Dead folder.' }
  $b = [IO.File]::ReadAllBytes($exe)
  $pe = [BitConverter]::ToInt32($b, 0x3C)
  if ($b[$pe] -ne 0x50 -or $b[$pe+1] -ne 0x45) { throw 'Run this in the Left 4 Dead folder.' }
  if ($b[$pe+22] -band 0x20) { 'left4dead.exe already has the flag. Nothing to do.'; return }
  Copy-Item $exe "$exe.bak" -Force
  $b[$pe+22] = $b[$pe+22] -bor 0x20
  [IO.File]::WriteAllBytes($exe, $b)
  'Done. left4dead.exe can now use 4 GB. The original is left4dead.exe.bak.'
}`;

/** Renames an existing install's zz_ files to 00_ in place, so nobody re-downloads 3 GB for a name. */
const RENAME_SCRIPT = `Get-ChildItem zz_l4d2maps_*.vpk | Rename-Item -NewName { $_.Name -replace '^zz_', '00_' }`;

const PACK_FAQ: { q: string; a: preact.ComponentChildren }[] = [
  {
    q: 'I have the old version (a left4dead_dlc4 folder)',
    a: <><p>It still works, and you can play with people on the new one. To switch: open{' '}
      <code>left4dead\gameinfo.txt</code>, delete the line <code>Game left4dead_dlc4</code>,
      save, then delete the <code>left4dead_dlc4</code> folder and do the steps above. You get
      about 6 GB back.</p>
      <p>The old pack's exe also has the 4 GB permission, so you can keep it; ours is the same
      thing on Steam's newer build. If Steam has verified or updated the game since, do the 4 GB
      step again.</p></>,
  },
  {
    q: 'Why delete addonlist.txt?',
    a: <p>Some custom campaigns carry their own copies of L4D2 files, and when two add-ons
      have the same file, the one listed first in <code>addonlist.txt</code> wins. New add-ons
      go to the bottom of that list, so without this step the other campaign's files load on
      these maps: the hotel fire on Dead Center goes invisible (it still burns you), and some
      maps can crash. With the file gone, the game rebuilds the list in A to Z order, which puts
      these first (that is what the <code>00_</code> in the names is for). It also turns
      every add-on back on, so switch off anything you had off in the game's{' '}
      <strong>Add-ons</strong> menu. Do it with the game closed.</p>,
  },
  {
    q: 'Turning the pack off',
    a: <p>Untick the <code>00_l4d2maps</code> entries in the game's{' '}
      <strong>Add-ons</strong> menu, or move them out of the <code>addons</code> folder.</p>,
  },
];

function PieceRow({ piece, status, note, onGet }: {
  piece: L4D2Piece; status: 'have' | 'updated' | null; note?: string; onGet: () => void;
}) {
  return (
    <a class={`l4d2pick__row${status === 'have' ? ' is-have' : ''}`} href={piece.url} onClick={onGet}>
      <span class="l4d2pick__name">
        {piece.name}
        {note && <span class="l4d2pick__note"> {note}</span>}
      </span>
      <span class="l4d2pick__size">{mb(piece.bytes)}</span>
      <span class={`l4d2pick__status${status ? '' : ' l4d2pick__status--get'}`}>
        {status === 'have' ? '✓' : status === 'updated' ? 'Updated' : 'Download'}
      </span>
    </a>
  );
}

export function L4D2Pack() {
  const [got, setGot] = useState<Got>(readGot);
  const mark = (id: string, url: string) => {
    const next = { ...got, [id]: url };
    setGot(next);
    try { localStorage.setItem(STORE_KEY, JSON.stringify(next)); } catch { /* private window */ }
  };
  return (
    <Panel id="l4d2-pack">
      {/* The same header button as each campaign card below; the step 1 link alone was
          easy to miss inside the prose. */}
      <div class="ccamp__head l4d2pack__head">
        <h3>The L4D2 campaigns</h3>
        <a class="btn" href={L4D2_PACK_URL} onClick={() => mark('all', L4D2_PACK_URL)}>
          Download all {L4D2_PACK_SIZE}
        </a>
      </div>
      <p>
        Dead Center, Dark Carnival, Swamp Fever, Hard Rain, The Parish, Passifice (The Passing
        and The Sacrifice as one campaign), Cold Stream and The Last Stand, ported to L4D1. They are not part of a normal install, so install
        these once before you can join a match on one.
      </p>
      <div class="l4d2fix" role="note">
        <strong>Installed these before October 9?</strong> The files had <code>zz_</code> names,
        which can end up below other campaigns and hide the Dead Center fire. You do not need to
        download again. With the game closed, open <code>left4dead\addons</code>, right-click
        an empty spot, pick <strong>Open in Terminal</strong> (Windows 10: <strong>File</strong>,
        then <strong>Open Windows PowerShell</strong>), paste this and press Enter:
        <pre class="launch-opts"><code>{RENAME_SCRIPT}</code></pre>
        Then delete <code>left4dead\addonlist.txt</code> and start the game. Or rename the twelve{' '}
        <code>zz_l4d2maps_*.vpk</code> files to start with <code>00_</code> by hand.
      </div>
      <div class="l4d2pick">
        <p class="l4d2pick__lede">
          Or only the ones you want: the shared files once, then any campaign, now or later.
          Download all already has every one of these, so skip this if you got it.
        </p>
        <div class="l4d2shared">
          <p class="l4d2shared__label">Start here: every campaign needs the shared files</p>
          <PieceRow piece={L4D2_SHARED} status={pieceStatus(L4D2_SHARED, got)} note="needed once, by every campaign"
            onGet={() => mark(L4D2_SHARED.id, L4D2_SHARED.url)} />
          <p class="l4d2shared__why">A campaign download on its own will not load. Get these first, once.</p>
        </div>
        <div class="l4d2pick__grid">
          {L4D2_CAMPAIGNS.map((p) => (
            <PieceRow key={p.id} piece={p} status={pieceStatus(p, got)} note={p.note} onGet={() => mark(p.id, p.url)} />
          ))}
        </div>
      </div>
      <ol class="howto">
        <li>
          <a href={L4D2_PACK_URL} onClick={() => mark('all', L4D2_PACK_URL)}><strong>Download the L4D2 campaigns</strong></a>{' '}
          (all of them, {L4D2_PACK_SIZE}), or the shared files and the campaigns you want from the
          list above. Inside are <code>00_l4d2maps_*.vpk</code> files, ordinary add-ons like the
          campaigns below.
        </li>
        <li>
          Put every <code>00_l4d2maps_*.vpk</code> in <code>left4dead\addons</code>. In Steam, right-click{' '}
          <strong>Left 4 Dead</strong>, then <strong>Manage</strong>, then{' '}
          <strong>Browse local files</strong>, then open <code>left4dead</code>, then{' '}
          <code>addons</code>.
        </li>
        <li>
          <strong class="howto-warn">With the game closed, delete <code>left4dead\addonlist.txt</code></strong> if it
          is there, one folder up from <code>addons</code>. The game rebuilds it with these
          first, which they need to be; see below for why. <strong>Do this again every time
          you add one of these later.</strong> Had older <code>zz_l4d2maps_*.vpk</code> files?
          Delete those (or rename them, see the box above) so you do not have two copies.
        </li>
        <li>
          <strong>Let the game use 4 GB of memory.</strong> These maps need more than 2 GB, and
          Steam's <code>left4dead.exe</code> is only allowed 2 GB, so on it they crash with "Out
          of memory or address space". Linux and Steam Deck: skip this, Proton already allows
          4 GB.
          <details class="howto-more">
          <summary>How to do it on Windows (pick one)</summary>
          <ul>
            <li>
              <a href={L4D2_EXE_URL} download="left4dead.exe"><strong>Download the 4 GB left4dead.exe</strong></a>.
              It is Steam's current <code>left4dead.exe</code> with that one permission switched
              on and nothing else changed. In the Left 4 Dead folder, rename Steam's to{' '}
              <code>left4dead.exe.bak</code> and put this one in its place. You can check it:{' '}
              <code>fc.exe /b left4dead.exe.bak left4dead.exe</code> lists exactly one
              difference, <code>000000FE: 02 22</code>.
            </li>
            <li>
              Or make that same one-byte change to your own exe yourself. In the
              Left 4 Dead folder, right-click an empty spot and pick{' '}
              <strong>Open in Terminal</strong> (Windows 10: <strong>File</strong>, then{' '}
              <strong>Open Windows PowerShell</strong>), paste this and press Enter:
              <pre class="launch-opts"><code>{LAA_SCRIPT}</code></pre>
              It keeps your original as <code>left4dead.exe.bak</code>. Check it with{' '}
              <code>fc.exe /b left4dead.exe.bak left4dead.exe</code>: exactly one difference,{' '}
              <code>000000FE: 02 22</code>.
            </li>
            <li>
              Or, if you own Left 4 Dead 2, use its exe: it already has the 4 GB permission and
              runs L4D1 fine, since it only starts whichever game's files sit next to it. In
              Steam, right-click <strong>Left 4 Dead 2</strong>, then <strong>Manage</strong>,
              then <strong>Browse local files</strong>, and copy <code>left4dead2.exe</code>.
              In your Left 4 Dead folder, rename Steam's <code>left4dead.exe</code> to{' '}
              <code>left4dead.exe.bak</code>, paste the copy, and rename it to{' '}
              <code>left4dead.exe</code>. The name matters: the game finds its own folder from
              the exe's name, and Steam starts <code>left4dead.exe</code>.
            </li>
          </ul>
          <p>Steam's <strong>Verify integrity of game files</strong> and any L4D1 update put
          Steam's exe back, so redo this after either.</p>
          </details>
        </li>
        <li>
          <strong class="howto-warn">Turn your Shader Detail down, or these maps will crash your game.</strong>{' '}
          <strong>Options</strong>, then <strong>Video</strong>, then <strong>Advanced</strong>,
          then <strong>Shader Detail</strong>: Medium or lower.
        </li>
        <li>
          Restart the game and check it worked: open the console and type{' '}
          <code>map c1m1_hotel</code>. If a hotel level loads, you are done.
        </li>
      </ol>
      <div class="faq">
        {PACK_FAQ.map((f) => (
          <details key={f.q}>
            <summary>{f.q}</summary>
            <div class="faq__answer">{f.a}</div>
          </details>
        ))}
      </div>
    </Panel>
  );
}
