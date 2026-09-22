// @vitest-environment node
//
// Not a real test: a hook scripts/check-hud-vpk.sh uses to get a real VPK out
// of the real generator, for the Python vpk reader to check independently of
// vitest. It matches web/**/*.test.ts, so plain `npm test` runs it too; the
// guard below makes that a no-op rather than a stray file write.
import { it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { packHud } from './build';
import { validateDesign } from './design';

it('writes a sample VPK for the Python reader', () => {
  if (!process.env.HUD_VPK_OUT) return;
  const d = validateDesign({ v: 1, preset: 'stock', elements: { ownHealth: { x: 8, y: 400 }, teamColumn: { scale: 1.25, dir: 'column', spacing: 36 } },
    styles: { panelBg: { kind: 'rounded', color: '0 0 0 150' } } });
  writeFileSync(process.env.HUD_VPK_OUT, packHud(d).bytes);
});
