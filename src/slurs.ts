/**
 * The slur check behind the admin channel's conduct alerts.
 *
 * Deliberately narrow: the owner chose "slurs only" on 2026-09-23. Insults,
 * swearing and "gay" used as an insult are NOT here, because in the chat
 * history they are mostly banter between friends and would bury the channel.
 * A false positive costs an admin a glance and a false negative costs a
 * report, so each pattern is written against the real lines in the history
 * scan and against the ordinary words that share its letters (see the test).
 *
 * Matching is per word, never across words, so "I can get u" is never read as
 * one run of letters. Two things are done to each word first:
 *   - lowercase, accents stripped, and the usual stand-ins mapped back
 *     (1 ! | to i, 3 to e, 0 to o, 4 @ to a, $ 5 to s, 7 to t, 6 9 q to g);
 *   - vowels stretched to any length count as one and consonants as at most
 *     two, so "niiiigggga" reads as "nigga" while "nigger" and "Niger" stay
 *     different words.
 * Letters spelled out one at a time ("n i g g a", "n.i.g.g.e.r") are joined
 * back into a word before the check.
 *
 * "negro" is NOT a slur here: it is the ordinary Spanish word for black.
 */

export type SlurKind = 'n-word' | 'f-slur' | 'r-word' | 'ethnic slur' | 'homophobic slur' | 'transphobic slur' | 'kys';

const PATTERNS: [SlurKind, RegExp][] = [
  // The -er ending needs the double g: "niger" is a country and a river.
  ['n-word', /^(?:nig|nigg)(?:a|ah|as|az|uh|s)?$|^nigger(?:s|z)?$|^niga|^nigga|^nigger|^nga(?:s|z)?$|^nibba(?:s)?$/],
  ['f-slur', /^fagg?(?:s|ot|ots|er|ers|y|git|gits)?$|^fagg?ot/],
  ['r-word', /^re?tard(?:s|ed|o|os)?$/],
  ['ethnic slur', /^(?:chink|spic|spick|kike|gok|wetback|beaner|sudaca)s?$/],
  ['homophobic slur', /^(?:maricon|maricones|viado|viados)$/],
  ['transphobic slur', /^tran{1,2}(?:y|ys|ies)$/],
  ['kys', /^kys$/],
];

const LEET: Record<string, string> = {
  '1': 'i', '!': 'i', '|': 'i', '3': 'e', '0': 'o', '4': 'a', '@': 'a',
  '$': 's', '5': 's', '7': 't', '6': 'g', '9': 'g', q: 'g',
};

/** Lowercase, strip accents, map the stand-ins. Characters that are not
 *  letters after that become separators. */
function letters(text: string): string {
  const base = text.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();
  let out = '';
  for (const ch of base) out += LEET[ch] ?? (/[a-z]/.test(ch) ? ch : ' ');
  return out;
}

/** Vowels to one, consonants to at most two. */
function squeeze(word: string): string {
  return word
    .replace(/([aeiouy])\1+/g, '$1')
    .replace(/([^aeiouy])\1{2,}/g, '$1$1');
}

/** The words to test: every word as written, plus each run of three or more
 *  single letters joined back together. */
function words(text: string): string[] {
  const parts = letters(text).split(/\s+/).filter(Boolean);
  const out: string[] = [];
  let run = '';
  for (const p of parts) {
    if (p.length === 1) { run += p; continue; }
    if (run.length >= 3) out.push(run);
    run = '';
    out.push(p);
  }
  if (run.length >= 3) out.push(run);
  return out.map(squeeze);
}

const KILL_YOURSELF = /\bkil+ (?:your|ur|yo) ?self\b/;

/** The distinct kinds of slur in a line of chat or a name, in the order
 *  found. Empty when there is none. */
export function findSlurs(text: string): SlurKind[] {
  const found: SlurKind[] = [];
  const add = (k: SlurKind) => { if (!found.includes(k)) found.push(k); };
  for (const w of words(text)) {
    for (const [kind, re] of PATTERNS) if (re.test(w)) add(kind);
  }
  if (KILL_YOURSELF.test(letters(text).replace(/\s+/g, ' '))) add('kys');
  return found;
}
