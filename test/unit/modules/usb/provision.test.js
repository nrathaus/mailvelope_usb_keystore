/**
 * Copyright (C) 2026 Noam Rathaus
 * Licensed under the GNU Affero General Public License version 3
 *
 * Covers provisioning, migration and teardown.
 *
 * Migration deletes the local copy of key material, so the cases that matter most
 * here are the failure paths: a failed or unverified write must leave the local copy
 * exactly where it was.
 */

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

jest.mock('../../../../src/modules/usb/handleStore', () => ({
  get: jest.fn(),
  put: jest.fn(),
  remove: jest.fn()
}));

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
const PRIV_KEY = `mvelo.keyring.${MAIN}.privateKeys`;
const PUB_KEY = `mvelo.keyring.${MAIN}.publicKeys`;
const AUTOCRYPT_KEY = `mvelo.autocrypt.${MAIN}`;
const ATTR_KEY = 'mvelo.keyring.attributes';
const PRIV = '-----BEGIN PGP PRIVATE KEY BLOCK-----\nsecret\n-----END PGP PRIVATE KEY BLOCK-----';
const PUB = '-----BEGIN PGP PUBLIC KEY BLOCK-----\npublic\n-----END PGP PUBLIC KEY BLOCK-----';

describe('usb/provision', () => {
  let provision; let state; let constants; let mocks; let handleStore; let store; let device;

  function seedStorage(initial = {}) {
    store = {...initial};
    // The real API returns every item for get(null), which readLocalStorage relies on.
    chrome.storage.local.get.mockImplementation(key => {
      if (key === null || key === undefined) {
        return Promise.resolve({...store});
      }
      return Promise.resolve(key in store ? {[key]: store[key]} : {});
    });
    chrome.storage.local.set.mockImplementation(obj => {
      Object.assign(store, obj);
      return Promise.resolve();
    });
    chrome.storage.local.remove.mockImplementation(key => {
      delete store[key];
      return Promise.resolve();
    });
  }

  function seedDevice(initial = {}) {
    device = {...initial};
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
    mocks.listDir.mockResolvedValue([]);
  }

  function load() {
    jest.resetModules();
    chrome.storage.local.get.mockReset();
    chrome.storage.local.set.mockReset();
    chrome.storage.local.remove.mockReset();
    constants = require('../../../../src/modules/usb/constants');
    mocks = require('../../../../src/modules/usb/FsaBackend').default.__mocks;
    mocks.supported = true;
    handleStore = require('../../../../src/modules/usb/handleStore');
    state = require('../../../../src/modules/usb/state');
    provision = require('../../../../src/modules/usb/provision');
  }

  /** Bring the state machine up with a reachable, correctly-marked device. */
  async function bootReady(localSeed = {}) {
    seedStorage({[constants.USB_CONFIG_KEY]: {keystoreId: KEYSTORE_ID}, ...localSeed});
    seedDevice({'mailvelope-keystore/keystore.json': JSON.stringify({keystoreId: KEYSTORE_ID})});
    mocks.probe.mockResolvedValue({available: true, permission: 'granted', configured: true});
    await state.init();
    expect(state.getState()).toBe(constants.USB_STATE.READY);
  }

  const keyringDir = `mailvelope-keystore/keyrings/${Buffer.from(MAIN).toString('hex')}`;

  beforeEach(() => {
    load();
  });

  describe('provision', () => {
    it('creates a marker and records it as this profile keystore', async () => {
      seedStorage({});
      seedDevice({});
      mocks.probe.mockResolvedValue({available: true, permission: 'granted', configured: true});
      await state.init();
      const status = await provision.provision({label: 'my stick'});
      const marker = JSON.parse(device['mailvelope-keystore/keystore.json']);
      expect(marker.keystoreId).toMatch(/^[0-9a-f-]+$/i);
      expect(marker.label).toBe('my stick');
      expect(marker.version).toBe(constants.KEYSTORE_VERSION);
      expect((await state.getConfig()).keystoreId).toBe(marker.keystoreId);
      expect(status.state).toBe(constants.USB_STATE.READY);
    });

    // Whoever finds this folder may be doing so because Mailvelope is gone, so
    // the recovery instructions have to live on the device.
    it('leaves recovery instructions on the device', async () => {
      seedStorage({});
      seedDevice({});
      mocks.probe.mockResolvedValue({available: true, permission: 'granted', configured: true});
      await state.init();
      await provision.provision({label: 'stick'});
      const readme = device['mailvelope-keystore/README.txt'];
      expect(readme).toContain('gpg --import');
      expect(readme).toContain('private.asc');
      // It must also explain the mistake the guard exists to catch.
      expect(readme).toContain('not this folder itself');
    });

    it('still provisions when the README cannot be written', async () => {
      seedStorage({});
      seedDevice({});
      mocks.probe.mockResolvedValue({available: true, permission: 'granted', configured: true});
      await state.init();
      mocks.writeFile.mockImplementation((path, content) => {
        if (path.endsWith('README.txt')) {
          return Promise.reject(new Error('read-only'));
        }
        device[path] = content;
        return Promise.resolve();
      });
      const status = await provision.provision({label: 'stick'});
      expect(status.state).toBe(constants.USB_STATE.READY);
    });

    // A device set up on another machine should be adoptable rather than reset,
    // which would orphan the keys already on it.
    it('adopts an existing keystore without rewriting its id', async () => {
      seedStorage({});
      const existing = {version: 1, keystoreId: 'pre-existing', label: 'old stick'};
      seedDevice({'mailvelope-keystore/keystore.json': JSON.stringify(existing)});
      mocks.probe.mockResolvedValue({available: true, permission: 'granted', configured: true});
      await state.init();
      await provision.provision({label: 'ignored'});
      expect(JSON.parse(device['mailvelope-keystore/keystore.json']).keystoreId).toBe('pre-existing');
      expect((await state.getConfig()).keystoreId).toBe('pre-existing');
    });

    // Picking the keystore folder itself nests a second keystore inside the first,
    // and it is the natural choice when reconnecting because it is the folder the
    // user can actually see.
    it('refuses the keystore folder itself', async () => {
      seedStorage({});
      seedDevice({'keystore.json': JSON.stringify({keystoreId: 'inner', version: 1})});
      mocks.probe.mockResolvedValue({available: true, permission: 'granted', configured: true});
      await state.init();
      await expect(provision.provision({label: 'mailvelope-keystore'}))
      .rejects.toMatchObject({code: 'USB_KEYSTORE_NESTED_PICK'});
      // Nothing nested was created.
      expect(device['mailvelope-keystore/keystore.json']).toBeUndefined();
    });

    // Silently repointing would leave the user looking at an empty keyring while
    // their keys sat on the previous device.
    it('refuses to switch to a different keystore without being told to', async () => {
      await bootReady();
      seedDevice({'mailvelope-keystore/keystore.json': JSON.stringify({keystoreId: 'someone-else'})});
      await expect(provision.provision({label: 'other'}))
      .rejects.toMatchObject({code: 'USB_KEYSTORE_DIFFERENT_DEVICE'});
      expect((await state.getConfig()).keystoreId).toBe(KEYSTORE_ID);
    });

    it('refuses a folder holding no keystore when one is already configured', async () => {
      await bootReady();
      seedDevice({});
      await expect(provision.provision({label: 'empty'}))
      .rejects.toMatchObject({code: 'USB_KEYSTORE_NOT_CONFIGURED_DEVICE'});
      expect((await state.getConfig()).keystoreId).toBe(KEYSTORE_ID);
      // No new identity was minted over the configured one.
      expect(device['mailvelope-keystore/keystore.json']).toBeUndefined();
    });

    it('switches when the user explicitly adopts the other keystore', async () => {
      await bootReady();
      seedDevice({'mailvelope-keystore/keystore.json': JSON.stringify({keystoreId: 'someone-else', label: 'other'})});
      await provision.provision({label: 'other', adopt: true});
      expect((await state.getConfig()).keystoreId).toBe('someone-else');
    });

    // A React click event reached this flag as `adopt` once, making every pick
    // adopt silently and defeating the identity check. Only an explicit true counts.
    it('treats a non-boolean adopt flag as no consent', async () => {
      await bootReady();
      seedDevice({'mailvelope-keystore/keystore.json': JSON.stringify({keystoreId: 'someone-else'})});
      for (const bogus of [{nativeEvent: {}}, 'yes', 1, {}]) {
        await expect(provision.provision({label: 'other', adopt: bogus}))
        .rejects.toMatchObject({code: 'USB_KEYSTORE_DIFFERENT_DEVICE'});
      }
      expect((await state.getConfig()).keystoreId).toBe(KEYSTORE_ID);
    });

    it('creates a keystore on an empty folder when the user adopts it', async () => {
      await bootReady();
      seedDevice({});
      await provision.provision({label: 'fresh', adopt: true});
      const marker = JSON.parse(device['mailvelope-keystore/keystore.json']);
      expect(marker.label).toBe('fresh');
      expect((await state.getConfig()).keystoreId).toBe(marker.keystoreId);
    });

    // devicePath is written by selectDevice() on the native path and is the only
    // thing telling that backend where the device is. Replacing the config rather
    // than merging dropped it, and the state machine then reported "no keystore
    // configured" while the label and id were plainly displayed from that config.
    it('keeps configuration it did not set, such as the native device path', async () => {
      seedStorage({[constants.USB_CONFIG_KEY]: {devicePath: '/run/media/u/STICK'}});
      seedDevice({});
      mocks.probe.mockResolvedValue({available: true, permission: 'granted', configured: true});
      await state.init();
      await provision.provision({label: 'STICK'});
      const config = await state.getConfig();
      expect(config.devicePath).toBe('/run/media/u/STICK');
      expect(config.keystoreId).toBeTruthy();
    });

    it('keeps the device path when adopting an existing keystore too', async () => {
      seedStorage({[constants.USB_CONFIG_KEY]: {devicePath: '/run/media/u/STICK'}});
      seedDevice({'mailvelope-keystore/keystore.json': JSON.stringify({keystoreId: 'existing', label: 'STICK'})});
      mocks.probe.mockResolvedValue({available: true, permission: 'granted', configured: true});
      await state.init();
      await provision.provision({label: 'STICK'});
      const config = await state.getConfig();
      expect(config.devicePath).toBe('/run/media/u/STICK');
      expect(config.keystoreId).toBe('existing');
    });

    it('refuses when the browser has no backend', async () => {
      seedStorage({});
      mocks.supported = false;
      await state.init();
      await expect(provision.provision({})).rejects.toThrow(/no usb keystore backend/i);
    });
  });

  describe('inspectLocalKeyMaterial', () => {
    it('counts what is still held locally, per type', async () => {
      await bootReady({
        [PRIV_KEY]: [PRIV],
        [PUB_KEY]: [PUB, PUB],
        [AUTOCRYPT_KEY]: {'a@b.c': {keydata: 'x'}, 'd@e.f': {keydata: 'y'}}
      });
      const summary = await provision.inspectLocalKeyMaterial();
      expect(summary.privateKeys).toBe(1);
      expect(summary.publicKeys).toBe(2);
      expect(summary.autocrypt).toBe(2);
      expect(summary.keyrings).toEqual([MAIN]);
    });

    it('ignores settings and tokens', async () => {
      await bootReady({
        'mvelo.preferences': {security: {}},
        'mvelo.watchlist': [{site: 'x'}],
        'mvelo.oauth.gmail': {token: 'x'}
      });
      const summary = await provision.inspectLocalKeyMaterial();
      expect(summary).toEqual({keyrings: [], privateKeys: 0, publicKeys: 0, autocrypt: 0});
    });

    it('changes nothing', async () => {
      await bootReady({[PRIV_KEY]: [PRIV]});
      await provision.inspectLocalKeyMaterial();
      expect(store[PRIV_KEY]).toEqual([PRIV]);
      expect(mocks.writeFile).not.toHaveBeenCalled();
    });
  });

  describe('migrateLocalKeyMaterial', () => {
    it('moves key material to the device and deletes the local copy', async () => {
      await bootReady({[PRIV_KEY]: [PRIV], [PUB_KEY]: [PUB]});
      const {moved, failed} = await provision.migrateLocalKeyMaterial();
      expect(failed).toEqual([]);
      expect(moved).toContain(PRIV_KEY);
      expect(device[`${keyringDir}/private.asc`]).toContain('BEGIN PGP PRIVATE KEY BLOCK');
      expect(device[`${keyringDir}/public.asc`]).toContain('BEGIN PGP PUBLIC KEY BLOCK');
      expect(store[PRIV_KEY]).toBeUndefined();
      expect(store[PUB_KEY]).toBeUndefined();
    });

    // The whole point of write-verify-delete: a failure must not lose the only copy.
    it('keeps the local copy when the device write fails', async () => {
      await bootReady({[PRIV_KEY]: [PRIV]});
      mocks.writeFile.mockRejectedValue(new Error('device full'));
      const {moved, failed} = await provision.migrateLocalKeyMaterial();
      expect(moved).not.toContain(PRIV_KEY);
      expect(failed).toEqual([{key: PRIV_KEY, error: 'device full'}]);
      expect(store[PRIV_KEY]).toEqual([PRIV]);
    });

    it('keeps the local copy when the written data does not read back identically', async () => {
      await bootReady({[PRIV_KEY]: [PRIV]});
      // Only the key file must read back wrong; the marker still has to be
      // readable or assertUsable() would fail the device before migration starts.
      mocks.writeFile.mockResolvedValue(undefined); // pretend success, write nothing
      const realRead = mocks.readFile.getMockImplementation();
      mocks.readFile.mockImplementation(path =>
        (path.endsWith('.asc') ? Promise.resolve('truncated') : realRead(path)));
      const {moved, failed} = await provision.migrateLocalKeyMaterial();
      expect(moved).not.toContain(PRIV_KEY);
      expect(failed[0].error).toMatch(/verification/i);
      expect(store[PRIV_KEY]).toEqual([PRIV]);
    });

    it('moves what it can and reports the rest, rather than aborting', async () => {
      await bootReady({[PRIV_KEY]: [PRIV], [PUB_KEY]: [PUB]});
      mocks.writeFile.mockImplementation((path, content) => {
        if (path.endsWith('private.asc')) {
          return Promise.reject(new Error('nope'));
        }
        device[path] = content;
        return Promise.resolve();
      });
      const {moved, failed} = await provision.migrateLocalKeyMaterial();
      expect(moved).toContain(PUB_KEY);
      expect(failed.map(f => f.key)).toEqual([PRIV_KEY]);
      expect(store[PRIV_KEY]).toEqual([PRIV]);
      expect(store[PUB_KEY]).toBeUndefined();
    });

    it('splits attributes, leaving the keyring registry local', async () => {
      await bootReady({[ATTR_KEY]: {[MAIN]: {default_key: 'ff00', sanitized: true}}});
      await provision.migrateLocalKeyMaterial();
      expect(store[ATTR_KEY]).toEqual({[MAIN]: {sanitized: true}});
      expect(JSON.parse(device['mailvelope-keystore/keyrings/attributes.json']))
      .toEqual({[MAIN]: {default_key: 'ff00'}});
    });

    it('leaves settings and tokens alone', async () => {
      await bootReady({
        'mvelo.preferences': {security: {}},
        'mvelo.oauth.gmail': {token: 'x'},
        [PRIV_KEY]: [PRIV]
      });
      await provision.migrateLocalKeyMaterial();
      expect(store['mvelo.preferences']).toEqual({security: {}});
      expect(store['mvelo.oauth.gmail']).toEqual({token: 'x'});
    });

    it('refuses to run without a usable device', async () => {
      seedStorage({[constants.USB_CONFIG_KEY]: {keystoreId: KEYSTORE_ID}, [PRIV_KEY]: [PRIV]});
      seedDevice({});
      mocks.probe.mockResolvedValue({available: true, permission: 'granted', configured: true});
      await state.init();
      expect(state.getState()).toBe(constants.USB_STATE.ABSENT);
      await expect(provision.migrateLocalKeyMaterial()).rejects.toMatchObject({
        code: constants.USB_KEYSTORE_UNAVAILABLE
      });
      expect(store[PRIV_KEY]).toEqual([PRIV]);
    });

    // Those stale [] entries left behind when USB mode is first enabled.
    it('clears empty key arrays too', async () => {
      await bootReady({[PRIV_KEY]: [], [PUB_KEY]: []});
      const {moved, failed} = await provision.migrateLocalKeyMaterial();
      expect(failed).toEqual([]);
      expect(moved).toContain(PRIV_KEY);
      expect(store[PRIV_KEY]).toBeUndefined();
    });
  });

  describe('disable', () => {
    it('drops this profile config and handle, leaving the device untouched', async () => {
      await bootReady({[PRIV_KEY]: [PRIV]});
      const before = {...device};
      const status = await provision.disable();
      expect(await state.getConfig()).toBeUndefined();
      expect(handleStore.remove).toHaveBeenCalled();
      expect(device).toEqual(before);
      expect(status.state).toBe(constants.USB_STATE.NOT_CONFIGURED);
      expect(state.isEnabled()).toBe(false);
    });
  });

  describe('diagnostics', () => {
    it('lists keyring directories when the device is ready', async () => {
      await bootReady();
      mocks.listDir.mockImplementation(path =>
        Promise.resolve(path.endsWith('/keyrings') ? ['6162', 'not-hex'] : ['private.asc']));
      const result = await provision.diagnostics();
      expect(result.keyrings).toEqual([{
        dir: '6162',
        files: ['private.asc'],
        onDevice: {publicKeys: 0, privateKeys: 0},
        loaded: null
      }]);
    });

    // The number the settings page shows: what the device holds, next to what the
    // extension actually loaded. A read that returns part of a file leaves a keyring
    // that looks ordinary but short, and this is the only place the two are compared.
    it('counts the keys on the device and the keys held in memory', async () => {
      await bootReady();
      seedDevice({
        'mailvelope-keystore/keyrings/6162/public.asc': `${PUB}\n${PUB}`,
        'mailvelope-keystore/keyrings/6162/private.asc': PRIV
      });
      mocks.listDir.mockImplementation(path =>
        Promise.resolve(path.endsWith('/keyrings') ? ['6162'] : ['public.asc', 'private.asc']));
      const result = await provision.diagnostics({loaded: {6162: {publicKeys: 1, privateKeys: 1}}});
      expect(result.keyrings[0].onDevice).toEqual({publicKeys: 2, privateKeys: 1});
      expect(result.keyrings[0].loaded).toEqual({publicKeys: 1, privateKeys: 1});
    });

    // A keyring file that is not there yet is not a failure, and must not read as a
    // shortfall against what is loaded.
    it('counts a missing key file as no keys rather than failing', async () => {
      await bootReady();
      mocks.listDir.mockImplementation(path =>
        Promise.resolve(path.endsWith('/keyrings') ? ['6162'] : []));
      const result = await provision.diagnostics();
      expect(result.keyrings[0].onDevice).toEqual({publicKeys: 0, privateKeys: 0});
      // detail carries the status's own null when nothing went wrong; a message here
      // would mean the missing file had been treated as a read failure.
      expect(result.detail).toBeFalsy();
    });

    it('reports state without touching the device when it is not ready', async () => {
      seedStorage({[constants.USB_CONFIG_KEY]: {keystoreId: KEYSTORE_ID}});
      seedDevice({});
      mocks.probe.mockResolvedValue({available: true, permission: 'granted', configured: true});
      await state.init();
      mocks.listDir.mockClear();
      const result = await provision.diagnostics();
      expect(result.state).toBe(constants.USB_STATE.ABSENT);
      expect(result.keyrings).toEqual([]);
      expect(mocks.listDir).not.toHaveBeenCalled();
    });
  });
  describe('migration onto a device that already holds a keystore', () => {
    const DEVICE_KEY = '-----BEGIN PGP PRIVATE KEY BLOCK-----\ndevice\n-----END PGP PRIVATE KEY BLOCK-----';
    const LOCAL_KEY = '-----BEGIN PGP PRIVATE KEY BLOCK-----\nlocal\n-----END PGP PRIVATE KEY BLOCK-----';
    const PRIV_PATH = `mailvelope-keystore/keyrings/${Buffer.from(MAIN).toString('hex')}/private.asc`;

    // Migration wrote the local value straight over the device path, so moving keys
    // onto a device that already had a keystore destroyed its keys -- recoverable
    // only from the .bak the atomic write happens to leave behind. Observed on real
    // hardware: a device key was replaced by the migrated one.
    it('keeps the keys already on the device', async () => {
      seedStorage({
        [constants.USB_CONFIG_KEY]: {keystoreId: KEYSTORE_ID},
        [`mvelo.keyring.${MAIN}.privateKeys`]: [LOCAL_KEY]
      });
      seedDevice({
        'mailvelope-keystore/keystore.json': JSON.stringify({keystoreId: KEYSTORE_ID}),
        [PRIV_PATH]: DEVICE_KEY
      });
      mocks.probe.mockResolvedValue({available: true, permission: 'granted', configured: true});
      await state.init();

      const result = await provision.migrateLocalKeyMaterial();
      expect(result.failed).toEqual([]);
      expect(device[PRIV_PATH]).toContain('device');
      expect(device[PRIV_PATH]).toContain('local');
      expect(result.added).toBe(1);
    });

    it('does not duplicate a key already present on the device', async () => {
      seedStorage({
        [constants.USB_CONFIG_KEY]: {keystoreId: KEYSTORE_ID},
        [`mvelo.keyring.${MAIN}.privateKeys`]: [DEVICE_KEY]
      });
      seedDevice({
        'mailvelope-keystore/keystore.json': JSON.stringify({keystoreId: KEYSTORE_ID}),
        [PRIV_PATH]: DEVICE_KEY
      });
      mocks.probe.mockResolvedValue({available: true, permission: 'granted', configured: true});
      await state.init();

      const result = await provision.migrateLocalKeyMaterial();
      const blocks = device[PRIV_PATH].match(/BEGIN PGP PRIVATE KEY BLOCK/g) || [];
      expect(blocks).toHaveLength(1);
      expect(result.added).toBe(0);
    });

    // attributes.json named a default key that migration had just removed from the
    // keystore, leaving the device internally inconsistent.
    it('does not repoint the default key of an existing keystore', async () => {
      const attrPath = 'mailvelope-keystore/keyrings/attributes.json';
      seedStorage({
        [constants.USB_CONFIG_KEY]: {keystoreId: KEYSTORE_ID},
        'mvelo.keyring.attributes': {[MAIN]: {default_key: 'incoming'}}
      });
      seedDevice({
        'mailvelope-keystore/keystore.json': JSON.stringify({keystoreId: KEYSTORE_ID}),
        [attrPath]: JSON.stringify({[MAIN]: {default_key: 'already-there'}})
      });
      mocks.probe.mockResolvedValue({available: true, permission: 'granted', configured: true});
      await state.init();

      await provision.migrateLocalKeyMaterial();
      expect(JSON.parse(device[attrPath])[MAIN].default_key).toBe('already-there');
    });
  });
});
