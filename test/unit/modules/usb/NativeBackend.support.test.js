/**
 * Copyright (C) 2026 Noam Rathaus
 * Licensed under the GNU Affero General Public License version 3
 *
 * Firefox hides permission-gated APIs until the permission is granted, and
 * nativeMessaging is optional. Testing for chrome.runtime.sendNativeMessage
 * therefore made support read as false until granted -- while the UI that asks for
 * the grant was itself gated on support. Unreachable by construction, and exactly
 * what happened in Firefox.
 */

describe('NativeBackend.isSupported', () => {
  let NativeBackend;
  let savedRuntime;
  let savedPermissions;

  beforeEach(() => {
    jest.resetModules();
    savedRuntime = global.chrome.runtime;
    savedPermissions = global.chrome.permissions;
    NativeBackend = require('../../../../src/modules/usb/NativeBackend').default;
  });

  afterEach(() => {
    global.chrome.runtime = savedRuntime;
    global.chrome.permissions = savedPermissions;
  });

  it('is supported when the API is already exposed', () => {
    global.chrome.runtime = {sendNativeMessage: jest.fn()};
    global.chrome.permissions = undefined;
    expect(NativeBackend.isSupported()).toBe(true);
  });

  // The case that was broken: Firefox before the permission is granted.
  it('is supported when the API is hidden but the permission can be requested', () => {
    global.chrome.runtime = {};
    global.chrome.permissions = {request: jest.fn()};
    expect(NativeBackend.isSupported()).toBe(true);
  });

  it('is not supported when neither the API nor a way to request it exists', () => {
    global.chrome.runtime = {};
    global.chrome.permissions = undefined;
    expect(NativeBackend.isSupported()).toBe(false);
  });

  describe('calling convention', () => {
    // Firefox exposes chrome.* as an alias for browser.*, and the two have
    // historically differed on promise versus callback. Assuming promises would make
    // a callback-only implementation resolve to undefined, which the class reports as
    // "the helper returned no response" -- a missing-helper message for a working
    // helper.
    it('works when the API returns a promise', async () => {
      global.chrome.runtime = {
        sendNativeMessage: jest.fn(() => Promise.resolve({result: {version: 1}})),
        lastError: undefined
      };
      const backend = new NativeBackend();
      await expect(backend.send({op: 'hello'})).resolves.toEqual({version: 1});
    });

    it('works when the API only calls back', async () => {
      global.chrome.runtime = {
        sendNativeMessage: jest.fn((_name, _msg, cb) => cb({result: {version: 1}})),
        lastError: undefined
      };
      const backend = new NativeBackend();
      await expect(backend.send({op: 'hello'})).resolves.toEqual({version: 1});
    });

    it('surfaces lastError from the callback path as a helper failure', async () => {
      global.chrome.runtime = {
        sendNativeMessage: jest.fn((_name, _msg, cb) => {
          global.chrome.runtime.lastError = {message: 'no such native application'};
          cb(undefined);
        }),
        lastError: undefined
      };
      const backend = new NativeBackend();
      await expect(backend.send({op: 'hello'})).rejects.toMatchObject({
        code: 'USB_HOST_UNAVAILABLE'
      });
      global.chrome.runtime.lastError = undefined;
    });
  });

  describe('probe', () => {
    function withHost(reply) {
      global.chrome.runtime = {
        sendNativeMessage: jest.fn(() => Promise.resolve(reply)),
        lastError: undefined
      };
    }

    // probe() discarded the helper's answer and returned a fixed object, so a
    // write-protected device still reported as fully usable and the write was
    // attempted anyway. The helper is the only source that can answer this before
    // a write, since the File System Access API cannot.
    it('forwards writability reported by the helper', async () => {
      withHost({result: {version: 1, writable: false}});
      const backend = new NativeBackend();
      backend.setRoot('/run/media/u/STICK');
      // hello and probe both answer from the same stub, which is enough here.
      const result = await backend.probe();
      expect(result.writable).toBe(false);
    });

    it('treats a writable device as writable', async () => {
      withHost({result: {version: 1, writable: true}});
      const backend = new NativeBackend();
      backend.setRoot('/run/media/u/STICK');
      expect((await backend.probe()).writable).toBe(true);
    });

    // An older helper that does not report the field must not be read as read-only.
    it('assumes writable when the helper does not say', async () => {
      withHost({result: {version: 1}});
      const backend = new NativeBackend();
      backend.setRoot('/run/media/u/STICK');
      expect((await backend.probe()).writable).toBe(true);
    });
  });

  // Calling without the permission must name the permission, not blame the helper:
  // telling someone to install software they already have is worse than silence.
  it('reports a missing permission distinctly from a missing helper', async () => {
    global.chrome.runtime = {};
    global.chrome.permissions = {request: jest.fn()};
    const backend = new NativeBackend();
    await expect(backend.send({op: 'hello'})).rejects.toMatchObject({
      code: 'USB_HOST_PERMISSION'
    });
  });
});
