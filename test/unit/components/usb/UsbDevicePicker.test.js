/**
 * Copyright (C) 2026 Noam Rathaus
 * Licensed under the GNU Affero General Public License version 3
 *
 * Two prerequisites can be missing on the native path and they need different
 * remedies: the optional nativeMessaging permission, which the user can grant here,
 * and the helper program, which has to be installed outside the browser. Collapsing
 * them into one "unavailable" would tell someone to install software they already
 * have, so the distinction is worth pinning down.
 */

import React from 'react';
import {render, screen, waitFor} from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const mockSend = jest.fn();
jest.mock('../../../../src/app/app', () => ({port: {send: (...args) => mockSend(...args)}}));

import UsbDevicePicker from '../../../../src/components/usb/UsbDevicePicker';
import {strings} from '../../../../src/modules/usb/strings';

const DEVICES = [
  {path: '/run/media/noamr/STICK', label: 'STICK', writable: true},
  {path: '/run/media/noamr/LOCKED', label: 'LOCKED', writable: false}
];

function grantState(granted) {
  global.chrome.permissions = {
    contains: jest.fn((_p, cb) => cb(granted)),
    request: jest.fn((_p, cb) => cb(true))
  };
}

describe('UsbDevicePicker', () => {
  let onSelect;

  beforeEach(() => {
    mockSend.mockReset();
    onSelect = jest.fn();
    grantState(true);
  });

  it('lists the devices the helper reports, with their real paths', async () => {
    mockSend.mockResolvedValue(DEVICES);
    render(<UsbDevicePicker onSelect={onSelect} />);
    expect(await screen.findByText('STICK')).toBeInTheDocument();
    // The real path is shown because the native path can, unlike the picker path.
    expect(screen.getByText('/run/media/noamr/STICK')).toBeInTheDocument();
  });

  it('selects a device by path', async () => {
    mockSend.mockResolvedValue(DEVICES);
    render(<UsbDevicePicker onSelect={onSelect} />);
    const buttons = await screen.findAllByText(strings.devices_use);
    await userEvent.click(buttons[0]);
    expect(onSelect).toHaveBeenCalledWith('/run/media/noamr/STICK');
  });

  // A keystore on a read-only device would fail at the first write, so do not
  // offer it.
  it('will not offer a read-only device', async () => {
    mockSend.mockResolvedValue(DEVICES);
    render(<UsbDevicePicker onSelect={onSelect} />);
    await screen.findByText('LOCKED');
    expect(screen.getByText(strings.devices_read_only)).toBeInTheDocument();
    const buttons = screen.getAllByText(strings.devices_use);
    expect(buttons[1].closest('button')).toBeDisabled();
  });

  it('says so when nothing is connected', async () => {
    mockSend.mockResolvedValue([]);
    render(<UsbDevicePicker onSelect={onSelect} />);
    expect(await screen.findByText(strings.devices_none)).toBeInTheDocument();
  });

  describe('missing prerequisites', () => {
    it('asks for the permission rather than blaming the helper', async () => {
      grantState(false);
      render(<UsbDevicePicker onSelect={onSelect} />);
      expect(await screen.findByText(strings.helper_permission)).toBeInTheDocument();
      expect(screen.queryByText(strings.helper_needed)).not.toBeInTheDocument();
      // Nothing should have been asked of the helper without permission to do so.
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('lists devices once the permission is granted', async () => {
      grantState(false);
      mockSend.mockResolvedValue(DEVICES);
      render(<UsbDevicePicker onSelect={onSelect} />);
      await userEvent.click(await screen.findByText(strings.helper_permission_grant));
      expect(await screen.findByText('STICK')).toBeInTheDocument();
    });

    it('reports a missing helper rather than a permission problem', async () => {
      const error = new Error('no such native application');
      error.code = 'USB_HOST_UNAVAILABLE';
      mockSend.mockRejectedValue(error);
      render(<UsbDevicePicker onSelect={onSelect} />);
      expect(await screen.findByText(strings.helper_needed)).toBeInTheDocument();
      expect(screen.queryByText(strings.helper_permission)).not.toBeInTheDocument();
    });

    it('shows other failures as errors, not as a missing helper', async () => {
      mockSend.mockRejectedValue(Object.assign(new Error('disk on fire'), {code: 'USB_HOST_IO_ERROR'}));
      render(<UsbDevicePicker onSelect={onSelect} />);
      await waitFor(() => expect(screen.getByText('disk on fire')).toBeInTheDocument());
      expect(screen.queryByText(strings.helper_needed)).not.toBeInTheDocument();
    });
  });
});
