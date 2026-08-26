/**
 * Copyright (C) 2026 Noam Rathaus
 * Licensed under the GNU Affero General Public License version 3
 *
 * "Remember password" cannot work while keys live on a USB device -- pwdCache.set()
 * refuses to cache, because the alarm it would create writes the key's fingerprint
 * into this computer's profile. The box was still offered, and checked, so it
 * promised something that never happened.
 */

import React from 'react';
import {render, screen, act} from '@testing-library/react';
import * as l10n from 'lib/l10n';
import PasswordDialog from 'components/enter-password/PasswordDialog';
import {strings as usbStrings} from 'modules/usb/strings';

jest.mock('../../../../src/lib/EventHandler', () => require('../../__mocks__/lib/EventHandler').default);

describe('PasswordDialog cache checkbox', () => {
  beforeAll(() => {
    l10n.mapToLocal();
  });

  async function setup(initData) {
    const ref = React.createRef();
    render(<PasswordDialog ref={ref} id="pwd-dialog-test" />);
    await act(async () => {
      ref.current.setInitData({
        keyId: 'A1B2C3D4',
        userId: 'Tester <tester@test.com>',
        reason: '',
        ...initData
      });
    });
    return screen.getByRole('checkbox');
  }

  it('offers the box when the passphrase can actually be cached', async () => {
    const checkbox = await setup({cache: true, cacheDisabled: false});
    expect(checkbox).toBeChecked();
    expect(checkbox).toBeEnabled();
    expect(screen.queryByText(usbStrings.cache_unavailable)).not.toBeInTheDocument();
  });

  // The bug: checked, clickable, and caching nothing.
  it('shows the box unchecked, disabled and explained on a USB keystore', async () => {
    const checkbox = await setup({cache: false, cacheDisabled: true});
    expect(checkbox).not.toBeChecked();
    expect(checkbox).toBeDisabled();
    expect(screen.getByText(usbStrings.cache_unavailable)).toBeInTheDocument();
  });

  // The field is optional, and its absence must not disable a working box.
  it('leaves the box usable when the controller says nothing about it', async () => {
    const checkbox = await setup({cache: true});
    expect(checkbox).toBeEnabled();
  });
});
