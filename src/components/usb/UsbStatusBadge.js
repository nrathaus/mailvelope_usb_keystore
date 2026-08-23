/**
 * Copyright (C) 2026 Noam Rathaus
 * Licensed under the GNU Affero General Public License version 3
 *
 * Compact indicator of where keys are stored and, for a USB keystore, whether the
 * device is currently reachable. Shown on the keyring page so the storage location
 * is always visible rather than buried in settings.
 */

import React from 'react';
import PropTypes from 'prop-types';
import {USB_STATE} from '../../modules/usb/constants';
import {strings, describeState} from '../../modules/usb/strings';
import {port} from '../../app/app';
import {statusVariant, useUsbStatus} from './usbStatus';

export default function UsbStatusBadge({status: statusProp}) {
  // The hook must run unconditionally; the prop only overrides its result.
  const fetched = useUsbStatus(port);
  const status = statusProp ?? fetched;
  if (!status) {
    return null;
  }
  if (!status.enabled) {
    return (
      <span className="badge badge-secondary" title={strings.storage_local_description}>
        {strings.storage_indicator_local}
      </span>
    );
  }
  return (
    <span
      className={`badge badge-${statusVariant(status)}`}
      // Derived from the shared state description rather than a local guess, so the
      // tooltip cannot drift from what the settings page says.
      title={describeState(status.state)}
    >
      {indicatorLabel(status.state)}
    </span>
  );
}

/**
 * The short label for a state.
 *
 * Previously binary -- anything other than READY read as "disconnected", which is
 * plainly false for a device that is connected but write-protected, and that was the
 * only signal the keyring page carried.
 * @param {String} state
 * @return {String}
 */
function indicatorLabel(state) {
  switch (state) {
    case USB_STATE.READY:
      return strings.storage_indicator_usb;
    case USB_STATE.READ_ONLY:
      return strings.storage_indicator_usb_read_only;
    default:
      return strings.storage_indicator_usb_disconnected;
  }
}

UsbStatusBadge.propTypes = {
  status: PropTypes.object
};
