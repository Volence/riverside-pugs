import { api } from '../../api';
import { useFetch } from '../../hooks/useFetch';
import { Empty } from '../../components/bits';
import { PageHeader } from '../../components/PageHeader';
import { GameValuesView } from './GameValuesView';

/** The public Game values page: what every balance setting is right now, the
 *  vanilla L4D1 value beside it, and the rules our plugins add. */
export function GameValues() {
  const { data, error } = useFetch((s) => api.gameValues(s), []);
  return (
    <div class="page page--list">
      <PageHeader eyebrow="Balance" title="Game values">
        <p>
          Every balance setting as our servers run it, next to the vanilla Left 4 Dead value. Rows that
          differ from vanilla are highlighted, and a dash means ours is the same as vanilla. <a href="/balance">Patch notes</a> say why each change was made.
        </p>
      </PageHeader>
      {error ? <Empty>Could not load the game values.</Empty>
        : !data ? <Empty>Loading…</Empty>
        : <GameValuesView data={data} admin={false} />}
    </div>
  );
}
