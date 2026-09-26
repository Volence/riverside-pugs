import { Panel } from '../components/bits';

/** The repacked L4D2 campaigns: twelve addon VPKs (l4d/l4d2vpk in the deploy tree) built from
 *  the v3.1e "L4D2 maps for L4D1" pack. Same files and map CRCs as the old left4dead_dlc4
 *  folder install, so players on either one can share a server. */
export const L4D2_PACK_URL = 'https://assets.riversidepug.com/mappack/Riverside-L4D2-Maps-VPK-v3.1e.zip';
export const L4D2_PACK_SIZE = '3.4 GB';
/** Steam's current left4dead.exe (2024-10-19 build, identical to the SteamCMD copy) with only
 *  the 4 GB (large address aware) flag set: one byte, 000000FE 02 -> 22. Rebuild and re-upload
 *  under a new dated key if Steam ever ships a new exe. */
export const L4D2_EXE_URL = 'https://assets.riversidepug.com/mappack/left4dead-4gb-steam-20241019.exe';

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
    a: <p>Some custom campaigns carry their own copies of L4D2 models, and when two add-ons
      have the same file, the one listed first in <code>addonlist.txt</code> wins. New add-ons
      go to the bottom of that list, so without this step the other campaign's model loads on
      these maps and can crash your game. With the file gone, the game rebuilds the list and
      puts these first (that is what the <code>zz_</code> in the names is for). It also turns
      every add-on back on, so switch off anything you had off in the game's{' '}
      <strong>Add-ons</strong> menu. Add-ons you install later go
      below these, so you only do this once.</p>,
  },
  {
    q: 'Turning the pack off',
    a: <p>Untick the twelve <code>zz_l4d2maps</code> entries in the game's{' '}
      <strong>Add-ons</strong> menu, or move them out of the <code>addons</code> folder.</p>,
  },
];

export function L4D2Pack() {
  return (
    <Panel id="l4d2-pack">
      <h3>The L4D2 campaigns</h3>
      <p>
        Dead Center, Dark Carnival, Swamp Fever, Hard Rain, The Parish, Passifice, Cold Stream
        and The Sacrifice, ported to L4D1. They are not part of a normal install, so install
        these once before you can join a match on one.
      </p>
      <ol class="howto">
        <li>
          <a href={L4D2_PACK_URL}><strong>Download the L4D2 campaigns</strong></a> ({L4D2_PACK_SIZE}).
          Inside are twelve <code>zz_l4d2maps_*.vpk</code> files, ordinary add-ons like the
          campaigns below.
        </li>
        <li>
          Put all twelve in <code>left4dead\addons</code>. In Steam, right-click{' '}
          <strong>Left 4 Dead</strong>, then <strong>Manage</strong>, then{' '}
          <strong>Browse local files</strong>, then open <code>left4dead</code>, then{' '}
          <code>addons</code>.
        </li>
        <li>
          <strong class="howto-warn">Delete <code>left4dead\addonlist.txt</code></strong> if it
          is there, one folder up from <code>addons</code>. The game rebuilds it with these
          first, which they need to be; see below for why.
        </li>
        <li>
          <strong>Let the game use 4 GB of memory.</strong> These maps need more than 2 GB, and
          Steam's <code>left4dead.exe</code> is only allowed 2 GB, so on it they crash with "Out
          of memory or address space". Linux and Steam Deck: skip this, Proton already allows
          4 GB. On Windows, pick one:
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
