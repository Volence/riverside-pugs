import { Panel } from '../../components/bits';
import { SIGN_ORDER, SIGN_TEXT, type SecondSign } from '../../../../src/fingerprint';

/**
 * What every line on Needs a look and on a player's file means, for staff.
 *
 * Static, and deliberately in the site rather than in a doc: the wording here
 * tracks the code that produces each line (src/admin/arrived.ts and the
 * src/admin/timeline adapters), so a new kind of flag gets its entry in the
 * same change. Moderators asked for it so they can judge a file themselves
 * instead of asking what a line means.
 */

/** One line per second sign. A Record, so a new sign does not compile until
 *  it is explained here. */
const SIGN_HELP: Record<SecondSign, string> = {
  vpn: 'One of their connections comes from a VPN or hosting provider (Datacamp, M247, Vultr and the like). Evaders hide behind these; so do some honest players.',
  fresh_identity: 'The Steam account is under a year old or private, the Discord account is under 90 days old, or the Discord is new to us on a site account under a week old. Private profiles are common: this counts only next to a fingerprint.',
  cheat_flag: 'They have an aimbot, aimlock or newcomer wallhack flag from a match they played.',
  two_members: 'Two or more of the known evader\'s own accounts are among their 10 nearest fingerprints, not just the pooled record.',
  shared_connection: 'They have used a connection one of the evader\'s accounts used. This also posts its own watch-list alert.',
};
export function StaffGuide() {
  return (
    <div class="stack">
      <nav class="panel howto-index" aria-label="On this page">
        <ul>
          <li><a href="#reading">Reading the list</a></li>
          <li><a href="#input">Input flags</a></li>
          <li><a href="#lilac">Little Anti-Cheat</a></li>
          <li><a href="#aim">Aim rules</a></li>
          <li><a href="#setting">Client settings</a></li>
          <li><a href="#replay">Replay moments</a></li>
          <li><a href="#ranking">Analyzer ranking</a></li>
          <li><a href="#steam">Steam</a></li>
          <li><a href="#fingerprint">Fingerprint alerts</a></li>
          <li><a href="#drops">Connect drops</a></li>
          <li><a href="#slurs">Slurs</a></li>
          <li><a href="#appeals">Appeals</a></li>
        </ul>
      </nav>

      <Panel id="reading">
        <h3>Reading the list</h3>
        <p>
          Needs a look lists players who have something new on their file that no staff member has read
          yet. The <strong>What arrived</strong> column says what came in since the last time someone pressed{' '}
          <strong>Looked at</strong>, in a fixed order: input flags, Little Anti-Cheat, client settings,
          replay moments, Steam, connect drops, slurs. Pressing Looked at takes the player off the list until
          something else arrives. It records your name and decides nothing.
        </p>
        <p>
          None of these lines is proof by itself. Everything except slurs is an automatic check, and every
          one of them misfires on honest players sometimes. What matters is a pattern: the same flag across
          several matches, or different checks pointing the same way. Open the file, read the timeline, and
          watch the replay where there is one before you decide anything.
        </p>
      </Panel>

      <Panel id="input">
        <h3>Input flags</h3>
        <p>
          Shown as <code>N input flags (pounce_spam, pistol_rate, autobhop, fakelag)</code>. The server records the timing of
          button presses and looks for speeds a hand cannot keep up. A hand clicking as fast as it can peaks
          at about 8 presses a second. A macro holds 13 or more for as long as it is on. A flag only exists
          once the pattern repeats within one match, so a single lucky burst never makes one.
        </p>
        <dl class="howto-cmds">
          <dt><code>pounce_spam</code></dt>
          <dd>
            A hunter pressing attack 12 or more times a second while airborne, on 4 or more pounces in one
            match. Typical of a mouse wheel bound to attack, a rapid-fire bind or a macro.
          </dd>
          <dt><code>pistol_rate</code></dt>
          <dd>
            Pistol fire held at 12 or more presses a second for 3 full seconds, twice in one match.
          </dd>
          <dt><code>autobhop</code></dt>
          <dd>
            A jump script. While bunnyhopping, 65% or more of the hops left the ground on the exact tick
            the player landed, over 20 or more chained hops. Scroll-wheel jumpers get about half at best;
            the confirmed Aimware cheater got 72%. A wheel bind does not explain this one.
          </dd>
          <dt><code>fakelag</code></dt>
          <dd>
            A hunter whose inputs stop and then all arrive at once, ten or more times caught mid-pounce, and
            at least a quarter of their hunter stalls. On other screens it looks like teleporting, and a hunter
            frozen mid-air cannot be skeeted. Bad connections stall too, but at random moments: the worst on
            record hung mid-pounce 4 times, the confirmed Aimware cheater 29.
          </dd>
        </dl>
        <p>The file also says what the presses looked like, which is the part that matters most:</p>
        <dl class="howto-cmds">
          <dt>scroll wheel</dt>
          <dd>
            Presses shaped like a mouse wheel bound to attack or jump. <strong>Wheel binds are legal.</strong>{' '}
            These stay on the file for the record but never put anyone on Needs a look.
          </dd>
          <dt><code>steady taps</code></dt>
          <dd>
            Shaped like a wheel, but at a perfectly even rate no spun wheel keeps. That is a rapid-fire bind
            or mouse auto-fire, so it stays evidence. There is no ruling yet on whether rapid-fire binds are
            allowed: raise it with an admin rather than acting on it alone.
          </dd>
          <dt>holds look fixed-hold</dt>
          <dd>
            Every press held down for the same length of time. A script with a set hold time does this; hands
            do not. The strongest of the input signs.
          </dd>
          <dt>holds look variable-hold</dt>
          <dd>Press lengths vary the way a hand does. Fast, but human-shaped.</dd>
        </dl>
      </Panel>

      <Panel id="lilac">
        <h3>Little Anti-Cheat</h3>
        <p>
          Shown as <code>Little Anti-Cheat: aimlock ×2</code>. Little Anti-Cheat (LilAC) is the anti-cheat
          plugin on every server. On ours it <strong>never bans or kicks</strong>, it only reports. Its own
          documentation says a few rare suspicions are usually false positives, and that holds here: one
          flag means almost nothing, a run of them on the same player is what to look at. LilAC has no clip,
          but the file gives the match, so you can open that match's replay and find the moment.
        </p>
        <dl class="howto-cmds">
          <dt><code>aimbot</code></dt>
          <dd>
            Checked on every kill from more than 350 units away, using the half second of aim before the
            shot. The file names LilAC's reason:
            <ul>
              <li><strong>Aim-Snap / Aim-Snap2:</strong> the crosshair jumped most of the way onto the target in one input, just before the shot.</li>
              <li><strong>Angle-Repeat:</strong> the view jumped for the shot and straight back to where it was.</li>
              <li><strong>Autoshoot:</strong> attack pressed for exactly one input on the kill, twice in a row or alongside another reason. A scroll wheel or rapid-fire bind does this too, which is the usual cause here.</li>
              <li><strong>Total-Delta:</strong> the view turned more than 450 degrees in total in that half second.</li>
            </ul>
            Under it is our own measurement over the 1.5 seconds before: the biggest single aim change, the
            total, and the trigger presses. A real snap shows a big single change. Autoshoot with a tiny
            single change (under a degree or two) and lots of one-input presses is a wheel or rapid-fire
            pattern, not an aimbot.
            {' '}A flag whose single biggest snap (LilAC's own aim-snap reading) was <strong>60 degrees or
            more</strong> is marked <strong>high severity</strong> and called a big snap. Every honest aimbot
            flag on record snapped under 45; the confirmed aimbot (nepmir, match 722) snapped 143.5. Unlike
            the rest of LilAC, one of these is worth opening on its own.
          </dd>
          <dt><code>aimlock</code></dt>
          <dd>
            The crosshair turned more than 20 degrees in one input, landed on an enemy, and stayed
            within 5 degrees of it for over a tenth of a second. Only checked with no enemy within 300 units,
            and it takes two of these within 3 minutes to make one flag (they can be on different targets).
            Good flicks at range trip it. LilAC does not check walls, and <strong>infected see survivors
            through walls</strong>, so an infected player locking onto a survivor is usually legitimate; the
            file says so when that was the case. A survivor locking onto a spawned infected, more than once,
            is the version worth a closer look.
          </dd>
          <dt><code>bhop</code></dt>
          <dd>
            Several perfect bunny hops in a row: jumping on the exact tick of landing. The file gives the
            count. A few in a row happen by skill or a wheel bound to jump (legal); a long run every time is
            a script.
          </dd>
          <dt><code>convar</code></dt>
          <dd>A client setting LilAC watches was outside its allowed range.</dd>
          <dt><code>nolerp</code></dt>
          <dd>Network interpolation set too low or too high to be honest.</dd>
          <dt><code>angles</code></dt>
          <dd>Aim angles a normal client cannot send (for example looking further than straight up or down).</dd>
          <dt><code>chatclear</code>, <code>newline_name</code></dt>
          <dd>Chat or a name stuffed with line breaks to wipe or fake the chat box.</dd>
          <dt><code>anti_duck_delay</code></dt>
          <dd>Crouching faster than the game's crouch delay allows.</dd>
        </dl>
      </Panel>

      <Panel id="aim">
        <h3>Aim rules</h3>
        <p>
          Shown as <code>aim rules: hs_share, aimbot_multi</code>. Three rules learned from the first
          confirmed aimbot (nepmir, match 722). They judge a whole match once it ends, never a moment, and
          they never ban or kick anyone.
        </p>
        <dl class="howto-cmds">
          <dt><code>hs_share</code></dt>
          <dd>
            Ten or more kills of human infected with the SMG or pistols in one match, with a headshot share
            so far above everyone else's that the odds of it by chance are under 1 in 1000. The file gives the
            kills, the headshots, the odds and the rate it was compared with. nepmir: 14 of 16.
          </dd>
          <dt><code>flick_return</code></dt>
          <dd>
            Two or more infected kills in one match where the view swung 90 degrees or more onto the kill in
            the 0.3 s before it, then came back within 45 degrees of where it started in the second after.
            nepmir did it twice; nobody else on record more than once.
          </dd>
          <dt><code>aimbot_multi</code></dt>
          <dd>
            Two of the three (the two above, or one of them plus a Little Anti-Cheat big snap) in the same
            match. High severity, and it pings the mod role. Still evidence: watch the replay.
          </dd>
        </dl>
        <p>
          While the rules are in log mode (Settings, Aim rules) these sit on the file without putting it in
          Needs a look, because the thresholds are being re-measured.
        </p>
      </Panel>

      <Panel id="setting">
        <h3>Client settings</h3>
        <p>
          Shown as <code>client setting cpu_level 0 (N matches)</code>. The server reads some of each
          player's video settings. <code>cpu_level 0</code> is low effect detail, which thins smoke, fire and
          the boomer cloud enough to see infected through them. Some players use it for frame rate. Ready-up
          holds a player who has it until they raise it; "Changed cpu_level to 1 after being held" is them
          fixing it and is not evidence. Playing a match with it is.
        </p>
      </Panel>

      <Panel id="replay">
        <h3>Replay moments</h3>
        <p>
          Shown as <code>N flagged replay moments</code>. A program reads every recorded round and marks
          stretches where a survivor's crosshair moved along with an infected they could not see. Each one is
          a clip with a link straight to that moment in the replay. Always watch it: the number is a reason
          to watch, never a finding.
        </p>
        <dl class="howto-cmds">
          <dt>followed a ghost</dt>
          <dd>
            The crosshair moved with a ghost (an infected player choosing where to spawn) behind a wall.
            Pre-aiming a known spawn spot does not count; only following the ghost's own movement does.
          </dd>
          <dt>followed a spawned infected nobody on the team could see</dt>
          <dd>
            The same, for a spawned infected that nobody on the survivor team could see. This check is newer
            and not calibrated yet, so these show on the file but never put a player on Needs a look alone.
          </dd>
          <dt>fidelity</dt>
          <dd>
            How closely the aim followed, from 0 (no better than holding still) to 1 (exactly). Clips start
            at 0.4. A higher number over a longer clip, with the target moving a lot, is harder to explain.
          </dd>
        </dl>
        <p class="muted">
          Its limit: a player watching an infected that is standing still behind a wall looks exactly like
          an honest player holding that corner, so it cannot catch that.
        </p>
      </Panel>

      <Panel id="ranking">
        <h3>Analyzer ranking</h3>
        <p>
          The second tab on Needs a look ranks everyone the replay program has measured. The top of this list
          is mostly your best players, because good players aim where infected are. Treat it as a place to
          start watching, never as a list of suspects.
        </p>
        <dl class="howto-cmds">
          <dt>Tracking</dt>
          <dd>Across all their rounds, how well their aim followed ghosts behind walls (0 to 1).</dd>
          <dt>Occupancy</dt>
          <dd>How much more often their crosshair sat on hidden ghosts than is normal on that map. 0 is normal; higher is more.</dd>
          <dt>Team gap</dt>
          <dd>The same, compared with their own teammates in the same rounds. A player far above their own team stands out more.</dd>
          <dt>Hidden tracking</dt>
          <dd>Tracking, for spawned infected the team could not see.</dd>
          <dt>Hidden pre-aim</dt>
          <dd>Occupancy, for spawned infected the team could not see.</dd>
          <dt>Reveal on target</dt>
          <dd>How often an infected came into view with their crosshair already on it.</dd>
          <dt>too few rounds</dt>
          <dd>Not enough recorded rounds to rank fairly yet.</dd>
        </dl>
      </Panel>

      <Panel id="steam">
        <h3>Steam</h3>
        <dl class="howto-cmds">
          <dt>recent VAC or game ban</dt>
          <dd>
            Steam shows a ban on the account, the newest one recent. Steam does not say which game, so this is
            context, not a finding about our matches.
          </dd>
          <dt>game borrowed from a banned account</dt>
          <dd>
            Playing on a copy of L4D shared through Steam Family Sharing by an account banned here. Households
            share libraries, so it is a reason to look and nothing more. Alts on the People desk has more.
          </dd>
        </dl>
      </Panel>

      <Panel id="fingerprint">
        <h3>Fingerprint alerts</h3>
        <p>
          The site times how long every player holds infected buttons: the hunter, smoker and boomer claw, and
          attacks in the air. A hand holds them for a typical length of its own, and no aimbot drives these
          presses, so the pattern follows a person from one Steam account to the next. At the end of every match,
          each new account (under 15 rated matches, or a site account under 30 days old) is compared with every
          known evader on People &gt; Alts.
        </p>
        <dl class="howto-cmds">
          <dt>Fingerprint match</dt>
          <dd>
            The account holds buttons like that evader, and nothing else points at them. Nothing is done to the
            account. Look at the file, the matches and the connections before you decide anything.
          </dd>
          <dt>Fingerprint match with a second sign</dt>
          <dd>The same, plus one of the signs below. It pings the mod role, and nobody is held.</dd>
          <dt>Fingerprint hold</dt>
          <dd>
            A fingerprint match plus a second sign while holds are switched on. The account is on hold until a
            moderator looks: lift it, or (admins) use <strong>Ban as same person</strong>, which bans it and adds it
            and its Discord to the evader's record.
          </dd>
        </dl>
        <p>
          <strong>Reading the numbers.</strong> The distance is 0 for identical hold patterns and 1 for nothing in
          common. "#2 nearest" means one fingerprint on record, out of everyone, is closer to this account than the
          evader's is. The limit is the evader's own: how far their accounts' single matches sit from the rest of
          them. A match needs the evader in the 5 nearest and under that limit.
        </p>
        <p>
          <strong>A fingerprint alone is not proof.</strong> Across the first matches of 183 honest players, the
          evader's record landed in the 5 nearest for about 3% of them. That is why a fingerprint alone only posts,
          and a hold needs one of these as well:
        </p>
        <dl class="howto-cmds">
          {SIGN_ORDER.flatMap((s) => [
            <dt key={`${s}-t`}>{SIGN_TEXT[s]}</dt>,
            <dd key={`${s}-d`}>{SIGN_HELP[s]}</dd>,
          ])}
        </dl>
      </Panel>
      <Panel id="drops">
        <h3>Repeated connect drops</h3>
        <p>

          The server checks certain game files on connect and the player's own game disconnects at the first
          one that has been modified, so repeated drops can mean a skin or no-foliage mod. A cancelled loading
          screen or a bad connection looks exactly the same, so ask before assuming.
        </p>
      </Panel>

      <Panel id="slurs">
        <h3>Slurs</h3>
        <p>
          Shown as <code>slurs: N chat lines, N names</code>. A slur typed in chat or used as a player name.
          The file shows the exact text, so you can judge it directly and handle it under the conduct rules.
        </p>
      </Panel>

      <Panel id="appeals">
        <h3>Appeals</h3>
        <p>
          Banned, held and Discord-sanctioned people can appeal from the site, the Appeal button beside Report a player,
          or riversidepug.com/appeal. Each ban gets one appeal at a time and two in total; after a denial they wait seven
          days. Bans shorter than a day cannot be appealed (holds always can).
        </p>
        <p>
          You can write back and forth with the player as many times as you need, from the appeal page. They see your
          messages as from "Staff", never your name, and get each one as a Discord DM; the whole conversation is also
          posted in the appeal's forum thread. They can write any time while the appeal is open (deny it if they spam).
          After each of your messages they have 72 hours to reply; no reply by then closes the appeal as denied.
          Then Accept (the ban is lifted), Shorten (pick a new end; website bans only) or Deny. The outcome itself is
          always a fixed sentence.
        </p>
        <p>
          Anyone at the issuer's rank or above decides, including whoever issued the ban: an admin's ban needs an admin.
          An appeal containing a slur is denied automatically and still shown here. Appeals by staff, or about a ban from
          a restricted ticket, have no forum post. An admin can mark a ban "No more appeals".
        </p>
      </Panel>
    </div>
  );
}
