/**
 * Copyright (C) 2026 Noam Rathaus
 * Licensed under the GNU Affero General Public License version 3
 *
 * Covers the availability state machine against a fake backend. Most of state.js
 * had never executed outside the one manual provisioning run, so these exercise
 * every transition the UI and the storage wrapper depend on.
 */

// A controllable stand-in for the File System Access backend.
jest.mock('../../../../src/modules/usb/FsaBackend', () => {
  const mocks = {
    supported: true,
    probe: jest.fn(),
    readFile: jest.fn(),
    writeFile: jest.fn(),
    removeFile: jest.fn(),
    listDir: jest.fn()
  };
  class FakeBackend {
    static isSupported() {
      return mocks.supported;
    }

    constructor() {
      this.clearCache = jest.fn();
      this.probe = mocks.probe;
      this.readFile = mocks.readFile;
      this.writeFile = mocks.writeFile;
      this.removeFile = mocks.removeFile;
      this.listDir = mocks.listDir;
    }
  }
  FakeBackend.__mocks = mocks;
  return {__esModule: true, default: FakeBackend};
});

// Two backends exist now, so a test that means "no backend at all" has to say so
// for both. Native support is off by default here; the Firefox path has its own
// tests.
jest.mock('../../../../src/modules/usb/NativeBackend', () => {
  class FakeNative {
    static isSupported() {
      return FakeNative.supported === true;
    }
  }
  FakeNative.supported = false;
  return {__esModule: true, default: FakeNative};
});

const KEYSTORE_ID = 'abc123';
const MARKER_PATH = 'mailvelope-keystore/keystore.json';

function seedStorage(initial = {}) {
  const store = {...initial};
  chrome.storage.local.get.mockImplementation(key =>
    Promise.resolve(key in store ? {[key]: store[key]} : {}));
  chrome.storage.local.set.mockImplementation(obj => {
    Object.assign(store, obj);
    return Promise.resolve();
  });
  chrome.storage.local.remove.mockImplementation(key => {
    delete store[key];
    return Promise.resolve();
  });
  return store;
}

describe('usb/state', () => {
  let state; let constants; let backend; let mocks; let USB_STATE;

  function load() {
    jest.resetModules();
    chrome.storage.local.get.mockReset();
    chrome.storage.local.set.mockReset();
    chrome.storage.local.remove.mockReset();
    constants = require('../../../../src/modules/usb/constants');
    USB_STATE = constants.USB_STATE;
    backend = require('../../../../src/modules/usb/FsaBackend').default;
    mocks = backend.__mocks;
    mocks.supported = true;
    state = require('../../../../src/modules/usb/state');
  }

  /** Configured device whose marker matches, i.e. the happy path. */
  function seedReady() {
    seedStorage({[constants.USB_CONFIG_KEY]: {keystoreId: KEYSTORE_ID}});
    mocks.probe.mockResolvedValue({available: true, permission: 'granted', configured: true});
    mocks.readFile.mockResolvedValue(JSON.stringify({keystoreId: KEYSTORE_ID, label: 'stick'}));
  }

  beforeEach(() => {
    load();
  });

  describe('state resolution', () => {
    it('is NOT_CONFIGURED with no config, and reports the browser as supported', async () => {
      seedStorage({});
      expect(await state.probe()).toBe(USB_STATE.NOT_CONFIGURED);
      expect(state.isEnabled()).toBe(false);
      // Not opting in must take precedence over backend availability, so an
      // unconfigured profile looks like stock Mailvelope.
      expect(state.getStatus().supported).toBe(false); // no backend selected until init()
    });

    it('is UNSUPPORTED when configured but the browser has no backend', async () => {
      seedStorage({[constants.USB_CONFIG_KEY]: {keystoreId: KEYSTORE_ID}});
      mocks.supported = false;
      await state.init();
      expect(state.getState()).toBe(USB_STATE.UNSUPPORTED);
      // Critically: still 'enabled', so the storage wrapper fails closed rather
      // than silently writing keys to local storage.
      expect(state.isEnabled()).toBe(true);
    });

    it('is PERMISSION_REQUIRED when the grant is missing', async () => {
      seedStorage({[constants.USB_CONFIG_KEY]: {keystoreId: KEYSTORE_ID}});
      mocks.probe.mockResolvedValue({available: false, permission: 'prompt', configured: true});
      await state.init();
      expect(state.getState()).toBe(USB_STATE.PERMISSION_REQUIRED);
    });

    it('is ABSENT when the marker file is missing', async () => {
      const {NotFoundError} = require('../../../../src/modules/usb/backend');
      seedReady();
      mocks.readFile.mockRejectedValue(new NotFoundError(MARKER_PATH));
      await state.init();
      expect(state.getState()).toBe(USB_STATE.ABSENT);
    });

    it('is ABSENT when the device itself is unreachable', async () => {
      const {DeviceUnavailableError} = require('../../../../src/modules/usb/backend');
      seedReady();
      mocks.readFile.mockRejectedValue(new DeviceUnavailableError());
      await state.init();
      expect(state.getState()).toBe(USB_STATE.ABSENT);
    });

    it('is WRONG_DEVICE when the marker belongs to another keystore', async () => {
      seedReady();
      mocks.readFile.mockResolvedValue(JSON.stringify({keystoreId: 'someone-else', label: 'other'}));
      await state.init();
      expect(state.getState()).toBe(USB_STATE.WRONG_DEVICE);
      expect(state.getStatus().detail).toBe('other');
    });

    it('is ERROR on unexpected failures, not silently ABSENT', async () => {
      seedReady();
      mocks.readFile.mockRejectedValue(new Error('disk on fire'));
      await state.init();
      expect(state.getState()).toBe(USB_STATE.ERROR);
      expect(state.getStatus().detail).toBe('disk on fire');
    });

    it('is ERROR when the marker is not valid JSON', async () => {
      seedReady();
      mocks.readFile.mockResolvedValue('not json at all');
      await state.init();
      expect(state.getState()).toBe(USB_STATE.ERROR);
    });

    it('is READY when the marker matches', async () => {
      seedReady();
      await state.init();
      expect(state.getState()).toBe(USB_STATE.READY);
      expect(state.isUsable()).toBe(true);
      expect(state.isEnabled()).toBe(true);
    });

    // Presence is established by reading the marker, not by resolving the handle:
    // automounters differ in whether the mount point vanishes on removal or is
    // left behind as an empty directory.
    it('reads the marker file to decide presence', async () => {
      seedReady();
      await state.init();
      expect(mocks.readFile).toHaveBeenCalledWith(MARKER_PATH);
    });
  });

  describe('assertUsable', () => {
    it('resolves when READY', async () => {
      seedReady();
      await state.init();
      await expect(state.assertUsable()).resolves.toBeUndefined();
    });

    it('rejects with USB_KEYSTORE_UNAVAILABLE when the device is gone', async () => {
      const {NotFoundError} = require('../../../../src/modules/usb/backend');
      seedReady();
      await state.init();
      mocks.readFile.mockRejectedValue(new NotFoundError(MARKER_PATH));
      await expect(state.assertUsable(true)).rejects.toMatchObject({
        code: constants.USB_KEYSTORE_UNAVAILABLE
      });
    });

    // A stale READY reading must not let a write proceed against a pulled device.
    it('re-probes before writes when asked', async () => {
      seedReady();
      await state.init();
      mocks.readFile.mockClear();
      await state.assertUsable(true);
      expect(mocks.readFile).toHaveBeenCalled();
    });

    it('does not re-probe on reads while READY', async () => {
      seedReady();
      await state.init();
      mocks.readFile.mockClear();
      await state.assertUsable();
      expect(mocks.readFile).not.toHaveBeenCalled();
    });
  });

  describe('listeners', () => {
    it('notifies on transition, with previous and next state', async () => {
      const {NotFoundError} = require('../../../../src/modules/usb/backend');
      seedReady();
      await state.init();
      const seen = [];
      state.addStateListener((next, previous) => seen.push([previous, next]));
      mocks.readFile.mockRejectedValue(new NotFoundError(MARKER_PATH));
      await state.probe();
      expect(seen).toEqual([[USB_STATE.READY, USB_STATE.ABSENT]]);
    });

    it('does not notify when the state is unchanged', async () => {
      seedReady();
      await state.init();
      const listener = jest.fn();
      state.addStateListener(listener);
      await state.probe();
      expect(listener).not.toHaveBeenCalled();
    });

    it('unregisters', async () => {
      const {NotFoundError} = require('../../../../src/modules/usb/backend');
      seedReady();
      await state.init();
      const listener = jest.fn();
      state.addStateListener(listener)();
      mocks.readFile.mockRejectedValue(new NotFoundError(MARKER_PATH));
      await state.probe();
      expect(listener).not.toHaveBeenCalled();
    });

    it('survives a throwing listener so one bad consumer cannot block others', async () => {
      const {NotFoundError} = require('../../../../src/modules/usb/backend');
      seedReady();
      await state.init();
      const good = jest.fn();
      state.addStateListener(() => {
        throw new Error('bad listener');
      });
      state.addStateListener(good);
      mocks.readFile.mockRejectedValue(new NotFoundError(MARKER_PATH));
      await state.probe();
      expect(good).toHaveBeenCalled();
    });
  });

  describe('config and probing', () => {
    it('starts the periodic probe on init', async () => {
      seedReady();
      await state.init();
      expect(chrome.alarms.create).toHaveBeenCalledWith(
        constants.PROBE_ALARM,
        {periodInMinutes: constants.PROBE_PERIOD_MINUTES}
      );
    });

    it('round-trips and clears config without touching mvelo.storage', async () => {
      seedStorage({});
      await state.setConfig({keystoreId: KEYSTORE_ID});
      expect(await state.getConfig()).toEqual({keystoreId: KEYSTORE_ID});
      await state.clearConfig();
      expect(await state.getConfig()).toBeUndefined();
    });

    it('recovers to READY when the device comes back', async () => {
      const {NotFoundError} = require('../../../../src/modules/usb/backend');
      seedReady();
      await state.init();
      const marker = JSON.stringify({keystoreId: KEYSTORE_ID});
      mocks.readFile.mockRejectedValue(new NotFoundError(MARKER_PATH));
      expect(await state.probe()).toBe(USB_STATE.ABSENT);
      mocks.readFile.mockResolvedValue(marker);
      expect(await state.probe()).toBe(USB_STATE.READY);
    });
  });
});
