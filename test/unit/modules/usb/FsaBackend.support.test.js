/**
 * Copyright (C) 2026 Noam Rathaus
 * Licensed under the GNU Affero General Public License version 3
 *
 * Firefox implements FileSystemDirectoryHandle for the origin-private file system
 * but has no showDirectoryPicker, so a feature test on the handle alone reports
 * support in a browser that cannot reach a USB device at all. The picker cannot be
 * tested for directly -- it does not exist in the background context in any browser
 * -- so the browser itself is the signal.
 */

describe('FsaBackend.isSupported', () => {
  let FsaBackend;

  function load({chrome: isChrome, handle}) {
    jest.resetModules();
    jest.doMock('../../../../src/lib/browser', () => ({isChrome, isFirefox: !isChrome}));
    if (handle) {
      global.FileSystemDirectoryHandle = class {};
    } else {
      delete global.FileSystemDirectoryHandle;
    }
    FsaBackend = require('../../../../src/modules/usb/FsaBackend').default;
  }

  afterEach(() => {
    delete global.FileSystemDirectoryHandle;
    jest.dontMock('../../../../src/lib/browser');
  });

  it('is supported on Chromium with the API present', () => {
    load({chrome: true, handle: true});
    expect(FsaBackend.isSupported()).toBe(true);
  });

  // The case that matters: Firefox has the handle class but no picker.
  it('is not supported on Firefox even though the handle class exists', () => {
    load({chrome: false, handle: true});
    expect(FsaBackend.isSupported()).toBe(false);
  });

  it('is not supported on Chromium without the API', () => {
    load({chrome: true, handle: false});
    expect(FsaBackend.isSupported()).toBe(false);
  });
});
