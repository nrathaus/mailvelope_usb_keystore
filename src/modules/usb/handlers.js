/**
 * Copyright (C) 2026 Noam Rathaus
 * Licensed under the GNU Affero General Public License version 3
 *
 * Port event handlers for the USB keystore, attached to an existing controller.
 *
 * Packaged as one registration call so the controller only needs a single added
 * line rather than an entry per event.
 */

import * as state from './state';
import * as provision from './provision';

/**
 * Attach USB keystore events to a controller and forward state changes to its port.
 * @param {SubController} controller
 */
export function registerUsbHandlers(controller) {
  // Probe rather than answer from cache: a view opening or refreshing is a natural
  // moment to re-check, and it means the UI self-corrects even if the periodic
  // alarm has not fired. One small file read.
  controller.on('usb-get-status', () => provision.reprobe());
  controller.on('usb-probe', () => provision.reprobe());
  controller.on('usb-provision', ({label} = {}) => provision.provision({label}));
  controller.on('usb-disable', () => provision.disable());
  controller.on('usb-diagnostics', () => provision.diagnostics());
  controller.on('usb-inspect-local', () => provision.inspectLocalKeyMaterial());
  controller.on('usb-migrate', () => provision.migrateLocalKeyMaterial());

  const unregister = state.addStateListener((next, previous, status) => {
    const port = controller.ports?.[controller.mainType];
    if (!port) {
      return;
    }
    try {
      port.emit('usb-status-changed', status);
    } catch (e) {
      // The view is gone; stop forwarding to it.
      unregister();
    }
  });
}
