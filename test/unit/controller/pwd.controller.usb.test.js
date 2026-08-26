/**
 * Copyright (C) 2026 Noam Rathaus
 * Licensed under the GNU Affero General Public License version 3
 *
 * The passphrase dialog's "remember password" box was offered from the stored
 * preference, which defaults to on -- but pwdCache.set() refuses to cache anything
 * while keys live on a USB device, so the box was checked and did nothing.
 *
 * The second half matters as much: the dialog now reports the box off, and taking
 * that as the user's choice would overwrite their preference with a value they were
 * never offered, so disabling the keystore would not restore it.
 */

jest.mock('../../../src/modules/usb/state', () => ({isConfigured: jest.fn()}));
jest.mock('../../../src/modules/prefs', () => ({
  prefs: {security: {password_cache: true}},
  update: jest.fn()
}));
jest.mock('../../../src/modules/pwdCache', () => ({unlock: jest.fn(), get: jest.fn()}));
jest.mock('../../../src/modules/key', () => ({getUserInfo: jest.fn()}));
jest.mock('../../../src/modules/uiLog', () => ({push: jest.fn()}));
jest.mock('../../../src/controller/sub.controller', () => ({
  SubController: class {
    constructor() {
      this.handlers = new Map();
    }

    on(event, handler) {
      this.handlers.set(event, handler.bind(this));
    }
  }
}));

describe('passphrase dialog with a USB keystore', () => {
  let controller; let usbState; let prefs; let pwdCache; let key;

  const KEY = {getKeyID: () => ({toHex: () => 'a1b2c3d4'})};

  beforeEach(() => {
    jest.resetModules();
    usbState = require('../../../src/modules/usb/state');
    prefs = require('../../../src/modules/prefs');
    pwdCache = require('../../../src/modules/pwdCache');
    key = require('../../../src/modules/key');
    key.getUserInfo.mockResolvedValue({userId: 'Tester <tester@test.com>'});
    prefs.prefs.security.password_cache = true;
    const PwdController = require('../../../src/controller/pwd.controller').default;
    controller = new PwdController();
    controller.options = {key: KEY, reason: ''};
    controller.ports = {pwdDialog: {emit: jest.fn()}};
  });

  function initData() {
    return controller.handlers.get('pwd-dialog-init')()
    .then(() => controller.ports.pwdDialog.emit.mock.calls[0][1]);
  }

  async function confirm(cache) {
    controller.passwordRequest = Promise.withResolvers();
    pwdCache.unlock.mockResolvedValue(KEY);
    await controller.handlers.get('pwd-dialog-ok')({password: 'secret', cache});
    return controller.passwordRequest.promise;
  }

  it('offers the box from the preference when no keystore is configured', async () => {
    usbState.isConfigured.mockResolvedValue(false);
    await expect(initData()).resolves.toMatchObject({cache: true, cacheDisabled: false});
  });

  // The bug: checked, and caching nothing.
  it('offers the box off and disabled while keys are on a USB device', async () => {
    usbState.isConfigured.mockResolvedValue(true);
    await expect(initData()).resolves.toMatchObject({cache: false, cacheDisabled: true});
  });

  it('records a changed choice as the preference in the normal case', async () => {
    usbState.isConfigured.mockResolvedValue(false);
    await confirm(false);
    expect(prefs.update).toHaveBeenCalledWith({security: {password_cache: false}});
  });

  // Otherwise the dialog's forced-off box silently turns the user's own setting off,
  // and turning the keystore off later would leave it that way.
  it('leaves the preference alone while keys are on a USB device', async () => {
    usbState.isConfigured.mockResolvedValue(true);
    await confirm(false);
    expect(prefs.update).not.toHaveBeenCalled();
    expect(prefs.prefs.security.password_cache).toBe(true);
  });
});
