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
import {USB_STATE} from '../../modules/usb/constants';

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
  } else {
    port.send('usb-get-status').then(publish).catch(() => {});
  }
  return () => subscribers.delete(onStatus);
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
  return Boolean(status?.enabled) && status.state !== USB_STATE.READY;
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
      return 'warning';
    default:
      return 'danger';
  }
}
