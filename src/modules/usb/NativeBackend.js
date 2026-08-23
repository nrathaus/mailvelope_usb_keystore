/**
 * Copyright (C) 2026 Noam Rathaus
 * Licensed under the GNU Affero General Public License version 3
 *
 * Native messaging backend, for browsers with no File System Access API.
 *
 * Firefox cannot reach a removable device from an extension at all: no
 * showDirectoryPicker, and the origin-private file system is not the device. A small
 * native host (native-host/mailvelope_usb_keystore.py) provides the same five
 * operations the File System Access backend does, over stdio.
 *
 * Two consequences worth knowing, both of which make this path arguably better than
 * the in-browser one:
 *
 *   - There is no directory picker, and none is needed: the host enumerates mounted
 *     removable devices, so the UI can offer a list instead of a file dialog.
 *   - The configured location is a real path, which the UI can show in full. The
 *     File System Access API deliberately withholds that.
 *
 * The host is a program with the user's filesystem authority, so it -- not this
 * class -- is where confinement is enforced. Nothing here should be treated as a
 * security boundary; see the host's own security notes.
 */

import {MvError} from '../../lib/util';
import {UsbBackend, NotFoundError, DeviceUnavailableError} from './backend';

/** Must match the "name" in the installed native messaging manifest. */
export const HOST_NAME = 'mailvelope_usb_keystore';

/** Protocol version this client understands. */
export const PROTOCOL_VERSION = 1;

/** Host error codes that mean "the device is not there", rather than a fault. */
const ABSENT_CODES = ['not_found', 'io_error', 'root_not_mounted'];

export default class NativeBackend extends UsbBackend {
  constructor() {
    super();
    this.root = null;
    this.available = null; // null = not yet probed
  }

  /**
   * Whether native messaging is reachable at all.
   *
   * Only checks that the API exists; whether the host is actually installed can
   * only be discovered by talking to it, which probe() does.
   * @return {Boolean}
   */
  static isSupported() {
    return typeof chrome !== 'undefined' && Boolean(chrome.runtime?.sendNativeMessage);
  }

  /** The device path this backend operates on. Set from the stored configuration. */
  setRoot(root) {
    this.root = root;
  }

  clearCache() {
    this.available = null;
  }

  /**
   * One request/response exchange with the host.
   *
   * Uses sendNativeMessage rather than a long-lived connectNative port: every
   * operation here is self-contained, and a one-shot exchange cannot leave a stale
   * port to reason about. The cost is a process spawn per call, which is
   * inconsequential next to reading a file from a USB stick.
   * @param {Object} request
   * @return {Promise<Object>} the host's result
   */
  async send(request) {
    let response;
    try {
      response = await chrome.runtime.sendNativeMessage(HOST_NAME, request);
    } catch (e) {
      // No host installed, or it failed to start. Not the same as no device.
      throw new MvError(
        `The Mailvelope USB keystore helper is not available: ${e.message}`,
        'USB_HOST_UNAVAILABLE'
      );
    }
    if (!response) {
      throw new MvError('The USB keystore helper returned no response', 'USB_HOST_UNAVAILABLE');
    }
    if (response.error) {
      if (ABSENT_CODES.includes(response.error)) {
        if (response.error === 'not_found') {
          throw new NotFoundError(request.path ?? request.root ?? '');
        }
        throw new DeviceUnavailableError(response.message || 'device unavailable');
      }
      throw new MvError(response.message || response.error, `USB_HOST_${response.error.toUpperCase()}`);
    }
    return response.result ?? {};
  }

  /**
   * Mounted removable devices, for the UI to offer instead of a picker.
   * @return {Promise<Array<{path: String, label: String, writable: Boolean}>>}
   */
  async listDevices() {
    const {devices} = await this.send({op: 'listDevices'});
    return devices ?? [];
  }

  /**
   * Check the host is present, speaks a version we understand, and that the
   * configured device is mounted.
   */
  async probe() {
    let hello;
    try {
      hello = await this.send({op: 'hello'});
    } catch (e) {
      // Distinguish "no helper installed" from "no device": the UI needs to tell
      // the user to install something, not to plug something in.
      return {available: false, permission: 'prompt', configured: false, hostMissing: true};
    }
    if (hello.version !== PROTOCOL_VERSION) {
      throw new MvError(
        `The USB keystore helper speaks version ${hello.version}, this extension expects ${PROTOCOL_VERSION}`,
        'USB_HOST_VERSION'
      );
    }
    if (!this.root) {
      return {available: false, permission: 'granted', configured: false};
    }
    try {
      await this.send({op: 'probe', root: this.root});
    } catch (e) {
      if (e instanceof DeviceUnavailableError || e instanceof NotFoundError) {
        return {available: false, permission: 'granted', configured: true};
      }
      throw e;
    }
    // No permission model here: authority comes from having installed the host, so
    // there is no per-session grant to lose. Reported as granted so the state
    // machine never asks the user to reconnect.
    return {available: true, permission: 'granted', configured: true};
  }

  async readFile(path) {
    this.requireRoot();
    const {content} = await this.send({op: 'read', root: this.root, path});
    return content;
  }

  async writeFile(path, content) {
    this.requireRoot();
    // The host stages, fsyncs and renames, keeping the previous generation as .bak,
    // so the atomicity guarantee matches the File System Access backend.
    await this.send({op: 'write', root: this.root, path, content});
  }

  async removeFile(path) {
    this.requireRoot();
    await this.send({op: 'remove', root: this.root, path});
  }

  async listDir(path) {
    this.requireRoot();
    const {names} = await this.send({op: 'list', root: this.root, path});
    return names ?? [];
  }

  requireRoot() {
    if (!this.root) {
      throw new DeviceUnavailableError('No USB keystore device configured');
    }
  }
}
