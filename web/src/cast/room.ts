import type { MatchRoomView } from '../api';
import type { OverlayFeed } from '../../../src/cast/types';

/** The tournament room on a studio feed (src/cast/room.ts castRoom). The
 *  shared types file keeps no server imports, so the room is typed here,
 *  by the web's own copy of the room view. */
export function castRoomOf(feed: OverlayFeed | null | undefined): MatchRoomView | null {
  return (feed?.room as MatchRoomView | null | undefined) ?? null;
}
