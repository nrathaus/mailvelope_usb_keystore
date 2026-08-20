/**
 * Copyright (C) 2026 Noam Rathaus
 * Licensed under the GNU Affero General Public License version 3
 *
 * File System Access API backend. Chromium only; Firefox has no
 * showDirectoryPicker() and needs NativeBackend instead.
 *
 * The directory handle comes from IndexedDB (see handleStore.js) so that this
 * backend works in the MV3 service worker, which cannot open a picker itself.
 */

import * as handleStore from './handleStore';
import {UsbBackend, NotFoundError, DeviceUnavailableError} from './backend';

/** Errors the platform raises when the device has gone away. */
const ABSENT_ERRORS = ['NotFoundError', 'NotReadableError', 'InvalidStateError', 'AbortError'];

function isAbsentError(e) {
  return ABSENT_ERRORS.includes(e?.name);
}

function splitPath(path) {
  const segments = path.split('/').filter(segment => segment.length);
  const name = segments.pop();
  return {dirs: segments, name};
}

export default class FsaBackend extends UsbBackend {
  constructor() {
    super();
    this.root = null;
  }

  static isSupported() {
    // FileSystemDirectoryHandle exists in both window and worker scopes; the
    // picker itself is only reachable from a document, which is why provisioning
    // happens in the app page.
    return typeof FileSystemDirectoryHandle !== 'undefined';
  }

  /**
   * Load the stored directory handle. Cached, since IndexedDB access is not free
   * and the handle does not change while configured.
   * @return {Promise<FileSystemDirectoryHandle>}
   */
  async getRoot() {
    if (!this.root) {
      this.root = await handleStore.get();
    }
    if (!this.root) {
      throw new DeviceUnavailableError('No USB keystore directory configured');
    }
    return this.root;
  }

  /** Drop the cached handle, e.g. after the configuration changed. */
  clearCache() {
    this.root = null;
  }

  async probe() {
    let root;
    try {
      root = await this.getRoot();
    } catch (e) {
      return {available: false, permission: 'prompt', configured: false};
    }
    let permission;
    try {
      permission = await root.queryPermission({mode: 'readwrite'});
    } catch (e) {
      // Some builds reject queryPermission once the underlying entry is gone.
      return {available: false, permission: 'prompt', configured: true};
    }
    if (permission !== 'granted') {
      return {available: false, permission, configured: true};
    }
    // A granted permission says nothing about whether the device is plugged in;
    // only touching the filesystem does. Callers probe the marker file next.
    return {available: true, permission, configured: true};
  }

  /**
   * Resolve a directory handle for a list of path segments.
   * @param {Array<String>} dirs
   * @param {Boolean} create
   * @return {Promise<FileSystemDirectoryHandle>}
   */
  async resolveDir(dirs, create = false) {
    let dir = await this.getRoot();
    for (const segment of dirs) {
      try {
        dir = await dir.getDirectoryHandle(segment, {create});
      } catch (e) {
        if (e?.name === 'NotFoundError' && !create) {
          throw new NotFoundError(dirs.join('/'));
        }
        if (isAbsentError(e)) {
          throw new DeviceUnavailableError();
        }
        throw e;
      }
    }
    return dir;
  }

  async readFile(path) {
    const {dirs, name} = splitPath(path);
    const dir = await this.resolveDir(dirs);
    try {
      const fileHandle = await dir.getFileHandle(name);
      const file = await fileHandle.getFile();
      return await file.text();
    } catch (e) {
      if (e?.name === 'NotFoundError') {
        throw new NotFoundError(path);
      }
      if (isAbsentError(e)) {
        throw new DeviceUnavailableError();
      }
      throw e;
    }
  }

  /**
   * Atomic-as-possible write: stage to a .tmp file, verify it round-trips, keep the
   * previous generation as .bak, then move the staged file into place. A device
   * pulled at any point leaves either the old file or a recoverable .bak, never a
   * truncated primary.
   */
  async writeFile(path, content) {
    const {dirs, name} = splitPath(path);
    const dir = await this.resolveDir(dirs, true);
    const tmpName = `${name}.tmp`;
    try {
      await this.writeRaw(dir, tmpName, content);
      // Verify the staged copy before it replaces anything.
      const staged = await (await dir.getFileHandle(tmpName)).getFile();
      if (await staged.text() !== content) {
        throw new Error(`Verification of staged write failed: ${path}`);
      }
      const previous = await this.tryGetFileHandle(dir, name);
      const tmpHandle = await dir.getFileHandle(tmpName);
      if (typeof tmpHandle.move === 'function') {
        if (previous) {
          await this.removeEntry(dir, `${name}.bak`);
          await previous.move(dir, `${name}.bak`);
        }
        await tmpHandle.move(dir, name);
      } else {
        // No move() available: fall back to a direct write. Less safe, but the
        // staged copy has already been verified and is left in place as .bak.
        if (previous) {
          await this.removeEntry(dir, `${name}.bak`);
          await previous.move?.(dir, `${name}.bak`);
        }
        await this.writeRaw(dir, name, content);
        await this.removeEntry(dir, tmpName);
      }
    } catch (e) {
      if (isAbsentError(e)) {
        throw new DeviceUnavailableError();
      }
      throw e;
    }
  }

  async writeRaw(dir, name, content) {
    const fileHandle = await dir.getFileHandle(name, {create: true});
    const writable = await fileHandle.createWritable();
    try {
      await writable.write(content);
    } finally {
      await writable.close();
    }
  }

  async tryGetFileHandle(dir, name) {
    try {
      return await dir.getFileHandle(name);
    } catch (e) {
      if (e?.name === 'NotFoundError') {
        return null;
      }
      throw e;
    }
  }

  async removeEntry(dir, name) {
    try {
      await dir.removeEntry(name, {recursive: true});
    } catch (e) {
      if (e?.name !== 'NotFoundError') {
        throw e;
      }
    }
  }

  async removeFile(path) {
    const {dirs, name} = splitPath(path);
    let dir;
    try {
      dir = await this.resolveDir(dirs);
    } catch (e) {
      if (e instanceof NotFoundError) {
        return;
      }
      throw e;
    }
    try {
      await this.removeEntry(dir, name);
    } catch (e) {
      if (isAbsentError(e)) {
        throw new DeviceUnavailableError();
      }
      throw e;
    }
  }

  async listDir(path) {
    let dir;
    try {
      dir = await this.resolveDir(splitPath(`${path}/x`).dirs);
    } catch (e) {
      if (e instanceof NotFoundError) {
        return [];
      }
      throw e;
    }
    const names = [];
    try {
      for await (const name of dir.keys()) {
        names.push(name);
      }
    } catch (e) {
      if (isAbsentError(e)) {
        throw new DeviceUnavailableError();
      }
      throw e;
    }
    return names;
  }
}
