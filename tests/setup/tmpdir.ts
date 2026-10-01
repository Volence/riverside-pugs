// Every test run gets its own temp folder, removed when the run ends. Many server tests create
// temp dirs and sqlite files with mkdtemp(tmpdir()) and never remove them; on 2026-10-01 they were
// leaving about 10,000 folders a day in /tmp, which is a tmpfs with a fixed inode count (it ran
// out on 2026-09-30).
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export default function setup(): () => void {
  const dir = mkdtempSync(join(tmpdir(), 'pug-tests-'));
  process.env.TMPDIR = dir; // worker processes inherit it, so os.tmpdir() points here
  return () => { rmSync(dir, { recursive: true, force: true }); };
}
