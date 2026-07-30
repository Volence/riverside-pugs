import { describe, it, expect } from 'vitest';
import { loadConfig } from '../src/config.js';
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
    expect(Object.keys(CAMPAIGNS)).toEqual(['no_mercy', 'death_toll', 'dead_air', 'blood_harvest']);
  });
});
