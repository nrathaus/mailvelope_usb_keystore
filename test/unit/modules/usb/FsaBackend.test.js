/**
 * Copyright (C) 2026 Noam Rathaus
 * Licensed under the GNU Affero General Public License version 3
 *
 * Covers the File System Access backend against a fake filesystem.
 *
 * Worth testing here rather than by hand: the write path stages to a .tmp file,
 * verifies it round-trips, rotates the previous generation to .bak and only then
 * moves the staged file into place. A device pulled mid-save must leave either the
 * old file or a recoverable .bak, never a truncated primary — and that is precisely
 * what a tmpfs test directory cannot demonstrate.
 */

jest.mock('../../../../src/modules/usb/handleStore', () => ({
  get: jest.fn(),
  put: jest.fn(),
  remove: jest.fn()
}));

/** Minimal stand-in for the FileSystemDirectoryHandle tree. */
function makeDir(name = '') {
  const entries = new Map();
  const dir = {
    kind: 'directory',
    name,
    entries,
    permission: 'granted',
    async queryPermission() {
      return dir.permission;
    },
    async getDirectoryHandle(childName, {create = false} = {}) {
      if (!entries.has(childName)) {
        if (!create) {
          throw Object.assign(new Error('missing'), {name: 'NotFoundError'});
        }
        entries.set(childName, makeDir(childName));
      }
      const child = entries.get(childName);
      if (child.kind !== 'directory') {
        throw Object.assign(new Error('not a directory'), {name: 'TypeMismatchError'});
      }
      return child;
    },
    async getFileHandle(childName, {create = false} = {}) {
      if (!entries.has(childName)) {
        if (!create) {
          throw Object.assign(new Error('missing'), {name: 'NotFoundError'});
        }
        entries.set(childName, makeFile(childName, dir, ''));
      }
      return entries.get(childName);
    },
    async removeEntry(childName) {
      if (!entries.has(childName)) {
        throw Object.assign(new Error('missing'), {name: 'NotFoundError'});
      }
      entries.delete(childName);
    },
    async* keys() {
      for (const key of entries.keys()) {
        yield key;
      }
    }
  };
  return dir;
}

function makeFile(name, parent, content) {
  const file = {
    kind: 'file',
    name,
    parent,
    content,
    async getFile() {
      return {text: async () => file.content};
    },
    async createWritable() {
      let buffer = '';
      return {
        write: async chunk => {
          buffer += chunk;
        },
        close: async () => {
          file.content = buffer;
        }
      };
    },
    async move(destDir, newName) {
      file.parent.entries.delete(file.name);
      file.name = newName ?? file.name;
      file.parent = destDir;
      destDir.entries.set(file.name, file);
    }
  };
  return file;
}

/** Read a file's content from the tree by '/'-separated path, or undefined. */
function read(root, path) {
  const parts = path.split('/');
  let node = root;
  for (const part of parts.slice(0, -1)) {
    node = node.entries.get(part);
    if (!node) {
      return undefined;
    }
  }
  return node.entries.get(parts[parts.length - 1])?.content;
}

describe('usb/FsaBackend', () => {
  let FsaBackend; let handleStore; let backend; let root; let errors;

  beforeEach(() => {
    jest.resetModules();
    handleStore = require('../../../../src/modules/usb/handleStore');
    FsaBackend = require('../../../../src/modules/usb/FsaBackend').default;
    errors = require('../../../../src/modules/usb/backend');
    root = makeDir('device');
    handleStore.get.mockResolvedValue(root);
    backend = new FsaBackend();
  });

  describe('probe', () => {
    it('reports not configured when no handle is stored', async () => {
      handleStore.get.mockResolvedValue(undefined);
      expect(await backend.probe()).toEqual({available: false, permission: 'prompt', configured: false});
    });

    it('reports the permission when it has not been granted', async () => {
      root.permission = 'prompt';
      expect(await backend.probe()).toEqual({available: false, permission: 'prompt', configured: true});
    });

    it('reports available when granted', async () => {
      expect(await backend.probe()).toEqual({available: true, permission: 'granted', configured: true});
    });

    // Some builds reject queryPermission once the underlying entry is gone.
    it('survives queryPermission throwing', async () => {
      root.queryPermission = async () => {
        throw new Error('entry gone');
      };
      expect(await backend.probe()).toEqual({available: false, permission: 'prompt', configured: true});
    });
  });

  describe('readFile', () => {
    it('reads a nested file', async () => {
      const dir = await root.getDirectoryHandle('mailvelope-keystore', {create: true});
      const file = await dir.getFileHandle('keystore.json', {create: true});
      file.content = '{"a":1}';
      expect(await backend.readFile('mailvelope-keystore/keystore.json')).toBe('{"a":1}');
    });

    it('raises NotFoundError for a missing file', async () => {
      await root.getDirectoryHandle('mailvelope-keystore', {create: true});
      await expect(backend.readFile('mailvelope-keystore/nope.json'))
      .rejects.toBeInstanceOf(errors.NotFoundError);
    });

    it('raises NotFoundError for a missing directory', async () => {
      await expect(backend.readFile('no-such-dir/file.json'))
      .rejects.toBeInstanceOf(errors.NotFoundError);
    });

    // An unplugged device surfaces as NotReadableError rather than NotFoundError.
    it('maps an unreadable device to DeviceUnavailableError', async () => {
      root.getDirectoryHandle = async () => {
        throw Object.assign(new Error('gone'), {name: 'NotReadableError'});
      };
      await expect(backend.readFile('mailvelope-keystore/keystore.json'))
      .rejects.toBeInstanceOf(errors.DeviceUnavailableError);
    });

    it('raises DeviceUnavailableError when no handle is configured', async () => {
      handleStore.get.mockResolvedValue(undefined);
      await expect(backend.readFile('a/b')).rejects.toBeInstanceOf(errors.DeviceUnavailableError);
    });
  });

  describe('writeFile', () => {
    it('creates parent directories and writes the content', async () => {
      await backend.writeFile('mailvelope-keystore/keyrings/abc/private.asc', 'KEY');
      expect(read(root, 'mailvelope-keystore/keyrings/abc/private.asc')).toBe('KEY');
    });

    it('leaves no .tmp file behind on success', async () => {
      await backend.writeFile('mailvelope-keystore/a.asc', 'ONE');
      const dir = root.entries.get('mailvelope-keystore');
      expect([...dir.entries.keys()]).not.toContain('a.asc.tmp');
    });

    it('keeps the previous generation as .bak when overwriting', async () => {
      await backend.writeFile('mailvelope-keystore/a.asc', 'ONE');
      await backend.writeFile('mailvelope-keystore/a.asc', 'TWO');
      expect(read(root, 'mailvelope-keystore/a.asc')).toBe('TWO');
      expect(read(root, 'mailvelope-keystore/a.asc.bak')).toBe('ONE');
    });

    it('replaces an existing .bak rather than failing on the second overwrite', async () => {
      await backend.writeFile('mailvelope-keystore/a.asc', 'ONE');
      await backend.writeFile('mailvelope-keystore/a.asc', 'TWO');
      await backend.writeFile('mailvelope-keystore/a.asc', 'THREE');
      expect(read(root, 'mailvelope-keystore/a.asc')).toBe('THREE');
      expect(read(root, 'mailvelope-keystore/a.asc.bak')).toBe('TWO');
    });

    // The point of staging: a bad write must not replace good data.
    it('does not touch the primary file when the staged copy fails verification', async () => {
      await backend.writeFile('mailvelope-keystore/a.asc', 'GOOD');
      const dir = root.entries.get('mailvelope-keystore');
      const originalGetFileHandle = dir.getFileHandle.bind(dir);
      dir.getFileHandle = async (name, opts) => {
        const handle = await originalGetFileHandle(name, opts);
        if (name.endsWith('.tmp')) {
          // Simulate a short write: the staged file does not match what we asked for.
          handle.getFile = async () => ({text: async () => 'TRUNCATED'});
        }
        return handle;
      };
      await expect(backend.writeFile('mailvelope-keystore/a.asc', 'NEW')).rejects.toThrow(/verification/i);
      expect(read(root, 'mailvelope-keystore/a.asc')).toBe('GOOD');
    });

    it('reports a device pulled mid-write as DeviceUnavailableError', async () => {
      const dir = await root.getDirectoryHandle('mailvelope-keystore', {create: true});
      dir.getFileHandle = async () => {
        throw Object.assign(new Error('gone'), {name: 'NotReadableError'});
      };
      await expect(backend.writeFile('mailvelope-keystore/a.asc', 'X'))
      .rejects.toBeInstanceOf(errors.DeviceUnavailableError);
    });

    // move() is Chromium 111+; without it the write is less safe but must still work.
    it('falls back to a direct write when move() is unavailable', async () => {
      const dir = await root.getDirectoryHandle('mailvelope-keystore', {create: true});
      const originalGetFileHandle = dir.getFileHandle.bind(dir);
      dir.getFileHandle = async (name, opts) => {
        const handle = await originalGetFileHandle(name, opts);
        delete handle.move;
        return handle;
      };
      await backend.writeFile('mailvelope-keystore/a.asc', 'ONE');
      expect(read(root, 'mailvelope-keystore/a.asc')).toBe('ONE');
      expect([...dir.entries.keys()]).not.toContain('a.asc.tmp');
    });
  });

  describe('removeFile', () => {
    it('removes an existing file', async () => {
      await backend.writeFile('mailvelope-keystore/a.asc', 'ONE');
      await backend.removeFile('mailvelope-keystore/a.asc');
      expect(read(root, 'mailvelope-keystore/a.asc')).toBeUndefined();
    });

    it('treats a missing file as already gone', async () => {
      await root.getDirectoryHandle('mailvelope-keystore', {create: true});
      await expect(backend.removeFile('mailvelope-keystore/nope.asc')).resolves.toBeUndefined();
    });

    it('treats a missing directory as already gone', async () => {
      await expect(backend.removeFile('no-dir/nope.asc')).resolves.toBeUndefined();
    });
  });

  describe('listDir', () => {
    it('lists entry names', async () => {
      await backend.writeFile('mailvelope-keystore/keyrings/abc/private.asc', 'K');
      await backend.writeFile('mailvelope-keystore/keyrings/def/private.asc', 'K');
      expect((await backend.listDir('mailvelope-keystore/keyrings')).sort()).toEqual(['abc', 'def']);
    });

    it('returns nothing for a missing directory', async () => {
      expect(await backend.listDir('mailvelope-keystore/keyrings')).toEqual([]);
    });
  });

  describe('handle caching', () => {
    it('reads the stored handle once and reuses it', async () => {
      await backend.probe();
      await backend.probe();
      expect(handleStore.get).toHaveBeenCalledTimes(1);
    });

    it('re-reads after the cache is cleared, so a re-provision takes effect', async () => {
      await backend.probe();
      backend.clearCache();
      await backend.probe();
      expect(handleStore.get).toHaveBeenCalledTimes(2);
    });
  });
});
