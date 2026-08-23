/**
 * Copyright (C) 2026 Noam Rathaus
 * Licensed under the GNU Affero General Public License version 3
 *
 * UI strings for the USB keystore.
 *
 * Deliberately not in locales/en/messages.json: that file is regenerated wholesale
 * upstream (see the 'Normalize l10n files to Weblate format' and 'drop orphan and
 * untranslated keys' commits), so keys added there conflict on every translation
 * sync. English-only here costs nothing on a feature branch; moving these into
 * messages.json is mechanical if the feature is ever upstreamed.
 */

import {USB_STATE} from './constants';

export const strings = {
  settings_tab: 'Key Storage',

  storage_heading: 'Where your keys are stored',
  storage_local_label: 'This computer (default)',
  storage_local_description: 'Keys are stored in this browser profile, on this computer.',
  storage_usb_label: 'USB device',
  storage_usb_description: 'Keys are stored on a removable device. Encryption, decryption and signing only work while it is connected.',
  storage_indicator_local: 'Stored on this computer',
  storage_indicator_usb: 'Stored on USB device',
  storage_indicator_usb_disconnected: 'USB device disconnected',
  storage_switch_to_usb: 'Choose the USB device',
  storage_switch_back_warning: 'Switching back to this computer does not copy any keys back. The keys stay on the device and this profile loses access to them.',

  setup_card_title: 'USB keystore',
  setup_card_text: 'Keep your keys on a removable USB device instead of on this computer. Encryption is only possible while the device is connected.',
  setup_card_button: 'Set up USB keystore',

  status_heading: 'Device status',
  status_checked_now: 'checked just now',
  status_checked_ago: 'checked $1s ago',
  status_checking_live: 'rechecking every second while this page is open',
  status_checking_background: 'rechecking every 30 seconds in the background',
  status_folder: 'Folder',
  status_folder_unknown: 'not selected yet',
  status_path_note: 'Keys are kept in a “mailvelope-keystore” folder inside it. Browsers only report the folder name, not its full path.',
  status_keystore_id: 'Keystore ID',
  status_ready: 'Connected and ready.',
  status_not_configured: 'No USB keystore has been set up.',
  status_unsupported: 'This browser cannot access a USB keystore. Chrome or another Chromium browser is required; Firefox support needs the Mailvelope native helper.',
  status_permission_required: 'Permission to access the keystore directory is needed. Click “Reconnect” to restore it.',
  status_absent: 'The USB keystore is not available. Connect the device to use your keys.',
  status_wrong_device: 'The connected device is not this profile’s keystore.',
  status_error: 'The USB keystore could not be read.',

  banner_unavailable_heading: 'USB keystore not available',
  banner_unavailable_text: 'Your keys are stored on a USB device that is not currently connected. Encryption, decryption and signing are unavailable until you reconnect it.',
  banner_reconnect: 'Reconnect',
  action_menu_unavailable: 'USB keystore not connected',

  choose_directory: 'Choose directory…',
  choose_other_directory: 'Select a different folder…',
  choose_other_directory_hint: 'Use this if the device is mounted somewhere new, or to point this profile at a different device.',
  choose_directory_hint: 'Select the drive or folder that will contain the keystore — typically the root of the device. Mailvelope creates a “mailvelope-keystore” folder inside it, so do not select that folder itself.',
  reconnect: 'Reconnect',
  disable: 'Stop using the USB keystore',
  disable_hint: 'Keys already on the device are left untouched. This browser profile will no longer have access to them.',

  migrate_heading: 'Keys on this computer',
  migrate_text: 'These keys are currently stored in the browser profile. Moving them to the device deletes the local copies.',
  migrate_button: 'Move keys to the device',
  migrate_none: 'No keys are stored on this computer.',
  migrate_done: 'Moved $1 item(s) to the device.',
  migrate_failed: 'Some items could not be moved: $1',
  migrate_private: '$1 private key(s)',
  migrate_public: '$1 public key(s)',
  migrate_autocrypt: '$1 Autocrypt record(s)',
  check_again: 'Check again',
  adopt_anyway: 'Use this folder anyway',
  adopt_hint: 'The keys on the folder this profile used before will no longer be reachable from this browser.',
  migrate_residue_warning: 'Deleting local data does not erase it from the disk: a migrated private key may stay recoverable from the browser profile until the browser reclaims that space. For keys that must never touch this computer, generate a new key directly onto the device and revoke the old one.',

  passphrase_required: 'A passphrase is required when keys are stored on a USB device — it is the only thing protecting them if the device is lost.',
  encrypted_volume_hint: 'For protection at rest, put an encrypted volume on the device (VeraCrypt, or LUKS on Linux) and select it once unlocked. Mailvelope reports a locked volume as disconnected.',
  formatting_hint: 'exFAT is the best choice if the device moves between computers. ext4 adds journaling and file permissions but is practically Linux-only.',

  generate_first_heading: 'Set up the device first',
  generate_first_text: 'Set up the USB keystore before generating or importing a key, so no key material is ever written to this computer.'
};

/**
 * Message describing a state, for the status panel and banners.
 * @param {String} state - one of USB_STATE
 * @return {String}
 */
export function describeState(state) {
  if (!state) {
    return '';
  }
  switch (state) {
    case USB_STATE.READY: return strings.status_ready;
    case USB_STATE.NOT_CONFIGURED: return strings.status_not_configured;
    case USB_STATE.UNSUPPORTED: return strings.status_unsupported;
    case USB_STATE.PERMISSION_REQUIRED: return strings.status_permission_required;
    case USB_STATE.ABSENT: return strings.status_absent;
    case USB_STATE.WRONG_DEVICE: return strings.status_wrong_device;
    default: return strings.status_error;
  }
}
