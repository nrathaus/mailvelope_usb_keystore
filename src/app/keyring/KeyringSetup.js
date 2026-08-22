/**
 * Copyright (C) 2015-2019 Mailvelope GmbH
 * Licensed under the GNU Affero General Public License version 3
 */

import React from 'react';
import PropTypes from 'prop-types';
import {Link} from 'react-router-dom';
import * as l10n from '../../lib/l10n';
import GnupgFooter from './GnupgFooter';
import UsbSetupCard from '../../components/usb/UsbSetupCard';
import UsbKeyActionGate from '../../components/usb/UsbKeyActionGate';

import './KeyringSetup.scss';

l10n.register([
  'gnupg_connection',
  'keyring_available_settings',
  'keyring_setup_generate_key',
  'keyring_setup_generate_key_explanation',
  'keyring_setup_import_key',
  'keyring_setup_import_key_explanation',
  'keyring_setup_no_keypair',
  'keyring_setup_no_keypair_heading'
]);

export default function KeyringSetup({generatePath, importPath, showNoKeypairAlert = false, showGnupgFooter = false}) {
  return (
    <>
      {showNoKeypairAlert && (
        <div className="alert alert-info w-100 mb-4">
          <strong>{l10n.map.keyring_setup_no_keypair_heading}</strong><br />
          <span>{l10n.map.keyring_setup_no_keypair}</span>
        </div>
      )}
      <div className="row row-cols-1 row-cols-md-2">
        <UsbKeyActionGate>
          <div className="col mb-3">
            <div className="card h-100 border keyring-setup-card">
              <div className="card-img-top py-5 text-center">
                <img src="../img/key.svg" width="64" height="64" alt="" />
              </div>
              <div className="card-body d-flex flex-column">
                <h5 className="card-title">{l10n.map.keyring_setup_generate_key}</h5>
                <p className="card-text flex-grow-1">{l10n.map.keyring_setup_generate_key_explanation}</p>
                <Link to={generatePath} className="btn btn-primary btn-lg w-100 mt-auto">
                  {l10n.map.keyring_setup_generate_key}
                </Link>
              </div>
            </div>
          </div>
          <div className="col mb-3">
            <div className="card h-100 border keyring-setup-card">
              <div className="card-img-top py-5 text-center">
                <img src="../img/attachment.svg" width="64" height="64" alt="" />
              </div>
              <div className="card-body d-flex flex-column">
                <h5 className="card-title">{l10n.map.keyring_setup_import_key}</h5>
                <p className="card-text flex-grow-1">{l10n.map.keyring_setup_import_key_explanation}</p>
                <Link to={importPath} className="btn btn-primary btn-lg w-100 mt-auto">
                  {l10n.map.keyring_setup_import_key}
                </Link>
              </div>
            </div>
          </div>
        </UsbKeyActionGate>
        <UsbSetupCard />
      </div>
      {showGnupgFooter && (
        <GnupgFooter heading={l10n.map.gnupg_connection} body={l10n.map.keyring_available_settings} />
      )}
    </>
  );
}

KeyringSetup.propTypes = {
  generatePath: PropTypes.string.isRequired,
  importPath: PropTypes.string.isRequired,
  showNoKeypairAlert: PropTypes.bool,
  showGnupgFooter: PropTypes.bool
};
