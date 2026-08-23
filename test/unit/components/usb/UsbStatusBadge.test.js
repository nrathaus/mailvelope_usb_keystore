/**
 * Copyright (C) 2026 Noam Rathaus
 * Licensed under the GNU Affero General Public License version 3
 *
 * This badge is the only indication the keyring page carries about where keys live,
 * so a wrong label here is the user's whole picture. It used to be binary --
 * anything other than READY read as "disconnected" -- which is plainly false for a
 * device that is connected but write-protected.
 */

import React from 'react';
import {render, screen} from '@testing-library/react';

jest.mock('../../../../src/app/app', () => ({port: {on: jest.fn(), send: jest.fn(() => new Promise(() => {}))}}));

import UsbStatusBadge from '../../../../src/components/usb/UsbStatusBadge';
import {USB_STATE} from '../../../../src/modules/usb/constants';
import {strings} from '../../../../src/modules/usb/strings';

/** Render in isolation and unmount, so repeated calls in one test cannot stack. */
const label = state => {
  const {container, unmount} = render(<UsbStatusBadge status={{enabled: true, state}} />);
  const text = container.textContent;
  unmount();
  return text;
};

describe('UsbStatusBadge', () => {
  it('says where keys are when no device is configured', () => {
    render(<UsbStatusBadge status={{enabled: false, state: USB_STATE.NOT_CONFIGURED}} />);
    expect(screen.getByText(strings.storage_indicator_local)).toBeInTheDocument();
  });

  it('says the keys are on the device when it is ready', () => {
    expect(label(USB_STATE.READY)).toBe(strings.storage_indicator_usb);
  });

  // The case that was wrong: connected, readable, but refusing writes.
  it('distinguishes write-protected from disconnected', () => {
    expect(label(USB_STATE.READ_ONLY)).toBe(strings.storage_indicator_usb_read_only);
    expect(label(USB_STATE.READ_ONLY)).not.toBe(strings.storage_indicator_usb_disconnected);
  });

  it('reports genuinely unreachable states as disconnected', () => {
    for (const state of [USB_STATE.ABSENT, USB_STATE.PERMISSION_REQUIRED,
      USB_STATE.WRONG_DEVICE, USB_STATE.ERROR]) {
      expect(label(state)).toBe(strings.storage_indicator_usb_disconnected);
    }
  });

  it('renders nothing before the status is known', () => {
    const {container} = render(<UsbStatusBadge status={null} />);
    expect(container).toBeEmptyDOMElement();
  });
});
