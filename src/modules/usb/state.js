/**
 * Copyright (C) 2026 Noam Rathaus
 * Licensed under the GNU Affero General Public License version 3
 *
 * Availability state machine for the USB keystore.
 *
 * There is no filesystem "device removed" event, so presence is always established
 * by actively reading the marker file: on a timer, and before every keystore
 * operation. Resolving the directory handle alone is not enough — automounters
 * differ in whether the mount point disappears on removal or is left behind as an
 * empty directory, and only reading the marker covers both.
 *
 * Kept free of Mailvelope app imports so it can be unit tested in isolation and
 * cannot form an import cycle. Consumers react through addStateListener().
 */

import {
  USB_STATE, UNUSABLE_STATES, USB_CONFIG_KEY, DEVICE_ROOT, MARKER_FILE,
  PROBE_ALARM, PROBE_PERIOD_MINUTES
} from './constants';
import {NotFoundError, DeviceUnavailableError} from './backend';
import FsaBackend from './FsaBackend';

let backend = null;
let state = USB_STATE.NOT_CONFIGURED;
let detail = null;
let enabled = false;
let label = null;
let keystoreId = null;
const listeners = new Set();

/**
 * Select a backend for this browser. Chromium gets the File System Access
 * implementation; Firefox has no picker and will need the native messaging host,
 * until which point the feature reports UNSUPPORTED rather than silently falling
 * back to local storage.
 * @return {UsbBackend|null}
 */
function selectBackend() {
  if (FsaBackend.isSupported()) {
    return new FsaBackend();
  }
  return null;
}

export function getBackend() {
  return backend;
}

export function getState() {
  return state;
}

export function getStatus() {
  // label is the picked folder's name. Chrome does not expose a handle's full path,
  // so this is the most specific location the UI can show -- enough to tell one
  // configured device from another.
  return {state, detail, supported: Boolean(backend), enabled, label, keystoreId};
}

export function isUsable() {
  return state === USB_STATE.READY;
}

/**
 * Whether a USB keystore has been set up for this profile.
 *
 * This gates the storage redirection: until the user opts in, Mailvelope must
 * behave exactly as upstream and keep using local storage. Once opted in, crypto
 * keys go to the device or fail — never silently back to local storage.
 * @return {Boolean}
 */
export function isEnabled() {
  return enabled;
}

/**
 * Read the USB keystore configuration. Uses chrome.storage.local directly rather
 * than mvelo.storage, which this feature wraps — avoiding any re-entrancy.
 * @return {Promise<Object|undefined>}
 */
export async function getConfig() {
  const {[USB_CONFIG_KEY]: config} = await chrome.storage.local.get(USB_CONFIG_KEY);
  return config;
}

export async function setConfig(config) {
  await chrome.storage.local.set({[USB_CONFIG_KEY]: config});
}

/**
 * Record that the device has held a private key at some point.
 *
 * Needed because a detached device cannot be asked. Without it, "configured but
 * detached" is indistinguishable from "configured and never used", so the toolbar
 * menu cannot tell whether to offer onboarding. A boolean carries no key material,
 * so it belongs in the local config.
 * @param {Boolean} hadKeys
 */
export async function setHadKeys(hadKeys) {
  const config = await getConfig();
  if (!config || config.hadKeys === hadKeys) {
    return;
  }
  await setConfig({...config, hadKeys});
}

/**
 * Whether the configured device is known to have held a private key.
 * @return {Promise<Boolean>}
 */
export async function hadKeys() {
  return Boolean((await getConfig())?.hadKeys);
}

export async function clearConfig() {
  await chrome.storage.local.remove(USB_CONFIG_KEY);
}

/**
 * Register a callback invoked on every state transition.
 * @param {Function} listener - (nextState, previousState, status) => void
 * @return {Function} unregister
 */
export function addStateListener(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function transition(nextState, nextDetail = null) {
  if (nextState === state && nextDetail === detail) {
    return false;
  }
  const previous = state;
  state = nextState;
  detail = nextDetail;
  for (const listener of listeners) {
    try {
      listener(state, previous, getStatus());
    } catch (e) {
      console.log('USB keystore state listener failed', e);
    }
  }
  return true;
}

/**
 * Determine the current state by talking to the device.
 * @return {Promise<{state: String, detail: String|null}>}
 */
async function computeState() {
  const config = await getConfig();
  enabled = Boolean(config?.keystoreId);
  label = config?.label ?? null;
  keystoreId = config?.keystoreId ?? null;
  // Not opting in takes precedence over an unsupported browser: an unconfigured
  // profile is simply upstream Mailvelope, and the setup UI reports separately
  // (via getStatus().supported) whether this browser could support the feature.
  if (!enabled) {
    return {state: USB_STATE.NOT_CONFIGURED, detail: null};
  }
  if (!backend) {
    return {state: USB_STATE.UNSUPPORTED, detail: 'no_backend'};
  }
  let probe;
  try {
    probe = await backend.probe();
  } catch (e) {
    return {state: USB_STATE.ERROR, detail: e.message};
  }
  if (!probe.configured) {
    return {state: USB_STATE.NOT_CONFIGURED, detail: null};
  }
  if (probe.permission !== 'granted') {
    return {state: USB_STATE.PERMISSION_REQUIRED, detail: probe.permission};
  }
  let marker;
  try {
    marker = JSON.parse(await backend.readFile(`${DEVICE_ROOT}/${MARKER_FILE}`));
  } catch (e) {
    if (e instanceof NotFoundError || e instanceof DeviceUnavailableError) {
      return {state: USB_STATE.ABSENT, detail: null};
    }
    return {state: USB_STATE.ERROR, detail: e.message};
  }
  if (marker?.keystoreId !== config.keystoreId) {
    return {state: USB_STATE.WRONG_DEVICE, detail: marker?.label ?? null};
  }
  return {state: USB_STATE.READY, detail: null};
}

/**
 * Probe the device and publish any state change.
 * @return {Promise<String>} the current state
 */
export async function probe() {
  const next = await computeState();
  transition(next.state, next.detail);
  return state;
}

/**
 * Throw unless key material may be touched right now. Every crypto path inherits
 * this through the storage wrapper, so callers do not implement it individually.
 * @param {Boolean} [reprobe] - probe first; used before write operations
 */
export async function assertUsable(reprobe = false) {
  if (reprobe || UNUSABLE_STATES.includes(state)) {
    await probe();
  }
  if (!isUsable()) {
    throw new DeviceUnavailableError(`USB keystore is not available (${state})`);
  }
}

/**
 * Drop the cached directory handle and re-probe, after the configuration changed.
 */
export async function reload() {
  backend?.clearCache?.();
  return probe();
}

/**
 * Register the periodic-probe alarm listener.
 *
 * MUST be called during the synchronous evaluation of the background script, not
 * from init(). An MV3 service worker only receives events whose listeners were
 * registered in that first turn; a listener added after an await is silently never
 * called on a woken worker, so the periodic presence check would never run and the
 * device could only be noticed on startup or by an explicit user action.
 *
 * Separate from init() because init() is async by nature -- it has to read the
 * device -- so anything after its first await is already too late.
 */
export function registerProbeListener() {
  if (!chrome.alarms?.onAlarm) {
    return;
  }
  chrome.alarms.onAlarm.addListener(alarm => {
    if (alarm.name === PROBE_ALARM) {
      probe().catch(e => console.log('USB keystore probe failed', e));
    }
  });
}

/**
 * Initialise the state machine: select a backend, take a first reading, and start
 * the periodic probe. The listener itself is registered by registerProbeListener().
 */
export async function init() {
  backend = selectBackend();
  await probe();
  chrome.alarms?.create(PROBE_ALARM, {periodInMinutes: PROBE_PERIOD_MINUTES});
  return getStatus();
}
