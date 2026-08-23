/**
 * Copyright (C) 2026 Noam Rathaus
 * Licensed under the GNU Affero General Public License version 3
 *
 * Decides, for every chrome.storage.local key Mailvelope touches, whether the
 * value is crypto material that belongs on the USB device or ordinary settings
 * that stay local.
 *
 * This module is the single enforcement point for the requirement that no crypto
 * information is stored anywhere but the device. Keeping that decision in one
 * place means it cannot drift per call site, and an upstream commit that adds a
 * new crypto storage key is caught here rather than silently writing to disk.
 */

import {DEVICE_ROOT, KEYRINGS_DIR, USB_CONFIG_KEY} from './constants';

/** Storage key holding the keyring attribute map. Split; see below. */
export const KEYRING_ATTRIBUTES_KEY = 'mvelo.keyring.attributes';

/** Armored key arrays, one storage key per keyring and type. */
const KEY_ARRAY_RE = /^mvelo\.keyring\.(.+)\.(publicKeys|privateKeys)$/;

/** Autocrypt records: public keys harvested from message headers. */
const AUTOCRYPT_RE = /^mvelo\.autocrypt\.(.+)$/;

/**
 * Attribute fields inside KEYRING_ATTRIBUTES_KEY that are crypto information and
 * move to the device. Everything else in that map — notably the set of keyring
 * IDs itself and the 'sanitized' flag — stays local.
 *
 * The split exists for a practical reason as well as a privacy one: keyring.init()
 * reads this map at startup to learn which keyrings exist. Were the whole map on
 * the device, starting the browser without it would leave the keyring subsystem
 * unable to initialise at all, rather than merely without keys.
 */
const CRYPTO_ATTR_FIELDS = ['default_key', 'primary_key', 'sync_data', 'key_binding'];

/**
 * Storage keys known to hold no crypto material. Anything not matched by the
 * crypto patterns and not on this list still passes through to local storage, but
 * its value is screened for key material first (see containsKeyMaterial).
 */
const LOCAL_ALLOWLIST = [
  'mvelo.preferences',
  'mvelo.watchlist',
  USB_CONFIG_KEY,
  // Diagnostics, off by default, and by policy free of key material. Allowlisted so
  // the leak safety net does not have to guess about them.
  'mvelo.usb.debug',
  'mvelo.usb.debugEnabled'
];
const LOCAL_ALLOWLIST_PREFIXES = ['mvelo.oauth.'];

/** Armor headers that identify OpenPGP key material in a serialized value. */
const ARMOR_MARKERS = [
  '-----BEGIN PGP PRIVATE KEY BLOCK-----',
  '-----BEGIN PGP PUBLIC KEY BLOCK-----'
];

export const TARGET = {DEVICE: 'device', LOCAL: 'local', SPLIT: 'split'};

/**
 * Encode a keyring ID for use as a directory name.
 *
 * Hex rather than base64: keyring IDs contain '|' (KEYRING_DELIMITER is '|#|'),
 * which is illegal on Windows/FAT/exFAT, and those filesystems are also
 * case-insensitive — so a case-sensitive encoding such as base64 could map two
 * distinct keyring IDs onto one directory. Hex is single-case and safe.
 * @param {String} keyringId
 * @return {String}
 */
export function encodeKeyringId(keyringId) {
  return Array.from(new TextEncoder().encode(keyringId))
  .map(byte => byte.toString(16).padStart(2, '0'))
  .join('');
}

function keyringDir(keyringId) {
  return `${DEVICE_ROOT}/${KEYRINGS_DIR}/${encodeKeyringId(keyringId)}`;
}

/**
 * Classify a storage key.
 * @param {String} storageKey
 * @return {{target: String, path?: String, format?: String, keyringId?: String}}
 *   format is 'asc' for concatenated armored keys, 'json' otherwise
 */
export function classify(storageKey) {
  if (storageKey === KEYRING_ATTRIBUTES_KEY) {
    return {
      target: TARGET.SPLIT,
      path: `${DEVICE_ROOT}/${KEYRINGS_DIR}/attributes.json`,
      format: 'json'
    };
  }
  const keyArray = KEY_ARRAY_RE.exec(storageKey);
  if (keyArray) {
    const [, keyringId, type] = keyArray;
    const name = type === 'publicKeys' ? 'public.asc' : 'private.asc';
    return {
      target: TARGET.DEVICE,
      path: `${keyringDir(keyringId)}/${name}`,
      format: 'asc',
      keyringId
    };
  }
  const autocrypt = AUTOCRYPT_RE.exec(storageKey);
  if (autocrypt) {
    const [, keyringId] = autocrypt;
    return {
      target: TARGET.DEVICE,
      path: `${keyringDir(keyringId)}/autocrypt.json`,
      format: 'json',
      keyringId
    };
  }
  return {target: TARGET.LOCAL};
}

/**
 * Is this storage key known to be free of crypto material?
 * @param {String} storageKey
 * @return {Boolean}
 */
export function isAllowedLocal(storageKey) {
  return LOCAL_ALLOWLIST.includes(storageKey) ||
    LOCAL_ALLOWLIST_PREFIXES.some(prefix => storageKey.startsWith(prefix));
}

/**
 * Safety net for storage keys this module does not know about: refuse to let
 * OpenPGP key material reach local storage even if it arrives under an
 * unrecognised key. Cheap enough to run on every unknown write.
 * @param {Any} value
 * @return {Boolean}
 */
export function containsKeyMaterial(value) {
  if (value === undefined || value === null) {
    return false;
  }
  let serialized;
  if (typeof value === 'string') {
    serialized = value;
  } else {
    try {
      serialized = JSON.stringify(value);
    } catch (e) {
      // Unserializable values cannot be armored key text.
      return false;
    }
  }
  return ARMOR_MARKERS.some(marker => serialized.includes(marker));
}

/**
 * Split a keyring attribute map into the part that belongs on the device and the
 * part that stays local.
 * @param {Object} attributes - map of keyringId to attribute map
 * @return {{device: Object, local: Object}}
 */
export function splitAttributes(attributes = {}) {
  const device = {};
  const local = {};
  for (const [keyringId, attrs] of Object.entries(attributes || {})) {
    const deviceAttrs = {};
    const localAttrs = {};
    for (const [field, value] of Object.entries(attrs || {})) {
      if (CRYPTO_ATTR_FIELDS.includes(field)) {
        deviceAttrs[field] = value;
      } else {
        localAttrs[field] = value;
      }
    }
    // Always record the keyring in the local map, even with no local attributes:
    // the set of keyring IDs is what lets keyring.init() work without the device.
    local[keyringId] = localAttrs;
    if (Object.keys(deviceAttrs).length) {
      device[keyringId] = deviceAttrs;
    }
  }
  return {device, local};
}

/**
 * Recombine the two halves of a keyring attribute map.
 * @param {Object} local
 * @param {Object} device
 * @return {Object}
 */
export function mergeAttributes(local = {}, device = {}) {
  const merged = {};
  for (const keyringId of new Set([...Object.keys(local || {}), ...Object.keys(device || {})])) {
    merged[keyringId] = {...(local?.[keyringId] || {}), ...(device?.[keyringId] || {})};
  }
  return merged;
}

/**
 * Serialize a storage value for the device.
 * @param {Any} value
 * @param {String} format - 'asc' or 'json'
 * @return {String}
 */
export function serialize(value, format) {
  if (format === 'asc') {
    // The value is an array of armored keys. Concatenating them keeps the file
    // importable with `gpg --import` straight off the device.
    return (value || []).join('\n');
  }
  return JSON.stringify(value ?? null);
}

/**
 * Combine a value already on the device with one being migrated into it.
 *
 * Migration used to write the local value straight over the device path, so moving
 * keys onto a device that already held a keystore destroyed what was there. Only
 * the atomic-write .bak rotation made that recoverable, which is not a guarantee to
 * rely on.
 *
 * Existing device content always wins a conflict: migration is additive by
 * definition, and a device's own keystore is not the thing being moved.
 * @param {Any} existing - value already on the device, or undefined
 * @param {Any} incoming - value being migrated in
 * @param {String} format - 'asc' or 'json'
 * @return {{value: Any, added: Number}} merged value, and how much was new
 */
export function mergeForDevice(existing, incoming, format) {
  if (existing === undefined || existing === null) {
    const added = format === 'asc' ? (incoming ?? []).length : 1;
    return {value: incoming, added};
  }
  if (format === 'asc') {
    const blocks = [...(existing ?? [])];
    let added = 0;
    for (const block of incoming ?? []) {
      // Exact-text comparison. Two different armorings of the same key would not
      // dedupe, but openpgp reconciles duplicate fingerprints when the keyring
      // loads, so the cost is a redundant block rather than a wrong keyring.
      if (!blocks.includes(block)) {
        blocks.push(block);
        added += 1;
      }
    }
    return {value: blocks, added};
  }
  if (typeof existing !== 'object' || typeof incoming !== 'object') {
    return {value: existing, added: 0};
  }
  // Per-entry merge with the device winning, which keeps a device's own default_key
  // and its own Autocrypt records intact.
  const merged = {...existing};
  let added = 0;
  for (const [key, value] of Object.entries(incoming ?? {})) {
    if (!(key in merged)) {
      merged[key] = value;
      added += 1;
    } else if (value && typeof value === 'object' && typeof merged[key] === 'object') {
      merged[key] = {...value, ...merged[key]};
    }
  }
  return {value: merged, added};
}

/**
 * Parse a device file back into a storage value.
 * @param {String} content
 * @param {String} format - 'asc' or 'json'
 * @return {Any}
 */
export function deserialize(content, format) {
  if (format === 'asc') {
    if (!content?.trim()) {
      return [];
    }
    const blocks = content.match(/-----BEGIN PGP [^-]+-----[\s\S]*?-----END PGP [^-]+-----/g);
    return blocks || [];
  }
  if (!content?.trim()) {
    return undefined;
  }
  return JSON.parse(content);
}
