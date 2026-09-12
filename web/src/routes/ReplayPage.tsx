import { Viewer } from '../replay/Viewer';

export function ReplayPage({ name }: { name: string }) {
  return (
    <div class="page">
      <div class="page__head"><h2>Replay</h2></div>
      <Viewer spec={{ kind: 'file', name: decodeURIComponent(name) }} />
    </div>
  );
}
