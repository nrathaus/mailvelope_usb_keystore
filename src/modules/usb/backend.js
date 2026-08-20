/**
 * Copyright (C) 2026 Noam Rathaus
 * Licensed under the GNU Affero General Public License version 3
 *
 * Backend interface for USB keystore I/O.
 *
 * Two implementations are planned:
 *   - FsaBackend    File System Access API, Chromium only
 *   - NativeBackend native messaging host, required for Firefox
 *
 * All paths are '/'-separated and relative to the device root directory
 * (the directory the user picked), e.g. 'mailvelope-keystore/keystore.json'.
 */

import {MvError} from '../../lib/util';
import {USB_KEYSTORE_UNAVAILABLE} from './constants';

/** Thrown when a path does not exist on the device. */
export class NotFoundError extends MvError {
  constructor(path) {
    super(`Not found on USB keystore: ${path}`, 'USB_NOT_FOUND');
  }
}

/** Thrown when the device cannot be reached at all. */
export class DeviceUnavailableError extends MvError {
  constructor(message = 'USB keystore is not available') {
    super(message, USB_KEYSTORE_UNAVAILABLE);
  }
}

export class UsbBackend {
  /**
   * Whether this backend can work in the current browser.
   * @return {Boolean}
   */
  static isSupported() {
    return false;
  }

  /**
   * Check that the device is reachable.
   * @return {Promise<{available: Boolean, permission: String}>} permission is
   *   'granted', 'prompt' or 'denied'
   */
  async probe() {
    throw new Error('not implemented');
  }

  /**
   * Read a UTF-8 text file.
   * @param {String} path
   * @return {Promise<String>}
   * @throws {NotFoundError|DeviceUnavailableError}
   */
  async readFile(path) { // eslint-disable-line no-unused-vars
    throw new Error('not implemented');
  }

  /**
   * Write a UTF-8 text file, creating parent directories as needed.
   * The write must be atomic from the reader's point of view: a device pulled
   * mid-write must not leave a half-written file in place of the old one.
   * @param {String} path
   * @param {String} content
   * @return {Promise<undefined>}
   */
  async writeFile(path, content) { // eslint-disable-line no-unused-vars
    throw new Error('not implemented');
  }

  /**
   * Remove a file. Missing files are not an error.
   * @param {String} path
   * @return {Promise<undefined>}
   */
  async removeFile(path) { // eslint-disable-line no-unused-vars
    throw new Error('not implemented');
  }

  /**
   * List the entry names of a directory. A missing directory yields [].
   * @param {String} path
   * @return {Promise<Array<String>>}
   */
  async listDir(path) { // eslint-disable-line no-unused-vars
    throw new Error('not implemented');
  }
}
