/**
 * Copyright (C) 2026 Noam Rathaus
 * Licensed under the GNU Affero General Public License version 3
 *
 * Shared client-side helpers for the USB keystore UI.
 *
 * Note on subscriptions: EventHandler.on() keeps one handler per event in a Map, so
 * a second registration for the same event silently replaces the first. Several
 * components on a page need the status, so they must not each call port.on() —
 * only the last would stay live. This module registers once and fans out.
 */

import {useEffect, useState} from 'react';
import {USB_STATE, FOCUS_PROBE_INTERVAL_MS} from '../../modules/usb/constants';
import {describeState} from '../../modules/usb/strings';

/** Storage locations offered in the UI. */
export const STORAGE = {LOCAL: 'local', USB: 'usb'};

const subscribers = new Set();
let wiredPort = null;
let lastStatus = null;

function publish(status) {
  lastStatus = status;
  for (const subscriber of subscribers) {
    subscriber(status);
  }
}

function wire(port) {
  if (wiredPort === port) {
    return;
  }
  wiredPort = port;
  port.on('usb-status-changed', publish);
  if (typeof document !== 'undefined') {
    // Check the moment the page is looked at again, rather than waiting for the
    // next tick of any timer.
    document.addEventListener('visibilitychange', () => {
      updatePolling(port);
      if (document.visibilityState === 'visible') {
        port.send('usb-get-status').then(publish).catch(() => {});
      }
    });
    window.addEventListener('focus', () => {
      port.send('usb-get-status').then(publish).catch(() => {});
    });
  }
}

let pollTimer = null;

/**
 * Poll the device while this page is visible.
 *
 * The background alarm cannot run faster than every 30 seconds, which is a long
 * time to stare at a page that is telling you the wrong thing. Someone looking at
 * Mailvelope is exactly when latency is felt, so poll quickly then and stop as soon
 * as the page is hidden or nobody is subscribed.
 * @param {EventHandler} port
 */
function updatePolling(port) {
  const shouldPoll = subscribers.size > 0 &&
    (typeof document === 'undefined' || document.visibilityState === 'visible');
  if (shouldPoll && !pollTimer) {
    pollTimer = setInterval(() => {
      port.send('usb-get-status').then(publish).catch(() => {});
    }, FOCUS_PROBE_INTERVAL_MS);
  } else if (!shouldPoll && pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

/**
 * Subscribe to USB keystore status. The first subscriber triggers one fetch; later
 * ones get the cached value immediately and share the background pushes.
 * @param {EventHandler} port
 * @param {Function} onStatus
 * @return {Function} unsubscribe
 */
export function subscribeStatus(port, onStatus) {
  wire(port);
  subscribers.add(onStatus);
  if (lastStatus) {
    onStatus(lastStatus);
  }
  // Always ask, even with a cached value: the cache may predate a device change.
  port.send('usb-get-status').then(publish).catch(() => {});
  updatePolling(port);
  return () => {
    subscribers.delete(onStatus);
    updatePolling(port);
  };
}

/** Push a status obtained out of band (e.g. as an action's return value). */
export function updateStatus(status) {
  if (status) {
    publish(status);
  }
}

/**
 * React hook giving the current USB keystore status, kept up to date by background
 * pushes. Lets each UI site be wired in with a single component tag rather than
 * threading status through props.
 * @param {EventHandler} port
 * @return {Object|null}
 */
export function useUsbStatus(port) {
  const [status, setStatus] = useState(lastStatus);
  useEffect(() => {
    if (!port) {
      return;
    }
    return subscribeStatus(port, setStatus);
  }, [port]);
  return status;
}

/**
 * Which storage location a status describes.
 * @param {Object} status - from the 'usb-get-status' event
 * @return {String} one of STORAGE
 */
export function storageOf(status) {
  return status?.enabled ? STORAGE.USB : STORAGE.LOCAL;
}

/**
 * Whether the USB keystore is configured but currently unusable — the condition
 * that has to be visible to the user everywhere, not just in settings.
 * @param {Object} status
 * @return {Boolean}
 */
export function isUnavailable(status) {
  if (!status?.enabled) {
    return false;
  }
  // READ_ONLY is deliberately not "unavailable": the keys are readable and usable,
  // so treating it as absence would hide them and claim the keystore was missing.
  return status.state !== USB_STATE.READY && status.state !== USB_STATE.READ_ONLY;
}

/**
 * Whether the keystore can accept changes right now.
 *
 * Destructive controls should be disabled rather than offered and then refused:
 * clicking Delete and watching a key disappear -- because the keyring mutates
 * memory before persisting -- then having it reappear is worse than not being able
 * to click at all. Especially for a key being deleted because it is compromised.
 *
 * True when no keystore is configured, so ordinary local operation is untouched.
 * @param {Object} status
 * @return {Boolean}
 */
export function canModifyKeys(status) {
  if (!status?.enabled) {
    return true;
  }
  return status.state === USB_STATE.READY;
}

/**
 * Why changes are not possible, for a title attribute on a disabled control.
 * @param {Object} status
 * @return {String|undefined}
 */
export function whyCannotModify(status) {
  return canModifyKeys(status) ? undefined : describeState(status?.state);
}

/**
 * Bootstrap contextual class for a status, for badges and alerts.
 * @param {Object} status
 * @return {String}
 */
export function statusVariant(status) {
  if (!status?.enabled) {
    return 'secondary';
  }
  switch (status.state) {
    case USB_STATE.READY:
      return 'success';
    case USB_STATE.ABSENT:
    case USB_STATE.PERMISSION_REQUIRED:
    case USB_STATE.READ_ONLY:
      return 'warning';
    default:
      return 'danger';
  }
}
