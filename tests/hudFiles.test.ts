import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import {
  HUD_CAPS, hudPathProblem, hudFileProblem, hudSetProblem, shareableHudFiles, hudId, pngSize,
} from '../src/hudFiles.js';

const BASE = join(import.meta.dirname, '..', 'web', 'src', 'hud', 'base');

/** Every file under one of the editor's bases, keyed by its path inside the addon. */
function loadBase(name: 'stock' | 'modern'): Map<string, Uint8Array> {
  const root = join(BASE, name);
  const out = new Map<string, Uint8Array>();
  const walk = (dir: string) => {
    for (const e of readdirSync(dir)) {
      const full = join(dir, e);
      if (statSync(full).isDirectory()) walk(full);
      else out.set(relative(root, full).split('\\').join('/'), new Uint8Array(readFileSync(full)));
    }
  };
  walk(root);
  return out;
}

const text = (s: string) => new TextEncoder().encode(s);
const bytes = (...b: number[]) => new Uint8Array(b);
const sized = (n: number, head: Uint8Array = new Uint8Array(0)) => {
  const b = new Uint8Array(n);
  b.set(head);
  return b;
};

/** A VTF header with the given size; the rest of the header is zeros. */
function vtf(w: number, h: number, magic = 'VTF\0'): Uint8Array {
  const b = new Uint8Array(80);
  b.set(text(magic));
  new DataView(b.buffer).setUint16(16, w, true);
  new DataView(b.buffer).setUint16(18, h, true);
  return b;
}

describe('the editor bases', () => {
  for (const name of ['stock', 'modern'] as const) {
    it(`allows every ${name} base file`, () => {
      const files = loadBase(name);
      expect(files.size).toBeGreaterThan(10);
      for (const [path, data] of files) {
        expect(hudPathProblem(path), path).toBeNull();
        expect(hudFileProblem(path, data), path).toBeNull();
      }
    });
  }

  it('allows the whole stock set', () => {
    expect(hudSetProblem(loadBase('stock'))).toBeNull();
  });
});

describe('hudPathProblem', () => {
  const refused = [
    'cfg/autoexec.cfg',
    'addoninfo.txt',
    'gameinfo.txt',
    'sound/ui/x.wav',
    'models/x.mdl',
    'scripts/weapon_rifle.txt',
    'resource/gamemenu.res',
    'resource/english.txt',
    'resource/ui/optionssubkeyboard.res',
    'resource/ui/spectatorgui.res',
    'materials/models/x.vtf',
    'materials/vgui/x.vpk',
    'resource/../cfg/a.cfg',
    'Resource/ClientScheme.res',
    'resource/ui/hud/.res',
    'resource/fonts/my font.ttf',
    'resource//ui/hud/a.res',
    './scripts/hudlayout.res',
  ];
  for (const path of refused) {
    it(`refuses ${JSON.stringify(path)}`, () => {
      const problem = hudPathProblem(path);
      expect(problem).not.toBeNull();
      expect(problem).toContain(path);
    });
  }

  const allowed = [
    'scripts/hudlayout.res',
    'scripts/hudanimations.txt',
    'scripts/hud_textures.txt',
    'scripts/mod_textures.txt',
    'resource/clientscheme.res',
    'resource/chatscheme.res',
    'resource/ui/basechat.res',
    'resource/ui/zombiepanel.res',
    'resource/ui/spectatorinfected.res',
    'resource/ui/hud/sub/panel.res',
    'resource/fonts/myfont.ttf',
    'resource/font.otf',
    'resource/a/b/c.vfont',
    'materials/vgui/hud/hudeditor/clear.vtf',
    'materials/vgui/hud/altcrosshair.vmt',
  ];
  for (const path of allowed) {
    it(`allows ${path}`, () => expect(hudPathProblem(path)).toBeNull());
  }
});

describe('hudFileProblem', () => {
  const ok = (path: string, data: Uint8Array) => expect(hudFileProblem(path, data)).toBeNull();
  const bad = (path: string, data: Uint8Array) => {
    const p = hudFileProblem(path, data);
    expect(p).not.toBeNull();
    expect(p).toContain(path);
  };

  it('runs the path rule first', () => bad('cfg/autoexec.cfg', text('bind w kill')));

  // Byte for byte, not UTF-8: the game reads single bytes.
  const latin1 = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0));

  it('does not take a non-breaking space for whitespace before a comment marker', () =>
    bad('resource/ui/scoreboard.res', latin1('"A"\n{\n  "labelText" "hi" \xa0// "command" "engine bind mouse1 quit"\n}\n')));

  it('refuses a byte above 0x7f outside a quoted string or a comment', () =>
    bad('resource/ui/hud/a.res', latin1('"A"\n{\n  "x" caf\xe9\n}\n')));

  it('allows a byte above 0x7f inside a quoted string or a comment', () =>
    ok('resource/ui/hud/a.res', latin1('"A" // caf\xe9\n{\n  "x" "caf\xe9"\n}\n')));

  it('reads a form feed as whitespace before a comment marker, as the game does', () =>
    ok('resource/ui/hud/a.res', latin1('"A"\n{\n  "labelText" \f// "command" "engine quit"\n}\n')));

  it('refuses a NUL byte in a text file', () => bad('resource/ui/hud/a.res', bytes(0x22, 0x61, 0x22, 0, 0x7b)));

  it('refuses a quoted engine command', () =>
    bad('resource/ui/hud/a.res', text('"A"\n{\n  "command" "engine bind w kill"\n}\n')));

  it('refuses a bare engine command', () =>
    bad('resource/ui/hud/a.res', text('A\n{\n  command engine quit\n}\n')));

  it('refuses an engine command whatever its case', () =>
    bad('resource/clientscheme.res', text('"x" "  ENGINE quit"\n')));

  it('ignores engine inside a comment', () =>
    ok('resource/ui/hud/a.res', text('"A" // engine quit\n{\n  "x" "1" // "engine bind"\n}\n')));

  it('does not mistake a word that starts with engine', () =>
    ok('resource/ui/hud/a.res', text('"A"\n{\n  "fieldName" "engineer"\n  "x" "engine"\n}\n')));

  it('refuses FireCommand in hudanimations.txt', () =>
    bad('scripts/hudanimations.txt', text('event Foo\n{\n  FireCommand 0.0 "x"\n}\n')));

  it('refuses PlaySound in hudanimations.txt', () =>
    bad('scripts/hudanimations.txt', text('event Foo\n{\n  PlaySound 0 "x.wav"\n}\n')));

  it('refuses a command hidden after another on the same line', () =>
    bad('scripts/hudanimations.txt', text('event Foo\n{\n  Animate a Alpha 0 Linear 0 0 FireCommand 0 "x"\n}\n')));

  it('refuses a command on the same line as a brace', () =>
    bad('scripts/hudanimations.txt', text('event Foo { SetInputEnabled a 1 0 }\n')));

  it('allows RunEvent, SetVisible and comments in hudanimations.txt', () =>
    ok('scripts/hudanimations.txt', text([
      '// a comment',
      'event Foo',
      '{',
      '  RunEvent Bar 0.0 // run it',
      '  SetVisible Panel 1 0.5',
      '  Animate Panel Alpha "255" Linear 0.0 0.2',
      '}',
      '',
    ].join('\n'))));

  it('refuses a comment marker inside a bare word that hides a later value', () =>
    bad('resource/ui/hud/a.res', text('"A"\n{\n  "k" v//x "command" "engine quit"\n}\n')));

  it('allows a comment marker inside a bare word when nothing after it is refused', () =>
    ok('resource/ui/hud/a.res', text('"A"\n{\n  "image" hud//x\n}\n')));

  it('refuses a quoted string that is not closed on its line', () => {
    bad('resource/ui/hud/a.res', text('"A"\n{\n  "k" "one\n// " "command" "x"\n}\n'));
    // Closed only when a backslash is read literally: the escaped reading runs off the line.
    bad('resource/ui/hud/a.res', text('"A"\n{\n  "k" "C:\\"\n}\n'));
    bad('scripts/hudanimations.txt', text('event Foo\n{\n  Animate a Alpha "255\n" Linear 0 0\n}\n'));
  });

  it('refuses a denied animation command hidden behind a mid-word comment marker', () =>
    bad('scripts/hudanimations.txt', text('event Foo\n{\n  StopEvent X//y 0 FireCommand 0 "x"\n}\n')));

  it('refuses a denied animation command inside a quoted string or a longer word', () => {
    bad('scripts/hudanimations.txt', text('event Foo\n{\n  StopEvent "xplaysoundx" 0\n}\n'));
    bad('scripts/hudanimations.txt', text('event Foo\n{\n  StopEvent X"a SETINPUTENABLED 0 b" 0\n}\n'));
  });

  it('refuses a break character glued to a denied command', () => {
    bad('scripts/hudanimations.txt', text('event Foo\n{\n  StopEvent X:FireCommand 0 "x"\n}\n'));
    for (const c of ['(', ')', "'", ':']) {
      bad('scripts/hudanimations.txt', text(`event Foo\n{\n  StopEvent X${c}Y 0\n}\n`));
    }
    // The game's signed char reads a byte above 0x7f as whitespace.
    bad('scripts/hudanimations.txt', bytes(...text('event Foo\n{\n  StopEvent X'), 0xa0, ...text('Y 0\n}\n')));
  });

  it('allows break characters inside a comment in hudanimations.txt', () =>
    ok('scripts/hudanimations.txt', text("// Pulse: (freq) it's\nevent Foo // a: (b)\n{\n  StopEvent X 0 // c'd\n}\n")));

  it('refuses a second, unknown command on one line', () => {
    bad('scripts/hudanimations.txt', text('event Foo\n{\n  StopEvent X 0 SomeOtherCommand 0\n}\n'));
    bad('scripts/hudanimations.txt', text('event Foo\n{\n  Animate P Alpha "0" Pulse 3 0 1 Other 0\n}\n'));
    bad('scripts/hudanimations.txt', text('event Foo\n{\n  Animate P Alpha "0" Linear 0 1 X\n}\n'));
  });

  it('reads commands by their argument counts across lines', () =>
    ok('scripts/hudanimations.txt', text([
      'event Foo { Animate P Alpha "0" Pulse 3 0 1 Animate P Alpha "9" Flicker 0.5 0 1',
      '  StopAnimation P Alpha 0 StopPanelAnimations P 0',
      '  RunEvent Bar 0 StopEvent Bar',
      '  0 SetFont P font "X" 0 SetTexture P t "a/b" 0 SetString P s "hi there" 0',
      '}',
      'event Bar',
      '{',
      '}',
      '',
    ].join('\n'))));

  it('refuses a file that is not a run of events', () => {
    bad('scripts/hudanimations.txt', text('Foo\n{\n}\n'));
    bad('scripts/hudanimations.txt', text('event Foo\nStopEvent X 0\n'));
    bad('scripts/hudanimations.txt', text('event Foo\n{\n  StopEvent X\n'));
  });

  it('allows a TrueType font', () => ok('resource/a.ttf', sized(64, bytes(0, 1, 0, 0))));
  it('refuses a zip named .ttf', () => bad('resource/a.ttf', sized(64, text('PK\x03\x04'))));
  it('allows an OpenType font', () => ok('resource/a.otf', sized(64, text('OTTO'))));
  it('allows a vfont', () => ok('resource/a.vfont', text('abcdefVFONT1')));
  it('refuses a vfont without its trailer', () => bad('resource/a.vfont', text('abcdefVFONT')));
  it('refuses a font over 4 MB', () => bad('resource/a.ttf', sized(HUD_CAPS.font + 1, bytes(0, 1, 0, 0))));

  it('allows a 256x256 VTF', () => ok('materials/vgui/a.vtf', vtf(256, 256)));
  it('refuses a 4096x16 VTF', () => bad('materials/vgui/a.vtf', vtf(4096, 16)));
  it('refuses a 0x16 VTF', () => bad('materials/vgui/a.vtf', vtf(0, 16)));
  it('refuses a bad VTF magic', () => bad('materials/vgui/a.vtf', vtf(256, 256, 'VTX\0')));
  it('refuses a truncated VTF', () => bad('materials/vgui/a.vtf', text('VTF\0')));

  it('refuses a vmt over 16 KB', () => bad('materials/vgui/a.vmt', sized(16 * 1024 + 1).fill(0x20)));
  it('allows a vmt at 16 KB', () => ok('materials/vgui/a.vmt', sized(16 * 1024).fill(0x20)));
  it('refuses a res over 512 KB', () => bad('resource/ui/hud/a.res', sized(512 * 1024 + 1).fill(0x20)));
});

describe('hudSetProblem', () => {
  const layout = () => new Map([['scripts/hudlayout.res', text('"Resource/HudLayout.res"\n{\n}\n')]]);

  it('needs scripts/hudlayout.res', () => {
    const files = new Map([['resource/clientscheme.res', text('x')]]);
    expect(hudSetProblem(files)).toMatch(/hudlayout\.res/);
  });

  it('refuses a set holding a refused file', () => {
    const files = layout();
    files.set('cfg/autoexec.cfg', text('x'));
    expect(hudSetProblem(files)).toContain('cfg/autoexec.cfg');
  });

  it('refuses 401 files', () => {
    const files = layout();
    for (let i = 0; i < 400; i++) files.set(`resource/ui/hud/p${i}.res`, text('x'));
    expect(files.size).toBe(401);
    expect(hudSetProblem(files)).toMatch(/400/);
    files.delete('resource/ui/hud/p0.res');
    expect(hudSetProblem(files)).toBeNull();
  });

  it('refuses 20 MB + 1 in total', () => {
    const files = new Map([['scripts/hudlayout.res', text('x')]]);
    for (let i = 0; i < 5; i++) files.set(`resource/f${i}.ttf`, sized(HUD_CAPS.font, bytes(0, 1, 0, 0)));
    expect(hudSetProblem(files)).toMatch(/20 MB/);
    files.set('scripts/hudlayout.res', new Uint8Array(0));
    expect(hudSetProblem(files)).toBeNull();
  });
});

describe('shareableHudFiles', () => {
  it('keeps the HUD files and lists the rest, sorted, with reasons', () => {
    const stock = loadBase('stock');
    const files = new Map(stock);
    files.set('cfg/autoexec.cfg', text('bind w kill'));
    files.set('resource/x.ttf', text('nope'));
    files.set('addoninfo.txt', text('"AddonInfo" {}'));
    const { kept, left } = shareableHudFiles(files);
    expect([...kept.keys()].sort()).toEqual([...stock.keys()].sort());
    expect(left).toHaveLength(3);
    expect(left.map((l) => l.split(': ')[0])).toEqual(['addoninfo.txt', 'cfg/autoexec.cfg', 'resource/x.ttf']);
    for (const l of left) expect(l.split(': ')[1]?.length).toBeGreaterThan(0);
  });
});

describe('hudId', () => {
  const a = new Map([['resource/a.res', text('hello')], ['scripts/hudlayout.res', text('B')]]);
  const b = new Map([['scripts/hudlayout.res', text('B')], ['resource/a.res', text('hello')]]);

  it('does not depend on insertion order', async () => {
    expect(await hudId(a)).toBe(await hudId(b));
  });

  it('is SHA-256 over sorted path, NUL, length, NUL, bytes', async () => {
    expect(await hudId(a)).toBe('9f1d6931241a71d2eba41b52281a611ee279823391be07c22a0bc7aa264ab0ff');
  });
});

describe('pngSize', () => {
  /** The smallest real PNG: signature, a 1x1 IHDR, an IDAT and an IEND (CRCs are not checked). */
  const png1x1 = bytes(
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 0x1f, 0x15, 0xc4, 0x89,
    0, 0, 0, 13, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0, 1, 0, 0, 5, 0, 1, 0x0d, 0x0a, 0x2d, 0xb4,
    0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
  );

  it('reads a 1x1 PNG', () => expect(pngSize(png1x1)).toEqual({ w: 1, h: 1 }));
  it('refuses garbage', () => expect(pngSize(text('not a png at all, not at all'))).toBeNull());
  it('refuses a signature with no IHDR', () => {
    const b = png1x1.slice();
    b.set(text('IDAT'), 12);
    expect(pngSize(b)).toBeNull();
    expect(pngSize(png1x1.slice(0, 8))).toBeNull();
  });
});
