import { Panel } from '../../components/bits';

/**
 * What every line on Needs a look and on a player's file means, for staff.
 *
 * Static, and deliberately in the site rather than in a doc: the wording here
 * tracks the code that produces each line (src/admin/arrived.ts and the
 * src/admin/timeline adapters), so a new kind of flag gets its entry in the
 * same change. Moderators asked for it so they can judge a file themselves
 * instead of asking what a line means.
 */
export function StaffGuide() {
  return (
    <div class="stack">
      <nav class="panel howto-index" aria-label="On this page">
        <ul>
          <li><a href="#reading">Reading the list</a></li>
          <li><a href="#input">Input flags</a></li>
          <li><a href="#lilac">Little Anti-Cheat</a></li>
          <li><a href="#setting">Client settings</a></li>
          <li><a href="#replay">Replay moments</a></li>
          <li><a href="#ranking">Analyzer ranking</a></li>
          <li><a href="#steam">Steam</a></li>
          <li><a href="#drops">Connect drops</a></li>
          <li><a href="#slurs">Slurs</a></li>
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
          Shown as <code>N input flags (pounce_spam, pistol_rate)</code>. The server records the timing of
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

      <Panel id="drops">
        <h3>Repeated connect drops</h3>
        <p>
          The player dropped out while loading in, twice within ten minutes with no successful join between.
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
    </div>
  );
}
