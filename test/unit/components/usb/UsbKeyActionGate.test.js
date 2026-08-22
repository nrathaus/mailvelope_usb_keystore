/**
 * Copyright (C) 2026 Noam Rathaus
 * Licensed under the GNU Affero General Public License version 3
 *
 * The gate's condition is easy to get wrong in a way that would either break
 * ordinary local key generation or fail to warn when the device is missing, so it
 * is worth pinning down: block only when a keystore is configured *and* unusable.
 */

import React from 'react';
import {render, screen} from '@testing-library/react';
import {MemoryRouter} from 'react-router-dom';

// The component reads the shared app port; a stub keeps app.js out of the test.
jest.mock('../../../../src/app/app', () => ({port: {on: jest.fn(), send: jest.fn(() => new Promise(() => {}))}}));

import UsbKeyActionGate from '../../../../src/components/usb/UsbKeyActionGate';
import {USB_STATE} from '../../../../src/modules/usb/constants';
import {strings} from '../../../../src/modules/usb/strings';

function renderGate(status) {
  return render(
    <MemoryRouter>
      <UsbKeyActionGate status={status}>
        <div>generate and import cards</div>
      </UsbKeyActionGate>
    </MemoryRouter>
  );
}

const CHILDREN = 'generate and import cards';

describe('UsbKeyActionGate', () => {
  // Blocking here would break Mailvelope for everyone not using the feature.
  it('allows key creation when no keystore is configured', () => {
    renderGate({enabled: false, state: USB_STATE.NOT_CONFIGURED});
    expect(screen.getByText(CHILDREN)).toBeInTheDocument();
    expect(screen.queryByText(strings.generate_first_heading)).not.toBeInTheDocument();
  });

  it('allows key creation while the device is connected', () => {
    renderGate({enabled: true, state: USB_STATE.READY});
    expect(screen.getByText(CHILDREN)).toBeInTheDocument();
  });

  it('allows key creation before the status has loaded, rather than flashing a warning', () => {
    renderGate(null);
    expect(screen.getByText(CHILDREN)).toBeInTheDocument();
  });

  it('blocks and explains when the configured device is absent', () => {
    renderGate({enabled: true, state: USB_STATE.ABSENT});
    expect(screen.queryByText(CHILDREN)).not.toBeInTheDocument();
    expect(screen.getByText(strings.generate_first_heading)).toBeInTheDocument();
    expect(screen.getByText(strings.status_absent)).toBeInTheDocument();
  });

  it('blocks when the permission grant is missing', () => {
    renderGate({enabled: true, state: USB_STATE.PERMISSION_REQUIRED});
    expect(screen.queryByText(CHILDREN)).not.toBeInTheDocument();
    expect(screen.getByText(strings.status_permission_required)).toBeInTheDocument();
  });

  it('blocks when the wrong device is connected', () => {
    renderGate({enabled: true, state: USB_STATE.WRONG_DEVICE});
    expect(screen.queryByText(CHILDREN)).not.toBeInTheDocument();
  });

  it('offers a route to the key storage settings so the user can act on it', () => {
    renderGate({enabled: true, state: USB_STATE.ABSENT});
    expect(screen.getByText(strings.banner_reconnect).closest('a'))
    .toHaveAttribute('href', '/settings/key-storage');
  });
});
