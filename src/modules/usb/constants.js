/**
 * Copyright (C) 2026 Noam Rathaus
 * Licensed under the GNU Affero General Public License version 3
 *
 * Constants for the USB-resident keystore.
 *
 * Deliberately kept out of src/lib/constants.js: this feature is developed on a
 * branch that tracks upstream master, so all of its state lives in new files and
 * existing files are only touched at small hook points. See doc/usb-keystore-plan.md.
 */

/** Availability states of the USB keystore. */
export const USB_STATE = {
  /** No USB keystore has been set up. */
  NOT_CONFIGURED: 'NOT_CONFIGURED',
  /** No usable backend in this browser (Firefox without the native host). */
  UNSUPPORTED: 'UNSUPPORTED',
  /** A directory handle is stored but the permission grant is missing. */
  PERMISSION_REQUIRED: 'PERMISSION_REQUIRED',
  /** Configured and permitted, but the device is not readable: not plugged in. */
  ABSENT: 'ABSENT',
  /** Readable, but it is not the device this profile was set up with. */
  WRONG_DEVICE: 'WRONG_DEVICE',
  /** I/O failure or a corrupt keystore. */
  ERROR: 'ERROR',
  /** Everything usable. */
  READY: 'READY'
};

/** States in which key material must not be read or written. */
export const UNUSABLE_STATES = [
  USB_STATE.NOT_CONFIGURED,
  USB_STATE.UNSUPPORTED,
  USB_STATE.PERMISSION_REQUIRED,
  USB_STATE.ABSENT,
  USB_STATE.WRONG_DEVICE,
  USB_STATE.ERROR
];

/** Error code raised whenever a crypto operation is attempted without the device. */
export const USB_KEYSTORE_UNAVAILABLE = 'USB_KEYSTORE_UNAVAILABLE';

/** chrome.storage.local key holding the USB keystore configuration (no key material). */
export const USB_CONFIG_KEY = 'mvelo.usb.config';

/** IndexedDB database and store holding the FileSystemDirectoryHandle. */
export const HANDLE_DB_NAME = 'mvelo.usb';
export const HANDLE_STORE_NAME = 'handles';
export const HANDLE_KEY = 'keystoreDir';

/** Root directory created on the device. */
export const DEVICE_ROOT = 'mailvelope-keystore';
/** Marker file used both as the presence probe and as the device identity. */
export const MARKER_FILE = 'keystore.json';
/** Plain-text explanation written alongside the keys, for recovery by hand. */
export const README_FILE = 'README.txt';

/** Subdirectory holding one directory per keyring. */
export const KEYRINGS_DIR = 'keyrings';

/** On-device layout version, so a future format change can be detected. */
export const KEYSTORE_VERSION = 1;

/** chrome.alarms name for the periodic presence probe. */
export const PROBE_ALARM = 'mvelo.usb.probe';
/**
 * Probe period in minutes. 0.5 (30s) is Chrome's floor for a periodic alarm.
 *
 * This is only the backstop for when nobody is looking. A timer is the wrong
 * instrument for "the user is watching the page" -- see FOCUS_PROBE_INTERVAL_MS.
 */
export const PROBE_PERIOD_MINUTES = 0.5;

/**
 * How often a *visible* Mailvelope page re-checks the device.
 *
 * Not subject to the alarm floor, and this is the number that governs perceived
 * latency: detection only feels slow while someone is looking at the page. Each
 * check is one small marker-file read, and polling stops the moment the page is
 * hidden or the last subscriber goes away, so an idle browser does no device I/O
 * beyond the 30-second alarm.
 *
 * The cost of 1s is that a visible page keeps a removable device from idling. That
 * is a real but small price on flash media, and it only applies while a Mailvelope
 * page is actually in front of the user.
 */
export const FOCUS_PROBE_INTERVAL_MS = 1000;
