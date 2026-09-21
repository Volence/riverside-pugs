import { render } from 'preact';
import { api } from './api';
import { setCampaignNames } from './format';
import { LocationProvider, Route, Router, useLocation } from 'preact-iso';
import { useLiveState } from './hooks/useLiveState';
import { Nav } from './components/Nav';
import { QueueBar } from './components/QueueBar';
import { EndorseBar } from './components/EndorseBar';
import { DevPanel } from './components/DevPanel';
import { ConfirmHost } from './components/Confirm';
import { Play } from './routes/Play';
import { Leaderboard } from './routes/Leaderboard';
import { Matches } from './routes/Matches';
import { Live } from './routes/Live';
import { Streams } from './routes/Streams';
import { MatchDetail } from './routes/MatchDetail';
import { MapDetail } from './routes/MapDetail';
import { Maps } from './routes/Maps';
import { CustomCampaigns } from './routes/CustomCampaigns';
import { Profile } from './routes/Profile';
import { Crosshair } from './routes/Crosshair';
import { ReplayPage } from './routes/ReplayPage';
import { LinkDiscord } from './routes/LinkDiscord';
import { Admin } from './routes/Admin';
import { Bans } from './routes/Bans';
import { HowToPlay } from './routes/HowToPlay';
import { HelpConsistency } from './routes/HelpConsistency';
import { Panel } from './components/bits';
import { PageHeader } from './components/PageHeader';
import './styles/app.css';

/** The 404.
 *
 *  It gets more traffic than a 404 normally would, because match and player
 *  URLs get pasted into Discord and a typo'd or voided id lands here. A bare
 *  "No such page." over an empty screen gave no way onward, so this offers the
 *  three places someone who mistyped a link was most likely heading. */
function NotFound() {
  return (
    <div class="page page--list">
      <PageHeader eyebrow="404" title="Page not found" />
      <Panel>
        <p class="muted">
          That link does not point at anything. A match or player link can also
          land here if the id was mistyped, or if the match was voided.
        </p>
        <nav class="notfound__links">
          <a class="chip" href="/">Play</a>
          <a class="chip" href="/matches">Recent matches</a>
          <a class="chip" href="/leaderboard">Leaderboard</a>
          <a class="chip" href="/how-to-play">How to play</a>
        </nav>
      </Panel>
    </div>
  );
}

/** Live state is held at the root rather than inside the Play route, because
 *  the websocket connection and the ready-check countdown must survive
 *  navigation: a player browsing the leaderboard still needs the nav border to
 *  turn red when a ready check starts. */
function App() {
  const { session, state, refresh } = useLiveState();
  const me = session.kind === 'active' ? session.me.steamid : null;
  const { path } = useLocation();

  return (
    <>
      <Nav session={session} state={state} />
      {/* Below the nav and above the router: it belongs to the shell, not to
          any page, and it is what keeps a running ready check visible while
          you are reading the leaderboard. It also owns data-urgent and the
          tab title for the whole app, so nothing else may set them. */}
      <QueueBar state={state} path={path} />
      <EndorseBar me={me} path={path} />
      <main>
        <Router>
          <Route path="/" component={Play} session={session} state={state} refresh={refresh} />
          <Route path="/leaderboard" component={Leaderboard} me={me} />
          <Route path="/matches" component={Matches} />
          <Route path="/live" component={Live} me={me} />
          <Route path="/streams" component={Streams} />
          <Route path="/match/:id" component={MatchDetail} me={me} />
          <Route path="/maps" component={Maps} />
          <Route path="/custom-campaigns" component={CustomCampaigns} />
          <Route path="/crosshair" component={Crosshair} />
          <Route path="/replay/file/:name" component={ReplayPage} />
          <Route path="/map/:map" component={MapDetail} />
          <Route path="/player/:steamid" component={Profile} session={session} refresh={refresh} />
          <Route path="/admin" component={Admin} session={session} />
          <Route path="/bans" component={Bans} session={session} />
          <Route path="/how-to-play" component={HowToPlay} session={session} />
          <Route path="/help/consistency" component={HelpConsistency} />
          <Route path="/link/discord" component={LinkDiscord} session={session} refresh={refresh} />
          <Route default component={NotFound} />
        </Router>
      </main>
      <DevPanel refresh={refresh} />
      {/* Last, and outside <main>: it renders nothing until something calls
          confirm(), and when it does it must sit above the whole shell. */}
      <ConfirmHost />
    </>
  );
}

// Campaign display names, fetched once and registered before anything asks for
// one. Not awaited: a slow or failed request must not stop the site rendering,
// and campaignName already falls back to the slug, which is exactly what every
// custom campaign showed before this existed. Failure is therefore a cosmetic
// regression to the old behaviour rather than a broken page.
api.campaignNames()
  .then((r) => setCampaignNames(r.names))
  .catch(() => { /* slugs it is */ });

render(
  <LocationProvider>
    <App />
  </LocationProvider>,
  document.getElementById('app')!,
);
