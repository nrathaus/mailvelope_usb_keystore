/**
 * Copyright (C) 2026 Noam Rathaus
 * Licensed under the GNU Affero General Public License version 3
 *
 * A bounded diagnostic log for the USB keystore, written to chrome.storage.local.
 *
 * Why there rather than the console: the interesting failures happen in the service
 * worker, which goes idle and takes its console with it, and reproducing them means
 * asking someone to copy text out of DevTools. chrome.storage.local is readable
 * directly from the browser profile on disk, so whoever is debugging can read the
 * log themselves without the user relaying it.
 *
 * Deliberately NOT via chrome.downloads: that would need a new manifest permission,
 * and widening an encryption extension's permissions for a debugging convenience is
 * a bad trade.
 *
 * NEVER log key material. Paths, sizes, states, error names and codes only. The log
 * lives in local storage, which is exactly where this feature exists to keep key
 * material out of.
 *
 * DISABLED BY DEFAULT, and deliberately not exposed in the UI. Diagnostics that
 * write to disk are a liability for an encryption extension: an always-on log is one
 * more place for something sensitive to end up, and a visible switch is one more way
 * to turn that on by accident. It has to be enabled explicitly, and disabling it
 * erases whatever was captured.
 */

const STORAGE_KEY = 'mvelo.usb.debug';
/** Ring buffer bound. Enough for several sessions, small enough to stay cheap. */
const MAX_ENTRIES = 300;
/** Guard against a runaway caller filling storage with one enormous entry. */
const MAX_DETAIL_LENGTH = 500;

const ENABLED_KEY = 'mvelo.usb.debugEnabled';

let entries = [];
let loaded = false;
let writing = null;
let enabled = null;  // null = not yet read from storage

/**
 * Whether logging is on. Cached after the first read; a disabled log must not cost
 * a storage round-trip per call.
 * @return {Promise<Boolean>}
 */
async function isEnabled() {
  if (enabled === null) {
    try {
      const {[ENABLED_KEY]: stored} = await chrome.storage.local.get(ENABLED_KEY);
      enabled = stored === true;
    } catch (e) {
      enabled = false;
    }
  }
  return enabled;
}

/**
 * Turn logging on or off. Disabling erases what was already captured, so switching
 * it off is also a way to clean up.
 * @param {Boolean} on
 */
export async function setEnabled(on) {
  enabled = on === true;
  await chrome.storage.local.set({[ENABLED_KEY]: enabled});
  if (!enabled) {
    await clearLog();
  }
}

function clip(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? null);
  if (!text) {
    return text;
  }
  return text.length > MAX_DETAIL_LENGTH ? `${text.slice(0, MAX_DETAIL_LENGTH)}…` : text;
}

async function load() {
  if (loaded) {
    return;
  }
  loaded = true;
  try {
    const {[STORAGE_KEY]: stored} = await chrome.storage.local.get(STORAGE_KEY);
    if (Array.isArray(stored)) {
      entries = stored.slice(-MAX_ENTRIES);
    }
  } catch (e) {
    // A log that cannot load is still usable for new entries.
  }
}

/** Serialise writes so concurrent log calls cannot clobber each other. */
async function flush() {
  writing = (writing ?? Promise.resolve()).then(async () => {
    try {
      await chrome.storage.local.set({[STORAGE_KEY]: entries});
    } catch (e) {
      // Never let logging break the operation being logged.
    }
  });
  return writing;
}

/**
 * Record a diagnostic event.
 * @param {String} event - short stable identifier, e.g. 'probe' or 'provision.refused'
 * @param {Object} [detail] - small plain object; must contain no key material
 */
export async function log(event, detail) {
  if (!await isEnabled()) {
    return;
  }
  await load();
  entries.push({
    t: new Date().toISOString(),
    event,
    ...(detail !== undefined && {detail: clip(detail)})
  });
  if (entries.length > MAX_ENTRIES) {
    entries = entries.slice(-MAX_ENTRIES);
  }
  await flush();
}

/**
 * Record a failure, keeping the parts that identify it rather than the stack.
 * @param {String} event
 * @param {Error} error
 * @param {Object} [detail]
 */
export function logError(event, error, detail) {
  // Routed through log(), so the enabled check applies here too.
  return log(event, {
    ...detail,
    error: error?.name ?? 'Error',
    code: error?.code,
    message: clip(error?.message ?? String(error))
  });
}

/**
 * The whole log, for display or export.
 * @return {Promise<Array<Object>>}
 */
export async function getLog() {
  await load();
  return entries.slice();
}

/** Drop the log. */
export async function clearLog() {
  entries = [];
  loaded = true;
  await flush();
}

/** Storage keys, so the router can keep them local and out of the crypto paths. */
export const DEBUG_STORAGE_KEYS = [STORAGE_KEY, ENABLED_KEY];
