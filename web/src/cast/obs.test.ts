import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { obsAuth } from './obs';

describe('obs-websocket auth', () => {
  it('answers base64(sha256(base64(sha256(password + salt)) + challenge))', async () => {
    const b64 = (s: string) => createHash('sha256').update(s).digest('base64');
    expect(await obsAuth('pw', 'salty', 'chal')).toBe(b64(b64('pwsalty') + 'chal'));
  });
});
