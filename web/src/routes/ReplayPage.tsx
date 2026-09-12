import { PageHeader } from '../components/PageHeader';
import { Viewer } from '../replay/Viewer';

export function ReplayPage({ name }: { name: string }) {
  const file = decodeURIComponent(name);
  return (
    <div class="page page--match">
      <PageHeader eyebrow={file} title="Replay" />
      <Viewer spec={{ kind: 'file', name: file }} />
    </div>
  );
}
