import { useState } from 'preact/hooks';
import { Panel } from '../components/bits';
import { mb, PieceRow, pieceStatus, readGot, type Got, type L4D2Piece } from './L4D2Pack';

/** The mirrored campaigns (Season 1): the same thirteen 00_mirrormaps_*.vpk files as all five
 *  servers, built by mirror/out/dist/s1/build.sh. Versioned like the L4D2 pieces: an updated
 *  piece gets a new key, and inAll false until the full zip is rebuilt. */
const BASE = 'https://assets.riversidepug.com/mappack/mirror-s1';
export const MIRROR_PACK_URL = `${BASE}/Riverside-Mirror-Maps-S1.zip`;
export const MIRROR_PACK_BYTES = 912533321;

export const MIRROR_SHARED: L4D2Piece =
  { id: 'shared', name: 'Shared files', url: `${BASE}/Riverside-Mirror-Shared-Files.zip`, bytes: 233145588, inAll: true };
/** Named after the originals, since that is what a player knows them by; the note is the
 *  backwards title the vote shows. needsL4D2 marks the ones that also need the L4D2 pack. */
export const MIRROR_CAMPAIGN_PIECES: (L4D2Piece & { needsL4D2?: boolean })[] = [
  { id: 'no_mercy', name: 'No Mercy', note: 'Ycrem On', url: `${BASE}/Riverside-Mirror-No-Mercy.zip`, bytes: 40907711, inAll: true },
  { id: 'death_toll', name: 'Death Toll', note: 'Llot Htaed', url: `${BASE}/Riverside-Mirror-Death-Toll.zip`, bytes: 56424718, inAll: true },
  { id: 'dead_air', name: 'Dead Air', note: 'Ria Daed', url: `${BASE}/Riverside-Mirror-Dead-Air.zip`, bytes: 37197660, inAll: true },
  { id: 'blood_harvest', name: 'Blood Harvest', note: 'Tsevrah Doolb', url: `${BASE}/Riverside-Mirror-Blood-Harvest.zip`, bytes: 39980408, inAll: true },
  { id: 'crash_center', name: 'Crash Center', note: 'Retnec Daed', url: `${BASE}/Riverside-Mirror-Crash-Center.zip`, bytes: 63010240, inAll: true, needsL4D2: true },
  { id: 'dark_carnival', name: 'Dark Carnival', note: 'Lavinrac Krad', url: `${BASE}/Riverside-Mirror-Dark-Carnival.zip`, bytes: 73485519, inAll: true, needsL4D2: true },
  { id: 'swamp_fever', name: 'Swamp Fever', note: 'Revef Pmaws', url: `${BASE}/Riverside-Mirror-Swamp-Fever.zip`, bytes: 58840752, inAll: true, needsL4D2: true },
  { id: 'hard_rain', name: 'Hard Rain', note: 'Niar Drah', url: `${BASE}/Riverside-Mirror-Hard-Rain.zip`, bytes: 85021756, inAll: true, needsL4D2: true },
  { id: 'the_parish', name: 'The Parish', note: 'Hsirap Eht', url: `${BASE}/Riverside-Mirror-The-Parish.zip`, bytes: 60605038, inAll: true, needsL4D2: true },
  { id: 'passifice', name: 'Passifice', note: 'Ecifircas Eht', url: `${BASE}/Riverside-Mirror-Passifice.zip`, bytes: 47469471, inAll: true, needsL4D2: true },
  { id: 'cold_stream', name: 'Cold Stream', note: 'Maerts Dloc', url: `${BASE}/Riverside-Mirror-Cold-Stream.zip`, bytes: 95055042, inAll: true, needsL4D2: true },
  { id: 'the_last_stand', name: 'The Last Stand', note: 'Dnats Tsal Eht', url: `${BASE}/Riverside-Mirror-The-Last-Stand.zip`, bytes: 21396450, inAll: true, needsL4D2: true },
];

/** Its own key, so a mirror piece and an L4D2 piece with the same id never tick each other. */
const STORE_KEY = 'mirror-downloads';
/** Whether this browser has ticked any mirror download: the play page's
 *  get-the-mirrored-maps notice stays away for someone who already got them. */
export function gotAnyMirror(): boolean {
  return Object.keys(readGot(STORE_KEY)).length > 0;
}

export function MirrorPack() {
  const [got, setGot] = useState<Got>(() => readGot(STORE_KEY));
  const mark = (id: string, url: string) => {
    const next = { ...got, [id]: url };
    setGot(next);
    try { localStorage.setItem(STORE_KEY, JSON.stringify(next)); } catch { /* private window */ }
  };
  const status = (p: L4D2Piece) => pieceStatus(p, got, MIRROR_PACK_URL);
  const l4d1 = MIRROR_CAMPAIGN_PIECES.filter((p) => !p.needsL4D2);
  const l4d2 = MIRROR_CAMPAIGN_PIECES.filter((p) => p.needsL4D2);
  return (
    <Panel id="mirror-pack">
      <div class="ccamp__head l4d2pack__head">
        <h3>The mirrored campaigns</h3>
        <a class="btn" href={MIRROR_PACK_URL} onClick={() => mark('all', MIRROR_PACK_URL)}>
          Download all {mb(MIRROR_PACK_BYTES)}
        </a>
      </div>
      <p>
        Season 1's Wrong Way maps: every chapter flipped left to right, so the route you know turns
        the other way. Finales are the original maps. Signs and text read backwards on purpose.
        Every match vote has one mirrored campaign on it, so install these before you queue.
      </p>
      <div class="l4d2pick">
        <p class="l4d2pick__lede">
          Or only the ones you want: the shared files once, then any campaign. Download all
          already has every one of these.
        </p>
        <div class="l4d2shared">
          <p class="l4d2shared__label">Start here: every mirrored campaign needs the shared files</p>
          <PieceRow piece={MIRROR_SHARED} status={status(MIRROR_SHARED)} note="needed once, by every campaign"
            onGet={() => mark(MIRROR_SHARED.id, MIRROR_SHARED.url)} />
        </div>
        <p class="l4d2pick__lede">The stock four, mirrored:</p>
        <div class="l4d2pick__grid">
          {l4d1.map((p) => (
            <PieceRow key={p.id} piece={p} status={status(p)} note={p.note} onGet={() => mark(p.id, p.url)} />
          ))}
        </div>
        <p class="l4d2pick__lede">
          The L4D2 campaigns, mirrored. These also need the <a href="#l4d2-pack">L4D2 campaigns</a> above.
        </p>
        <div class="l4d2pick__grid">
          {l4d2.map((p) => (
            <PieceRow key={p.id} piece={p} status={status(p)} note={p.note} onGet={() => mark(p.id, p.url)} />
          ))}
        </div>
      </div>
      <ol class="howto">
        <li>
          <a href={MIRROR_PACK_URL} onClick={() => mark('all', MIRROR_PACK_URL)}><strong>Download the mirrored campaigns</strong></a>{' '}
          (all of them, {mb(MIRROR_PACK_BYTES)}), or the shared files and the campaigns you want from
          the list above.
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
