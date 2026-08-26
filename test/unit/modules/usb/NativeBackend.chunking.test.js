/**
 * Copyright (C) 2026 Noam Rathaus
 * Licensed under the GNU Affero General Public License version 3
 *
 * A browser drops a native message over 1 MB before the extension sees it, and the
 * helper refused an oversized message in the other direction -- so importing a
 * public keyring exported with `gpg --export --armor` failed at the save with
 * "message of 1392580 bytes exceeds the limit", and could not have been read back
 * even if it had been written.
 *
 * These tests drive the backend against a fake helper that implements the offset
 * protocol, because the part that can silently corrupt a keyring is the bookkeeping:
 * a chunk written at the wrong offset, or a character split across two chunks.
 */

describe('NativeBackend chunking', () => {
  let NativeBackend;
  let savedRuntime;
  let host;

  /** Bytes of content per message, as the backend uses. */
  const CHUNK = 384 * 1024;

  /**
   * A fake helper: one in-memory file per path, with the host's own offset rules.
   */
  function fakeHost() {
    const files = new Map();
    const staged = new Map();
    const requests = [];
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    const handle = request => {
      requests.push(request);
      if (request.op === 'hello') {
        return {version: 1, chunkBytes: CHUNK, maxFileBytes: 16 * 1024 * 1024};
      }
      if (request.op === 'write') {
        const data = encoder.encode(request.content);
        const previous = staged.get(request.path) ?? new Uint8Array(0);
        const offset = request.offset ?? 0;
        if (offset && offset !== previous.length) {
          return {error: 'bad_offset', message: `staged write holds ${previous.length} bytes`};
        }
        const base = offset ? previous : new Uint8Array(0);
        const merged = new Uint8Array(base.length + data.length);
        merged.set(base);
        merged.set(data, base.length);
        staged.set(request.path, merged);
        if (request.final) {
          files.set(request.path, merged);
          staged.delete(request.path);
        }
        return {ok: true};
      }
      if (request.op === 'read') {
        const bytes = files.get(request.path);
        if (!bytes) {
          return {error: 'not_found', message: 'no such file'};
        }
        const offset = request.offset ?? 0;
        let end = Math.min(offset + Math.min(request.maxBytes ?? CHUNK, CHUNK), bytes.length);
        while (end > offset && end < bytes.length && (bytes[end] & 0xc0) === 0x80) {
          end -= 1;
        }
        return {
          content: decoder.decode(bytes.subarray(offset, end)),
          offset,
          bytesRead: end - offset,
          nextOffset: end,
          size: bytes.length,
          eof: end >= bytes.length
        };
      }
      return {error: 'unknown_op', message: request.op};
    };
    return {
      files,
      requests,
      send: request => {
        const answer = handle(request);
        return Promise.resolve(answer.error ? answer : {result: answer});
      },
      text: path => decoder.decode(files.get(path))
    };
  }

  function backendFor(fake) {
    global.chrome.runtime = {
      sendNativeMessage: jest.fn((_name, request) => fake.send(request)),
      lastError: undefined
    };
    const backend = new NativeBackend();
    backend.setRoot('/run/media/u/STICK');
    return backend;
  }

  beforeEach(() => {
    jest.resetModules();
    savedRuntime = global.chrome.runtime;
    NativeBackend = require('../../../../src/modules/usb/NativeBackend').default;
    host = fakeHost();
  });

  afterEach(() => {
    global.chrome.runtime = savedRuntime;
  });

  // The failure that started this: a whole exported public keyring.
  it('writes and reads back a keyring larger than a single message', async () => {
    const block = `${'-----BEGIN PGP PUBLIC KEY BLOCK-----\n'}${'mQINBF'.repeat(200)}\n-----END PGP PUBLIC KEY BLOCK-----\n`;
    const keyring = block.repeat(1200); // comfortably over 1 MB
    expect(new TextEncoder().encode(keyring).length).toBeGreaterThan(1024 * 1024);
    const backend = backendFor(host);
    await backend.writeFile('mailvelope-keystore/keyrings/00/public.asc', keyring);
    const read = await backend.readFile('mailvelope-keystore/keyrings/00/public.asc');
    expect(read).toBe(keyring);
  });

  it('sends chunks in order, each starting where the last ended', async () => {
    const content = 'x'.repeat(CHUNK * 2 + 17);
    const backend = backendFor(host);
    await backend.writeFile('mailvelope-keystore/public.asc', content);
    const writes = host.requests.filter(r => r.op === 'write');
    expect(writes.map(r => r.offset)).toEqual([0, CHUNK, CHUNK * 2]);
    expect(writes.map(r => r.final)).toEqual([false, false, true]);
  });

  // One message per small file: the common case must not pay for the large one.
  it('writes a small file in a single final message', async () => {
    const backend = backendFor(host);
    await backend.writeFile('mailvelope-keystore/meta.json', '{"a":1}');
    const writes = host.requests.filter(r => r.op === 'write');
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({offset: 0, final: true, content: '{"a":1}'});
  });

  it('writes an empty file rather than nothing at all', async () => {
    const backend = backendFor(host);
    await backend.writeFile('mailvelope-keystore/meta.json', '');
    expect(host.requests.filter(r => r.op === 'write')).toHaveLength(1);
    expect(host.text('mailvelope-keystore/meta.json')).toBe('');
  });

  // A user ID with a non-ASCII name lands on a chunk boundary sooner or later. Split
  // a character across two chunks and both halves are lost, silently.
  it('never splits a multi-byte character across chunks', async () => {
    // 'é' is two bytes, so the boundary falls inside a character.
    const content = `${'a'.repeat(CHUNK - 1)}${'é'.repeat(2000)}`;
    const backend = backendFor(host);
    await backend.writeFile('mailvelope-keystore/public.asc', content);
    expect(host.text('mailvelope-keystore/public.asc')).toBe(content);
    expect(await backend.readFile('mailvelope-keystore/public.asc')).toBe(content);
  });

  it('reports a missing file as not found, chunked read or not', async () => {
    const backend = backendFor(host);
    await expect(backend.readFile('mailvelope-keystore/public.asc')).rejects.toMatchObject({
      code: 'USB_NOT_FOUND'
    });
  });

  // A helper that claims neither progress nor the end of the file would otherwise be
  // read in a loop that never ends.
  it('gives up on a helper that stops making progress', async () => {
    global.chrome.runtime = {
      sendNativeMessage: jest.fn(() => Promise.resolve({
        result: {content: '', offset: 0, bytesRead: 0, nextOffset: 0, size: 10, eof: false}
      })),
      lastError: undefined
    };
    const backend = new NativeBackend();
    backend.setRoot('/run/media/u/STICK');
    await expect(backend.readFile('mailvelope-keystore/public.asc')).rejects.toMatchObject({
      code: 'USB_HOST_PROTOCOL'
    });
  });
});
