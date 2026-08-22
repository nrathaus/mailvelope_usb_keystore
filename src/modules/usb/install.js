/**
 * Copyright (C) 2026 Noam Rathaus
 * Licensed under the GNU Affero General Public License version 3
 *
 * Installs the USB keystore by wrapping mvelo.storage.
 *
 * Every crypto persistence path in Mailvelope funnels through
 * mvelo.storage.{get,set,remove}: armored keys via KeyStoreLocal, key metadata via
 * KeyringAttrMap, Autocrypt records via autocryptWrapper.Store. Wrapping those three
 * functions here routes crypto material to the USB device and lets everything else
 * pass through to chrome.storage.local — so KeyStoreLocal, KeyringAttrMap and
 * autocryptWrapper.Store keep working unmodified.
 *
 * The redirection is therefore invisible at those call sites, which is a deliberate
 * trade: this branch tracks upstream master, and an additive hook in one file
 * rebases where edits scattered across the keyring layer would conflict. It also
 * puts the "nothing stored outside the device" rule in a single auditable place
 * instead of re-implementing it per call site. See doc/usb-keystore-plan.md §4.
 */

import mvelo from '../../lib/lib-mvelo';
import {USB_STATE} from './constants';
import * as state from './state';
import * as router from './router';
import {NotFoundError} from './backend';
import {MvError} from '../../lib/util';
import {getAll as getAllKeyrings} from '../keyring';
import {clear as clearPwdCache} from '../pwdCache';

let installed = false;
const original = {};

/**
 * Read a device-backed value.
 * @param {Object} route - result of router.classify()
 * @return {Promise<Any>} undefined if the file does not exist yet
 */
async function readDevice(route) {
  // A read must never throw because the device is missing.
  //
  // keyring.init() treats a failing keystore load as a broken keyring and deletes
  // it from the attribute map, so an unplugged device at startup would deregister
  // the keyring entirely -- recoverable for the main keyring, permanent for
  // client-API keyrings, whose keys would be stranded on the device. Degrade to
  // "empty" instead. Writes still fail closed, so nothing can be destroyed by
  // reading empty and storing it back.
  if (!state.isUsable()) {
    await state.probe();
    if (!state.isUsable()) {
      return undefined;
    }
  }
  try {
    const content = await state.getBackend().readFile(route.path);
    return router.deserialize(content, route.format);
  } catch (e) {
    if (!(e instanceof NotFoundError)) {
      // Not merely absent data: log it, but still degrade rather than take the
      // destructive path above. The state machine reports ERROR to the user
      // independently, so the failure is not hidden from them.
      console.log('USB keystore: read failed', route.path, e);
    }
    return undefined;
  }
}

async function writeDevice(route, value) {
  // Reprobe before writing: a stale READY reading would otherwise let a write be
  // attempted against a device that has just been pulled.
  await state.assertUsable(true);
  await state.getBackend().writeFile(route.path, router.serialize(value, route.format));
}

async function removeDevice(route) {
  await state.assertUsable();
  await state.getBackend().removeFile(route.path);
}

async function wrappedGet(id) {
  if (!state.isEnabled()) {
    return original.get(id);
  }
  const route = router.classify(id);
  if (route.target === router.TARGET.DEVICE) {
    return readDevice(route);
  }
  if (route.target === router.TARGET.SPLIT) {
    const local = await original.get(id);
    if (!state.isUsable()) {
      // Without the device the keyring registry is still readable, so the keyring
      // subsystem can initialise; the crypto attributes simply appear unset.
      return local;
    }
    let device;
    try {
      device = await readDevice(route);
    } catch (e) {
      console.log('USB keystore: reading keyring attributes failed', e);
      return local;
    }
    return router.mergeAttributes(local, device);
  }
  return original.get(id);
}

async function wrappedSet(id, value) {
  if (!state.isEnabled()) {
    return original.set(id, value);
  }
  const route = router.classify(id);
  if (route.target === router.TARGET.DEVICE) {
    return writeDevice(route, value);
  }
  if (route.target === router.TARGET.SPLIT) {
    const {device, local} = router.splitAttributes(value);
    await original.set(id, local);
    // Only touch the device when there is crypto metadata to store. This is what
    // lets a fresh profile create its main keyring with no device attached.
    if (Object.keys(device).length) {
      await writeDevice(route, device);
    }
    return;
  }
  // Unknown storage key. Pass it through, but refuse to let key material reach
  // local storage under a key this router does not recognise — the safety net for
  // an upstream change that adds a new crypto storage key.
  if (!router.isAllowedLocal(id) && router.containsKeyMaterial(value)) {
    throw new MvError(
      `Refusing to write OpenPGP key material to local storage under '${id}' while a USB keystore is active`,
      'USB_KEYSTORE_LEAK_BLOCKED'
    );
  }
  return original.set(id, value);
}

async function wrappedRemove(id) {
  if (!state.isEnabled()) {
    return original.remove(id);
  }
  const route = router.classify(id);
  if (route.target === router.TARGET.DEVICE) {
    return removeDevice(route);
  }
  if (route.target === router.TARGET.SPLIT) {
    await original.remove(id);
    if (state.isUsable()) {
      await removeDevice(route);
    }
    return;
  }
  return original.remove(id);
}

/**
 * Badge arbitration.
 *
 * uiLog already owns the toolbar badge: it shows a green 'Ok' on user interaction
 * and clears it unconditionally two seconds later, which would wipe a USB warning.
 * Wrapping mvelo.action.state keeps that logic in uiLog untouched — a request to
 * clear the badge restores the USB warning instead of blanking it.
 */
function usbBadge() {
  if (!state.isEnabled() || state.isUsable()) {
    return null;
  }
  return {badge: '!', badgeColor: '#d32f2f'};
}

function wrappedActionState(options = {}) {
  const warning = usbBadge();
  if (warning && options.badge === '') {
    return original.actionState(warning);
  }
  return original.actionState(options);
}

function refreshBadge() {
  const warning = usbBadge();
  original.actionState(warning || {badge: ''});
}

/**
 * Clear every trace of key material from memory when the device goes away.
 *
 * Raced against a timeout because keyring.getAll() waits on keyring initialisation:
 * if the device disappears before that finishes, awaiting it here would hang and
 * keep this task alive indefinitely.
 */
async function purgeInMemoryKeyMaterial() {
  try {
    clearPwdCache();
  } catch (e) {
    console.log('USB keystore: clearing password cache failed', e);
  }
  try {
    const keyrings = await Promise.race([
      getAllKeyrings(),
      new Promise(resolve => setTimeout(() => resolve(null), 2000))
    ]);
    if (!keyrings) {
      // Keyring subsystem not initialised yet, so it holds no key material anyway.
      return;
    }
    for (const keyring of keyrings) {
      keyring.keystore.clear();
    }
  } catch (e) {
    console.log('USB keystore: clearing in-memory keyrings failed', e);
  }
}

function onStateChange(next, previous) {
  refreshBadge();
  if (next !== USB_STATE.READY && previous === USB_STATE.READY) {
    purgeInMemoryKeyMaterial();
  }
}

/**
 * Install the USB keystore hooks and start monitoring the device.
 * Idempotent. Must run before the keyring subsystem is initialised.
 * @return {Promise<Object>} the initial status
 */
export async function installUsbKeystore() {
  if (installed) {
    return state.getStatus();
  }
  installed = true;
  original.get = mvelo.storage.get.bind(mvelo.storage);
  original.set = mvelo.storage.set.bind(mvelo.storage);
  original.remove = mvelo.storage.remove.bind(mvelo.storage);
  original.actionState = mvelo.action.state.bind(mvelo.action);
  mvelo.storage.get = wrappedGet;
  mvelo.storage.set = wrappedSet;
  mvelo.storage.remove = wrappedRemove;
  mvelo.action.state = wrappedActionState;
  state.addStateListener(onStateChange);
  const status = await state.init();
  refreshBadge();
  return status;
}

/** Test seam: undo the hooks. */
export function uninstallUsbKeystore() {
  if (!installed) {
    return;
  }
  mvelo.storage.get = original.get;
  mvelo.storage.set = original.set;
  mvelo.storage.remove = original.remove;
  mvelo.action.state = original.actionState;
  installed = false;
}
