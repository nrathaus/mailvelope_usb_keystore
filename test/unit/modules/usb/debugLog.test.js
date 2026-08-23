/**
 * Copyright (C) 2026 Noam Rathaus
 * Licensed under the GNU Affero General Public License version 3
 *
 * A diagnostic log that writes to disk is a liability for an encryption extension,
 * so the property that matters most is that it stays silent until explicitly turned
 * on, and forgets what it captured when turned off.
 */

describe('usb/debugLog', () => {
  let debugLog; let store;

  function seedStorage(initial = {}) {
    store = {...initial};
    chrome.storage.local.get.mockImplementation(key =>
      Promise.resolve(key in store ? {[key]: store[key]} : {}));
    chrome.storage.local.set.mockImplementation(obj => {
      Object.assign(store, obj);
      return Promise.resolve();
    });
    return store;
  }

  beforeEach(() => {
    jest.resetModules();
    chrome.storage.local.get.mockReset();
    chrome.storage.local.set.mockReset();
    seedStorage({});
    debugLog = require('../../../../src/modules/usb/debugLog');
  });

  describe('disabled by default', () => {
    it('records nothing and writes nothing', async () => {
      await debugLog.log('probe', {state: 'READY'});
      expect(await debugLog.getLog()).toEqual([]);
      expect(chrome.storage.local.set).not.toHaveBeenCalled();
    });

    it('ignores errors too', async () => {
      await debugLog.logError('provision', new Error('boom'));
      expect(await debugLog.getLog()).toEqual([]);
    });

    it('treats any stored value other than true as off', async () => {
      seedStorage({'mvelo.usb.debugEnabled': 'yes'});
      await debugLog.log('probe');
      expect(await debugLog.getLog()).toEqual([]);
    });
  });

  describe('once enabled', () => {
    beforeEach(async () => {
      await debugLog.setEnabled(true);
      chrome.storage.local.set.mockClear();
    });

    it('records events with a timestamp', async () => {
      await debugLog.log('probe', {state: 'ABSENT'});
      const entries = await debugLog.getLog();
      expect(entries).toHaveLength(1);
      expect(entries[0].event).toBe('probe');
      expect(entries[0].t).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(entries[0].detail).toContain('ABSENT');
    });

    it('keeps the identifying parts of an error, not its stack', async () => {
      const error = new Error('device gone');
      error.code = 'USB_KEYSTORE_UNAVAILABLE';
      await debugLog.logError('write', error, {path: 'a/b.asc'});
      const [entry] = await debugLog.getLog();
      expect(entry.detail).toContain('USB_KEYSTORE_UNAVAILABLE');
      expect(entry.detail).toContain('a/b.asc');
      expect(entry.detail).not.toContain('at Object');
    });

    // An unbounded log on a device people carry around is its own problem.
    it('bounds the ring buffer', async () => {
      for (let i = 0; i < 320; i++) {
        await debugLog.log('probe', {i});
      }
      const entries = await debugLog.getLog();
      expect(entries).toHaveLength(300);
      expect(entries[entries.length - 1].detail).toContain('319');
    });

    it('clips an oversized detail rather than storing it whole', async () => {
      await debugLog.log('big', 'x'.repeat(5000));
      const [entry] = await debugLog.getLog();
      expect(entry.detail.length).toBeLessThan(600);
      expect(entry.detail.endsWith('…')).toBe(true);
    });
  });

  describe('turning it off', () => {
    // Switching off should also be a way to clean up, not just to stop adding.
    it('erases what was already captured', async () => {
      await debugLog.setEnabled(true);
      await debugLog.log('probe', {state: 'READY'});
      expect(await debugLog.getLog()).toHaveLength(1);

      await debugLog.setEnabled(false);
      expect(await debugLog.getLog()).toEqual([]);
      expect(store['mvelo.usb.debug']).toEqual([]);
      expect(store['mvelo.usb.debugEnabled']).toBe(false);
    });

    it('stays silent afterwards', async () => {
      await debugLog.setEnabled(true);
      await debugLog.setEnabled(false);
      await debugLog.log('probe');
      expect(await debugLog.getLog()).toEqual([]);
    });
  });

  describe('router treatment', () => {
    it('keeps its storage keys local, so the leak net does not have to guess', () => {
      const {isAllowedLocal} = require('../../../../src/modules/usb/router');
      for (const key of debugLog.DEBUG_STORAGE_KEYS) {
        expect(isAllowedLocal(key)).toBe(true);
      }
    });
  });
});
