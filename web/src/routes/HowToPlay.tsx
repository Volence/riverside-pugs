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
    q: 'My demo crashes when I play it back.',
    a: <>Load any versus map first (<code>map l4d_vs_hospital01_apartment versus</code>), then <code>playdemo</code>. Loading a versus demo from the main menu crashes the game. The match page has the full steps next to the downloads.</>,
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
