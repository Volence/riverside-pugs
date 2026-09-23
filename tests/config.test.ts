import { describe, it, expect } from 'vitest';
import { loadConfig, missingDirs } from '../src/config.js';
import { CAMPAIGNS } from '../src/campaigns.js';

describe('loadConfig', () => {
  it('applies defaults', () => {
    const c = loadConfig({});
    expect(c.port).toBe(8080);
    expect(c.publicUrl).toBe('http://localhost:8080');
    expect(c.devMode).toBe(false);
    expect(c.adminSteamIds).toEqual([]);
  });

  it('parses env values', () => {
    const c = loadConfig({
      PORT: '9000',
      DEV_MODE: '1',
      ADMIN_STEAMIDS: '76561198000000001,76561198000000002',
    });
    expect(c.port).toBe(9000);
    expect(c.devMode).toBe(true);
    expect(c.adminSteamIds).toEqual(['76561198000000001', '76561198000000002']);
  });

  it('applies orchestration defaults', () => {
    const c = loadConfig({});
    expect(c.logListenPort).toBe(27500);
    expect(c.logPublicAddress).toBe('127.0.0.1:27500');
  });

  it('parses orchestration env', () => {
    const c = loadConfig({ LOG_LISTEN_PORT: '30000', LOG_PUBLIC_ADDRESS: '203.0.113.9:30000' });
    expect(c.logListenPort).toBe(30000);
    expect(c.logPublicAddress).toBe('203.0.113.9:30000');
  });
});

describe('campaigns', () => {
  it('has the four original campaigns', () => {
    expect(Object.keys(CAMPAIGNS)).toEqual([
      'no_mercy',
      'death_toll',
      'dead_air',
      'blood_harvest',
      'dead_center',
      'dark_carnival',
      'swamp_fever',
      'hard_rain',
      'the_parish',
      'the_passing',
      'cold_stream',
      'the_last_stand',
    ]);
  });
});

describe('missingDirs', () => {
  it('names a configured directory that is not there', () => {
    const cfg = loadConfig({ REPLAY_DIR: '/definitely/not/here', DEMO_DIR: '' });
    expect(missingDirs(cfg)).toEqual([{ name: 'REPLAY_DIR', path: '/definitely/not/here' }]);
  });

  // ADDONS_DIR fails the same way and worse: the campaign upload route reports
  // free space as unknown and then the write fails, which reads as a broken
  // uploader rather than a path that is not there.
  it('names a missing ADDONS_DIR too', () => {
    const cfg = loadConfig({ ADDONS_DIR: '/no/such/addons', REPLAY_DIR: '', DEMO_DIR: '' });
    expect(missingDirs(cfg)).toEqual([{ name: 'ADDONS_DIR', path: '/no/such/addons' }]);
  });

  it('says nothing when a directory is simply not configured', () => {
    expect(missingDirs(loadConfig({}))).toEqual([]);
  });

  it('says nothing when the directory exists', () => {
    const cfg = loadConfig({ REPLAY_DIR: process.cwd() });
    expect(missingDirs(cfg)).toEqual([]);
  });
});

describe('dlc4MissionsDir', () => {
  it('reads DLC4_MISSIONS_DIR, defaulting to empty', () => {
    expect(loadConfig({ DLC4_MISSIONS_DIR: '/srv/left4dead_dlc4/missions' }).dlc4MissionsDir)
      .toBe('/srv/left4dead_dlc4/missions');
    expect(loadConfig({}).dlc4MissionsDir).toBe('');
  });
});

describe('ticketAttachmentsDir', () => {
  it('defaults to a directory beside the database', () => {
    expect(loadConfig({}).ticketAttachmentsDir).toBe('data/ticket-attachments');
    expect(loadConfig({ TICKET_ATTACHMENTS_DIR: ' /mnt/files ' }).ticketAttachmentsDir).toBe('/mnt/files');
  });
});

describe('replayLiveDir', () => {
  it('defaults to replays-live beside the database, and takes REPLAY_LIVE_DIR', () => {
    expect(loadConfig({}).replayLiveDir).toBe('data/replays-live');
    expect(loadConfig({ DB_PATH: '/srv/pug/data/pug.db' }).replayLiveDir).toBe('/srv/pug/data/replays-live');
    expect(loadConfig({ REPLAY_LIVE_DIR: ' /mnt/live ' }).replayLiveDir).toBe('/mnt/live');
  });
});
