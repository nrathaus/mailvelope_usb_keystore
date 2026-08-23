/**
 * Copyright (C) 2026 Noam Rathaus
 * Licensed under the GNU Affero General Public License version 3
 *
 * Destructive controls are disabled rather than offered and then refused. Clicking
 * Delete, watching the key vanish because the keyring mutates memory before
 * persisting, and then seeing it reappear is worse than not being able to click --
 * particularly for a key being deleted because it is compromised.
 */

jest.mock('../../../../src/app/app', () => ({port: {on: jest.fn(), send: jest.fn()}}));

import {canModifyKeys, whyCannotModify} from '../../../../src/components/usb/usbStatus';
import {USB_STATE} from '../../../../src/modules/usb/constants';
import {strings} from '../../../../src/modules/usb/strings';

describe('canModifyKeys', () => {
  // Ordinary local operation must be untouched by a feature nobody opted into.
  it('allows changes when no keystore is configured', () => {
    expect(canModifyKeys({enabled: false, state: USB_STATE.NOT_CONFIGURED})).toBe(true);
    expect(canModifyKeys(null)).toBe(true);
    expect(canModifyKeys(undefined)).toBe(true);
  });

  it('allows changes on a connected, writable device', () => {
    expect(canModifyKeys({enabled: true, state: USB_STATE.READY})).toBe(true);
  });

  // The case that prompted this: the device is present and the keys are readable,
  // so nothing looked wrong, but no write could succeed.
  it('refuses changes on a write-protected device', () => {
    expect(canModifyKeys({enabled: true, state: USB_STATE.READ_ONLY})).toBe(false);
  });

  it('refuses changes when the device is not reachable', () => {
    for (const state of [USB_STATE.ABSENT, USB_STATE.PERMISSION_REQUIRED,
      USB_STATE.WRONG_DEVICE, USB_STATE.ERROR, USB_STATE.UNSUPPORTED]) {
      expect(canModifyKeys({enabled: true, state})).toBe(false);
    }
  });

  describe('whyCannotModify', () => {
    it('says nothing when changes are possible', () => {
      expect(whyCannotModify({enabled: true, state: USB_STATE.READY})).toBeUndefined();
    });

    // Used as the tooltip on a disabled control, so it has to explain rather than
    // just deny.
    it('explains write protection', () => {
      expect(whyCannotModify({enabled: true, state: USB_STATE.READ_ONLY}))
      .toBe(strings.status_read_only);
    });

    it('explains a disconnected device', () => {
      expect(whyCannotModify({enabled: true, state: USB_STATE.ABSENT}))
      .toBe(strings.status_absent);
    });
  });
});
