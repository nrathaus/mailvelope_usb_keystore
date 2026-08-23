/**
 * Copyright (C) 2026 Noam Rathaus
 * Licensed under the GNU Affero General Public License version 3
 *
 * Covers the mvelo.storage interception: what reaches the device, what stays local,
 * and what is refused. This is the enforcement point for the requirement that no
 * crypto material is stored anywhere but the device, so it is also where the
 * storage audit in the plan's Phase 4 lives.
 *
 * Uses the real lib-mvelo, router and state modules against a fake backend, so the
 * wrapper is exercised through the same path the extension takes.
 */

jest.mock('../../../../src/modules/keyring', () => ({getAll: jest.fn()}));
jest.mock('../../../../src/modules/pwdCache', () => ({clear: jest.fn()}));

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
const MAIN = 'localhost|#|mailvelope';
const PRIV_KEY = 'mvelo.keyring.localhost|#|mailvelope.privateKeys';
const ATTR_KEY = 'mvelo.keyring.attributes';
const PRIVATE_ARMORED = '-----BEGIN PGP PRIVATE KEY BLOCK-----\nsecret\n-----END PGP PRIVATE KEY BLOCK-----';

describe('usb/install storage interception', () => {
  let mvelo; let state; let constants; let mocks; let install; let localStore; let device;

  /** Fake device filesystem, so writes and reads can be asserted by path. */
  function seedDevice() {
    device = {};
    mocks.writeFile.mockImplementation((path, content) => {
      device[path] = content;
      return Promise.resolve();
    });
    mocks.readFile.mockImplementation(path => {
      if (!(path in device)) {
        const {NotFoundError} = require('../../../../src/modules/usb/backend');
        return Promise.reject(new NotFoundError(path));
      }
      return Promise.resolve(device[path]);
    });
    mocks.removeFile.mockImplementation(path => {
      delete device[path];
      return Promise.resolve();
    });
  }

  function seedStorage(initial = {}) {
    localStore = {...initial};
    chrome.storage.local.get.mockImplementation(key =>
      Promise.resolve(key in localStore ? {[key]: localStore[key]} : {}));
    chrome.storage.local.set.mockImplementation(obj => {
      Object.assign(localStore, obj);
      return Promise.resolve();
    });
    chrome.storage.local.remove.mockImplementation(key => {
      delete localStore[key];
      return Promise.resolve();
    });
  }

  function load() {
    jest.resetModules();
    chrome.storage.local.get.mockReset();
    chrome.storage.local.set.mockReset();
    chrome.storage.local.remove.mockReset();
    chrome.action.setBadgeText.mockClear();
    constants = require('../../../../src/modules/usb/constants');
    mocks = require('../../../../src/modules/usb/FsaBackend').default.__mocks;
    mocks.supported = true;
    seedDevice();
    mvelo = require('../../../../src/lib/lib-mvelo').default;
    state = require('../../../../src/modules/usb/state');
    install = require('../../../../src/modules/usb/install');
  }

  /** Configured and reachable. */
  async function bootReady() {
    seedStorage({[constants.USB_CONFIG_KEY]: {keystoreId: KEYSTORE_ID}});
    device['mailvelope-keystore/keystore.json'] = JSON.stringify({keystoreId: KEYSTORE_ID});
    mocks.probe.mockResolvedValue({available: true, permission: 'granted', configured: true});
    await install.installUsbKeystore();
    expect(state.getState()).toBe(constants.USB_STATE.READY);
  }

  /** Configured but the device is gone. */
  async function bootAbsent() {
    seedStorage({[constants.USB_CONFIG_KEY]: {keystoreId: KEYSTORE_ID}});
    mocks.probe.mockResolvedValue({available: true, permission: 'granted', configured: true});
    await install.installUsbKeystore();
    expect(state.getState()).toBe(constants.USB_STATE.ABSENT);
  }

  beforeEach(() => {
    load();
  });

  describe('when no keystore is configured', () => {
    it('passes everything through to local storage, unchanged', async () => {
      seedStorage({});
      await install.installUsbKeystore();
      await mvelo.storage.set(PRIV_KEY, [PRIVATE_ARMORED]);
      expect(localStore[PRIV_KEY]).toEqual([PRIVATE_ARMORED]);
      expect(await mvelo.storage.get(PRIV_KEY)).toEqual([PRIVATE_ARMORED]);
      expect(mocks.writeFile).not.toHaveBeenCalled();
    });
  });

  describe('when the device is READY', () => {
    it('writes armored keys to the device as .asc and never locally', async () => {
      await bootReady();
      await mvelo.storage.set(PRIV_KEY, [PRIVATE_ARMORED]);
      const path = `mailvelope-keystore/keyrings/${Buffer.from(MAIN).toString('hex')}/private.asc`;
      expect(device[path]).toContain('BEGIN PGP PRIVATE KEY BLOCK');
      expect(localStore[PRIV_KEY]).toBeUndefined();
    });

    it('reads armored keys back from the device', async () => {
      await bootReady();
      await mvelo.storage.set(PRIV_KEY, [PRIVATE_ARMORED]);
      expect(await mvelo.storage.get(PRIV_KEY)).toEqual([PRIVATE_ARMORED]);
    });

    it('reports an empty keyring, not an error, when nothing is stored yet', async () => {
      await bootReady();
      expect(await mvelo.storage.get(PRIV_KEY)).toBeUndefined();
    });

    it('splits keyring attributes: crypto fields to the device, registry local', async () => {
      await bootReady();
      await mvelo.storage.set(ATTR_KEY, {[MAIN]: {default_key: 'ff00', sanitized: true}});
      expect(localStore[ATTR_KEY]).toEqual({[MAIN]: {sanitized: true}});
      const attrPath = 'mailvelope-keystore/keyrings/attributes.json';
      expect(JSON.parse(device[attrPath])).toEqual({[MAIN]: {default_key: 'ff00'}});
    });

    it('merges both halves of the attribute map on read', async () => {
      await bootReady();
      await mvelo.storage.set(ATTR_KEY, {[MAIN]: {default_key: 'ff00', sanitized: true}});
      expect(await mvelo.storage.get(ATTR_KEY)).toEqual({[MAIN]: {default_key: 'ff00', sanitized: true}});
    });

    it('keeps settings and OAuth tokens local', async () => {
      await bootReady();
      await mvelo.storage.set('mvelo.preferences', {security: {}});
      await mvelo.storage.set('mvelo.oauth.gmail', {token: 'x'});
      expect(localStore['mvelo.preferences']).toEqual({security: {}});
      expect(localStore['mvelo.oauth.gmail']).toEqual({token: 'x'});
    });

    it('removes key files from the device', async () => {
      await bootReady();
      await mvelo.storage.set(PRIV_KEY, [PRIVATE_ARMORED]);
      await mvelo.storage.remove(PRIV_KEY);
      expect(await mvelo.storage.get(PRIV_KEY)).toBeUndefined();
    });
  });

  describe('when the device is ABSENT', () => {
    // keyring.init() wraps buildKeyring in a try/catch that DELETES the keyring
    // from the attribute map on failure. A throwing read would therefore destroy
    // the registry entry just because the device was unplugged at startup, so
    // reads must degrade to "empty" instead.
    it('reports an empty keyring rather than throwing, so keyring init survives', async () => {
      await bootAbsent();
      await expect(mvelo.storage.get(PRIV_KEY)).resolves.toBeUndefined();
    });

    it('still returns the local keyring registry so keyrings can be enumerated', async () => {
      seedStorage({
        [constants.USB_CONFIG_KEY]: {keystoreId: KEYSTORE_ID},
        [ATTR_KEY]: {[MAIN]: {sanitized: true}}
      });
      mocks.probe.mockResolvedValue({available: true, permission: 'granted', configured: true});
      await install.installUsbKeystore();
      expect(await mvelo.storage.get(ATTR_KEY)).toEqual({[MAIN]: {sanitized: true}});
    });

    it('refuses writes of key material and leaves local storage untouched', async () => {
      await bootAbsent();
      await expect(mvelo.storage.set(PRIV_KEY, [PRIVATE_ARMORED])).rejects.toMatchObject({
        code: constants.USB_KEYSTORE_UNAVAILABLE
      });
      expect(localStore[PRIV_KEY]).toBeUndefined();
    });

    it('never falls back to local storage for key material', async () => {
      await bootAbsent();
      await mvelo.storage.set(PRIV_KEY, [PRIVATE_ARMORED]).catch(() => {});
      expect(JSON.stringify(localStore)).not.toContain('BEGIN PGP');
    });
  });

  describe('a fresh profile with no device attached', () => {
    // keyringAttr.init() creates the main keyring and stores it immediately. If
    // that write required the device, a first run without one would leave the
    // keyring subsystem unable to initialise at all.
    it('can create a keyring with no crypto attributes and no device', async () => {
      await bootAbsent();
      await expect(mvelo.storage.set(ATTR_KEY, {[MAIN]: {}})).resolves.toBeUndefined();
      expect(localStore[ATTR_KEY]).toEqual({[MAIN]: {}});
      expect(mocks.writeFile).not.toHaveBeenCalled();
    });
  });

  describe('leak safety net for unrecognised storage keys', () => {
    it('refuses armored key material under an unknown key', async () => {
      await bootReady();
      await expect(mvelo.storage.set('mvelo.something.new', {blob: PRIVATE_ARMORED}))
      .rejects.toMatchObject({code: 'USB_KEYSTORE_LEAK_BLOCKED'});
      expect(localStore['mvelo.something.new']).toBeUndefined();
    });

    it('allows ordinary values under an unknown key', async () => {
      await bootReady();
      await mvelo.storage.set('mvelo.something.new', {harmless: true});
      expect(localStore['mvelo.something.new']).toEqual({harmless: true});
    });
  });

  describe('purge on device loss', () => {
    it('clears the passphrase cache and in-memory keyrings', async () => {
      const {getAll} = require('../../../../src/modules/keyring');
      const {clear} = require('../../../../src/modules/pwdCache');
      const keystore = {clear: jest.fn()};
      getAll.mockResolvedValue([{keystore}]);
      await bootReady();
      delete device['mailvelope-keystore/keystore.json'];
      await state.probe();
      expect(clear).toHaveBeenCalled();
      await Promise.resolve();
      expect(keystore.clear).toHaveBeenCalled();
    });
  });

  describe('remembering that the device has held keys', () => {
    // A detached device cannot be asked whether it holds keys, so the answer has to
    // be remembered. Keys are written rarely but read on every startup, so the read
    // path is what makes this work for a profile set up before the flag existed.
    it('records the flag when private keys are read from the device', async () => {
      await bootReady();
      const path = `mailvelope-keystore/keyrings/${Buffer.from(MAIN).toString('hex')}/private.asc`;
      device[path] = PRIVATE_ARMORED;
      await mvelo.storage.get(PRIV_KEY);
      expect((await state.getConfig()).hadKeys).toBe(true);
    });

    it('records the flag when private keys are written', async () => {
      await bootReady();
      await mvelo.storage.set(PRIV_KEY, [PRIVATE_ARMORED]);
      expect((await state.getConfig()).hadKeys).toBe(true);
    });

    it('does not claim keys for an empty keyring', async () => {
      await bootReady();
      await mvelo.storage.set(PRIV_KEY, []);
      await mvelo.storage.get(PRIV_KEY);
      expect((await state.getConfig()).hadKeys).toBeUndefined();
    });
  });

  describe('reload when the device returns', () => {
    // Reads degrade to empty while the device is away, so every keyring in memory
    // is blank by the time it comes back. Without a reload the warning clears while
    // the UI still shows no keys, which reads as data loss.
    it('reloads the keyrings from the device on return to READY', async () => {
      const {getAll} = require('../../../../src/modules/keyring');
      const keystore = {clear: jest.fn(), load: jest.fn().mockResolvedValue(undefined)};
      getAll.mockResolvedValue([{keystore}]);
      await bootReady();
      const marker = device['mailvelope-keystore/keystore.json'];
      delete device['mailvelope-keystore/keystore.json'];
      await state.probe();
      expect(state.getState()).toBe(constants.USB_STATE.ABSENT);
      keystore.clear.mockClear();

      device['mailvelope-keystore/keystore.json'] = marker;
      await state.probe();
      expect(state.getState()).toBe(constants.USB_STATE.READY);
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(keystore.clear).toHaveBeenCalled();
      expect(keystore.load).toHaveBeenCalled();
    });

    it('does not reload while the device stays away', async () => {
      const {getAll} = require('../../../../src/modules/keyring');
      const keystore = {clear: jest.fn(), load: jest.fn().mockResolvedValue(undefined)};
      getAll.mockResolvedValue([{keystore}]);
      await bootAbsent();
      keystore.load.mockClear();
      await state.probe();
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(keystore.load).not.toHaveBeenCalled();
    });
  });

  describe('badge arbitration with uiLog', () => {
    // uiLog sets a green 'Ok' on user interaction and clears it 2s later. A clear
    // must restore the USB warning rather than blanking the toolbar.
    it('restores the warning when something clears the badge', async () => {
      await bootAbsent();
      chrome.action.setBadgeText.mockClear();
      mvelo.action.state({badge: ''});
      expect(chrome.action.setBadgeText).toHaveBeenCalledWith({text: '!'});
    });

    it('leaves the badge alone while the device is READY', async () => {
      await bootReady();
      chrome.action.setBadgeText.mockClear();
      mvelo.action.state({badge: ''});
      expect(chrome.action.setBadgeText).toHaveBeenCalledWith({text: ''});
    });
  });

  // The plan's requirement 3 as an assertion rather than a claim.
  describe('storage audit: no crypto material outside the device', () => {
    it('holds no armored key or crypto attribute locally after a full session', async () => {
      await bootReady();
      await mvelo.storage.set(ATTR_KEY, {[MAIN]: {}});
      await mvelo.storage.set(PRIV_KEY, [PRIVATE_ARMORED]);
      await mvelo.storage.set('mvelo.keyring.localhost|#|mailvelope.publicKeys', [PRIVATE_ARMORED]);
      await mvelo.storage.set(`mvelo.autocrypt.${MAIN}`, {'a@b.c': {keydata: 'AAAA'}});
      await mvelo.storage.set(ATTR_KEY, {
        [MAIN]: {default_key: 'ff00', sanitized: true, key_binding: {'a@b.c': {fingerprint: 'ff'}}}
      });

      const serialized = JSON.stringify(localStore);
      expect(serialized).not.toContain('BEGIN PGP');
      expect(Object.keys(localStore)).not.toContain(PRIV_KEY);
      expect(Object.keys(localStore)).not.toContain(`mvelo.autocrypt.${MAIN}`);
      for (const field of ['default_key', 'primary_key', 'sync_data', 'key_binding']) {
        expect(serialized).not.toContain(field);
      }
      // ...and it is all on the device instead.
      expect(JSON.stringify(device)).toContain('BEGIN PGP');
      expect(JSON.stringify(device)).toContain('default_key');
    });
  });
});
