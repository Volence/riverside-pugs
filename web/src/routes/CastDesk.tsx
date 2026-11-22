import CastStudio from './CastStudio';
import { DeskBody } from './DeskBody';
import { sampleFeed, sampleRoom } from '../overlay/sample';
import { defaultStudioState } from '../../../src/cast/types';

/**
 * /cast/desk: the caster studio's desk view, for a caster's second monitor.
 * The studio's own controls (match on air, number keys for scenes, OBS) over
 * the live stats (DeskBody). ?sample shows the sample match without signing
 * in, to see the layout.
 */
export default function CastDesk() {
  if (new URLSearchParams(location.search).has('sample')) {
    return <div class="desk"><DeskBody feed={sampleFeed(defaultStudioState(), Date.now())} room={sampleRoom(Date.now())} /></div>;
  }
  return <CastStudio desk />;
}
