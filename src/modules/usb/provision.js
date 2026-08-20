/**
 * Copyright (C) 2026 Noam Rathaus
 * Licensed under the GNU Affero General Public License version 3
 *
 * Setting up, migrating to, and tearing down a USB keystore.
 *
 * Split across two contexts by necessity: showDirectoryPicker() and
 * requestPermission() need a document and a user gesture, so pickDirectory() runs
 * in the app page. Everything that touches the device runs in the background,
 * where the backend lives.
 */

import {getUUID} from '../../lib/util';
import {
  DEVICE_ROOT, MARKER_FILE, KEYRINGS_DIR, KEYSTORE_VERSION, USB_STATE
} from './constants';
import * as state from './state';
import * as router from './router';
import * as handleStore from './handleStore';
import {NotFoundError} from './backend';

/**
 * Whether this context can open a directory picker. False in the service worker
 * and in Firefox, which has no File System Access picker at all.
 * @return {Boolean}
 */
export function isPickerAvailable() {
  return typeof self !== 'undefined' && typeof self.showDirectoryPicker === 'function';
}

/**
 * Ask the user for the keystore directory and persist the handle. App page only.
 * @return {Promise<{name: String}>} the chosen directory's name
 */
export async function pickDirectory() {
  if (!isPickerAvailable()) {
    throw new Error('Directory picker is not available in this browser');
  }
  // 'readwrite' asks for write access up front, so no second prompt is needed on
  // the first save. 'documents' is a neutral starting point; removable volumes are
  // reachable from the picker regardless.
  const handle = await self.showDirectoryPicker({mode: 'readwrite', id: 'mvelo-usb-keystore'});
  const permission = await handle.requestPermission({mode: 'readwrite'});
  if (permission !== 'granted') {
    throw new Error('Write permission for the keystore directory was not granted');
  }
  await handleStore.put(handle);
  return {name: handle.name};
}

/**
 * Create the keystore on the device and record it as this profile's keystore.
 * Reuses an existing marker file if the device already holds one, so a device set
 * up on another machine can simply be adopted.
 * @param {String} [label] - human-readable label stored in the marker file
 * @return {Promise<Object>} status after provisioning
 */
export async function provision({label} = {}) {
  const backend = state.getBackend();
  if (!backend) {
    throw new Error('No USB keystore backend available in this browser');
  }
  backend.clearCache?.();
  const markerPath = `${DEVICE_ROOT}/${MARKER_FILE}`;
  let marker;
  try {
    marker = JSON.parse(await backend.readFile(markerPath));
  } catch (e) {
    if (!(e instanceof NotFoundError)) {
      throw e;
    }
  }
  if (!marker?.keystoreId) {
    marker = {
      version: KEYSTORE_VERSION,
      keystoreId: getUUID(),
      created: new Date().toISOString(),
      label: label || 'Mailvelope USB keystore'
    };
    await backend.writeFile(markerPath, JSON.stringify(marker, null, 2));
  }
  await state.setConfig({keystoreId: marker.keystoreId, label: marker.label, provisioned: marker.created});
  await state.reload();
  return state.getStatus();
}

/**
 * Every local storage key that holds crypto material, read straight from
 * chrome.storage.local.
 *
 * Deliberately bypasses mvelo.storage: by the time migration runs the wrapper is
 * active, so a wrapped read would look on the device for values that are still
 * only local.
 * @return {Promise<Object>} raw storage contents
 */
async function readLocalStorage() {
  return chrome.storage.local.get(null);
}

/**
 * Report what a migration would move, without changing anything.
 * @return {Promise<{keyrings: Array<String>, publicKeys: Number, privateKeys: Number, autocrypt: Number}>}
 */
export async function inspectLocalKeyMaterial() {
  const all = await readLocalStorage();
  const summary = {keyrings: new Set(), publicKeys: 0, privateKeys: 0, autocrypt: 0};
  for (const [key, value] of Object.entries(all)) {
    const route = router.classify(key);
    if (route.target !== router.TARGET.DEVICE) {
      continue;
    }
    summary.keyrings.add(route.keyringId);
    if (key.endsWith('.privateKeys')) {
      summary.privateKeys += (value || []).length;
    } else if (key.endsWith('.publicKeys')) {
      summary.publicKeys += (value || []).length;
    } else {
      summary.autocrypt += Object.keys(value || {}).length;
    }
  }
  return {...summary, keyrings: Array.from(summary.keyrings)};
}

/**
 * Move all locally stored crypto material onto the device, then delete the local
 * copies.
 *
 * Each value is written, read back and compared before its local copy is removed,
 * so an interrupted migration never loses key material. Note that deleting from
 * chrome.storage.local does not erase the bytes from disk — LevelDB appends a
 * tombstone rather than overwriting — so a migrated key may stay recoverable from
 * the browser profile until compaction. Generating a fresh key onto the device is
 * the only path that avoids this entirely; see doc/usb-keystore-plan.md §3.1.
 * @return {Promise<{moved: Array<String>, failed: Array<{key: String, error: String}>}>}
 */
export async function migrateLocalKeyMaterial() {
  await state.assertUsable(true);
  const backend = state.getBackend();
  const all = await readLocalStorage();
  const moved = [];
  const failed = [];
  for (const [key, value] of Object.entries(all)) {
    const route = router.classify(key);
    if (route.target !== router.TARGET.DEVICE) {
      continue;
    }
    try {
      const serialized = router.serialize(value, route.format);
      await backend.writeFile(route.path, serialized);
      const readBack = await backend.readFile(route.path);
      if (readBack !== serialized) {
        throw new Error('verification after write failed');
      }
      await chrome.storage.local.remove(key);
      moved.push(key);
    } catch (e) {
      failed.push({key, error: e.message});
    }
  }
  // The keyring attribute map is split rather than moved: crypto fields go to the
  // device, the keyring registry stays local so the keyring subsystem can still
  // initialise without the device attached.
  const attributes = all[router.KEYRING_ATTRIBUTES_KEY];
  if (attributes) {
    try {
      const {device, local} = router.splitAttributes(attributes);
      if (Object.keys(device).length) {
        const route = router.classify(router.KEYRING_ATTRIBUTES_KEY);
        const serialized = router.serialize(device, route.format);
        await backend.writeFile(route.path, serialized);
        if (await backend.readFile(route.path) !== serialized) {
          throw new Error('verification after write failed');
        }
      }
      await chrome.storage.local.set({[router.KEYRING_ATTRIBUTES_KEY]: local});
      moved.push(router.KEYRING_ATTRIBUTES_KEY);
    } catch (e) {
      failed.push({key: router.KEYRING_ATTRIBUTES_KEY, error: e.message});
    }
  }
  return {moved, failed};
}

/**
 * Stop using the USB keystore. Key material on the device is left untouched; only
 * this profile's reference to it is dropped, so the extension returns to local
 * storage with no keys.
 * @return {Promise<Object>} status after teardown
 */
export async function disable() {
  await state.clearConfig();
  await handleStore.remove();
  await state.reload();
  return state.getStatus();
}

/**
 * Re-check the device after the user has re-granted permission in the app page.
 * @return {Promise<Object>}
 */
export async function reprobe() {
  await state.reload();
  return state.getStatus();
}

/**
 * Diagnostics for the settings page: what is on the device right now.
 * @return {Promise<Object>}
 */
export async function diagnostics() {
  const status = state.getStatus();
  const config = await state.getConfig();
  const result = {...status, label: config?.label ?? null, provisioned: config?.provisioned ?? null, keyrings: []};
  if (status.state !== USB_STATE.READY) {
    return result;
  }
  const backend = state.getBackend();
  try {
    for (const dir of await backend.listDir(`${DEVICE_ROOT}/${KEYRINGS_DIR}`)) {
      if (!/^[0-9a-f]+$/.test(dir)) {
        continue;
      }
      const files = await backend.listDir(`${DEVICE_ROOT}/${KEYRINGS_DIR}/${dir}`);
      result.keyrings.push({dir, files});
    }
  } catch (e) {
    result.detail = e.message;
  }
  return result;
}
