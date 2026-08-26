/**
 * Copyright (C) 2026 Noam Rathaus
 * Licensed under the GNU Affero General Public License version 3
 *
 * A keyring is reloaded by clearing it and loading it again, and both call sites did
 * exactly that. With two keys the gap between the two is invisible; with four hundred
 * read off a USB device it lasts seconds, and anything reading in that window sees a
 * fraction of the keyring -- a key list missing most of its rows, or a decryption
 * that cannot find a key that is present. Nothing asks again afterwards, because a
 * short list does not look wrong.
 */

import {KeyStoreBase} from '../../../src/modules/keyStore';

/** A store whose load() arrives one key at a time, as the real ones do. */
class SlowStore extends KeyStoreBase {
  constructor(id) {
    super(id);
    this.generation = SlowStore.generation;
    this.defaultKeyFpr = '';
  }

  async load() {
    for (const key of SlowStore.contents) {
      await Promise.resolve();
      this.publicKeys.push(`${key}-${this.generation}`);
    }
    this.defaultKeyFpr = `default-${this.generation}`;
  }
}
SlowStore.contents = ['a', 'b', 'c', 'd'];
SlowStore.generation = 1;

describe('KeyStoreBase.reload', () => {
  let store;

  beforeEach(async () => {
    SlowStore.generation = 1;
    store = new SlowStore('localhost|#|mailvelope');
    await store.load();
    SlowStore.generation = 2;
  });

  it('leaves the previous keys in place until the new ones have all arrived', async () => {
    const observed = [];
    const reloading = store.reload();
    // Watch the keyring the way a page does: read it repeatedly while the reload runs.
    for (let i = 0; i < SlowStore.contents.length * 2; i++) {
      await Promise.resolve();
      observed.push(store.publicKeys.keys.length);
    }
    await reloading;
    // Never a count between the two generations, and never zero.
    expect(observed.every(count => count === SlowStore.contents.length)).toBe(true);
  });

  it('replaces the keys with the new generation', async () => {
    await store.reload();
    expect(store.publicKeys.keys).toEqual(['a-2', 'b-2', 'c-2', 'd-2']);
  });

  // KeyStoreGPG's load() also sets defaultKeyFpr, which a swap of only the key arrays
  // would leave behind on the discarded store.
  it('carries over everything else load() populates', async () => {
    await store.reload();
    expect(store.defaultKeyFpr).toBe('default-2');
    expect(store.id).toBe('localhost|#|mailvelope');
  });

  it('reflects a keyring that has become empty', async () => {
    SlowStore.contents = [];
    try {
      await store.reload();
      expect(store.publicKeys.keys).toEqual([]);
    } finally {
      SlowStore.contents = ['a', 'b', 'c', 'd'];
    }
  });
});
