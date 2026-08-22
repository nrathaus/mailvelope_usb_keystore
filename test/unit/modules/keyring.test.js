// Mock the heavy crypto imports so requiring keyring.js stays cheap.
jest.mock('emailjs-mime-builder', () => ({__esModule: true, default: jest.fn()}));
jest.mock('openpgp', () => ({
  readKey: jest.fn(),
  generateKey: jest.fn(),
  config: {},
  enums: {}
}));
jest.mock('@openpgp/web-stream-tools', () => ({readToEnd: jest.fn()}), {virtual: true});
jest.mock('../../../src/modules/KeyringGPG', () => ({default: class {}}));
jest.mock('../../../src/modules/KeyStoreGPG', () => ({default: class {}}));
jest.mock('../../../src/modules/usb/state', () => ({isEnabled: jest.fn(() => false), isUsable: jest.fn(() => true)}));
jest.mock('../../../src/lib/browser.runtime', () => ({
  gpgme: null,
  initNativeMessaging: jest.fn()
}));

import {GNUPG_KEYRING_ID, MAIN_KEYRING_ID} from '../../../src/lib/constants';

function seedStorage(initial = {}) {
  const store = {...initial};
  chrome.storage.local.get.mockImplementation(key =>
    Promise.resolve(key in store ? {[key]: store[key]} : {}));
  chrome.storage.local.set.mockImplementation(obj => {
    Object.assign(store, obj);
    return Promise.resolve();
  });
  return store;
}

describe('keyring hasAnyPrivateKey', () => {
  let hasAnyPrivateKey;

  beforeEach(() => {
    jest.resetModules();
    chrome.storage.local.get.mockReset();
    chrome.storage.local.set.mockReset();
    // keyring.js never calls init() here, so keyringInitialized stays pending —
    // any awaited gate would hang the test rather than resolve.
    ({hasAnyPrivateKey} = require('../../../src/modules/keyring'));
  });

  it('returns false when no keyring attributes are stored', async () => {
    seedStorage({});
    await expect(hasAnyPrivateKey()).resolves.toBe(false);
  });

  it('returns false when the attributes map is empty', async () => {
    seedStorage({'mvelo.keyring.attributes': {}});
    await expect(hasAnyPrivateKey()).resolves.toBe(false);
  });

  it('returns true when the main keyring has non-empty private-key armor', async () => {
    seedStorage({
      'mvelo.keyring.attributes': {[MAIN_KEYRING_ID]: {}},
      [`mvelo.keyring.${MAIN_KEYRING_ID}.privateKeys`]: ['-----BEGIN PGP PRIVATE KEY BLOCK-----']
    });
    await expect(hasAnyPrivateKey()).resolves.toBe(true);
  });

  it('returns false when the main keyring is present but has no private keys', async () => {
    seedStorage({
      'mvelo.keyring.attributes': {[MAIN_KEYRING_ID]: {}},
      [`mvelo.keyring.${MAIN_KEYRING_ID}.privateKeys`]: []
    });
    await expect(hasAnyPrivateKey()).resolves.toBe(false);
  });

  it('returns false when the private-key armor entry is absent', async () => {
    seedStorage({'mvelo.keyring.attributes': {[MAIN_KEYRING_ID]: {}}});
    await expect(hasAnyPrivateKey()).resolves.toBe(false);
  });

  it('returns true when only a GnuPG keyring is registered (no native messaging)', async () => {
    seedStorage({'mvelo.keyring.attributes': {[GNUPG_KEYRING_ID]: {}}});
    await expect(hasAnyPrivateKey()).resolves.toBe(true);
  });

  it('returns true when a second local keyring carries the private key', async () => {
    const otherKeyringId = 'localhost|#|other';
    seedStorage({
      'mvelo.keyring.attributes': {[MAIN_KEYRING_ID]: {}, [otherKeyringId]: {}},
      [`mvelo.keyring.${MAIN_KEYRING_ID}.privateKeys`]: [],
      [`mvelo.keyring.${otherKeyringId}.privateKeys`]: ['-----BEGIN PGP PRIVATE KEY BLOCK-----']
    });
    await expect(hasAnyPrivateKey()).resolves.toBe(true);
  });
});

// GnuPG keeps secret keys in the OS home directory, which is exactly what a USB
// keystore exists to avoid, so it must disappear from key selection and from the
// keyring listing while that backend is active.
//
// The module-level mocks below make gpgme unavailable, which makes initGPG() delete
// the GnuPG keyring outright -- so these tests override them per-case, otherwise the
// keyring would never be registered and the assertions would pass vacuously.
describe('keyring GnuPG exclusion in USB mode', () => {
  let keyring; let usbState;

  function loadWithGnupgAvailable() {
    jest.resetModules();
    jest.doMock('../../../src/lib/browser.runtime', () => ({
      gpgme: {Keyring: {}},
      initNativeMessaging: jest.fn()
    }));
    jest.doMock('../../../src/modules/KeyStoreGPG', () => ({
      __esModule: true,
      default: class {
        constructor(id) {
          this.id = id;
        }

        async load() {}

        clear() {}

        getAllKeys() {
          return [];
        }
      }
    }));
    jest.doMock('../../../src/modules/KeyringGPG', () => ({
      __esModule: true,
      default: class {
        constructor(id, keystore) {
          this.id = id;
          this.keystore = keystore;
        }

        getAttr() {
          return {};
        }
      }
    }));
    usbState = require('../../../src/modules/usb/state');
    keyring = require('../../../src/modules/keyring');
  }

  beforeEach(() => {
    chrome.storage.local.get.mockReset();
    chrome.storage.local.set.mockReset();
    // init() only awaits initGPG() when this is not the first load of the session;
    // on a first load it is fired and forgotten, so the GnuPG keyring would not yet
    // be registered when the assertions run.
    chrome.storage.session.get.mockResolvedValue({keyringLoaded: true});
  });

  async function withBothKeyrings() {
    seedStorage({'mvelo.keyring.attributes': {[MAIN_KEYRING_ID]: {}, [GNUPG_KEYRING_ID]: {}}});
    await keyring.init();
  }

  it('registers and lists the GnuPG keyring when keys are stored locally', async () => {
    loadWithGnupgAvailable();
    usbState.isEnabled.mockReturnValue(false);
    await withBothKeyrings();
    expect(Object.keys(await keyring.getAllKeyringAttr())).toContain(GNUPG_KEYRING_ID);
    expect((await keyring.getAll()).map(k => k.id)).toContain(GNUPG_KEYRING_ID);
  });

  it('hides the GnuPG keyring from the listing in USB mode', async () => {
    loadWithGnupgAvailable();
    usbState.isEnabled.mockReturnValue(true);
    await withBothKeyrings();
    const attrs = await keyring.getAllKeyringAttr();
    expect(Object.keys(attrs)).not.toContain(GNUPG_KEYRING_ID);
    expect(Object.keys(attrs)).toContain(MAIN_KEYRING_ID);
  });

  it('excludes the GnuPG keyring from getAll in USB mode', async () => {
    loadWithGnupgAvailable();
    usbState.isEnabled.mockReturnValue(true);
    await withBothKeyrings();
    const ids = (await keyring.getAll()).map(k => k.id);
    expect(ids).not.toContain(GNUPG_KEYRING_ID);
    expect(ids).toContain(MAIN_KEYRING_ID);
  });
});

// init() treats a failure while building a keyring as a broken keyring and deletes
// it from the attribute map. Sanitising writes the keyring back, and that write
// fails when the USB device holding it is absent -- so an unplugged device at
// startup could deregister the keyring, permanently for client-API keyrings whose
// keys would then be stranded on the device.
describe('keyring sanitisation with an absent USB keystore', () => {
  let keyring; let usbState;

  const API_KEYRING = 'example.com|#|someapp';

  beforeEach(() => {
    jest.resetModules();
    chrome.storage.local.get.mockReset();
    chrome.storage.local.set.mockReset();
    chrome.storage.session.get.mockResolvedValue({keyringLoaded: true});
    usbState = require('../../../src/modules/usb/state');
    keyring = require('../../../src/modules/keyring');
    // A keyring that has never been sanitised, so sanitiseKeyring() will try to write.
    seedStorage({'mvelo.keyring.attributes': {[MAIN_KEYRING_ID]: {}, [API_KEYRING]: {}}});
  });

  it('keeps the keyring registered when the device is absent', async () => {
    usbState.isEnabled.mockReturnValue(true);
    usbState.isUsable.mockReturnValue(false);
    await keyring.init();
    const attrs = await keyring.getAllKeyringAttr();
    expect(Object.keys(attrs)).toContain(API_KEYRING);
    // Deferred, not done: the flag stays unset so it happens on a later start.
    expect(attrs[API_KEYRING].sanitized).toBeUndefined();
  });

  it('sanitises normally when the device is present', async () => {
    usbState.isEnabled.mockReturnValue(true);
    usbState.isUsable.mockReturnValue(true);
    await keyring.init();
    const attrs = await keyring.getAllKeyringAttr();
    expect(attrs[API_KEYRING].sanitized).toBe(true);
  });

  it('sanitises normally with no USB keystore configured', async () => {
    usbState.isEnabled.mockReturnValue(false);
    await keyring.init();
    const attrs = await keyring.getAllKeyringAttr();
    expect(attrs[API_KEYRING].sanitized).toBe(true);
  });
});
