/**
 * Copyright (C) 2018 Mailvelope GmbH
 * Licensed under the GNU Affero General Public License version 3
 */

import React from 'react';
import {Route, Redirect, withRouter} from 'react-router-dom';
import PropTypes from 'prop-types';
import * as l10n from '../../lib/l10n';
import {MAIN_KEYRING_ID, GNUPG_KEYRING_ID, SETUP_SKIPPED} from '../../lib/constants';
import {port} from '../app';
import {KeyringOptions} from './KeyringOptions';
import KeyGrid from './KeyGrid';
import Key from './Key';
import User from './User';
import KeyImport from './KeyImport';
import GenerateKey from './GenerateKey';
import KeyringSetup from './KeyringSetup';
import Spinner from '../../components/util/Spinner';
import KeyringSelect from './components/KeyringSelect';
import KeyringBreadcrumb from './components/KeyringBreadcrumb';
import Notifications from '../../components/util/Notifications';
import {subscribeStatus, isUnavailable, canModifyKeys, whyCannotModify} from '../../components/usb/usbStatus';

l10n.register([
  'keyring_generate_key',
  'keyring_import_keys',
  'keyring_setup',
  'onboarding_skip'
]);

const DEMAIL_SUFFIX = 'de-mail.de';

function PageTitle({children}) {
  return (
    <div className="card-title d-flex flex-wrap align-items-center">
      <h1 className="flex-shrink-0 mr-auto">{children}</h1>
    </div>
  );
}

PageTitle.propTypes = {
  children: PropTypes.node
};

class Keyring extends React.Component {
  constructor(props) {
    super(props);
    // get URL parameter
    const query = new URLSearchParams(document.location.search);
    const keyringId = query.get('krid') || '';
    const name = query.get('fname') || '';
    const email = query.get('email') || '';
    this.state = {
      keyringId,
      name,
      email,
      keyringAttr: undefined, // keyring meta data
      defaultKeyFpr: '', // active keyring: fingerprint of default key
      hasPrivateKey: false, // active keyring: has private key
      hasUsablePrivateKey: false, // any keyring in the preferred queue has a private key (fallback-aware)
      demail: false, // active keyring: is keyring from de-mail provider
      gnupg: false, // active keyring: is the GnuPG keyring
      keys: [], // active keyring: keys
      keysLoading: true, // active keyring: waiting for loading of keys
      setupSkipped: false,
      usbStatus: null,
      notifications: []
    };
    this.handleChangeKeyring = this.handleChangeKeyring.bind(this);
    this.handleDeleteKeyring = this.handleDeleteKeyring.bind(this);
    this.handleDeleteKey = this.handleDeleteKey.bind(this);
    this.handleChangeDefaultKey = this.handleChangeDefaultKey.bind(this);
    this.handleRefreshKeyring = this.handleRefreshKeyring.bind(this);
    this.loadKeyring = this.loadKeyring.bind(this);
    this.handleNotification = this.handleNotification.bind(this);
    this.handleSkipSetup = this.handleSkipSetup.bind(this);
  }

  async componentDidMount() {
    await this.initActiveKeyring();
    await this.loadKeyring();
    // The background reloads the keystore when the device returns, so refresh the
    // list rather than leaving the page showing the empty keyring it read while
    // the device was away.
    // Reload on any change of device state, in both directions. Leaving READY
    // matters as much as returning to it: the background purges its keyrings when
    // the device goes away, so a page that does not refresh keeps listing keys it
    // can no longer use.
    this.unsubscribeUsb = subscribeStatus(port, status => {
      const next = status?.state;
      const changed = this.usbState !== undefined && this.usbState !== next;
      this.usbState = next;
      // Kept in state so render can tell "no key pair" from "cannot read the keys".
      this.setState({usbStatus: status});
      // Reload on a change, and also whenever a reachable device coincides with an
      // empty list: that combination means this page read the keyring before the
      // background finished loading it from the device, and without a second look
      // it would keep offering to generate a key that already exists.
      const staleEmpty = status?.enabled && next === 'READY' && !this.state.keys.length;
      if (changed || staleEmpty) {
        this.loadKeyring();
      }
    });
  }

  componentWillUnmount() {
    this.unsubscribeUsb?.();
  }

  setStateAsync(state) {
    return new Promise(resolve => this.setState(state, resolve));
  }

  async initActiveKeyring() {
    if (this.state.keyringId) {
      return;
    }
    const keyringId = await port.send('get-active-keyring');
    await this.setStateAsync({keyringId: keyringId || MAIN_KEYRING_ID});
  }

  async loadKeyring() {
    /* eslint-disable react/no-access-state-in-setstate */
    const keyringAttr = await port.send('get-all-keyring-attr');
    const keyringId = keyringAttr[this.state.keyringId] ? this.state.keyringId : MAIN_KEYRING_ID;
    const defaultKeyFpr = keyringAttr[keyringId].default_key || '';
    const demail = keyringId.includes(DEMAIL_SUFFIX);
    const gnupg = keyringId === GNUPG_KEYRING_ID;
    // propagate state change to backend
    port.emit('set-active-keyring', {keyringId});
    const [keys, setupSkipped, hasUsablePrivateKey] = await Promise.all([
      port.send('getKeys', {keyringId}),
      port.send('get-session-pref', {key: SETUP_SKIPPED}),
      port.send('has-usable-private-key', {keyringId})
    ]);
    const sortedKeys = keys.sort((a, b) => a.name.localeCompare(b.name));
    const hasPrivateKey = sortedKeys.some(key => key.type === 'private');
    const wasEmpty = !this.state.keys.length;
    /* eslint-enable react/no-access-state-in-setstate */
    this.setState({
      keyringId, defaultKeyFpr, demail, gnupg, keyringAttr, hasPrivateKey, hasUsablePrivateKey, keys: sortedKeys, setupSkipped: Boolean(setupSkipped), keysLoading: false
    });
    // The redirect to the setup screen only happens on the exact /keyring path, so
    // once there the URL is sticky: keys arriving later leave the user looking at
    // "set up a key" with a perfectly good key loaded behind it. That is precisely
    // what happens when a USB device is reconnected. Leave the screen when keys
    // turn up, and only then -- a 0 to N transition cannot be confused with someone
    // deliberately opening setup while they already have keys.
    if (wasEmpty && sortedKeys.length && this.props.location?.pathname === '/keyring/setup') {
      this.props.history.push('/keyring/display');
    }
  }

  async handleSkipSetup() {
    await port.send('set-session-pref', {key: SETUP_SKIPPED, value: true});
    this.props.history.push('/keyring/display');
  }

  async handleChangeKeyring(keyringId) {
    await this.setStateAsync({keyringId, keysLoading: true});
    await this.loadKeyring();
  }

  async handleDeleteKeyring(keyringId) {
    await port.send('delete-keyring', {keyringId});
    await this.loadKeyring();
  }

  async handleChangeDefaultKey(keyFpr) {
    await port.send('set-keyring-attr', {keyringId: this.state.keyringId, keyringAttr: {default_key: keyFpr}});
    this.setState({defaultKeyFpr: keyFpr});
  }

  async handleDeleteKey(fingerprint, type) {
    try {
      await port.send('removeKey', {fingerprint, type, keyringId: this.state.keyringId});
    } catch (e) {
      // A swallowed failure here is worse than a visible one: the keyring mutates
      // memory before persisting, so a refused write made the key vanish from the
      // list while it remained on the device. Someone deleting a compromised key
      // would believe it gone.
      this.handleNotification({
        header: l10n.map.keyring_header,
        message: e.message,
        type: 'error',
        hideDelay: 10000
      });
    }
    this.loadKeyring();
  }

  async handleRefreshKeyring() {
    // Re-read the store, not just the in-memory copy, whenever the keys live
    // somewhere Mailvelope does not control. That was already true of GnuPG; it is
    // equally true of a USB device, whose contents can change while detached or be
    // edited from another machine. Without this, Refresh silently did less than it
    // appears to for a USB keystore.
    if (this.state.gnupg || this.state.usbStatus?.enabled) {
      this.setState({keysLoading: true});
      await port.send('reload-keystore', {keyringId: this.state.keyringId});
    }
    this.loadKeyring();
  }

  handleNotification(notification) {
    this.setState({notifications: [notification]});
  }

  render() {
    return (
      <>
        <KeyringOptions.Provider value={{keyringId: this.state.keyringId, demail: this.state.demail, gnupg: this.state.gnupg}}>
          <div className="jumbotron">
            <section className="card">
              {!this.state.keyringId || this.state.keysLoading ? (
                <Spinner delay={0} />
              ) : (
                <>
                  <Route exact path="/keyring" render={() => this.state.keys.length || this.state.setupSkipped || this.state.hasUsablePrivateKey ? <Redirect to="/keyring/display" /> : <Redirect to="/keyring/setup" />} />
                  <Route exact path="/keyring/key/:keyFpr" render={props => <Key {...props} keyData={this.state.keys.find(key => key.fingerprint === props.match.params.keyFpr)} defaultKeyFpr={this.state.defaultKeyFpr} onChangeDefaultKey={this.handleChangeDefaultKey} onDeleteKey={this.handleDeleteKey} onKeyringChange={this.loadKeyring} canModify={canModifyKeys(this.state.usbStatus)} cannotModifyReason={whyCannotModify(this.state.usbStatus)} />} />
                  <Route exact path="/keyring/key/:keyFpr/user/:userIdx" render={props => <User {...props} keyData={this.state.keys.find(key => key.fingerprint === props.match.params.keyFpr)} onKeyringChange={this.loadKeyring} />} />
                  <Route path="/keyring/display/:keyId?" render={props => (<KeyGrid keys={this.state.keys} {...props} keyringAttr={this.state.keyringAttr} onChangeKeyring={this.handleChangeKeyring} onDeleteKeyring={this.handleDeleteKeyring} prefs={this.props.prefs} defaultKeyFpr={this.state.defaultKeyFpr} onChangeDefaultKey={this.handleChangeDefaultKey} onDeleteKey={this.handleDeleteKey} onRefreshKeyring={this.handleRefreshKeyring} spinner={this.state.keysLoading} canModify={canModifyKeys(this.state.usbStatus)} cannotModifyReason={whyCannotModify(this.state.usbStatus)} />)} />
                  <Route path="/keyring/import" render={({location}) => (
                    <div className="card-body">
                      <KeyringBreadcrumb />
                      <PageTitle>{l10n.map.keyring_import_keys}</PageTitle>
                      <KeyImport onKeyringChange={this.loadKeyring} onImportComplete={() => this.props.history.push('/keyring/display/')} onNotification={this.handleNotification} location={location} cancelTo="/keyring" />
                    </div>
                  )} />
                  <Route path="/keyring/generate" render={() => (
                    <div className="card-body">
                      <KeyringBreadcrumb />
                      <PageTitle>{l10n.map.keyring_generate_key}</PageTitle>
                      <GenerateKey onKeyringChange={this.loadKeyring} onGenerateComplete={({key}) => this.props.history.push(`/keyring/display/${key.keyId}`)} onNotification={this.handleNotification} defaultName={this.state.name} defaultEmail={this.state.email} cancelTo="/keyring" />
                    </div>
                  )} />
                  <Route path="/keyring/setup" render={() => (
                    <div className="card-body">
                      <div className="card-title d-flex flex-wrap align-items-center">
                        <h1 className="flex-shrink-0 mr-auto">{l10n.map.keyring_setup}</h1>
                        <button type="button" className="btn btn-secondary px-4 mr-5" onClick={this.handleSkipSetup}>{l10n.map.onboarding_skip}</button>
                        <div className="flex-shrink-0">
                          <KeyringSelect keyringId={this.state.keyringId} keyringAttr={this.state.keyringAttr} onChange={this.handleChangeKeyring} prefs={this.props.prefs} />
                        </div>
                      </div>
                      <KeyringSetup
                        generatePath="/keyring/generate"
                        importPath="/keyring/import"
                        showNoKeypairAlert={!this.state.hasPrivateKey && !this.state.hasUsablePrivateKey && !isUnavailable(this.state.usbStatus)}
                        showGnupgFooter
                      />
                    </div>
                  )} />
                </>
              )}
            </section>
          </div>
          <Notifications items={this.state.notifications} hideDelay={5000} />
        </KeyringOptions.Provider>
      </>
    );
  }
}

Keyring.propTypes = {
  prefs: PropTypes.object,
  location: PropTypes.object,
  history: PropTypes.object
};

export default withRouter(Keyring);
