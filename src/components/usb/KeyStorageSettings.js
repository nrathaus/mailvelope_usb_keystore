/**
 * Copyright (C) 2026 Noam Rathaus
 * Licensed under the GNU Affero General Public License version 3
 *
 * Settings page for where key material is stored: this computer, or a USB device.
 *
 * Framed as a storage location rather than a feature toggle so the current location
 * is always legible. The directory picker has to run here, in the page: it needs a
 * document and a user gesture, which the service worker has neither of.
 */

import React from 'react';
import PropTypes from 'prop-types';
import {port} from '../../app/app';
import {USB_STATE} from '../../modules/usb/constants';
import {strings, describeState} from '../../modules/usb/strings';
import {pickDirectory, isPickerAvailable, regrantPermission} from '../../modules/usb/provision';
import UsbDevicePicker from './UsbDevicePicker';
import {STORAGE, storageOf, statusVariant, subscribeStatus, updateStatus} from './usbStatus';

/** Provisioning refusals the user is allowed to overrule. */
const OVERRIDABLE = ['USB_KEYSTORE_DIFFERENT_DEVICE', 'USB_KEYSTORE_NOT_CONFIGURED_DEVICE'];

export default class KeyStorageSettings extends React.Component {
  constructor(props) {
    super(props);
    this.state = {
      status: null,
      local: null,        // key material still in the browser profile
      diagnostics: null,
      pendingUsb: false,  // 'USB' selected in the UI but no device chosen yet
      busy: false,
      error: null,
      notice: null,
      adoptable: null  // label to retry with when a refusal can be overridden
    };
    this.handleSelectStorage = this.handleSelectStorage.bind(this);
    this.handleChooseDirectory = this.handleChooseDirectory.bind(this);
    this.handleMigrate = this.handleMigrate.bind(this);
    this.handleDisable = this.handleDisable.bind(this);
    this.handleProbe = this.handleProbe.bind(this);
    this.handleReconnect = this.handleReconnect.bind(this);
    this.handleAdopt = this.handleAdopt.bind(this);
    this.handleSelectDevice = this.handleSelectDevice.bind(this);
  }

  componentDidMount() {
    this.unsubscribe = subscribeStatus(port, status => {
      this.setState({status});
      this.refreshDetails(status);
    });
  }

  componentWillUnmount() {
    this.unsubscribe?.();
  }

  /**
   * Reload the informational panels. Takes the status explicitly rather than reading
   * it back out of state, which may not have been applied yet.
   * @param {Object} status
   */
  async refreshDetails(status) {
    try {
      this.setState({local: await port.send('usb-inspect-local')});
    } catch (e) {
      // Informational only; a failure here must not break the page.
    }
    if (status?.state !== USB_STATE.READY) {
      this.setState({diagnostics: null});
      return;
    }
    try {
      this.setState({diagnostics: await port.send('usb-diagnostics')});
    } catch (e) {}
  }

  /**
   * Run an action with a busy flag, surfacing failures rather than swallowing them.
   * @param {Function} fn - resolves to a status object, or undefined
   * @param {String} [notice] - success message
   */
  async run(fn, notice) {
    this.setState({busy: true, error: null, notice: null, adoptable: null});
    try {
      const status = await fn();
      if (status) {
        // Share it with the other subscribed components, not just this page.
        updateStatus(status);
        this.setState({status});
      }
      if (notice) {
        this.setState({notice});
      }
      await this.refreshDetails(status ?? this.state.status);
    } catch (e) {
      this.setState({error: e.message});
    } finally {
      this.setState({busy: false});
    }
  }

  handleSelectStorage({target}) {
    if (target.value === STORAGE.LOCAL) {
      this.handleDisable();
      return;
    }
    // Selecting 'USB device' only reveals the setup panel. Nothing moves until a
    // directory is actually chosen, so a mis-click cannot relocate key material.
    this.setState({pendingUsb: true, error: null, notice: null});
  }

  /**
   * @param {Boolean} [adoptArg] - true only when the user has explicitly agreed to
   *   switch to a different keystore. Coerced strictly: React hands a click event
   *   to an unwrapped handler, and a truthy event must not read as consent.
   */
  handleChooseDirectory(adoptArg) {
    const adopt = adoptArg === true;
    return this.run(async () => {
      const {name} = await pickDirectory();
      try {
        return await port.send('usb-provision', {label: name, adopt});
      } catch (e) {
        // Two refusals are the user's to overrule: a folder holding a different
        // keystore, or none at all. Offer the override rather than dead-ending.
        if (OVERRIDABLE.includes(e.code)) {
          this.setState({adoptable: name});
        }
        throw e;
      }
    });
  }

  handleAdopt() {
    const label = this.state.adoptable;
    return this.run(() => port.send('usb-provision', {label, adopt: true}));
  }

  handleProbe() {
    return this.run(() => port.send('usb-probe'));
  }

  /**
   * Adopt a device chosen from the helper's list, then provision it. Two steps
   * because the path has to be recorded before the device can be inspected: the
   * native backend has no stored handle to recover its location from.
   * @param {String} devicePath
   */
  handleSelectDevice(devicePath) {
    return this.run(async () => {
      await port.send('usb-select-device', {devicePath});
      try {
        return await port.send('usb-provision', {label: devicePath.split('/').pop()});
      } catch (e) {
        if (OVERRIDABLE.includes(e.code)) {
          this.setState({adoptable: devicePath.split('/').pop()});
        }
        throw e;
      }
    });
  }

  /**
   * Restore access to the directory already configured, falling back to a full
   * pick only if there is nothing stored or the user declines.
   */
  handleReconnect() {
    return this.run(async () => {
      const {granted} = await regrantPermission();
      if (!granted) {
        const {name} = await pickDirectory();
        return port.send('usb-provision', {label: name});
      }
      return port.send('usb-probe');
    });
  }

  handleMigrate() {
    return this.run(async () => {
      const {moved, failed} = await port.send('usb-migrate');
      if (failed.length) {
        throw new Error(strings.migrate_failed.replace('$1', failed.map(item => item.key).join(', ')));
      }
      this.setState({notice: strings.migrate_done.replace('$1', String(moved.length))});
      return port.send('usb-get-status');
    });
  }

  handleDisable() {
    return this.run(() => port.send('usb-disable'));
  }

  /**
   * Whether this browser can configure a device at all.
   *
   * Two routes: a directory picker (Chromium), or the native helper enumerating
   * devices (Firefox). Gating on the picker alone wrongly refused the whole feature
   * on Firefox once the helper existed.
   * @return {Boolean}
   */
  canConfigure() {
    return isPickerAvailable() || Boolean(this.state.status?.native);
  }

  renderStorageChoice() {
    const {status, busy, pendingUsb} = this.state;
    const selected = pendingUsb ? STORAGE.USB : storageOf(status);
    const configurable = this.canConfigure();
    return (
      <fieldset className="form-group">
        <legend className="h6">{strings.storage_heading}</legend>
        <div className="custom-control custom-radio mb-3">
          <input
            type="radio" id="storage-local" name="storage" value={STORAGE.LOCAL}
            className="custom-control-input" checked={selected === STORAGE.LOCAL}
            onChange={this.handleSelectStorage} disabled={busy}
          />
          <label className="custom-control-label" htmlFor="storage-local">
            <strong>{strings.storage_local_label}</strong>
            <span className="d-block text-muted">{strings.storage_local_description}</span>
          </label>
        </div>
        <div className="custom-control custom-radio">
          <input
            type="radio" id="storage-usb" name="storage" value={STORAGE.USB}
            className="custom-control-input" checked={selected === STORAGE.USB}
            onChange={this.handleSelectStorage} disabled={busy || !configurable}
          />
          <label className="custom-control-label" htmlFor="storage-usb">
            <strong>{strings.storage_usb_label}</strong>
            <span className="d-block text-muted">{strings.storage_usb_description}</span>
          </label>
        </div>
        {!configurable && (
          <div className="alert alert-secondary mt-3 mb-0">{strings.status_unsupported}</div>
        )}
      </fieldset>
    );
  }

  /**
   * How recently the device was checked, in words.
   * @return {String}
   */
  describeFreshness() {
    const checkedAt = this.state.status?.checkedAt;
    if (!checkedAt) {
      return '';
    }
    const seconds = Math.max(0, Math.round((Date.now() - checkedAt) / 1000));
    return seconds < 2 ? strings.status_checked_now : strings.status_checked_ago.replace('$1', String(seconds));
  }

  renderDevicePanel() {
    const {status, diagnostics, busy} = this.state;
    const configured = Boolean(status?.enabled);
    return (
      <div className="card mb-4">
        <div className="card-body">
          <h3 className="h6">{strings.status_heading}</h3>
          <p className="mb-1">
            <span className={`badge badge-${statusVariant(status)} mr-2`}>{status?.state ?? '…'}</span>
            {describeState(status?.state)}
          </p>
          {/* Freshness rather than a countdown: while this page is visible the
              device is rechecked every second, so a countdown would just flicker.
              What is worth showing is that the status is live and how recently it
              was confirmed -- and if this stops advancing, checking has stopped. */}
          <p className="text-muted small mb-3">
            {this.describeFreshness()}
            {' · '}
            {document.visibilityState === 'visible' ? strings.status_checking_live : strings.status_checking_background}
          </p>
          {configured && (
            <dl className="row small mb-3">
              <dt className="col-sm-4">{strings.status_folder}</dt>
              <dd className="col-sm-8 mb-1">
                <code>{status.label || strings.status_folder_unknown}</code>
                {status.label && <span className="d-block text-muted">{strings.status_path_note}</span>}
              </dd>
              {status.keystoreId && (
                <>
                  <dt className="col-sm-4">{strings.status_keystore_id}</dt>
                  <dd className="col-sm-8 mb-0"><code>{status.keystoreId}</code></dd>
                </>
              )}
            </dl>
          )}
          {configured && status.detail && <p className="text-muted small mb-3">{status.detail}</p>}
          <div className="d-flex flex-wrap">
            {/* Offered whenever the device is not usable, not only before setup:
                a removable device turns up at a different mount point all the time,
                and requiring "Stop using the USB keystore" first makes re-pointing
                look like a destructive act.

                Only on the picker path -- the native path lists devices instead,
                below, since Firefox has no directory picker. */}
            {isPickerAvailable() && (!configured || status.state !== USB_STATE.READY) && (
              <button type="button"
                className={`btn mr-2 mb-2 ${configured ? 'btn-secondary' : 'btn-primary'}`}
                onClick={() => this.handleChooseDirectory()} disabled={busy}>
                {configured ? strings.choose_other_directory : strings.choose_directory}
              </button>
            )}
            {configured && (
              <>
                {/* Re-granting permission needs a user gesture, so reconnecting means
                    picking the directory again from this page. */}
                {status.state === USB_STATE.PERMISSION_REQUIRED && (
                  <button type="button" className="btn btn-primary mr-2 mb-2"
                    onClick={this.handleReconnect} disabled={busy}>
                    {strings.reconnect}
                  </button>
                )}
                <button type="button" className="btn btn-secondary mr-2 mb-2"
                  onClick={this.handleProbe} disabled={busy}>
                  {strings.check_again}
                </button>
                <button type="button" className="btn btn-outline-danger mb-2"
                  onClick={this.handleDisable} disabled={busy}>
                  {strings.disable}
                </button>
              </>
            )}
          </div>
          <p className="text-muted small mb-0">
            {!configured && strings.choose_directory_hint}
            {configured && status.state !== USB_STATE.READY && strings.choose_other_directory_hint}
            {configured && status.state === USB_STATE.READY && strings.disable_hint}
          </p>
          {diagnostics?.keyrings?.length > 0 && (
            <ul className="list-unstyled small text-muted mt-3 mb-0">
              {diagnostics.keyrings.map(keyring => (
                <li key={keyring.dir}><code>{keyring.dir}</code>: {keyring.files.join(', ')}</li>
              ))}
            </ul>
          )}
        </div>
      </div>
    );
  }

  renderMigration() {
    const {local, status, busy} = this.state;
    if (!status?.enabled || !local) {
      return null;
    }
    const total = local.privateKeys + local.publicKeys + local.autocrypt;
    return (
      <div className="card mb-4">
        <div className="card-body">
          <h3 className="h6">{strings.migrate_heading}</h3>
          {total === 0 ? (
            <p className="mb-0 text-muted">{strings.migrate_none}</p>
          ) : (
            <>
              <p>{strings.migrate_text}</p>
              <ul className="small text-muted">
                <li>{strings.migrate_private.replace('$1', String(local.privateKeys))}</li>
                <li>{strings.migrate_public.replace('$1', String(local.publicKeys))}</li>
                <li>{strings.migrate_autocrypt.replace('$1', String(local.autocrypt))}</li>
              </ul>
              <div className="alert alert-warning small">{strings.migrate_residue_warning}</div>
              <button type="button" className="btn btn-primary"
                onClick={this.handleMigrate}
                disabled={busy || status.state !== USB_STATE.READY}>
                {strings.migrate_button}
              </button>
            </>
          )}
        </div>
      </div>
    );
  }

  render() {
    const {status, pendingUsb, error, notice, adoptable} = this.state;
    const showDevice = pendingUsb || Boolean(status?.enabled);
    return (
      <div id="key-storage">
        <h2 className="mb-4">{strings.settings_tab}</h2>
        {error && (
          <div className="alert alert-danger">
            <p className={adoptable ? 'mb-2' : 'mb-0'}>{error}</p>
            {adoptable && (
              <>
                <p className="mb-2 small">{strings.adopt_hint}</p>
                <button type="button" className="btn btn-sm btn-danger"
                  onClick={this.handleAdopt} disabled={this.state.busy}>
                  {strings.adopt_anyway}
                </button>
              </>
            )}
          </div>
        )}
        {notice && <div className="alert alert-success">{notice}</div>}
        {this.renderStorageChoice()}
        {showDevice && this.renderDevicePanel()}
        {showDevice && status?.native && status.state !== USB_STATE.READY && (
          <UsbDevicePicker onSelect={this.handleSelectDevice} />
        )}
        {this.renderMigration()}
        {showDevice && (
          <div className="card">
            <div className="card-body small text-muted">
              <p className="mb-2">{strings.passphrase_required}</p>
              <p className="mb-2">{strings.encrypted_volume_hint}</p>
              <p className="mb-2">{strings.formatting_hint}</p>
              <p className="mb-0">{strings.storage_switch_back_warning}</p>
            </div>
          </div>
        )}
      </div>
    );
  }
}

KeyStorageSettings.propTypes = {
  onSetNotification: PropTypes.func
};
