import { Panel } from '../components/bits';
import { PageHeader } from '../components/PageHeader';
import { SetupChecklist } from '../components/SetupChecklist';
import type { Session } from '../hooks/useLiveState';

const FAQ: { q: string; a: preact.ComponentChildren }[] = [
  {
    q: 'Why do I need Discord?',
    a: <>Queue pops, the ready check, the campaign vote, the connect info and your team voice channel all run through the Riverside Discord. Playing with your team in voice is a big part of what makes these games good, so being in the server is required to queue.</>,
  },
  {
    q: 'How do matches work?',
    a: <>When 8 players are queued it pops: everyone has two minutes to press Ready (on the site or the bot's card in #queue-here), then there is a 30 second campaign vote. Teams are balanced by SR, a server is set up, and you get a Connect button. A match is a full campaign minus the finale, both teams playing each map as survivors and infected.</>,
  },
  {
    q: 'Do I need to change any settings?',
    a: <>One thing: your rates. Riverside runs at 100 tick and an L4D1 client ignores rates the server tries to set for it, so they have to be set on your machine or your hit registration is worse than everyone else's. Download <a href="/autoexec.cfg" download="autoexec.cfg">autoexec.cfg</a> and drop it in <code>steamapps/common/left 4 dead/left4dead/cfg/</code>. It runs on its own every time the game starts. The rates are at the top; everything below them is preference you can change.</>,
  },
  {
    q: 'What launch options should I use?',
    a: <>The one that matters is <code>-lv</code>: without it, hittables drift out of line with their own hitboxes, so the car you are swinging at is not where the game thinks it is. Steam → right-click Left 4 Dead → Properties → Launch Options: <code>-lv -novid -forcenovsync -mat_queue_mode 2 -useforcedmparms -noforcemaccel -noforcemspd -refresh 60</code>, with the refresh rate changed to your monitor's. Full explanation under <strong>Your config</strong> above.</>,
  },
  {
    q: 'How do I connect to the server?',
    a: <>Press <strong>Connect</strong> on Play or on the Discord match card and paste the line into the L4D console (enable the console in Options, open it with <code>~</code>). The password goes first, then the connect: <code>password pug_xxxx; connect ip:port</code>. The other way round fails with "Bad password".</>,
  },
  {
    q: 'How does SR work?',
    a: <>SR comes from an OpenSkill rating, updated after every match from whether your team won. It is shown cautiously: a new player's rating is uncertain, so it starts lower and settles as you play. You are <strong>provisional</strong> for your first 3 matches and do not appear in the ranked part of the leaderboard until then. If you join a match as a sub and play under half of it, your stats count but your rating does not change.</>,
  },
  {
    q: 'What happens if I miss a ready check or do not show up?',
    a: <>You get a queue timeout. Missing a ready check, or never connecting to a match that gets cancelled for no-shows, costs 5 minutes the first time, then 15 minutes, then an hour, then a day for each one after that. Offenses older than a week stop counting. If it was a genuine accident, ask an admin to clear it.</>,
  },
  {
    q: 'What happens if I disconnect during a match?',
    a: <>The game pauses and you get 5 minutes to reconnect. That 5 minutes is for the <strong>whole match</strong>, not each disconnect, so every time you drop it keeps counting down from where it was. When everyone is back the game unpauses on its own. If you run out, the match ends as an abandon: nobody's rating changes, and you are banned from queueing for a day (3 days for a second abandon within a month, then a week). If it was a genuine crash, message an admin to appeal.</>,
  },
  {
    q: 'I left the queue on purpose. Is that a penalty?',
    a: <>No. Leaving the queue before it pops is always fine. Only an ignored ready check or a no-show counts.</>,
  },
  {
    q: 'How do I report someone?',
    a: <>Use <code>/report</code> in Discord, or the <strong>Report a player</strong> button at the bottom of the match page. You can report anyone from a match you played in, for 48 hours after it ends. Reports go straight to the admins, and the player is never told who reported them.</>,
  },
  {
    q: 'I linked Discord but it says I am not in the server.',
    a: <>Make sure the Discord account you linked is the one in the Riverside server (check your profile: it shows the linked name). If you linked the wrong one, Disconnect it on your profile and link again. Joining the server lets you in within a few seconds; press Check again.</>,
  },
  {
    q: 'What bot commands are there?',
    a: <><code>/profile</code>, <code>/leaderboard</code>, <code>/matches</code>, <code>/queue</code>, <code>/link</code> and <code>/report</code>. The queue itself is the panel in #queue-here.</>,
  },
  {
    q: 'A match is stuck, or the server never came up.',
    a: <>Matches where too few people connect are cancelled automatically after 10 minutes, and nobody who connected is penalised. If something else is wrong, tell an admin in Discord: they can abort a match and free the server.</>,
  },
  {
    q: 'I was dropped while loading with "Server is enforcing consistency for this file".',
    a: <>Your copy of the file it names has been modified, usually by a skin, a no-trees pack or a silenced-weapons pack. Remove that addon or verify your game files in Steam and you can connect straight away. <a href="/help/consistency">Step by step</a>.</>,
  },
  {
    q: 'My demo crashes when I play it back.',
    a: <>Load any versus map first (<code>map l4d_vs_hospital01_apartment versus</code>), then <code>playdemo</code>. Loading a versus demo from the main menu crashes the game. The match page has the full steps next to the downloads.</>,
  },
];

const INSTALL_FAQ: { q: string; a: preact.ComponentChildren }[] = [
  {
    q: "I don't want to run the pack's left4dead.exe",
    a: <><p>The pack's exe is there for one reason: it may use 4 GB of memory, and Steam's may
      only use 2 GB. The L4D2 maps need more than 2 GB, so on Steam's exe they crash with "Out
      of memory or address space". The catch is that the pack's exe is an older build, not
      Steam's with one change, so you cannot easily check what is in it. You can give your
      own exe the same permission instead, and that is a one-byte change you can check:</p>
      <ol class="howto">
        <li>In step 3, drag in everything except <code>left4dead.exe</code>.</li>
        <li>
          In the Left 4 Dead folder from step 2, right-click an empty spot and pick{' '}
          <strong>Open in Terminal</strong>. On Windows 10 it is <strong>File</strong>, then{' '}
          <strong>Open Windows PowerShell</strong>.
        </li>
        <li>
          Paste this and press Enter. It keeps your original as{' '}
          <code>left4dead.exe.bak</code> and does nothing if the exe is already done.
          <pre class="launch-opts"><code>{`& {
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
}`}</code></pre>
        </li>
        <li>
          Check it: <code>fc.exe /b left4dead.exe.bak left4dead.exe</code>. It should list
          exactly one difference, <code>000000FE: 02 22</code>, and nothing else.
        </li>
      </ol>
      <p>Steam's <strong>Verify integrity of game files</strong> and any L4D1 update put Steam's
      exe back, so run it again after either. Verify also resets{' '}
      <code>left4dead\gameinfo.txt</code>, which turns the map pack off, so redo step 3 after
      it too.</p></>,
  },
  {
    q: 'I already have L4D2 maps installed',
    a: <p>Delete the old <code>left4dead_dlc4</code> folder first. If <code>thelaststand.vpk</code>{' '}
      or <code>[L4D] Campaign pack l4d2.vpk</code> are in <code>left4dead\addons</code>, delete
      those too. Then start from step 3 above.</p>,
  },
  {
    q: 'Turning the map pack back off',
    a: <><p>Nothing to delete. Open <code>left4dead\gameinfo.txt</code>, put <code>//</code> in
      front of the <code>Game left4dead_dlc4</code> line, save, and restart the game. It looks
      like this:</p>
      <pre class="launch-opts"><code>{`SearchPaths
{
    Game    |gameinfo_path|.
    //Game  left4dead_dlc4
    Game    left4dead_dlc3
    Game    left4dead_dlc2
    Game    left4dead_dlc1
    Game    left4dead
    Game    hl2
}`}</code></pre>
      <p>Remove the <code>//</code> to turn it back on.</p></>,
  },
  {
    q: 'Checking which version you have',
    a: <p>Open <code>left4dead_dlc4\dlc4_version.inf</code> in a text editor. The first line
      reads <code>DLCVersion=</code>, and ours is <code>v3.1e</code>.</p>,
  },
];

export function HowToPlay({ session }: { session: Session }) {
  const me = session.kind === 'active' || session.kind === 'pending' ? session.me : null;
  return (
    <div class="page page--profile">
      <PageHeader eyebrow="Riverside" title="How to play" />
      <div class="stack">
        <Panel>
          <h3>Getting set up</h3>
          {session.kind !== 'loading' && <SetupChecklist me={me} />}
        </Panel>
        {/* Its own panel rather than a checklist item or an FAQ line alone.
            Everything else on this page is something the site can check for
            you; this is the one step that happens on the player's own machine
            where nothing here can tell whether it worked, so it gets said
            plainly instead of being one entry in a list of eleven. */}
        <Panel>
          <h3>Your config</h3>
          <p>
            Riverside runs at 100 tick. L4D1 clients ignore rates the server tries to set for
            them, so unless you set your own, your hit registration is worse than everyone
            else's and the server cannot fix it for you.
          </p>
          <ol class="howto">
            <li>
              <a href="/autoexec.cfg" download="autoexec.cfg"><strong>Download autoexec.cfg</strong></a>
            </li>
            <li>
              Put it in <code>steamapps/common/left 4 dead/left4dead/cfg/</code>. On Windows
              that is usually <code>C:\Program Files (x86)\Steam\steamapps\common\left 4 dead\left4dead\cfg</code>.
              If you already have one, keep a copy first.
            </li>
            <li>
              Restart L4D. It runs by itself, nothing to type. Check it took by holding
              TAB in a game: the net graph appears, and <code>cl_updaterate</code> in the
              console reads 100.
            </li>
          </ol>
          <p class="muted">
            The rates at the top are the part that matters. Everything below them is
            preference and you should change it, starting with <code>sensitivity</code>.
          </p>

          <h4>Launch options</h4>
          <p>
            One of these actually changes how the game plays. Without <code>-lv</code>,
            hittables drift out of line with their own hitboxes, so the car you are
            swinging at is not where the game thinks it is. Set it and forget it.
          </p>
          <p>
            In Steam, right-click <strong>Left 4 Dead</strong> →{' '}
            <strong>Properties</strong> → <strong>Launch Options</strong>, and paste:
          </p>
          <pre class="launch-opts"><code>-lv -novid -forcenovsync -mat_queue_mode 2 -useforcedmparms -noforcemaccel -noforcemspd -refresh 60</code></pre>
          <p class="muted">
            Change <code>-refresh 60</code> to your monitor's actual refresh rate.
            The rest: <code>-lv</code> keeps hittables honest, <code>-novid</code> skips
            the intro, <code>-forcenovsync</code> and <code>-mat_queue_mode 2</code> are
            frames, and the three mouse flags stop Windows applying its own acceleration
            on top of yours.
          </p>
        </Panel>
        <Panel>
          <h3>Installing the L4D2 map pack</h3>
          <p>
            This pack is only for the L4D2 campaigns ported to L4D1: Dead Center, Dark
            Carnival, Swamp Fever, Hard Rain, The Parish, Passifice, Cold Stream and The Last
            Stand. They are not part of a normal install, so before you can join a match on
            one, install the pack once. It stays installed after that.
          </p>
          <p class="muted">
            Custom campaigns are not in it. Each of those is its own download on the{' '}
            <a href="/custom-campaigns">Custom campaigns</a> page.
          </p>
          <ol class="howto">
            <li>
              <a href="https://assets.riversidepug.com/mappack/L4D2-Maps-for-L4D1-v3.1e.zip">
                <strong>Download the map pack</strong>
              </a>. It is 3.4 GB, so do not start it on a phone tether.
            </li>
            <li>
              Open your Left 4 Dead folder. In Steam, right-click <strong>Left 4 Dead</strong>,
              then <strong>Manage</strong>, then <strong>Browse local files</strong>. You should
              see a <code>left4dead</code> folder and an <code>hl2</code> folder there. If you
              do not, you are in the wrong place.
            </li>
            <li>
              Open the zip you downloaded, then drag everything inside it into that folder, and
              click <strong>Yes</strong> when it asks about replacing files. When it is done you
              will have a new <code>left4dead_dlc4</code> folder sitting next to <code>left4dead</code>.
              This includes a <code>left4dead.exe</code> that lets the game use more memory; if
              you would rather not run someone else's exe, see below.
            </li>
            <li>
              <strong class="howto-warn">Turn your Shader Detail down, or these maps will crash your game.</strong>{' '}
              In-game: <strong>Options</strong>, then <strong>Video</strong>, then{' '}
              <strong>Advanced</strong>, then <strong>Shader Detail</strong>, set to Medium or
              lower. This is the single most common reason someone drops mid match after
              installing the pack. The pack's own ReadMe buries it at step 4 of 5. We are not
              burying it here.
            </li>
            <li>
              Check it worked. Open the console and type <code>map c1m1_hotel</code>. If a hotel
              level loads, you are done. If you get "map not found", the files went into the
              wrong folder: redo step 2.
            </li>
          </ol>
          <div class="faq">
            {INSTALL_FAQ.map((f) => (
              <details key={f.q}>
                <summary>{f.q}</summary>
                <div class="faq__answer">{f.a}</div>
              </details>
            ))}
          </div>
        </Panel>
        <Panel>
          <h3>Playing a match</h3>
          <ol class="howto">
            <li><strong>Queue</strong> on the Play page or with Join Queue in #queue-here. Both are the same queue.</li>
            <li><strong>Ready up</strong> when it pops. You have two minutes, and the bot pings you.</li>
            <li><strong>Vote a campaign.</strong> Teams are balanced by SR once the vote closes.</li>
            <li><strong>Connect</strong> with the button, and paste the line into your L4D console.</li>
            <li><strong>Hop in your team voice channel.</strong> The bot makes one per team and moves you in if you are already in voice.</li>
            <li><strong>Play it out.</strong> The result, SR changes and stats are posted when the match ends.</li>
          </ol>
        </Panel>
        <Panel>
          <h3>FAQ</h3>
          <div class="faq">
            {FAQ.map((f) => (
              <details key={f.q}>
                <summary>{f.q}</summary>
                <p>{f.a}</p>
              </details>
            ))}
          </div>
        </Panel>
      </div>
    </div>
  );
}
