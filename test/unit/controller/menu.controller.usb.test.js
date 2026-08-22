/**
 * Copyright (C) 2026 Noam Rathaus
 * Licensed under the GNU Affero General Public License version 3
 *
 * The toolbar menu decides between the normal menu and the onboarding one from
 * whether a private key can be found. With a USB keystore that reads as "no keys"
 * whenever the device is detached, which would offer onboarding -- and so invite
 * someone whose key is safe on the device to generate a replacement.
 */

jest.mock('../../../src/modules/keyring', () => ({hasAnyPrivateKey: jest.fn()}));
jest.mock('../../../src/modules/usb/state', () => ({isEnabled: jest.fn(), isUsable: jest.fn(), hadKeys: jest.fn()}));
jest.mock('../../../src/modules/prefs', () => ({prefs: {}}));
jest.mock('../../../src/lib/analytics', () => ({shouldSeeConsentDialog: jest.fn()}));
jest.mock('../../../src/controller/sub.controller', () => ({
  SubController: class {
    constructor() {
      this.handlers = new Map();
    }

    on(event, handler) {
      this.handlers.set(event, handler.bind(this));
    }
  },
  reloadFrames: jest.fn(),
  setAppDataSlot: jest.fn()
}));

describe('menu controller setup state with a USB keystore', () => {
  let MenuController; let keyring; let usbState; let controller;

  beforeEach(() => {
    jest.resetModules();
    keyring = require('../../../src/modules/keyring');
    usbState = require('../../../src/modules/usb/state');
    MenuController = require('../../../src/controller/menu.controller').default;
    controller = new MenuController();
  });

  function getIsSetupDone() {
    return controller.handlers.get('get-is-setup-done')();
  }

  it('reports setup done when a private key is readable', async () => {
    usbState.isEnabled.mockReturnValue(false);
    keyring.hasAnyPrivateKey.mockResolvedValue(true);
    await expect(getIsSetupDone()).resolves.toEqual({isSetupDone: true});
  });

  it('reports setup not done on a fresh profile with no keystore', async () => {
    usbState.isEnabled.mockReturnValue(false);
    keyring.hasAnyPrivateKey.mockResolvedValue(false);
    await expect(getIsSetupDone()).resolves.toEqual({isSetupDone: false});
  });

  // The case that matters: keys exist but sit on a detached device, so the storage
  // read reports none. Offering onboarding here would invite a replacement key.
  it('still reports setup done when a device known to hold keys is detached', async () => {
    usbState.isEnabled.mockReturnValue(true);
    usbState.isUsable.mockReturnValue(false);
    usbState.hadKeys.mockResolvedValue(true);
    keyring.hasAnyPrivateKey.mockResolvedValue(false);
    await expect(getIsSetupDone()).resolves.toEqual({isSetupDone: true});
    // It must not even ask: the answer cannot be trusted while detached.
    expect(keyring.hasAnyPrivateKey).not.toHaveBeenCalled();
  });

  // ...but a keystore that was configured and never used is genuinely unset up, so
  // onboarding must still be offered rather than suppressed for every detached case.
  it('offers onboarding when a detached device never held a key', async () => {
    usbState.isEnabled.mockReturnValue(true);
    usbState.isUsable.mockReturnValue(false);
    usbState.hadKeys.mockResolvedValue(false);
    await expect(getIsSetupDone()).resolves.toEqual({isSetupDone: false});
  });

  // With the device connected the read is trustworthy again, so a genuinely empty
  // keystore should still offer onboarding.
  it('reports setup not done when the device is connected and holds no keys', async () => {
    usbState.isEnabled.mockReturnValue(true);
    usbState.isUsable.mockReturnValue(true);
    keyring.hasAnyPrivateKey.mockResolvedValue(false);
    await expect(getIsSetupDone()).resolves.toEqual({isSetupDone: false});
  });
});
