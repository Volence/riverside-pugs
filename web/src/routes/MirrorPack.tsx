import { useState } from 'preact/hooks';
import { Panel } from '../components/bits';
import { mb, readGot, type Got } from './L4D2Pack';

/** The mirrored campaigns (Season 1): one zip of the same thirteen 00_mirrormaps_*.vpk files as all
 *  five servers, built by mirror/out/dist/s1/build.sh. One download only (owner 11-02); an updated
 *  pack gets a new key, which is how a player who downloaded the old one is told it changed. */
export const MIRROR_PACK_URL = 'https://assets.riversidepug.com/mappack/mirror-s1/Riverside-Mirror-Maps-S1.zip';
export const MIRROR_PACK_BYTES = 912533321;

/** What this browser downloaded: { all: url }. Its own key, apart from the L4D2 pack's. */
const STORE_KEY = 'mirror-downloads';
/** Whether this browser has downloaded the pack: the play page's
 *  get-the-mirrored-maps notice stays away for someone who already got it. */
export function gotAnyMirror(): boolean {
  return Object.keys(readGot(STORE_KEY)).length > 0;
}

export function MirrorPack() {
  const [got, setGot] = useState<Got>(() => readGot(STORE_KEY));
  const status = got.all === MIRROR_PACK_URL ? 'have' : got.all ? 'updated' : null;
  const mark = () => {
    const next = { ...got, all: MIRROR_PACK_URL };
    setGot(next);
    try { localStorage.setItem(STORE_KEY, JSON.stringify(next)); } catch { /* private window */ }
  };
  const label = status === 'have' ? 'Downloaded' : status === 'updated' ? 'Updated: download again' : 'Download';
  return (
    <Panel id="mirror-pack">
      <div class="ccamp__head l4d2pack__head">
        <h3>The mirrored campaigns</h3>
        <a class="btn" href={MIRROR_PACK_URL} onClick={mark}>
          {label} {mb(MIRROR_PACK_BYTES)}
        </a>
      </div>
      <p>
        Season 1's Wrong Way maps: every chapter flipped left to right, so the route you know turns
        the other way. Finales are the original maps. Signs and text read backwards on purpose.
        Every match vote has one mirrored campaign on it, so install these before you queue. One
        download has all twelve: the stock four, and the eight L4D2 campaigns, which also need
        the <a href="#l4d2-pack">L4D2 campaigns</a> above.
      </p>
      <ol class="howto">
        <li>
          <a href={MIRROR_PACK_URL} onClick={mark}><strong>Download the mirrored campaigns</strong></a>{' '}
          ({mb(MIRROR_PACK_BYTES)}, 2.4 GB unzipped).
        </li>
        <li>
          With the game closed, put every <code>00_mirrormaps_*.vpk</code> in{' '}
          <code>left4dead\addons</code>, the same folder as the L4D2 campaigns.
        </li>
        <li>
          Start the game and check it worked: open the console and type{' '}
          <code>map l4d_vs_mhospital01_apartment versus</code>. If the apartment loads flipped, you are done.
        </li>
      </ol>
    </Panel>
  );
}
