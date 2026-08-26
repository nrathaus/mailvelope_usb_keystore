/**
 * Copyright (C) 2017 Mailvelope GmbH
 * Licensed under the GNU Affero General Public License version 3
 */

export class KeyStoreBase {
  constructor(keyringId) {
    this.clear();
    this.id = keyringId;
  }

  clear() {
    this.publicKeys = new KeyArray([]);
    this.privateKeys = new KeyArray([]);
  }

  /**
   * Reload every key from the backing store, publishing the result in one step.
   *
   * clear() followed by load() leaves the keyring visibly empty, then visibly
   * half-full, for as long as the load takes: microseconds for a keyring of two keys,
   * seconds for one of four hundred read off a removable device. Anything that reads
   * in that window gets a partial keyring -- a key list missing most of its rows, or
   * a decryption that cannot find a key which is in fact present -- and nothing tells
   * it to look again, because a short list is not obviously a wrong one.
   *
   * Loading into a detached store and swapping the result in makes a concurrent
   * reader see either the old generation whole or the new one whole.
   */
  async reload() {
    const fresh = new this.constructor(this.id);
    await fresh.load();
    for (const [property, value] of Object.entries(fresh)) {
      // Whatever load() populated: the two key arrays, plus defaultKeyFpr for GnuPG.
      if (property !== 'id') {
        this[property] = value;
      }
    }
  }

  getKeysForId(keyId, deep) {
    let result = [];
    result = result.concat(this.publicKeys.getForId(keyId, deep) || []);
    result = result.concat(this.privateKeys.getForId(keyId, deep) || []);
    return result.length ? result : null;
  }

  removeKeysForId(keyId) {
    let result = [];
    result = result.concat(this.publicKeys.removeForId(keyId) || []);
    result = result.concat(this.privateKeys.removeForId(keyId) || []);
    return result.length ? result : null;
  }

  getForAddress(email) {
    const result = [];
    result.push(...this.publicKeys.getForAddress(email));
    result.push(...this.privateKeys.getForAddress(email));
    return result;
  }

  getAllKeys() {
    return this.publicKeys.keys.concat(this.privateKeys.keys);
  }
}

class KeyArray {
  constructor(keys) {
    this.keys = keys;
  }

  getForAddress(email) {
    const results = [];
    for (let i = 0; i < this.keys.length; i++) {
      if (emailCheck(email, this.keys[i])) {
        results.push(this.keys[i]);
      }
    }
    return results;
  }

  getForId(keyId, deep) {
    for (let i = 0; i < this.keys.length; i++) {
      if (keyIdCheck(keyId, this.keys[i])) {
        return this.keys[i];
      }
      if (deep && this.keys[i].subkeys.length) {
        for (let j = 0; j < this.keys[i].subkeys.length; j++) {
          if (keyIdCheck(keyId, this.keys[i].subkeys[j])) {
            return this.keys[i];
          }
        }
      }
    }
    return null;
  }

  push(key) {
    return this.keys.push(key);
  }

  removeForId(keyId) {
    for (let i = 0; i < this.keys.length; i++) {
      if (keyIdCheck(keyId, this.keys[i])) {
        return this.keys.splice(i, 1)[0];
      }
    }
    return null;
  }
}

function emailCheck(email, key) {
  email = email.toLowerCase();
  // escape email before using in regular expression
  const emailEsc = email.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const emailRegex = new RegExp(`<${emailEsc}>`);
  const userIds = key.getUserIDs();
  for (let i = 0; i < userIds.length; i++) {
    const userId = userIds[i].toLowerCase();
    if (email === userId || emailRegex.test(userId)) {
      return true;
    }
  }
  return false;
}

function keyIdCheck(keyId, key) {
  if (keyId.length === 16) {
    return keyId === key.getKeyID().toHex();
  }
  return keyId === key.getFingerprint();
}
