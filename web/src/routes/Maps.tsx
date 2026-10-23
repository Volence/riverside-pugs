import { useEffect, useState } from 'preact/hooks';
import { api, type MapIndexRow } from '../api';
import { useFetch } from '../hooks/useFetch';
import { campaignName, campaignTint, chapterName, fmtClock, mapName, survivalLabel } from '../format';
import { Empty, Panel, PageSkeleton } from '../components/bits';
import { PageHeader, Figures, Figure } from '../components/PageHeader';
import { mapThumb } from '../../../src/mapThumbs';
import { CampaignTiles } from '../components/CampaignTiles';

/** The id of a campaign's table, which its tile links to. */
export const campaignAnchor = (slug: string): string => `campaign-${slug}`;

export function Maps() {
  const { data, error } = useFetch((s) => api.maps(s), []);
  const [showRest, setShowRest] = useState(false);
  // Scroll only once the table is on the page: a tile for a hidden campaign
  // opens the rest first, and the table appears on the next render.
  const [scrollTo, setScrollTo] = useState<string | null>(null);
  useEffect(() => {
    if (!scrollTo) return;
    document.getElementById(campaignAnchor(scrollTo))?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
    setScrollTo(null);
  }, [scrollTo, showRest]);

  if (error) {
    return (
      <div class="page page--list">
        <Panel><Empty>Couldn't load maps.</Empty></Panel>
      </div>
    );
  }
  if (!data) return <PageSkeleton variant="list" panels={2} />;

  const maps = data.maps;

  // Grouped by campaign because that is how people actually refer to them
  // ("Dead Air"), while the pages themselves are keyed by the engine map name.
  // Unknown campaigns collect under a single heading rather than vanishing.
  const groups = new Map<string, MapIndexRow[]>();
  for (const m of maps) {
    const key = m.campaign ?? 'other';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(m);
  }

  // In the current vote rotation first, then everything else by how much it has
  // been played, then the never-played. With 27 campaigns the page became a
  // wall, so (owner, 2026-09-22) the ones not in the vote fold away behind one
  // button, tiles and tables alike, and open exactly as before. Folded, not
  // dropped: a favourite campaign's history is one click away, never gone.
  // Defaulted, not assumed: a page that throws because one field is absent
  // is a worse failure than one that shows nothing in rotation.
  const pool = new Set(data.pool ?? []);
  const playedIn = (rows: MapIndexRow[]) => rows.reduce((n, m) => n + m.played, 0);
  const ordered = [...groups.entries()].sort(([aSlug, aRows], [bSlug, bRows]) => {
    const aPool = pool.has(aSlug) ? 1 : 0;
    const bPool = pool.has(bSlug) ? 1 : 0;
    if (aPool !== bPool) return bPool - aPool;
    // 'other' is the catch-all for maps no campaign claims, so it sinks.
    if ((aSlug === 'other') !== (bSlug === 'other')) return aSlug === 'other' ? 1 : -1;
    return playedIn(bRows) - playedIn(aRows);
  });

  // With nothing in the vote there is nothing to fold behind.
  const inVote = ordered.filter(([slug]) => pool.has(slug));
  const rest = ordered.filter(([slug]) => !pool.has(slug));
  const folding = inVote.length > 0 && rest.length > 0;
  const shown = folding && !showRest ? inVote : ordered;
  const restCampaigns = rest.filter(([slug]) => slug !== 'other').length;

  const tile = ([slug, rows]: [string, MapIndexRow[]]) => {
    const played = playedIn(rows);
    return {
      slug,
      sub: played === 0 ? 'Unplayed' : `${rows.length} map${rows.length === 1 ? '' : 's'} · ${played} played`,
      muted: played === 0,
      badge: pool.has(slug) ? 'In the vote' : undefined,
      href: `#${campaignAnchor(slug)}`,
    };
  };
  const follow = (slug: string, e: MouseEvent) => {
    // Handled here rather than left to the browser: the router treats a link
    // click as navigation, and a smooth scroll reads better than a jump.
    e.preventDefault();
    if (!pool.has(slug)) setShowRest(true);
    setScrollTo(slug);
    try { history.replaceState(null, '', `#${campaignAnchor(slug)}`); } catch { /* cosmetic */ }
  };

  return (
    <div class="page page--list">
      <PageHeader title="Campaigns">
        {maps.length > 0 && (
          <Figures>
            <Figure label="Maps played" value={maps.filter((m) => m.played > 0).length} />
            <Figure label="Campaigns" value={[...groups.keys()].filter((k) => k !== 'other').length} />
            <Figure
              label="Most played"
              value={maps.reduce((a, b) => (b.played > a.played ? b : a)).played}
              sub={(() => {
                const top = maps.reduce((a, b) => (b.played > a.played ? b : a));
                return chapterName(top.display ?? null, mapName(top.map));
              })()}
            />
          </Figures>
        )}
      </PageHeader>

      {maps.length === 0 ? (
        <Panel><Empty>No maps played yet.</Empty></Panel>
      ) : (
        <>
          <CampaignTiles items={shown.filter(([slug]) => slug !== 'other').map(tile)} onFollow={follow} />
          {folding && (
            <p class="campaigns-more">
              <button class="chip" type="button" aria-expanded={showRest} onClick={() => setShowRest(!showRest)}>
                {showRest
                  ? 'Hide the campaigns not in the vote'
                  : restCampaigns === 0
                    ? 'Show the other maps'
                    : `Show ${restCampaigns} more campaign${restCampaigns === 1 ? '' : 's'} not in the vote`}
              </button>
            </p>
          )}

          <div class="mapcamps">
            {shown.map(([campaign, rows]) => (
              <CampaignCard key={campaign} campaign={campaign} rows={rows} inVote={pool.has(campaign)} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

/** Survival pooled over a campaign's chapters, weighted by each chapter's own
 *  measured rounds, so a chapter with two readings cannot swing the total. */
export function pooledSurvival(rows: readonly MapIndexRow[]): { pct: number | null; measured: number } {
  let measured = 0;
  let survived = 0;
  for (const m of rows) {
    if (m.rounds.survivalPct === null || m.rounds.measured <= 0) continue;
    measured += m.rounds.measured;
    survived += (m.rounds.survivalPct / 100) * m.rounds.measured;
  }
  return { pct: measured > 0 ? Math.round((survived / measured) * 100) : null, measured };
}

/**
 * One campaign as a card: a band in the campaign's tint with its name and
 * totals, then one row per chapter in play order. Each row carries the same
 * four facts the old table did (played, average score, survival, round
 * times), but survival is drawn as a bar so the hard chapters stand out
 * without reading every number. A chapter nobody has played (usually the
 * finale, which PUGs skip) collapses to one muted line instead of a row of
 * n/a cells.
 */
function CampaignCard({ campaign, rows, inVote }: { campaign: string; rows: MapIndexRow[]; inVote: boolean }) {
  const played = rows.reduce((n, m) => n + m.played, 0);
  const surv = pooledSurvival(rows);
  const style = { '--campaign': campaign === 'other' ? 'var(--surface-2)' : campaignTint(campaign) } as Record<string, string>;
  return (
    <section class="mapcamp campaign-table" id={campaignAnchor(campaign)} style={style}>
      <header class="mapcamp__head">
        <div class="mapcamp__title">
          <p class="mapcamp__eyebrow">
            {rows.length} {rows.length === 1 ? 'chapter' : 'chapters'}
          </p>
          <h3>
            {campaign === 'other' ? 'Other maps' : campaignName(campaign)}
            {inVote && <span class="ccamp__pool">In the vote</span>}
          </h3>
        </div>
        <dl class="mapcamp__figs">
          <div><dt>Played</dt><dd>{played.toLocaleString('en-US')}</dd></div>
          <div>
            <dt>Survived</dt>
            <dd>{surv.pct === null || surv.measured < 10 ? <span class="muted">n/a</span> : `${surv.pct}%`}</dd>
          </div>
        </dl>
      </header>
      <ol class="mapch-list">
        {rows.map((m, i) => <ChapterRow key={m.map} m={m} n={i + 1} />)}
      </ol>
    </section>
  );
}

function ChapterRow({ m, n }: { m: MapIndexRow; n: number }) {
  const name = chapterName(m.display ?? null, mapName(m.map));
  const href = `/map/${encodeURIComponent(m.map)}`;
  if (m.played === 0) {
    return (
      <li class="mapch is-unplayed">
        <span class="mapch__num">{n}</span>
        <span class="mapch__name">{name}</span>
        <span class="mapch__none">Not played yet</span>
      </li>
    );
  }
  // Survival is null for rounds played before the plugin reported it, which
  // is not the same as nobody surviving; a sample too thin to state as a rate
  // is dimmed and says so. Its denominator (rounds with a reading) differs
  // from "played", so the count is printed beside it.
  const s = survivalLabel(m.rounds.survivalPct, m.rounds.measured);
  const pct = m.rounds.survivalPct;
  return (
    <li class="mapch">
      <span class="mapch__num">{n}</span>
      <a class="mapch__name" href={href}>
        {mapThumb(m.map, 640) && <img class="mapch__thumb" src={mapThumb(m.map, 640)!} alt="" loading="lazy" decoding="async" />}
        <span>{name}</span>
      </a>
      <span class="mapch__fig mapch__played"><b>{m.played}</b><small>played</small></span>
      <span class="mapch__fig mapch__score">
        {m.avgScore === null ? <b class="muted">not recorded</b> : <b>{m.avgScore}</b>}
        <small>avg score</small>
      </span>
      <span class={`mapch__surv${s.thin ? ' is-thin' : ''}`}>
        <span class="mapch__survtop">
          <b>{s.value}</b>
          <small>{s.thin ? (s.sub ?? 'survived') : `survived, ${s.sub}`}</small>
        </span>
        <span class="mapch__track" aria-hidden="true">
          {!s.thin && pct !== null && <span class="mapch__fill" style={{ width: `${pct}%` }} />}
        </span>
      </span>
      <span class="mapch__fig mapch__time">
        <b>{m.rounds.avgSec === null ? 'n/a' : fmtClock(m.rounds.avgSec)}</b>
        <small>
          {m.rounds.fastestSec !== null && m.rounds.slowestSec !== null
            ? `avg round, ${fmtClock(m.rounds.fastestSec)} to ${fmtClock(m.rounds.slowestSec)}`
            : 'avg round'}
        </small>
      </span>
    </li>
  );
}
