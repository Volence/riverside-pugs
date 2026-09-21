import { render } from 'preact';
import { api } from './api';
import { setCampaignNames } from './format';
import { LocationProvider, useLocation } from 'preact-iso';
import { useLiveState } from './hooks/useLiveState';
import { AppRoutes } from './AppRoutes';
import { Nav } from './components/Nav';
import { QueueBar } from './components/QueueBar';
import { EndorseBar } from './components/EndorseBar';
import { DevPanel } from './components/DevPanel';
import { ConfirmHost } from './components/Confirm';
import './styles/app.css';

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
      <Nav session={session} state={state} onSignedOut={refresh} />
      {/* Below the nav and above the router: it belongs to the shell, not to
          any page, and it is what keeps a running ready check visible while
          you are reading the leaderboard. It also owns data-urgent and the
          tab title for the whole app, so nothing else may set them. */}
      <QueueBar state={state} path={path} />
      <EndorseBar me={me} path={path} />
      <main>
        <AppRoutes session={session} state={state} refresh={refresh} />
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
