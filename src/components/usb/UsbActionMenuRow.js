/**
 * Copyright (C) 2026 Noam Rathaus
 * Licensed under the GNU Affero General Public License version 3
 *
 * Warning row in the toolbar menu when the USB keystore is not connected. Fetches
 * its own status so the surrounding menu needs no state of its own.
 */

import React, {useEffect, useState} from 'react';
import PropTypes from 'prop-types';
import {strings, describeState} from '../../modules/usb/strings';
import {isUnavailable} from './usbStatus';

export default function UsbActionMenuRow({port}) {
  const [status, setStatus] = useState(null);
  useEffect(() => {
    let active = true;
    port.send('usb-get-status')
    .then(next => active && setStatus(next))
    .catch(() => {});
    return () => {
      active = false;
    };
  }, [port]);
  if (!isUnavailable(status)) {
    return null;
  }
  return (
    <div className="action-menu-item list-group-item list-group-item-warning" role="menuitem">
      <div className="action-menu-item-title d-flex align-items-center">
        <strong>{strings.action_menu_unavailable}</strong>
      </div>
      <p className="mb-0">{describeState(status.state)}</p>
    </div>
  );
}

UsbActionMenuRow.propTypes = {
  port: PropTypes.object.isRequired
};
