/**
 * Valve KeyValues, as far as HUD .res files use it.
 *
 * The generator never writes a HUD file from scratch. It parses the real file,
 * changes a handful of values and writes the tree back, so everything the
 * editor does not understand reaches the game exactly as the base HUD had it.
 * That only holds if nothing is lost here: key order and duplicate keys are
 * kept (both occur in stock files and the game reads them positionally), and
 * platform conditionals like [$X360] ride along on the node they follow.
 * Comments are dropped; the game ignores them.
 */
export interface KvNode { key: string; value: string | KvNode[]; cond?: string }

type Tok = { t: 'str' | 'cond' | '{' | '}'; v: string; line: number };

function lex(text: string): Tok[] {
  const out: Tok[] = [];
  let i = 0, line = 1;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (c === '\n') { line++; i++; continue; }
    // The game's whitespace (C isspace), as src/hudFiles.ts reads it: a \f or \v
    // read as part of a word would turn `\f// "k" "v"` from a comment into keys.
    if (c === ' ' || c === '\t' || c === '\r' || c === '\f' || c === '\v') { i++; continue; }
    if (c === '/' && text[i + 1] === '/') { while (i < n && text[i] !== '\n') i++; continue; }
    if (c === '{' || c === '}') { out.push({ t: c, v: c, line }); i++; continue; }
    if (c === '"') {
      let j = i + 1;
      while (j < n && text[j] !== '"') { if (text[j] === '\n') line++; j++; }
      out.push({ t: 'str', v: text.slice(i + 1, j), line });
      i = j + 1; continue;
    }
    if (c === '[') {
      let j = i;
      while (j < n && text[j] !== ']' && text[j] !== '\n') j++;
      out.push({ t: 'cond', v: text.slice(i, j + 1), line });
      i = j + 1; continue;
    }
    let j = i;
    while (j < n && !' \t\r\n\f\v{}"'.includes(text[j])) j++;
    out.push({ t: 'str', v: text.slice(i, j), line });
    i = j;
  }
  return out;
}

export function parseKv(text: string): KvNode[] {
  const toks = lex(text);
  let p = 0;
  const fail = (why: string, line: number): never => { throw new Error(`KeyValues: ${why} at line ${line}`); };

  function block(depth: number): KvNode[] {
    const nodes: KvNode[] = [];
    for (;;) {
      const k = toks[p];
      if (!k) { if (depth > 0) fail('unclosed block', toks[toks.length - 1]?.line ?? 1); return nodes; }
      if (k.t === '}') { if (depth === 0) fail('stray }', k.line); p++; return nodes; }
      if (k.t !== 'str') fail(`expected a key, found ${k.v}`, k.line);
      p++;
      const node: KvNode = { key: k.v, value: '' };
      let next = toks[p];
      if (next?.t === 'cond' && toks[p + 1]?.t === '{') { node.cond = next.v; p++; next = toks[p]; }
      if (!next) fail(`key ${k.v} has no value`, k.line);
      if (next.t === '{') { p++; node.value = block(depth + 1); }
      else if (next.t === 'str') {
        p++; node.value = next.v;
        if (toks[p]?.t === 'cond') { node.cond = toks[p].v; p++; }
      } else fail(`key ${k.v} has no value`, k.line);
      nodes.push(node);
    }
  }
  return block(0);
}

export function writeKv(nodes: KvNode[], depth = 0): string {
  const pad = '\t'.repeat(depth);
  let out = '';
  for (const n of nodes) {
    const cond = n.cond ? ` ${n.cond}` : '';
    if (typeof n.value === 'string') out += `${pad}"${n.key}"\t\t"${n.value}"${cond}\r\n`;
    else out += `${pad}"${n.key}"${cond}\r\n${pad}{\r\n${writeKv(n.value, depth + 1)}${pad}}\r\n`;
  }
  return out;
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export function kvFind(nodes: KvNode[], path: string[]): KvNode | undefined {
  let level = nodes;
  let hit: KvNode | undefined;
  for (const part of path) {
    hit = level.find((n) => same(n.key, part));
    if (!hit) return undefined;
    level = typeof hit.value === 'string' ? [] : hit.value;
  }
  return hit;
}

/**
 * The symbols a conditional can name that hold on the game the editor
 * targets: L4D1 on Windows (it runs under Proton on Linux, still the Windows
 * build), in English. Everything else ($X360, $OSX, $LINUX, $POSIX) is false.
 */
const PC_SYMBOLS = new Set(['WIN32', 'WINDOWS', 'ENGLISH']);

/**
 * Whether the PC game keeps a line with this conditional. Base files carry
 * one value per platform side by side, e.g. localplayerpanel.res's health
 * number has "xpos" "39" [$OSX] then "xpos" "36" [$WINDOWS]; the game drops
 * the lines whose conditional is false before anything reads the panel, so
 * the editor must read and write the one that is left, or the preview shows
 * the Mac value and an edit lands on a line the game never sees.
 *
 * A term is $NAME or !$NAME; terms join with && or ||, && binding tighter.
 * Valve's own files also write [$!ENGLISH]: the engine reads that as the
 * unknown symbol "!ENGLISH", which is false, so it is false here too.
 */
export function pcApplies(cond: string | undefined): boolean {
  if (!cond) return true;
  const body = cond.trim().replace(/^\[|\]$/g, '');
  return body.split('||').some((any) => any.split('&&').every((term) => {
    const t = term.trim();
    const not = t.startsWith('!');
    const name = (not ? t.slice(1) : t).trim().replace(/^\$/, '').toUpperCase();
    return PC_SYMBOLS.has(name) !== not;
  }));
}

/**
 * kvFind as the PC game sees the file: at every level, a node whose
 * conditional fails on PC is skipped. scoreboard.res has BackgroundImage
 * [$X360] (400 wide) before BackgroundImage [$WIN32] (340 wide); kvFind
 * returns the console block, this the one the game draws. kvFind itself is
 * left as it is: switching every caller is its own change, which the golden
 * downloads would have to prove harmless (tab screen spec 4.4).
 */
export function pcFind(nodes: KvNode[], path: string[]): KvNode | undefined {
  let level = nodes;
  let hit: KvNode | undefined;
  for (const part of path) {
    hit = level.find((n) => same(n.key, part) && pcApplies(n.cond));
    if (!hit) return undefined;
    level = typeof hit.value === 'string' ? [] : hit.value;
  }
  return hit;
}

/** The blocks at this level the PC game keeps, in file order: no console-only block, no value line. */
export function pcBlocks(nodes: KvNode[]): KvNode[] {
  return nodes.filter((n) => typeof n.value !== 'string' && pcApplies(n.cond));
}

/** A value line the PC game reads: a string, under a conditional that holds there. */
const pcLine = (c: KvNode, key: string) => same(c.key, key) && typeof c.value === 'string' && pcApplies(c.cond);

export function kvGet(block: KvNode, key: string): string | undefined {
  if (typeof block.value === 'string') return undefined;
  const n = block.value.find((c) => pcLine(c, key));
  return n ? (n.value as string) : undefined;
}

export function kvSet(block: KvNode, key: string, value: string): void {
  if (typeof block.value === 'string') throw new Error(`KeyValues: ${block.key} is not a block`);
  const n = block.value.find((c) => pcLine(c, key));
  if (n) n.value = value; else block.value.push({ key, value });
}
