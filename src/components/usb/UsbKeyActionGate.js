/**
 * Copyright (C) 2026 Noam Rathaus
 * Licensed under the GNU Affero General Public License version 3
 *
 * Blocks the key-creating actions while keys are meant to live on a USB device
 * that is not currently reachable.
 *
 * The gate deliberately triggers only when a keystore is configured but unusable.
 * When none is configured at all, generating locally is ordinary upstream
 * behaviour and must not be obstructed — there is no way to tell a user who has
 * simply not set up a device from one who intends to and has not got round to it.
 *
 * The background already refuses the write, so this exists to explain the refusal
 * before the user fills in a form, not to enforce it.
 */

import React from 'react';
import PropTypes from 'prop-types';
import {Link} from 'react-router-dom';
import {port} from '../../app/app';
import {strings, describeState} from '../../modules/usb/strings';
import {isUnavailable, useUsbStatus} from './usbStatus';

export default function UsbKeyActionGate({status: statusProp, children}) {
  // The hook must run unconditionally; the prop only overrides its result.
  const fetched = useUsbStatus(port);
  const status = statusProp ?? fetched;
  if (!isUnavailable(status)) {
    return <>{children}</>;
  }
  return (
    <div className="col-12 mb-3">
      <div className="alert alert-warning mb-0">
        <strong>{strings.generate_first_heading}</strong>
        <p className="mb-2">{strings.generate_first_text}</p>
        <p className="mb-2">{describeState(status.state)}</p>
        <Link to="/settings/key-storage" className="btn btn-sm btn-primary">
          {strings.banner_reconnect}
        </Link>
      </div>
    </div>
  );
}

UsbKeyActionGate.propTypes = {
  status: PropTypes.object,
  children: PropTypes.node
};
