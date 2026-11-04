import { render } from 'preact';
import { useEffect } from 'preact/hooks';
import { SEASON_THEMES, type SeasonThemeId } from '../api';
import { applySeasonTheme } from '../seasonTheme';
import { parseWidgetUrl, type WidgetParams } from './params';
import { sessionSince, useWidgetData } from './useWidgetData';
import './widgetPage.css';

/**
 * OBS browser source entry (stream widgets). /widget/<steamid>/<kind>.
 * Public and keyless; no site chrome. A bad link, a player who is gone, or
 * the first load still in flight all render nothing, so a stream never shows
 * an error box.
 */

const params = parseWidgetUrl(location.pathname, location.search);
// "This stream" starts once per load at most; ?reset=1 starts a new one.
const since = params ? sessionSince(params.steamid, Date.now(), new URLSearchParams(location.search).get('reset') === '1') : null;

const knownTheme = (t: string | null): SeasonThemeId | null =>
  SEASON_THEMES.some((s) => s.id === t) ? t as SeasonThemeId : null;

function App({ params }: { params: WidgetParams }) {
  const state = useWidgetData(params.steamid, { since });
  const theme = state.kind === 'ok' ? knownTheme(state.data.theme) : undefined;
  // The season's look swaps the tokens on <html> (tokens.css [data-season]).
  useEffect(() => { if (theme !== undefined) applySeasonTheme(theme); }, [theme]);
  if (state.kind !== 'ok') return null;
  // The renderers arrive with Task 4: <Widget params={params} data={state.data} />.
  return null;
}

if (params) render(<App params={params} />, document.getElementById('widget')!);
