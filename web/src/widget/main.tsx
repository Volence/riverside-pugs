import { render } from 'preact';
import { useEffect } from 'preact/hooks';
import { SEASON_THEMES, type SeasonThemeId } from '../api';
import { setCampaignNames } from '../format';
import { applySeasonTheme } from '../seasonTheme';
import { parseWidgetUrl, type WidgetParams } from './params';
import { Widget } from './Widgets';
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

/** ?theme=<look> or ?theme=standard tries a look on this one load (not kept,
 *  so a browser source on air never sticks to a preview). */
const asked = new URLSearchParams(location.search).get('theme');
const themeOverride: SeasonThemeId | null | undefined =
  asked === 'standard' ? null : knownTheme(asked) ?? undefined;

function App({ params }: { params: WidgetParams }) {
  const state = useWidgetData(params.steamid, { since });
  const theme = state.kind === 'ok' ? (themeOverride !== undefined ? themeOverride : knownTheme(state.data.theme)) : undefined;
  // The season's look swaps the tokens on <html> (tokens.css [data-season]).
  useEffect(() => { if (theme !== undefined) applySeasonTheme(theme); }, [theme]);
  if (state.kind !== 'ok') return null;
  return <Widget params={params} data={state.data} />;
}

if (params) {
  // Display names for custom campaigns, as the site registers them (as the
  // caster overlay does). Not awaited: a slug is an acceptable fallback until
  // the next poll redraws.
  fetch('/api/campaigns/names').then((r) => (r.ok ? r.json() : null)).then((r: { names?: Record<string, string> } | null) => {
    if (r?.names) setCampaignNames(r.names);
  }).catch(() => { /* slugs it is */ });
  render(<App params={params} />, document.getElementById('widget')!);
}
