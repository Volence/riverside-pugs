import type { PublicEntry } from '../../api';
import { fmtDate } from '../../format';
import { GROUP_LABEL } from '../admin/balance/format';
import { APPROXIMATE_TEXT, CHANGES_UNAVAILABLE_TEXT, publicDelta, publicValue, skillBannerText, verdictSentence } from './wording';

/** "2026-08-01" to "2026-08-31", one date when the two agree, nothing when
 *  the patch has no counted rounds at all. */
function dateLine(entry: PublicEntry): string | null {
  if (!entry.firstRound) return null;
  const first = fmtDate(entry.firstRound).slice(0, 10);
  const last = entry.lastRound ? fmtDate(entry.lastRound).slice(0, 10) : first;
  return first === last ? first : `${first} to ${last}`;
}

/** One published balance patch: its notes, what settings changed, and (once
 *  there is a comparison to make) what the numbers say happened. Used both
 *  by the /balance list and, for the changesUnavailable states that need no
 *  comparison, on its own. */
export function PatchEntryView({ entry }: { entry: PublicEntry }) {
  const dates = dateLine(entry);
  const changes = entry.changes;
  const noChanges = !!changes && changes.knobs.length === 0 && changes.pluginsAdded.length === 0
    && changes.pluginsRemoved.length === 0 && changes.pluginsUpdated.length === 0 && changes.files.length === 0;

  return (
    <article class="patch-entry">
      <h3>{entry.name}</h3>
      <p class="patch-meta muted">
        {dates && <span>{dates} · </span>}
        {entry.matches} matches, {entry.rounds} rounds
        {entry.approximate && <span class="chip"> approximate</span>}
      </p>
      <p class="patch-notes">{entry.notes}</p>

      <h4>What changed</h4>
      {entry.changesUnavailable ? (
        <p>{CHANGES_UNAVAILABLE_TEXT[entry.changesUnavailable]}</p>
      ) : noChanges ? (
        <p>No tracked setting changed; see the notes.</p>
      ) : changes ? (
        <ul class="patch-changes">
          {changes.knobs.map((k) => <li key={k.label}>{k.label}: from {k.from} to {k.to}</li>)}
          {changes.pluginsAdded.length > 0 && <li>Added plugins: {changes.pluginsAdded.join(', ')}</li>}
          {changes.pluginsRemoved.length > 0 && <li>Removed plugins: {changes.pluginsRemoved.join(', ')}</li>}
          {changes.pluginsUpdated.length > 0 && <li>Updated plugins: {changes.pluginsUpdated.join(', ')}</li>}
          {changes.files.length > 0 && <li>Changed files: {changes.files.join(', ')}</li>}
        </ul>
      ) : null}

      <h4>Measured effect</h4>
      {entry.status === 'first' ? (
        <p>{CHANGES_UNAVAILABLE_TEXT.first}</p>
      ) : entry.status === 'no_rounds' ? (
        <p>No rounds yet.</p>
      ) : entry.effect && (
        <>
          <p>
            Compared with {entry.previous?.name}: {entry.effect.a.matches} matches before,{' '}
            {entry.effect.b.matches} matches after.
          </p>
          {skillBannerText(entry.effect.skill) && <p class="patch-banner">{skillBannerText(entry.effect.skill)}</p>}
          {entry.effect.approximate && <p class="patch-banner">{APPROXIMATE_TEXT}</p>}
          {Object.keys(GROUP_LABEL).map((g) => {
            const rows = entry.effect!.rows.filter((r) => r.group === g);
            if (rows.length === 0) return null;
            return (
              <section key={g}>
                <h5>{GROUP_LABEL[g]}</h5>
                <div class="table-wrap">
                  <table>
                    <thead>
                      <tr><th>Metric</th><th>Before</th><th>After</th><th>Change</th><th>What we measured</th></tr>
                    </thead>
                    <tbody>
                      {rows.map((r) => (
                        <tr key={r.metric} class={r.verdict === 'real' ? 'patch-row--real' : undefined}>
                          <td>{r.label}</td>
                          <td>{publicValue(r.metric, r.a)}</td>
                          <td>{publicValue(r.metric, r.b)}</td>
                          <td>{r.diff === null ? '' : publicDelta(r.metric, r.diff)}</td>
                          <td>{verdictSentence(r)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            );
          })}
        </>
      )}
    </article>
  );
}
