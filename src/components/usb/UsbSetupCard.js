/**
 * Copyright (C) 2026 Noam Rathaus
 * Licensed under the GNU Affero General Public License version 3
 *
 * Card offering a USB keystore on the keyring setup screen, so the option is
 * present at the moment a user would otherwise create keys on this computer.
 *
 * Ordering matters: setting up the device before generating a key is what keeps key
 * material off the local disk entirely, because deleting it later does not erase it
 * (see doc/usb-keystore-plan.md §3.1). Hence the card, and the note that appears
 * once a device is selected but not yet reachable.
 */

import React from 'react';
import PropTypes from 'prop-types';
import {Link} from 'react-router-dom';
import {port} from '../../app/app';
import {strings} from '../../modules/usb/strings';
import {isUnavailable, useUsbStatus} from './usbStatus';

export default function UsbSetupCard({status: statusProp}) {
  // The hook must run unconditionally; the prop only overrides its result.
  const fetched = useUsbStatus(port);
  const status = statusProp ?? fetched;
  // Once keys are on a reachable device there is nothing to offer here.
  if (status?.enabled && !isUnavailable(status)) {
    return null;
  }
  return (
    <div className="col mb-3">
      <div className="card h-100 border keyring-setup-card">
        <div className="card-img-top py-5 text-center">
          <img src="../img/key.svg" width="64" height="64" alt="" />
        </div>
        <div className="card-body d-flex flex-column">
          <h5 className="card-title">{strings.setup_card_title}</h5>
          <p className="card-text flex-grow-1">{strings.setup_card_text}</p>
          {isUnavailable(status) && (
            <p className="text-warning small">{strings.status_absent}</p>
          )}
          <Link to="/settings/key-storage" className="btn btn-secondary btn-lg w-100 mt-auto">
            {strings.setup_card_button}
          </Link>
        </div>
      </div>
    </div>
  );
}

UsbSetupCard.propTypes = {
  status: PropTypes.object
};
