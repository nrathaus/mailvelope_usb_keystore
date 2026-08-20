/**
 * Copyright (C) 2026 Noam Rathaus
 * Licensed under the GNU Affero General Public License version 3
 *
 * Guards for the paths that would copy key material off the USB device.
 *
 * Storage redirection is handled centrally by install.js, but two paths do not go
 * through storage at all — they upload key material to a remote sync server:
 *
 *   - PrivateKeyController.createPrivateKeyBackup, which encrypts the private key
 *     under a backup code and uploads it. Triggered by a webmail provider page
 *     through the client API, not by Mailvelope's own UI, so it has to be refused
 *     here rather than hidden in the interface.
 *   - SyncController.triggerSync, which uploads the encrypted keyring.
 *
 * Both are incompatible with keeping key material only on the device.
 */

import {MvError} from '../../lib/util';
import {USB_KEYSTORE_UNAVAILABLE} from './constants';
import {isEnabled} from './state';

/**
 * May key material be sent to a remote store?
 * @return {Boolean} false while a USB keystore is configured
 */
export function isRemoteKeyStorageAllowed() {
  return !isEnabled();
}

/**
 * Throw if key material may not be sent to a remote store.
 * @param {String} what - operation name, for the error message
 */
export function assertRemoteKeyStorageAllowed(what) {
  if (!isRemoteKeyStorageAllowed()) {
    throw new MvError(
      `${what} is not available while keys are stored on a USB device: it would copy key material off the device`,
      USB_KEYSTORE_UNAVAILABLE
    );
  }
}
