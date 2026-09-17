import { render } from 'preact';
import { LocationProvider, Route, Router, useLocation } from 'preact-iso';
import { useLiveState } from './hooks/useLiveState';
import { Nav } from './components/Nav';
import { QueueBar } from './components/QueueBar';
import { DevPanel } from './components/DevPanel';
import { Play } from './routes/Play';
import { Leaderboard } from './routes/Leaderboard';
import { Matches } from './routes/Matches';
import { Live } from './routes/Live';
import { MatchDetail } from './routes/MatchDetail';
import { MapDetail } from './routes/MapDetail';
import { Maps } from './routes/Maps';
import { Profile } from './routes/Profile';
import { Crosshair } from './routes/Crosshair';
import { ReplayPage } from './routes/ReplayPage';
import { LinkDiscord } from './routes/LinkDiscord';
import { Admin } from './routes/Admin';
import { HowToPlay } from './routes/HowToPlay';
import { Empty, Panel } from './components/bits';
import './styles/app.css';

function NotFound() {
  return (
    <div class="page page--list">
      <Panel><Empty>No such page.</Empty></Panel>
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
      <main>
        <Router>
          <Route path="/" component={Play} session={session} state={state} refresh={refresh} />
          <Route path="/leaderboard" component={Leaderboard} me={me} />
          <Route path="/matches" component={Matches} />
          <Route path="/live" component={Live} me={me} />
          <Route path="/match/:id" component={MatchDetail} me={me} />
          <Route path="/maps" component={Maps} />
          <Route path="/crosshair" component={Crosshair} />
          <Route path="/replay/file/:name" component={ReplayPage} />
          <Route path="/map/:map" component={MapDetail} />
          <Route path="/player/:steamid" component={Profile} session={session} refresh={refresh} />
          <Route path="/admin" component={Admin} session={session} />
          <Route path="/how-to-play" component={HowToPlay} session={session} />
          <Route path="/link/discord" component={LinkDiscord} session={session} refresh={refresh} />
          <Route default component={NotFound} />
        </Router>
      </main>
      <DevPanel refresh={refresh} />
    </>
  );
}

render(
  <LocationProvider>
    <App />
  </LocationProvider>,
  document.getElementById('app')!,
);
