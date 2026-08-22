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
import {isEnabled, assertUsable} from './state';

/**
 * Refuse a crypto operation when the device holding the keys is not connected.
 *
 * Without this the failure surfaces as "key not found", because reads degrade to an
 * empty keyring and the lookup legitimately finds nothing. That is honest at the
 * keyring layer and misleading at the user layer: it says the key does not exist,
 * when the truth is that it is not reachable. For a keystore that is deliberately
 * the only copy, "not found" is the message most likely to make someone think they
 * have lost the key -- or generate a replacement and abandon a perfectly good one.
 *
 * Applied at the crypto entry points rather than in the UI so the message is right
 * wherever the operation runs, including the editor embedded in a webmail page,
 * which never renders Mailvelope's own status banner.
 * @throws {MvError} with code USB_KEYSTORE_UNAVAILABLE
 */
export async function assertKeystoreForCrypto() {
  if (!isEnabled()) {
    return;
  }
  try {
    await assertUsable();
  } catch (e) {
    throw new MvError(
      'The USB keystore is not available. Connect the device to use your keys.',
      USB_KEYSTORE_UNAVAILABLE
    );
  }
}

/**
 * Require a passphrase whenever keys live on a removable device.
 *
 * The device provides separation and portability, not confidentiality: a private
 * key written to it is protected only by its OpenPGP passphrase. Without one, a
 * lost device hands over the identity outright, which turns the accepted "losing
 * the device is survivable" into a compromise.
 *
 * Enforced in the background rather than only in the generate form, because key
 * generation is also reachable from a webmail page through the client API.
 * @param {String} passphrase
 */
export function assertPassphrase(passphrase) {
  if (isEnabled() && !passphrase) {
    throw new MvError(
      'A passphrase is required when keys are stored on a USB device: it is the only protection if the device is lost',
      'USB_KEYSTORE_PASSPHRASE_REQUIRED'
    );
  }
}

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
