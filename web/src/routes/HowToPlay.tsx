import { Panel } from '../components/bits';
import { PageHeader } from '../components/PageHeader';
import { SetupChecklist } from '../components/SetupChecklist';
import type { Session } from '../hooks/useLiveState';

const FAQ: { q: string; a: preact.ComponentChildren }[] = [
  {
    q: 'Why do I need Discord?',
    a: <>Queue pops, the ready check, the campaign vote, the connect info and your team voice channel all run through the Riverside Discord. Playing with your team in voice is a big part of what makes these games good, so being in the server is required to queue, and you have to be sitting in one of its voice channels to press Ready. Leaving voice during the ready check un-readies you.</>,
  },
  {
    q: 'How do matches work?',
    a: <>When 8 players are queued it pops: everyone has two minutes to press Ready (on the site or the bot's card in Discord), then there is a 30 second campaign vote. Teams are split so each side has as close to an even chance as the ratings allow, a server is set up, and you get the connect line. A match is normally a full campaign minus the finale, both teams playing each map as survivors and infected, and the bot moves each team into its own voice channel.</>,
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
    a: <>Press <strong>Copy</strong> on Play, or <strong>Connect</strong> on the Discord match card, and paste the line into the L4D console (enable the console in Options, open it with <code>~</code>). The password goes first, then the connect: <code>password pug_xxxx; connect ip:port</code>. The other way round fails with "Bad password". Play also has a <strong>join through Steam</strong> link; it fills the password in for you, but you still have to press Enter on it.</>,
  },
  {
    q: 'How does SR work?',
    a: <>SR comes from an OpenSkill rating, updated after every match from whether your team won, lost or drew. It is shown cautiously: a new player's rating is uncertain, so it starts lower and settles as you play. You are <strong>provisional</strong> for your first 3 matches and are listed below the ranked part of the leaderboard until then. If you join a match as a sub and play under half of it, your stats count but your rating does not change.</>,
  },
  {
    q: 'What happens if I miss a ready check or do not show up?',
    a: <>You get a queue timeout. Missing a ready check, or never connecting to a match that gets cancelled for no-shows, costs 1 minute for each of the first three, then 5 minutes, then 15 minutes for each one after that. Offenses older than a week stop counting. If it was a genuine accident, ask an admin to clear it.</>,
  },
  {
    q: 'What happens if I disconnect during a match?',
    a: <>The game pauses and you get 7 minutes to reconnect. That 7 minutes is for the <strong>whole match</strong>, not each disconnect, so every time you drop it keeps counting down from where it was. When everyone is back the game unpauses on its own after a 10 second countdown. If you run out, the match ends as an abandon: nobody's rating changes, and you are banned from the queue and the Riverside servers for a day (3 days for a second abandon within a month, then a week). If you crashed, tell an admin straight away: they can put your clock on hold or give you more time.</>,
  },
  {
    q: 'I left the queue on purpose. Is that a penalty?',
    a: <>No. Leaving the queue before it pops is always fine. Only an ignored ready check or a no-show counts.</>,
  },
  {
    q: 'I linked Discord but it says I am not in the server.',
    a: <>Make sure the Discord account you linked is the one in the Riverside server (check your profile: it shows the linked name). If you linked the wrong one, Disconnect it on your profile and link again; you cannot do that while you are queued, in a match or banned. Joining the server lets you in within a few seconds; press Check again.</>,
  },
  {
    q: 'What bot commands are there?',
    a: <><code>/profile</code>, <code>/leaderboard</code>, <code>/matches</code>, <code>/queue</code>, <code>/link</code> and <code>/report</code>. The queue itself is the panel in Discord. When a match ends its result card has an <strong>Endorse</strong> button: you can endorse up to 2 players from it within 24 hours.</>,
  },
  {
    q: 'A match is stuck, or the server never came up.',
    a: <>If anyone has still not connected 10 minutes after the server is ready, the match is cancelled. Only the players who never connected get a no-show; everyone else goes free. A match with no round played 30 minutes after the server is ready is cancelled with no penalties at all. If something else is wrong, tell an admin in Discord: they can abort a match and free the server.</>,
  },
  {
    q: 'I was dropped while loading with "Server is enforcing consistency for this file".',
    a: <>Your copy of the file it names has been modified, usually by a skin, a no-trees pack or a silenced-weapons pack. Remove that addon or verify your game files in Steam and you can connect straight away. <a href="/help/consistency">Step by step</a>.</>,
  },
  {
    q: 'My demo crashes when I play it back.',
    a: <>Load the demo's map in versus first (for example <code>map l4d_vs_hospital01_apartment versus</code>), then <code>playdemo</code>. Loading a versus demo from the main menu crashes the game. The match page has the full steps next to the downloads.</>,
  },
];

const INSTALL_FAQ: { q: string; a: preact.ComponentChildren }[] = [
  {
    q: "I don't want to run the pack's left4dead.exe",
    a: <><p>On Linux or Steam Deck, leave it out and you are done. Proton already lets every
      game use 4 GB, so there is nothing to patch.</p>
      <p>The pack's exe is there for one reason: it may use 4 GB of memory, and Steam's may
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

/** The page's sections in order, for the index at the top. Each id is the
 *  id on that section's Panel below. */
const SECTIONS: { id: string; label: string }[] = [
  { id: 'setup', label: 'Getting set up' },
  { id: 'config', label: 'Your config' },
  { id: 'fov', label: 'Field of view' },
  { id: 'hud', label: 'HUD and crosshair' },
  { id: 'playing', label: 'Playing a match' },
  { id: 'commands', label: 'In-game commands' },
  { id: 'allowed', label: "What's allowed" },
  { id: 'reporting', label: 'Reporting' },
  { id: 'watching', label: 'Watching and replays' },
  { id: 'map-pack', label: 'L4D2 map pack' },
  { id: 'faq', label: 'FAQ' },
];

export function HowToPlay({ session }: { session: Session }) {
  const me = session.kind === 'active' || session.kind === 'pending' ? session.me : null;
  return (
    <div class="page page--profile">
      <PageHeader eyebrow="Riverside" title="How to play" />
      <div class="stack">
        <nav class="panel howto-index" aria-label="On this page">
          <ul>
            {SECTIONS.map((sec) => <li key={sec.id}><a href={`#${sec.id}`}>{sec.label}</a></li>)}
          </ul>
        </nav>
        <Panel id="setup">
          <h3>Getting set up</h3>
          {session.kind !== 'loading' && <SetupChecklist me={me} />}
        </Panel>
        {/* Its own panel rather than a checklist item or an FAQ line alone.
            Everything else on this page is something the site can check for
            you; this is the one step that happens on the player's own machine
            where nothing here can tell whether it worked, so it gets said
            plainly instead of being one entry in a list of eleven. */}
        <Panel id="config">
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

          {/* l4d_cvarwatch's ready gate takes back a ready from anyone on cpu_level 0.
              Set from the menu, not a cfg: the level applies a bundle of effect
              settings, and a console cpu_level may change the number the server
              reads without applying that bundle. */}
          <h4>Effect Detail</h4>
          <p>
            <strong class="howto-warn">Set Effect Detail to Medium or High.</strong>{' '}
            On Low, smoke, fire and the boomer cloud thin out enough to see infected through
            them, so the servers will not let you stay ready on it. In game:{' '}
            <strong>Options</strong>, then <strong>Video</strong>, then{' '}
            <strong>Advanced</strong>, then <strong>Effect Detail</strong>. The game remembers
            it, so you only do this once.
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
        {/* The server kicks a cl_fov outside 75 to 120 (l4d_texture_manager_block.cfg),
            so the range below is a rule, not advice. Keep them in step. */}
        <Panel id="fov">
          <h3>Field of view</h3>
          <p>
            L4D1 will not let you change your field of view on its own. A small client plugin
            fixes that and adds two console commands.
          </p>
          <ol class="howto">
            <li>
              Download both files:{' '}
              <a href="/fov/viewmodeloverride.dll" download="viewmodeloverride.dll"><strong>viewmodeloverride.dll</strong></a>
              {' '}and{' '}
              <a href="/fov/viewmodeloverride.vdf" download="viewmodeloverride.vdf"><strong>viewmodeloverride.vdf</strong></a>.
            </li>
            <li>
              Put them both in <code>steamapps/common/left 4 dead/left4dead/addons/</code>, then
              restart L4D.
            </li>
            <li>
              Set them in the console:
              <pre class="launch-opts"><code>{`fov_override 100
viewmodel_fov_override 70`}</code></pre>
              <code>fov_override</code> is your field of view. <code>viewmodel_fov_override</code>{' '}
              is how your hands and gun sit on screen. The numbers above are only a starting point.
            </li>
          </ol>
          <p>
            <strong class="howto-warn">Keep <code>fov_override</code> between 75 and 120.</strong>{' '}
            The servers kick anyone outside that range.
          </p>
          <p class="muted">
            To make them stick, add the two lines to the bottom of your{' '}
            <code>autoexec.cfg</code>. The plugin is the community Viewmodel FOV Changer by
            Applesauce. To remove it, delete the two files.
          </p>
        </Panel>
        <Panel id="hud">
          <h3>HUD and crosshair</h3>
          <p>
            Build your own in the browser and download it as an addon for your{' '}
            <code>addons</code> folder. Both are allowed on every Riverside server.
          </p>
          <ul class="howto">
            <li><a href="/hud"><strong>HUD editor</strong></a>: move, resize and restyle the survivor HUD.</li>
            <li><a href="/crosshair"><strong>Crosshair maker</strong></a>: draw a crosshair and download it on its own, or send it into your HUD.</li>
            <li><a href="/community"><strong>Community</strong></a>: HUDs and crosshairs other players have shared, ready to download.</li>
          </ul>
          <p>
            <strong>Purple and black squares on your HUD?</strong> The game cannot find one of its pictures.
            Riverside servers refuse pictures installed as loose files (for example a HUD folder in{' '}
            <code>left4dead_custom</code>), so keep a HUD as one <code>.vpk</code> in <code>addons</code>.
            To turn a HUD folder into one, zip the folder, import it in the <a href="/hud">HUD editor</a> and
            download it. A HUD made from the editor's Modern preset that shows the squares on the kill
            notices or the Tab score panel is an older download that missed some pictures: download it again.
          </p>
        </Panel>
        <Panel id="playing">
          <h3>Playing a match</h3>
          <ol class="howto">
            <li><strong>Queue</strong> on the Play page or with Join Queue on the Discord queue panel. Both are the same queue.</li>
            <li><strong>Ready up</strong> when it pops. You have two minutes, the bot pings you, and you need to be in a Discord voice channel to press Ready.</li>
            <li><strong>Vote a campaign.</strong> Teams are balanced by rating once the vote closes.</li>
            <li><strong>Connect</strong> with the button, and paste the line into your L4D console.</li>
            <li><strong>Hop in your team voice channel.</strong> The bot makes one per team and moves you in if you are already in voice.</li>
            <li><strong>Play it out.</strong> The result, SR changes and stats are posted when the match ends.</li>
          </ol>
        </Panel>
        {/* Player commands only. The config, map and score votes (!load, !match,
            !changemap, !setscores, !voteboss, !mix, !slots) are left out on purpose:
            none of them belongs in a ranked match. */}
        <Panel id="commands">
          <h3>In-game commands</h3>
          <p>Type these in game chat.</p>
          <dl class="howto-cmds">
            <dt><code>!ready</code> / <code>!unready</code></dt>
            <dd>Ready up, or take it back, before a round starts. F1 and F2 work too.</dd>
            <dt><code>!pause</code> / <code>!unpause</code></dt>
            <dd>Pause the game. Both teams type <code>!unpause</code> (or <code>!ready</code>) to resume after a countdown.</dd>
            <dt><code>!boss</code></dt>
            <dd>Where the tank and witch spawn this map, as a percentage of the way through, and who gets the tank.</dd>
            <dt><code>!scores</code> / <code>!bonus</code></dt>
            <dd>The scores so far, and this round's health bonus.</dd>
            <dt><code>!tankhud</code> / <code>!spechud</code></dt>
            <dd>Turn the tank or spectator HUD on or off.</dd>
            <dt><code>!rates</code> / <code>!lerps</code></dt>
            <dd>Everyone's network rates and interp, if a hit looked wrong.</dd>
            <dt><code>/mod</code></dt>
            <dd>Call a moderator. Only the moderators see it. See <a href="#reporting">Reporting</a>.</dd>
            <dt><code>!stuckwitch</code></dt>
            <dd>A witch is stuck in a wall or not moving. It records where she is so we can fix it.</dd>
          </dl>
        </Panel>
        {/* Only what the servers or the site actually enforce or review. Keep each
            line true to a check that exists: consistency, the fov and cpu_level
            checks, LilAC and the input-timing flags. */}
        <Panel id="allowed">
          <h3>What's allowed</h3>
          <h4>Fine</h4>
          <ul class="howto">
            <li>The <a href="/autoexec.cfg" download="autoexec.cfg">autoexec.cfg</a> rates and any settings of your own.</li>
            <li>The <a href="#fov">FOV plugin</a>, with <code>fov_override</code> between 75 and 120.</li>
            <li>HUDs and crosshairs, including everything from the <a href="#hud">HUD editor and Community</a>.</li>
            <li>The <a href="#map-pack">L4D2 map pack</a>.</li>
          </ul>
          <h4>Not fine</h4>
          <ul class="howto">
            <li>
              Addons that change game files the servers check, like skins, no-trees packs and
              silenced-weapon packs. You are dropped while loading;{' '}
              <a href="/help/consistency">here is how to fix it</a>.
            </li>
            <li>Effect Detail on Low. The servers will not let you stay ready on it.</li>
            <li>
              Cheats, and macros or scripts that press buttons for you. The servers run
              anticheat, and match data is reviewed for input no hand can make.
            </li>
          </ul>
        </Panel>
        <Panel id="reporting">
          <h3>Reporting</h3>
          <p>
            The player is never told who reported them. For anything that should stay
            private, pick <strong>Safety concern</strong> on the website: only admins see it.
          </p>
          <h4>During a match</h4>
          <p>
            Type <code>/mod</code> (or <code>/calladmin</code>) in game chat. Nobody else sees it.
          </p>
          <ol class="howto">
            <li>Pick a reason: cheating, toxic, griefing, AFK, not speaking English, something broke, or other.</li>
            <li>Pick who it is about: a player, your team, or the whole server.</li>
            <li>Type a line of detail within 30 seconds, or <code>/skip</code>.</li>
          </ol>
          <p>
            The moderators are pinged in Discord straight away, and a call about a player is
            filed as a report too. You can call again after 3 minutes.
          </p>
          <h4>After a match, or any time</h4>
          <ul class="howto">
            <li><code>/report</code> in Discord.</li>
            <li><strong>Report a player</strong> at the bottom of the match page.</li>
            <li><strong>Report this moment</strong> in the replay viewer, which pins the report to that point in the round so the moderators see exactly what you saw.</li>
            <li><strong>Report</strong> on the player's profile.</li>
          </ul>
          <p>
            You can file up to 5 reports a day, one per player per match. Follow yours
            under <strong>My reports</strong> on your profile, where you can also talk to the
            moderators about one.
          </p>
        </Panel>
        <Panel id="watching">
          <h3>Watching and replays</h3>
          <p>
            Every match is recorded, and there are a few ways to watch one back or while it
            happens. The quickest way to get better is to watch yourself.
          </p>
          <h4>Live</h4>
          <ul class="howto">
            <li>
              <a href="/live"><strong>Live</strong></a> shows every match being played right now:
              a map of where everyone is, the score, the stats and an event feed.
            </li>
            <li>
              <strong>Watch on SourceTV</strong> (on Live, or the <strong>Watch</strong> button
              on the Discord match card) puts you in the game as a spectator with no delay.
              You can free-roam or ride along in anyone's first person. Slots are limited, and
              everyone who watches is recorded.
            </li>
            <li>
              <a href="/streams"><strong>Streams</strong></a> lists Riverside players streaming
              on Twitch, with the ones in a PUG right now at the top.
            </li>
          </ul>
          <h4>After the match</h4>
          <ul class="howto">
            <li>
              <strong>The replay viewer</strong> is on every match page. It redraws each round
              on an overhead map: every player, common and witch, with markers on the timeline
              for pounces, skeets, clears, incaps, deaths and more. Pick yourself in the follow
              row and the timeline only shows your events, so you can jump straight to each of
              your deaths or pins and see where everyone was just before it. <strong>Stats</strong>{' '}
              shows the box score at that moment, and <strong>Key</strong> explains the symbols.
            </li>
            <li>
              <strong>Demos</strong>: each map has a download on the match page. A demo lets you
              watch the round in the real game from any player's eyes. When the viewer shows a{' '}
              <strong>tick</strong> next to the clock, type <code>demo_gototick</code> and that
              number in the demo to jump to the same moment. See the FAQ below if a demo crashes.
            </li>
            <li>
              <strong>Stats</strong>: the match page breaks every player down, from skeets,
              clears and how fast pinned teammates were freed to damage as each infected.
              Compare yours with the lobby, then find the moments behind the numbers in the
              viewer.
            </li>
          </ul>
        </Panel>
        <Panel id="map-pack">
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
        <Panel id="faq">
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
