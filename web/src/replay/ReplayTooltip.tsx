/** The one tooltip over the stage. Positioned above-right of the pointer
 *  and flipped when it would leave the stage. */
export function ReplayTooltip(
  { text, x, y, stageW, stageH }: { text: string | null; x: number; y: number; stageW: number; stageH: number },
) {
  if (!text) return null;
  const flipX = x > stageW - 180;
  const flipY = y < 40;
  // Clamped into the stage after the flip is chosen, not instead of it: the
  // flip picks which side of the anchor the tip grows from, and the clamp
  // only stops that anchor itself from sitting off either edge of a narrow
  // or heavily panned stage.
  const rawLeft = flipX ? x - 12 : x + 12;
  const left = Math.max(4, Math.min(rawLeft, stageW - 4));
  const style = {
    left: `${left}px`,
    top: `${flipY ? y + 14 : y - 10}px`,
    transform: `translate(${flipX ? '-100%' : '0'}, ${flipY ? '0' : '-100%'})`,
    maxWidth: `min(260px, ${stageW - 8}px)`,
  };
  return <div class="replay__tip" role="tooltip" style={style}>{text}</div>;
}
