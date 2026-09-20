import { Panel } from '../components/bits';
import { PageHeader } from '../components/PageHeader';

/** Static. Linked from the bot's DM to a player whose connection dropped while
 *  loading in, and from the admin player page. Everything here has to make
 *  sense to someone who has never heard the word "consistency": they have a
 *  dialog with a file name on it and want to get into the match. */
export function HelpConsistency() {
  return (
    <div class="page page--profile">
      <PageHeader eyebrow="Help" title="Server is enforcing consistency" />
      <div class="stack">
        <Panel>
          <h3>What the dialog means</h3>
          <p>
            If the game dropped you back to the menu while loading in, with a box that says
          </p>
          <blockquote class="mono">
            Server is enforcing consistency for this file:<br />
            materials/models/infected/hunter/hunter_01.vmt
          </blockquote>
          <p>
            then your copy of that file is not the one the game shipped with. The server sends a
            checksum for a list of game files, your game compares each one against its own disk, and
            it disconnects itself at the first one that differs. The file it names is the one to fix.
            Nobody kicked you and nothing was banned: fix the file and you can connect straight away.
            The same check runs again at every map change.
          </p>
          <p class="muted">
            Only your own screen shows the file name. The server and the admins never see it, so if
            you ask for help, say which file it was.
          </p>
        </Panel>

        <Panel>
          <h3>What it usually is</h3>
          <ol class="howto">
            <li>
              <strong>A skin.</strong> Recolored, brightened or glowing special infected, and replacement
              models. The file named starts with <code>materials/models/infected/</code> or{' '}
              <code>models/infected/</code>. Many skin guides have you edit <code>pak01_dir.vpk</code>{' '}
              directly, which is why removing addons alone does not always clear it.
            </li>
            <li>
              <strong>A no-trees or foliage pack.</strong> Anything that removes or thins trees, bushes
              and plants. The file named starts with <code>models/props_foliage/</code>,{' '}
              <code>models/props_plants/</code> or the matching <code>materials/models/</code> folders.
            </li>
            <li>
              <strong>Silenced weapons or a sound pack.</strong> Quieter gunfire, or louder or replaced
              special infected sounds. The file named starts with <code>sound/weapons/</code>,{' '}
              <code>sound/player/</code>, <code>sound/npc/witch/</code> or is one of the{' '}
              <code>scripts/game_sounds_*.txt</code> files.
            </li>
          </ol>
          <p>
            Smoke, boomer bile and the special infected particle effects (<code>materials/particle/</code>{' '}
            and <code>particles/*.pcf</code>) are checked too. HUDs, crosshairs, survivor skins, weapon
            skins and menu music are not on the list and are fine.
          </p>
        </Panel>

        <Panel>
          <h3>Remove the addon</h3>
          <ol class="howto">
            <li>Quit the game.</li>
            <li>
              Open the addons folder. In Steam: right-click <strong>Left 4 Dead</strong>,{' '}
              <strong>Manage</strong>, <strong>Browse local files</strong>, then{' '}
              <code>left4dead/addons</code>.
            </li>
            <li>
              Move the <code>.vpk</code> that changes the named file somewhere else (the Desktop is
              fine). If you cannot tell which one it is, move them all out and put them back one at a
              time.
            </li>
            <li>
              Look for loose files too. A sound pack is often unpacked straight into{' '}
              <code>left4dead/sound</code> or <code>left4dead/scripts</code> rather than shipped as a
              <code>.vpk</code>. Verifying game files, below, puts those back.
            </li>
            <li>Start the game and connect again.</li>
          </ol>
        </Panel>

        <Panel>
          <h3>Verify your game files</h3>
          <p>
            This is the fix when the file was edited in place, which is how most skins are installed,
            and it is safe to do any time.
          </p>
          <ol class="howto">
            <li>In Steam, right-click <strong>Left 4 Dead</strong> and pick <strong>Properties</strong>.</li>
            <li>Open <strong>Installed Files</strong>.</li>
            <li>
              Press <strong>Verify integrity of game files</strong> and let it finish. Steam downloads
              the original of anything that was changed.
            </li>
            <li>Start the game and connect again.</li>
          </ol>
        </Panel>

        <Panel>
          <h3>What you can keep</h3>
          <p>
            Custom HUDs and custom crosshairs are never checked, so there is no need to remove
            them. The same goes for the infected vision colour files, which you may edit or delete:
          </p>
          <ul>
            <li><code class="mono">ghost.raw</code> and <code class="mono">ghost.pwl.raw</code></li>
            <li><code class="mono">infected.raw</code> and <code class="mono">infected.pwl.raw</code></li>
          </ul>
          <p>
            If the dialog names a file, it is never one of these. Look at skins, foliage packs and
            sound packs first.
          </p>
        </Panel>

        <Panel>
          <h3>Grass settings are not part of this</h3>
          <p>
            Turning detail grass down or off with <code>cl_detaildist</code> or{' '}
            <code>r_drawdetailprops</code> is a console setting, not a file. This check cannot see
            settings, so those two never cause the dialog and changing them back will not clear it.
          </p>
        </Panel>

        <Panel>
          <h3>Still stuck</h3>
          <p>
            Tell an admin in the Riverside Discord which file the dialog named. If it names a file
            and you have no addons and have verified your game files, that is a bug on our side and we
            want to hear about it.
          </p>
        </Panel>
      </div>
    </div>
  );
}
