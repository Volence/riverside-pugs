/** The one tooltip over the stage. Positioned above-right of the pointer
 *  and flipped when it would leave the stage. */
export function ReplayTooltip(
  { text, x, y, stageW, stageH }: { text: string | null; x: number; y: number; stageW: number; stageH: number },
) {
  if (!text) return null;
  const flipX = x > stageW - 180;
  const flipY = y < 40;
  const style = {
    left: `${flipX ? x - 12 : x + 12}px`,
    top: `${flipY ? y + 14 : y - 10}px`,
    transform: `translate(${flipX ? '-100%' : '0'}, ${flipY ? '0' : '-100%'})`,
  };
  return <div class="replay__tip" role="tooltip" style={style}>{text}</div>;
}
