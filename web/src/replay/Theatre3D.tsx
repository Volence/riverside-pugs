import { useEffect, useState } from 'preact/hooks';
import { fmtBytes, mapName } from '../format';
import { loadTheatreManifest, theatreGap, theatreSrc, type TheatreManifest } from '../theatre';

/**
 * One map's SourceTV demo in the 3D viewer (docs/theatre-3d.md).
 *
 * An iframe onto the static viewer page rather than a component: the viewer is
 * a whole page of its own (its own styles, import map, render loop and keyboard
 * handling), still being built elsewhere, and kept out of the site bundle. The
 * frame isolates its globals and its key bindings from the page, and unmounting
 * it on a tab or map switch is what frees the GPU memory a map takes.
 */
export function Theatre3D(
  { matchId, ordinal, map, demoBytes }: {
    matchId: number; ordinal: number; map: string;
    /** The map's demo size, or null when no demo was recorded for it. */
    demoBytes: number | null;
  },
) {
  const [manifest, setManifest] = useState<TheatreManifest | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    void loadTheatreManifest().then((m) => { if (live) setManifest(m); });
    return () => { live = false; };
  }, []);

  if (manifest === undefined) return <div class="theatre3d theatre3d--empty">Loading the 3D viewer...</div>;
  if (manifest === null) {
    return <div class="theatre3d theatre3d--empty">The 3D viewer is not available right now. The 2D replay still works.</div>;
  }
  const gap = theatreGap(map, demoBytes !== null, manifest);
  if (gap) {
    const why = gap === 'no-demo'
      ? 'No SourceTV demo was saved for this map, so there is nothing to play in 3D.'
      : gap === 'mirror'
        ? `${mapName(map)} was played mirrored, and mirrored maps are not in 3D yet.`
        : `${mapName(map)} has not been converted to 3D yet.`;
    return <div class="theatre3d theatre3d--empty">{why} The 2D replay still works.</div>;
  }

  const src = theatreSrc({ matchId, ordinal, map });
  const total = (manifest.maps[map]?.bytes ?? 0) + (demoBytes ?? 0);
  return (
    <div class="theatre3d">
      <iframe
        class="theatre3d__frame"
        src={src}
        title={`3D replay of map ${ordinal + 1}, ${mapName(map)}`}
        allow="fullscreen; autoplay"
      />
      <p class="theatre3d__note muted">
        Both rounds of this map from the SourceTV demo, played in your browser.
        Click a player to follow them, F for first person, M for the event list.
        {total > 0 && <> Downloads about {fmtBytes(total)} for the map and the demo.</>}
        {' '}<a href={src} target="_blank" rel="noopener">Open in its own tab</a>
      </p>
    </div>
  );
}
