import { describe, it, expect } from 'vitest';
import { redactSecrets, REDACTED } from '../src/redact.js';
import { serverPasswordFor } from '../src/matchToken.js';

const TOKEN = '0123456789abcdef0123456789abcdef';

describe('redactSecrets', () => {
  it('takes the secret out of the message an rcon timeout carries', () => {
    const msg = `rcon exec timeout: sm_pug_leave ${TOKEN} 76561199000000001 hold`;
    expect(redactSecrets(msg, [TOKEN])).toBe(`rcon exec timeout: sm_pug_leave ${REDACTED} 76561199000000001 hold`);
  });

  it('takes out the sv_password the token derives too, which is the same secret spelled differently', () => {
    const msg = `rcon exec timeout: sv_password "${serverPasswordFor(TOKEN)}"`;
    expect(redactSecrets(msg, [TOKEN])).toBe(`rcon exec timeout: sv_password "${REDACTED}"`);
  });

  it('handles every occurrence, several secrets, and a console that shouted it back', () => {
    const other = 'f'.repeat(32);
    const msg = `${TOKEN} ${TOKEN.toUpperCase()} ${other}`;
    expect(redactSecrets(msg, [TOKEN, other])).toBe(`${REDACTED} ${REDACTED} ${REDACTED}`);
  });

  it('leaves the rest alone, and survives a missing secret', () => {
    expect(redactSecrets('connect ECONNREFUSED 1.2.3.4:27015', [null, undefined, ''])).toBe(
      'connect ECONNREFUSED 1.2.3.4:27015',
    );
  });
});
