/**
 * Copyright (C) 2026 Noam Rathaus
 * Licensed under the GNU Affero General Public License version 3
 *
 * Banner shown whenever keys live on a USB device that is not currently usable.
 *
 * This is the visible half of the requirement that an unavailable device is
 * clearly noted: the badge on the toolbar covers the case where no Mailvelope page
 * is open, this covers the case where one is.
 */

import React from 'react';
import PropTypes from 'prop-types';
import {Link} from 'react-router-dom';
import {port} from '../../app/app';
import {strings, describeState} from '../../modules/usb/strings';
import {isUnavailable, useUsbStatus} from './usbStatus';

export default function UsbStatusBanner({status: statusProp, onReconnect}) {
  // The hook must run unconditionally; the prop only overrides its result.
  const fetched = useUsbStatus(port);
  const status = statusProp ?? fetched;
  if (!isUnavailable(status)) {
    return null;
  }
  return (
    <div className="alert alert-warning d-flex flex-wrap align-items-center" role="alert">
      <div className="mr-auto">
        <strong>{strings.banner_unavailable_heading}</strong>
        <div>{describeState(status.state)}</div>
      </div>
      {onReconnect ? (
        <button type="button" className="btn btn-sm btn-primary" onClick={onReconnect}>
          {strings.banner_reconnect}
        </button>
      ) : (
        <Link to="/settings/key-storage" className="btn btn-sm btn-primary">
          {strings.banner_reconnect}
        </Link>
      )}
    </div>
  );
}

UsbStatusBanner.propTypes = {
  status: PropTypes.object,
  onReconnect: PropTypes.func
};
