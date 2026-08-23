/**
 * Copyright (C) 2026 Noam Rathaus
 * Licensed under the GNU Affero General Public License version 3
 *
 * Device chooser for the native-host path.
 *
 * Firefox has no directory picker, so a folder cannot be chosen the way it is on
 * Chromium. Instead the helper enumerates mounted removable media and the user picks
 * from that list. This is arguably the better interface: it only ever offers actual
 * devices, and it can show the real path, which the File System Access API
 * deliberately withholds.
 *
 * Two prerequisites can be missing, and they need different remedies, so they are
 * reported separately rather than as one "unavailable":
 *   - the nativeMessaging permission, which is optional and must be requested
 *   - the helper program itself, which is installed outside the browser
 */

import React from 'react';
import PropTypes from 'prop-types';
import {port} from '../../app/app';
import {strings} from '../../modules/usb/strings';

export default class UsbDevicePicker extends React.Component {
  constructor(props) {
    super(props);
    this.state = {
      devices: null,      // null = not yet asked
      permission: null,   // null = not yet checked
      hostMissing: false,
      busy: false,
      error: null
    };
    this.handleRefresh = this.handleRefresh.bind(this);
    this.handleGrant = this.handleGrant.bind(this);
  }

  componentDidMount() {
    this.checkPermission();
  }

  /**
   * The nativeMessaging permission is optional, so it may simply not be granted
   * yet. Without it every helper call fails, which would otherwise look like a
   * missing helper.
   */
  checkPermission() {
    if (!chrome.permissions?.contains) {
      this.setState({permission: true}, this.handleRefresh);
      return;
    }
    chrome.permissions.contains({permissions: ['nativeMessaging']}, granted => {
      this.setState({permission: granted}, () => {
        if (granted) {
          this.handleRefresh();
        }
      });
    });
  }

  handleGrant() {
    // Must be called from a user gesture, which is why this is a button rather than
    // something done automatically on mount.
    chrome.permissions.request({permissions: ['nativeMessaging']}, granted => {
      this.setState({permission: granted}, () => {
        if (granted) {
          this.handleRefresh();
        }
      });
    });
  }

  async handleRefresh() {
    this.setState({busy: true, error: null, hostMissing: false});
    try {
      const devices = await port.send('usb-list-devices');
      this.setState({devices});
    } catch (e) {
      // A helper that is not installed cannot be distinguished from one that failed
      // to start, and the remedy is the same, so both land here.
      if (e.code === 'USB_HOST_PERMISSION') {
        this.setState({permission: false, error: null});
        return;
      }
      this.setState({hostMissing: e.code === 'USB_HOST_UNAVAILABLE', error: e.message});
    } finally {
      this.setState({busy: false});
    }
  }

  handleSelect(devicePath) {
    return this.props.onSelect(devicePath);
  }

  render() {
    const {devices, permission, hostMissing, busy, error} = this.state;

    if (permission === false) {
      return (
        <div className="alert alert-warning">
          <strong className="d-block">{strings.helper_permission_heading}</strong>
          <p className="mb-2">{strings.helper_permission}</p>
          <button type="button" className="btn btn-sm btn-primary" onClick={this.handleGrant}>
            {strings.helper_permission_grant}
          </button>
        </div>
      );
    }

    if (hostMissing) {
      return (
        <div className="alert alert-warning">
          <strong className="d-block">{strings.helper_needed_heading}</strong>
          <p className="mb-2">{strings.helper_needed}</p>
          <button type="button" className="btn btn-sm btn-secondary"
            onClick={this.handleRefresh} disabled={busy}>
            {strings.devices_refresh}
          </button>
        </div>
      );
    }

    return (
      <div className="card mb-4">
        <div className="card-body">
          <h3 className="h6">{strings.devices_heading}</h3>
          {error && <div className="alert alert-danger small">{error}</div>}
          {devices?.length === 0 && (
            <p className="text-muted mb-3">{strings.devices_none}</p>
          )}
          {devices?.length > 0 && (
            <ul className="list-group list-group-flush mb-3">
              {devices.map(device => (
                <li key={device.path}
                  className="list-group-item d-flex align-items-center px-0">
                  <div className="mr-auto">
                    <strong>{device.label}</strong>
                    {!device.writable && (
                      <span className="badge badge-secondary ml-2">{strings.devices_read_only}</span>
                    )}
                    <code className="d-block small text-muted">{device.path}</code>
                  </div>
                  <button type="button" className="btn btn-sm btn-primary"
                    onClick={() => this.handleSelect(device.path)}
                    disabled={busy || !device.writable}>
                    {strings.devices_use}
                  </button>
                </li>
              ))}
            </ul>
          )}
          <button type="button" className="btn btn-sm btn-secondary"
            onClick={this.handleRefresh} disabled={busy}>
            {strings.devices_refresh}
          </button>
          <p className="text-muted small mb-0 mt-2">{strings.devices_hint}</p>
        </div>
      </div>
    );
  }
}

UsbDevicePicker.propTypes = {
  onSelect: PropTypes.func.isRequired
};
