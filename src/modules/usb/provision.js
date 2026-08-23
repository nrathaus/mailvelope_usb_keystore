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

import {getUUID, MvError} from '../../lib/util';
import {
  DEVICE_ROOT, MARKER_FILE, README_FILE, KEYRINGS_DIR, KEYSTORE_VERSION, USB_STATE
} from './constants';
import * as state from './state';
import {usesNativeHost} from './state';
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
 * Explanation left on the device itself.
 *
 * This keystore is intended to be the only copy of its private keys, so whoever
 * finds this folder may be doing so precisely because Mailvelope is unavailable —
 * a new machine, a broken extension, no browser at all. The instructions for
 * getting the keys out by hand therefore belong on the device, not only in the
 * extension's UI.
 * @return {String}
 */
function readmeText() {
  return [
    'Mailvelope USB keystore',
    '=======================',
    '',
    'This folder holds the OpenPGP keys for a Mailvelope installation. It is',
    'deliberately the only copy: nothing is stored on the computer.',
    '',
    'Layout',
    '------',
    '  keystore.json          identifies this keystore. Do not delete it.',
    '  keyrings/<id>/         one folder per keyring',
    '    private.asc          private keys, armored',
    '    public.asc           public keys, armored',
    '    attributes.json      which key is the default, and similar settings',
    '    *.bak                previous version of a file, kept in case a save',
    '                         was interrupted',
    '',
    'Recovering the keys without Mailvelope',
    '--------------------------------------',
    'The .asc files are ordinary armored OpenPGP keys, so any OpenPGP tool can',
    'read them:',
    '',
    '  gpg --import keyrings/*/private.asc',
    '',
    'The private keys are protected by the passphrase set when they were created.',
    'That passphrase is the only thing protecting them if this device is lost or',
    'stolen -- there is no other copy and no way to reset it.',
    '',
    'Reconnecting in Mailvelope',
    '--------------------------',
    'In Mailvelope, open Settings -> Key Storage and select the folder that',
    'CONTAINS this one (usually the root of the device), not this folder itself.',
    ''
  ].join('\n');
}

/**
 * Read and parse a marker file, or undefined if it is absent or unreadable.
 * @param {UsbBackend} backend
 * @param {String} path
 * @return {Promise<Object|undefined>}
 */
async function readMarker(backend, path) {
  try {
    const marker = JSON.parse(await backend.readFile(path));
    return marker?.keystoreId ? marker : undefined;
  } catch (e) {
    if (e instanceof NotFoundError) {
      return undefined;
    }
    // A corrupt or unreadable marker is not a usable keystore identity either.
    return undefined;
  }
}

/**
 * Re-grant access to the directory already stored for this profile.
 *
 * A permission grant does not survive an extension reload, and in all likelihood
 * not a browser restart either, so this is a routine action rather than an edge
 * case. Re-prompting for the stored handle asks the user to approve one dialog;
 * calling showDirectoryPicker() again would make them navigate to the directory
 * from scratch every session. App page only: requestPermission needs a user
 * gesture.
 * @return {Promise<{granted: Boolean, name: String|undefined}>}
 */
export async function regrantPermission() {
  const handle = await handleStore.get();
  if (!handle) {
    // Nothing stored to re-grant; the caller falls back to a full pick.
    return {granted: false, name: undefined};
  }
  if (await handle.queryPermission({mode: 'readwrite'}) === 'granted') {
    return {granted: true, name: handle.name};
  }
  const permission = await handle.requestPermission({mode: 'readwrite'});
  return {granted: permission === 'granted', name: handle.name};
}

/**
 * Removable devices the native host can see.
 *
 * Only meaningful on the native path: Firefox has no directory picker, so the user
 * chooses from a list of mounted devices instead of a file dialog.
 * @return {Promise<Array<{path: String, label: String, writable: Boolean}>>}
 */
export async function listDevices() {
  const backend = state.getBackend();
  if (!backend?.listDevices) {
    return [];
  }
  return backend.listDevices();
}

/**
 * Select a device by path, for the native host path.
 *
 * The File System Access backend gets its location from a stored handle produced by
 * the picker; here the path itself is the configuration, so it is recorded before
 * provisioning can look at the device.
 * @param {String} devicePath - as reported by listDevices()
 * @return {Promise<Object>} status after selection
 */
export async function selectDevice(devicePath) {
  if (!usesNativeHost()) {
    throw new MvError('Selecting a device by path requires the native helper', 'USB_NOT_NATIVE');
  }
  const config = await state.getConfig();
  await state.setConfig({...(config ?? {}), devicePath});
  await state.reload();
  return state.getStatus();
}

/**
 * Create the keystore on the device and record it as this profile's keystore.
 * Reuses an existing marker file if the device already holds one, so a device set
 * up on another machine can simply be adopted.
 * @param {String} [label] - human-readable label stored in the marker file
 * @return {Promise<Object>} status after provisioning
 */
export async function provision({label, adopt: adoptArg} = {}) {
  // Strict coercion: this arrives over a port from a view, and only an explicit
  // true counts as consent to switch keystore. Anything else -- a stray object, a
  // truthy string -- must not bypass the identity check below.
  const adopt = adoptArg === true;
  const backend = state.getBackend();
  if (!backend) {
    throw new Error('No USB keystore backend available in this browser');
  }
  backend.clearCache?.();

  // Reject the keystore directory itself. Picking it would nest a second keystore
  // inside the first, and it is the natural thing to choose when reconnecting
  // because it is the folder the user can actually see.
  if (await readMarker(backend, MARKER_FILE)) {
    throw new MvError(
      `The selected folder is already a Mailvelope keystore. Select the folder that contains '${DEVICE_ROOT}' instead, such as the root of the device.`,
      'USB_KEYSTORE_NESTED_PICK'
    );
  }

  const markerPath = `${DEVICE_ROOT}/${MARKER_FILE}`;
  const marker = await readMarker(backend, markerPath);
  const existing = await state.getConfig();

  // Never repoint a configured profile at a different keystore without being told
  // to. Doing so silently would leave the user looking at an empty keyring while
  // their keys sat on the previous device.
  if (existing?.keystoreId && !adopt) {
    if (!marker?.keystoreId) {
      throw new MvError(
        'This folder holds no Mailvelope keystore. Select the device this profile was set up with, or choose to switch to this folder instead.',
        'USB_KEYSTORE_NOT_CONFIGURED_DEVICE'
      );
    }
    if (marker.keystoreId !== existing.keystoreId) {
      throw new MvError(
        'This is a different Mailvelope keystore from the one this profile uses. Switching to it will leave the keys on the previous device inaccessible from here.',
        'USB_KEYSTORE_DIFFERENT_DEVICE'
      );
    }
  }

  if (!marker?.keystoreId) {
    const created = {
      version: KEYSTORE_VERSION,
      keystoreId: getUUID(),
      created: new Date().toISOString(),
      label: label || 'Mailvelope USB keystore'
    };
    await backend.writeFile(markerPath, JSON.stringify(created, null, 2));
    try {
      await backend.writeFile(`${DEVICE_ROOT}/${README_FILE}`, readmeText());
    } catch (e) {
      // Guidance is not worth failing provisioning over.
      console.log('USB keystore: could not write README', e);
    }
    await state.setConfig({keystoreId: created.keystoreId, label: created.label, provisioned: created.created});
    await state.reload();
    return state.getStatus();
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
