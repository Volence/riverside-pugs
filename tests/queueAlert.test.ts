import { describe, it, expect } from 'vitest';
import { openDb } from '../src/db.js';
import { setSetting } from '../src/settings.js';
import { validateSetting } from '../src/settingsSchema.js';
import { decideAlert, queueAlertConfig, type AlertInput } from '../src/discord/queueAlert.js';
import { renderQueueAlert, renderQueueAlertClosed } from '../src/discord/presenter.js';

const MIN = 60 * 1000;
const base: AlertInput = { count: 0, popping: false, threshold: 6, cooldownMs: 45 * MIN, now: 100 * MIN, lastAt: null, open: null };
const decide = (v: Partial<AlertInput>) => decideAlert({ ...base, ...v });

describe('decideAlert', () => {
  it('posts at the threshold and above, never below', () => {
    expect(decide({ count: 5 }).kind).toBe('none');
    expect(decide({ count: 6 }).kind).toBe('post');
    expect(decide({ count: 7 }).kind).toBe('post');
  });

  it('waits out the cooldown from the last alert', () => {
    expect(decide({ count: 6, lastAt: 100 * MIN - 44 * MIN }).kind).toBe('none');
    expect(decide({ count: 6, lastAt: 100 * MIN - 45 * MIN }).kind).toBe('post');
  });

  it('never posts during a pop', () => {
    expect(decide({ count: 7, popping: true }).kind).toBe('none');
  });

  it('closes an open alert on a pop, an empty queue, or a fall of three under the threshold', () => {
    expect(decide({ count: 6, popping: true, open: { count: 7 } })).toEqual({ kind: 'close', why: 'popped' });
    expect(decide({ count: 0, open: { count: 6 } })).toEqual({ kind: 'close', why: 'emptied' });
    expect(decide({ count: 3, open: { count: 6 } })).toEqual({ kind: 'close', why: 'dropped' });
    expect(decide({ count: 4, open: { count: 6 } }).kind).toBe('update');
  });

  it('edits an open alert only when the count it shows is out of date', () => {
    expect(decide({ count: 7, open: { count: 7 } }).kind).toBe('none');
    expect(decide({ count: 7, open: { count: 6 } }).kind).toBe('update');
    // After a restart the shown count is unknown: one edit puts it right.
    expect(decide({ count: 7, open: { count: null } }).kind).toBe('update');
  });

  it('never posts a second alert while one is open, whatever the cooldown says', () => {
    expect(decide({ count: 7, open: { count: 6 }, lastAt: 0 }).kind).toBe('update');
  });
});

describe('queueAlertConfig', () => {
  it('is off without a role id, and reads the defaults', () => {
    const db = openDb(':memory:');
    expect(queueAlertConfig(db, 'q')).toBeNull();
    setSetting(db, 'discord_pug_role_id', '555000000000000001');
    expect(queueAlertConfig(db, 'q')).toEqual({ roleId: '555000000000000001', threshold: 6, cooldownMs: 45 * MIN, channelId: 'q' });
    setSetting(db, 'discord_queue_alert_channel_id', '555000000000000099');
    expect(queueAlertConfig(db, 'q')!.channelId).toBe('555000000000000099');
  });
});

describe('queue alert settings', () => {
  it('accept only Discord ids for the role and the channel', () => {
    expect(validateSetting('discord_pug_role_id', '@Queue Alerts').ok).toBe(false);
    expect(validateSetting('discord_pug_role_id', '555000000000000001').ok).toBe(true);
    expect(validateSetting('discord_pug_role_id', '').ok).toBe(true);
    expect(validateSetting('discord_queue_alert_channel_id', '#queue').ok).toBe(false);
    expect(validateSetting('discord_queue_alert_channel_id', '555000000000000099').ok).toBe(true);
  });

  it('bound the threshold below a full queue', () => {
    expect(validateSetting('queue_alert_threshold', 8).ok).toBe(false);
    expect(validateSetting('queue_alert_threshold', 6).ok).toBe(true);
    expect(validateSetting('queue_alert_cooldown_minutes', 45).ok).toBe(true);
  });
});

describe('queue alert text', () => {
  it('says how many are in and how many are needed', () => {
    const r = (count: number) => renderQueueAlert({ count, size: 8, roleId: '1', publicUrl: 'https://pug.test' }).content;
    expect(r(6)).toContain('**6/8** in the PUG queue, 2 more needed.');
    expect(r(7)).toContain('one more and it pops');
    // A held pop (a duo that does not fit) still needs one, never "0 more".
    expect(r(9)).toContain('one more and it pops');
  });

  it('closes with no ping, no role tag and no buttons', () => {
    for (const why of ['popped', 'emptied', 'dropped'] as const) {
      const p = renderQueueAlertClosed({ why, count: 3, size: 8 });
      expect(p.mentionRoleIds).toEqual([]);
      expect(p.components).toEqual([]);
      expect(p.content).not.toContain('<@&');
    }
    expect(renderQueueAlertClosed({ why: 'dropped', count: 3, size: 8 }).content).toContain('3/8');
  });
});
