import { describe, it, expect } from 'vitest';
import { staffRoleIdsOf, validateSetting } from '../src/settingsSchema.js';

describe('staff and caster roles (discord_staff_role_id)', () => {
  it('takes one or several role ids, tidied to "a, b"', () => {
    expect(validateSetting('discord_staff_role_id', '1539967662388551791')).toEqual({ ok: true, value: '1539967662388551791' });
    expect(validateSetting('discord_staff_role_id', ' 1539967662388551791,1441967662388551792  1539967662388551791 '))
      .toEqual({ ok: true, value: '1539967662388551791, 1441967662388551792' });
    expect(validateSetting('discord_staff_role_id', '')).toEqual({ ok: true, value: '' });
  });
  it('refuses a role name or a mention', () => {
    expect(validateSetting('discord_staff_role_id', 'Riverside Caster').ok).toBe(false);
    expect(validateSetting('discord_staff_role_id', '<@&1539967662388551791>').ok).toBe(false);
  });
  it('reads a stored value as a list', () => {
    expect(staffRoleIdsOf('1539967662388551791, 1441967662388551792')).toEqual(['1539967662388551791', '1441967662388551792']);
    expect(staffRoleIdsOf('')).toEqual([]);
    expect(staffRoleIdsOf(null)).toEqual([]);
  });
});
