import { describe, it, expect } from 'vitest';
import { openDb } from '../src/db.js';
import { setSetting } from '../src/settings.js';
import { validateSetting } from '../src/settingsSchema.js';
import { extraVpnAsns, isVpnNetwork, KNOWN_VPN_ASNS } from '../src/networkKinds.js';

const none = new Set<number>();

describe('isVpnNetwork', () => {
  it('knows the providers seen in our logs', () => {
    for (const asn of [212238, 62240, 9009, 60068, 20473, 14061, 16509, 24940, 16276]) {
      expect(KNOWN_VPN_ASNS.has(asn), String(asn)).toBe(true);
      expect(isVpnNetwork(asn, 'whatever', none)).toBe(true);
    }
  });

  it('reads hosting words in the provider name', () => {
    expect(isVpnNetwork(64501, 'ACME-HOSTING-LTD', none)).toBe(true);
    expect(isVpnNetwork(64502, 'Example Cloud Services', none)).toBe(true);
    expect(isVpnNetwork(64503, 'FASTVPN', none)).toBe(true);
    expect(isVpnNetwork(64504, 'EXAMPLE-CABLE-RESIDENTIAL', none)).toBe(false);
  });

  it('never calls an unknown network a VPN', () => {
    expect(isVpnNetwork(null, null, none)).toBe(false);
    expect(isVpnNetwork(null, 'HOSTING', none)).toBe(false);
  });

  it('takes ASNs staff added by hand', () => {
    const db = openDb(':memory:');
    expect(extraVpnAsns(db).size).toBe(0);
    setSetting(db, 'vpn_asns_extra', '[64505]');
    expect(isVpnNetwork(64505, 'PLAIN-NAME', extraVpnAsns(db))).toBe(true);
    setSetting(db, 'vpn_asns_extra', 'not json');
    expect(extraVpnAsns(db).size).toBe(0);
  });

  it('validates the setting as a list of AS numbers', () => {
    expect(validateSetting('vpn_asns_extra', [212238, 9009])).toEqual({ ok: true, value: '[212238,9009]' });
    expect(validateSetting('vpn_asns_extra', [0]).ok).toBe(false);
  });
});
