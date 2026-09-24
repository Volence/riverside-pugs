import { Route, Router, lazy } from 'preact-iso';
import type { StateSnapshot } from './api';
import type { Session } from './hooks/useLiveState';
import { Redirect } from './components/Redirect';
import { Panel } from './components/bits';
import { PageHeader } from './components/PageHeader';
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
import { ADMIN_ROUTE_PATHS } from './routes/admin/adminRoutes';
import { HowToPlay } from './routes/HowToPlay';
import { HelpConsistency } from './routes/HelpConsistency';

// The HUD editor carries ~170 KB of base HUD files, so it stays out of the main bundle.
const Hud = lazy(() => import('./routes/Hud'));
// The community pages draw crosshairs and fetch on mount; lazy like the editor so
// neither weighs on the first load of the pages people land on most.
const Community = lazy(() => import('./routes/Community'));
const CommunityEntry = lazy(() => import('./routes/CommunityEntry'));

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

/** The ban list lives on the People desk now. Declared once rather than
 *  inline, so the router is not handed a new component type every render. */
const BansMoved = () => <Redirect to="/admin/people/bans" />;

/**
 * Every URL the site answers, in one place.
 *
 * Its own module rather than a block inside main.tsx, because main.tsx cannot
 * be imported by a test: it renders into the document and fetches on import.
 * The table is the thing worth testing (a route quietly lost is a page that
 * becomes a 404), so it lives where a test can mount it.
 */
export function AppRoutes(
  { session, state, refresh }: { session: Session; state: StateSnapshot | null; refresh: () => void },
) {
  const me = session.kind === 'active' ? session.me.steamid : null;
  // Only decides whether staff screens are offered; every one of them is
  // guarded again by the server.
  const staff = session.kind === 'active' && (session.me.isAdmin || session.me.isMod === true);
  return (
    <Router>
      <Route path="/" component={Play} session={session} state={state} refresh={refresh} />
      <Route path="/leaderboard" component={Leaderboard} me={me} />
      <Route path="/matches" component={Matches} />
      <Route path="/live" component={Live} me={me} />
      <Route path="/streams" component={Streams} />
      <Route path="/match/:id" component={MatchDetail} me={me} staff={staff} />
      <Route path="/maps" component={Maps} />
      <Route path="/custom-campaigns" component={CustomCampaigns} />
      <Route path="/crosshair" component={Crosshair} session={session} />
      <Route path="/hud" component={Hud} session={session} />
      <Route path="/community" component={Community} session={session} />
      <Route path="/community/:id" component={CommunityEntry} session={session} />
      <Route path="/replay/file/:name" component={ReplayPage} />
      <Route path="/map/:map" component={MapDetail} />
      <Route path="/player/:steamid" component={Profile} session={session} refresh={refresh} />
      {/* Every screen in the panel is a path now, so the shell needs the
          whole subtree rather than one route. */}
      {ADMIN_ROUTE_PATHS.map((p) => <Route key={p} path={p} component={Admin} session={session} />)}
      {/* The ban list moved into the panel; the old URL is in bookmarks. */}
      <Route path="/bans" component={BansMoved} />
      <Route path="/how-to-play" component={HowToPlay} session={session} />
      <Route path="/help/consistency" component={HelpConsistency} />
      <Route path="/link/discord" component={LinkDiscord} session={session} refresh={refresh} />
      <Route default component={NotFound} />
    </Router>
  );
}
