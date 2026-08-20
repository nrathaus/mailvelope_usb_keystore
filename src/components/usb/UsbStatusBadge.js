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
import {strings} from '../../modules/usb/strings';
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
  const ready = status.state === USB_STATE.READY;
  return (
    <span
      className={`badge badge-${statusVariant(status)}`}
      title={ready ? strings.status_ready : strings.status_absent}
    >
      {ready ? strings.storage_indicator_usb : strings.storage_indicator_usb_disconnected}
    </span>
  );
}

UsbStatusBadge.propTypes = {
  status: PropTypes.object
};
