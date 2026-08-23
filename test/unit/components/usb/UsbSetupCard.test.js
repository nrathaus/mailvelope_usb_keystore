/**
 * Copyright (C) 2026 Noam Rathaus
 * Licensed under the GNU Affero General Public License version 3
 *
 * The card serves two different audiences with one component: someone who has not
 * set up a keystore, and someone whose configured device is not reachable. It showed
 * a single hardcoded "not available. Connect the device" line for every unreachable
 * state, which names the wrong remedy for most of them -- the device is already
 * connected when it is the wrong one, or write-protected.
 */

import React from 'react';
import {render, screen} from '@testing-library/react';
import {MemoryRouter} from 'react-router-dom';

jest.mock('../../../../src/app/app', () => ({port: {on: jest.fn(), send: jest.fn(() => new Promise(() => {}))}}));

import UsbSetupCard from '../../../../src/components/usb/UsbSetupCard';
import {USB_STATE} from '../../../../src/modules/usb/constants';
import {strings} from '../../../../src/modules/usb/strings';

function renderCard(status) {
  return render(<MemoryRouter><UsbSetupCard status={status} /></MemoryRouter>);
}

describe('UsbSetupCard', () => {
  it('offers setup when no keystore is configured', () => {
    renderCard({enabled: false, state: USB_STATE.NOT_CONFIGURED});
    expect(screen.getByText(strings.setup_card_title)).toBeInTheDocument();
    // Nothing is wrong yet, so no warning belongs here.
    expect(screen.queryByText(strings.status_absent)).not.toBeInTheDocument();
  });

  // Keys are reachable, so there is nothing to offer and nothing to warn about.
  it('disappears once the device is connected', () => {
    const {container} = renderCard({enabled: true, state: USB_STATE.READY});
    expect(container).toBeEmptyDOMElement();
  });

  // A write-protected device is readable, so the keys work; the card must not
  // reappear claiming the keystore is missing.
  it('disappears on a write-protected device, which is still usable', () => {
    const {container} = renderCard({enabled: true, state: USB_STATE.READ_ONLY});
    expect(container).toBeEmptyDOMElement();
  });

  it('warns that the device is absent when it is', () => {
    renderCard({enabled: true, state: USB_STATE.ABSENT});
    expect(screen.getByText(strings.status_absent)).toBeInTheDocument();
  });

  // The case the generic wording got wrong: a device is present and readable, and
  // telling the user to connect one is a dead end.
  it('names the wrong-device state instead of asking for a device already connected', () => {
    renderCard({enabled: true, state: USB_STATE.WRONG_DEVICE});
    expect(screen.getByText(strings.status_wrong_device)).toBeInTheDocument();
    expect(screen.queryByText(strings.status_absent)).not.toBeInTheDocument();
  });

  it('names the error state rather than reporting absence', () => {
    renderCard({enabled: true, state: USB_STATE.ERROR});
    expect(screen.getByText(strings.status_error)).toBeInTheDocument();
    expect(screen.queryByText(strings.status_absent)).not.toBeInTheDocument();
  });
});
