/**
 * Copyright (C) 2026 Noam Rathaus
 * Licensed under the GNU Affero General Public License version 3
 *
 * The passphrase cache must not run while keys live on a USB device.
 *
 * Caching an entry makes chrome.alarms hold an alarm named PWD_ALARM_<fingerprint>,
 * and Chrome persists alarm names to disk with persistAcrossSessions. That writes the
 * fingerprint of a device-resident key into the local profile, where LevelDB's
 * append-only log keeps it readable long after the alarm is cleared -- found on a real
 * profile seven hours after the alarm had fired.
 */

jest.mock('../../../src/modules/usb/state', () => ({
  isConfigured: jest.fn()
}));

jest.mock('../../../src/modules/prefs', () => ({
  prefs: {security: {password_cache: true, password_timeout: 30}},
  addUpdateHandler: jest.fn()
}));

import * as pwdCache from '../../../src/modules/pwdCache';
import {isConfigured} from '../../../src/modules/usb/state';

// Enough of a key for the cache: it only ever asks for the fingerprint.
const KEY = {getFingerprint: () => '853078005387ddf48abb3f2aa038e019ea980beb'};

describe('pwdCache with a USB keystore', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    pwdCache.initSession();
    pwdCache.init();
  });

  it('caches normally when no USB keystore is configured', async () => {
    isConfigured.mockResolvedValue(false);
    await pwdCache.set({key: KEY, password: 'secret'});
    expect(await pwdCache.isCached(KEY.getFingerprint())).toBe(true);
  });

  it('does not cache while keys are on a USB device', async () => {
    isConfigured.mockResolvedValue(true);
    await pwdCache.set({key: KEY, password: 'secret'});
    expect(await pwdCache.isCached(KEY.getFingerprint())).toBe(false);
  });

  // The fingerprint reaches disk through the alarm name, so the test that matters is
  // that no alarm is created at all -- not merely that the entry is absent.
  it('creates no fingerprint-named alarm while keys are on a USB device', async () => {
    isConfigured.mockResolvedValue(true);
    await pwdCache.set({key: KEY, password: 'secret'});
    const calls = chrome.alarms.create.mock.calls || [];
    const named = calls.filter(([name]) =>
      typeof name === 'string' && name.includes(KEY.getFingerprint()));
    expect(named).toHaveLength(0);
  });

  // unlock() has its own `active` check, but privateKey.controller calls set()
  // directly and bypasses it -- which is why the gate lives in set().
  it('gates set() itself, not only the unlock path', async () => {
    isConfigured.mockResolvedValue(true);
    await pwdCache.set({key: KEY, password: 'secret', reservedOperations: 0});
    expect(isConfigured).toHaveBeenCalled();
  });

  // A storage read is used rather than the in-memory enabled flag, because the flag
  // reads false until the first probe and a false negative here permits the leak.
  it('asks storage rather than trusting an uninitialised flag', async () => {
    isConfigured.mockResolvedValue(true);
    await pwdCache.set({key: KEY, password: 'secret'});
    expect(isConfigured).toHaveBeenCalledTimes(1);
  });
});
