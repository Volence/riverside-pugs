import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { upsertPlayer, linkDiscord } from '../src/players.js';
import { addAlias } from '../src/aliases.js';
import {
  identityOf, discordLabel, plainLabel, plainLabelEscaped, escapeName,
} from '../src/identity.js';

let db: DB;
const P1 = '76561198000000001';
const P2 = '76561198000000002';
const ALT = '76561198000000099';

beforeEach(() => {
  db = openDb(':memory:');
  upsertPlayer(db, { steamid: P1, name: 'mira', avatar: null }, []);
  upsertPlayer(db, { steamid: P2, name: 'js', avatar: null }, []);
});

describe('identityOf', () => {
  it('a linked player carries both names', () => {
    linkDiscord(db, P1, '111', 'br1');
    const id = identityOf(db, P1);
    expect(id).toEqual({ steamid: P1, steamName: 'mira', discordId: '111', discordName: 'br1' });
  });

  it('an unlinked player has no discord id or name', () => {
    const id = identityOf(db, P2);
    expect(id).toEqual({ steamid: P2, steamName: 'js', discordId: null, discordName: null });
  });

  it('a steamid with no player row falls back to the raw id as its name', () => {
    const stranger = '76561198005192651';
    const id = identityOf(db, stranger);
    expect(id).toEqual({ steamid: stranger, steamName: stranger, discordId: null, discordName: null });
  });

  it('resolves an alias to its canonical account first', () => {
    linkDiscord(db, P1, '111', 'br1');
    addAlias(db, { steamid: ALT, canonical: P1, by: 'test' });
    expect(identityOf(db, ALT)).toEqual(identityOf(db, P1));
  });
});

describe('discordLabel', () => {
  it('bolds the steam name and mentions when linked', () => {
    const id = identityOf(db, P1);
    linkDiscord(db, P1, '111', 'br1');
    expect(discordLabel(identityOf(db, P1))).toBe('**mira** (<@111>)');
    expect(id).toBeTruthy(); // silence unused warning in strict mode if any
  });

  it('says no discord linked when unlinked', () => {
    expect(discordLabel(identityOf(db, P2))).toBe('**js** (no Discord linked)');
  });

  it('escapes markdown-hostile steam names', () => {
    upsertPlayer(db, { steamid: P1, name: '[x](http://evil)', avatar: null }, []);
    expect(discordLabel(identityOf(db, P1))).toBe('**\\[x\\]\\(http://evil\\)** (no Discord linked)');
  });

  it('escapes bold markers in a steam name', () => {
    upsertPlayer(db, { steamid: P1, name: '**bold**', avatar: null }, []);
    expect(discordLabel(identityOf(db, P1))).toBe('**\\*\\*bold\\*\\*** (no Discord linked)');
  });
});

describe('plainLabel', () => {
  it('shows just the steam name when there is no discord link', () => {
    expect(plainLabel(identityOf(db, P2))).toBe('js');
  });

  it('shows just the steam name when the discord name is the same, ignoring case', () => {
    linkDiscord(db, P1, '111', 'MIRA');
    expect(plainLabel(identityOf(db, P1))).toBe('mira');
  });

  it('shows both names when they differ', () => {
    linkDiscord(db, P1, '111', 'br1');
    expect(plainLabel(identityOf(db, P1))).toBe('mira (Discord: br1)');
  });

  it('is not escaped: callers escape for their own medium', () => {
    upsertPlayer(db, { steamid: P1, name: '**bold**', avatar: null }, []);
    linkDiscord(db, P1, '111', 'br1');
    expect(plainLabel(identityOf(db, P1))).toBe('**bold** (Discord: br1)');
  });
});

describe('plainLabelEscaped', () => {
  it('escapes both names for discord', () => {
    upsertPlayer(db, { steamid: P1, name: '**bold**', avatar: null }, []);
    linkDiscord(db, P1, '111', '*b1*');
    expect(plainLabelEscaped(identityOf(db, P1))).toBe('\\*\\*bold\\*\\* (Discord: \\*b1\\*)');
  });

  it('unlinked: just the escaped steam name', () => {
    upsertPlayer(db, { steamid: P2, name: 'j*s', avatar: null }, []);
    expect(plainLabelEscaped(identityOf(db, P2))).toBe('j\\*s');
  });
});

describe('escapeName', () => {
  it('neutralises discord markdown', () => {
    expect(escapeName('b*o_b')).toBe('b\\*o\\_b');
  });

  // A Steam name is attacker-controlled text with no length or character
  // limit worth trusting. `\@` and `\<` both render literally in Discord, so
  // escaping them is free; today's only backstop is the transport sending
  // allowedMentions: { parse: [] }, and a name is shown in more places than
  // the transport touches (embed titles, button labels).
  const hostile: [string, RegExp][] = [
    ['@everyone', /@everyone/],
    ['@here', /@here/],
    ['<@123456789012345678>', /<@/],
    ['<@&123456789012345678>', /<@&|<@/],
    ['<#123456789012345678>', /<#/],
    ['`rm -rf /`', /`/],
    ['[Free Nitro](http://evil.tk)', /\]\(/],
    ['**bold**', /\*\*/],
  ];
  it.each(hostile)('escapes every unescaped occurrence in %s', (name, unescaped) => {
    const out = escapeName(name);
    // The escaped output must contain no UNESCAPED instance of the hostile
    // pattern: every character the pattern matches is preceded by a backslash.
    const stripped = out.replace(/\\(.)/g, ''); // drop every escaped char
    expect(stripped).not.toMatch(unescaped);
  });

  it('does not touch a mention discordLabel or playerLabel builds themselves', () => {
    // escapeName only ever runs on the raw name text before a caller appends
    // "<@id>" or "(<@id>)"; it must never be run on that appended mention.
    expect(discordLabel({ steamid: '1', steamName: '@everyone', discordId: '111', discordName: null }))
      .toBe('**\\@everyone** (<@111>)');
  });
});
