import { adminApi } from '../../../api';
import { useFetch } from '../../../hooks/useFetch';
import { Empty } from '../../../components/bits';
import { GameValuesView } from '../../balance/GameValuesView';

/** Admin preview of the public Game values page: every rule, draft and
 *  inactive ones tagged, and unpublished patch names. Rules go public once
 *  balance/catalogue.json marks them reviewed. */
export function Values() {
  const { data, error } = useFetch((s) => adminApi.gameValues(s), []);
  if (error) return <Empty>Could not load the game values.</Empty>;
  if (!data) return <p class="muted">Loading...</p>;
  return (
    <div class="stack">
      <p class="balance-banner">Preview of the public <a href="/balance/values">Game values</a> page. Draft rules are hidden from the public until they are marked reviewed in balance/catalogue.json.</p>
      <GameValuesView data={data} admin />
    </div>
  );
}
