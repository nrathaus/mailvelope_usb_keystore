/**
 * Copyright (C) 2026 Noam Rathaus
 * Licensed under the GNU Affero General Public License version 3
 *
 * Surfaces USB keystore failures that no component reports.
 *
 * The keyring UI has one shape for key operations: swallow a cancelled password
 * dialog, rethrow everything else. In an async event handler a rethrow becomes an
 * unhandled promise rejection, so the failure is simply lost -- Key.handleRevoke,
 * User.addUser/removeUser/revokeUser, Keyring.handleDeleteKey and several others all
 * do this. That was nearly harmless while keys lived in local storage and writes
 * effectively never failed.
 *
 * A removable keystore makes those failures routine: the device can be unplugged
 * mid-operation, or be write-protected. Worse, the keyring mutates its in-memory
 * copy before persisting, so a refused write leaves a key looking deleted while it
 * is still on the device. Someone deleting a compromised key would believe it gone.
 *
 * Catching unhandled rejections centrally, rather than patching each call site,
 * keeps the change small and covers paths not enumerated here -- including any added
 * later.
 */

import React from 'react';
import {strings} from '../../modules/usb/strings';
import {USB_KEYSTORE_UNAVAILABLE, USB_READ_ONLY} from '../../modules/usb/constants';

/** Error codes this component takes responsibility for reporting. */
const REPORTED = [USB_KEYSTORE_UNAVAILABLE, USB_READ_ONLY, 'USB_HOST_UNAVAILABLE',
  'USB_HOST_PERMISSION', 'USB_KEYSTORE_LEAK_BLOCKED'];

export default class UsbErrorToast extends React.Component {
  constructor(props) {
    super(props);
    this.state = {message: null};
    this.handleRejection = this.handleRejection.bind(this);
    this.dismiss = this.dismiss.bind(this);
  }

  componentDidMount() {
    window.addEventListener('unhandledrejection', this.handleRejection);
  }

  componentWillUnmount() {
    window.removeEventListener('unhandledrejection', this.handleRejection);
    clearTimeout(this.timer);
  }

  handleRejection(event) {
    const reason = event?.reason;
    if (!reason || !REPORTED.includes(reason.code)) {
      return;
    }
    // Reported, so stop it also reaching the console as an uncaught error.
    event.preventDefault();
    this.setState({message: reason.message || strings.status_error});
    clearTimeout(this.timer);
    // Long enough to read and act on; these explain why something did not happen.
    this.timer = setTimeout(() => this.setState({message: null}), 12000);
  }

  dismiss() {
    clearTimeout(this.timer);
    this.setState({message: null});
  }

  render() {
    if (!this.state.message) {
      return null;
    }
    return (
      <div className="alert alert-danger d-flex align-items-start" role="alert">
        <div className="mr-auto">
          <strong className="d-block">{strings.operation_failed}</strong>
          {this.state.message}
        </div>
        <button type="button" className="close ml-3" aria-label="Close" onClick={this.dismiss}>
          <span aria-hidden="true">&times;</span>
        </button>
      </div>
    );
  }
}
