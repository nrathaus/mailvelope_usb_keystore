/**
 * Copyright (C) 2017 Mailvelope GmbH
 * Licensed under the GNU Affero General Public License version 3
 */

import mvelo from '../lib/lib-mvelo';
import {getUUID} from '../lib/util';
import {SubController, reloadFrames, setAppDataSlot} from './sub.controller';
import * as prefs from '../modules/prefs';
import {hasAnyPrivateKey} from '../modules/keyring';
import {isEnabled as usbEnabled, isUsable as usbUsable, hadKeys as usbHadKeys} from '../modules/usb/state';
import {shouldSeeConsentDialog} from '../lib/analytics';

export default class MenuController extends SubController {
  constructor(port) {
    super(port);
    this.singleton = true;
    // register event handlers
    this.on('browser-action', this.onBrowserAction);
    this.on('get-prefs', () => prefs.prefs);
    this.on('get-is-setup-done', this.getIsSetupDone);
    this.on('analytics-consent', this.analyticsConsent);
  }

  onBrowserAction({action}) {
    switch (action) {
      case 'reload-extension':
        reloadFrames();
        break;
      case 'activate-tab':
        this.addToWatchList();
        break;
      case 'dashboard':
        this.openApp('/dashboard');
        break;
      case 'options':
        this.openApp('/settings');
        break;
      case 'manage-keys':
        this.openApp('/keyring');
        break;
      case 'lets-start':
        this.analyticsConsent();
        break;
      case 'encrypt-file':
        this.openApp('/encrypt');
        break;
      case 'security-settings':
        this.openApp('/settings/security');
        break;
      case 'security-logs':
        this.openApp('/settings/security-log');
        break;
      case 'email-providers':
        this.openApp('/settings/watchlist');
        break;
      default:
        console.log('unknown browser action');
    }
  }

  async getIsSetupDone() {
    // A configured keystore that is merely disconnected means the keys cannot be
    // read, not that setup never happened. Reporting "not set up" here shows the
    // onboarding menu, which invites someone whose key is safe on a detached device
    // to generate a replacement -- the worst possible suggestion for a keystore
    // that is deliberately the only copy.
    if (usbEnabled() && !usbUsable()) {
      // Only claim setup is done if the device is known to have held a key. A
      // keystore configured but never used should still offer onboarding.
      return {isSetupDone: await usbHadKeys()};
    }
    return {isSetupDone: await hasAnyPrivateKey()};
  }

  async addToWatchList() {
    const tab = await mvelo.tabs.getActive();
    if (!tab) {
      throw new Error('No tab found');
    }
    const url = new URL(tab.url);
    const domain = mvelo.util.normalizeDomain(url.hostname);
    const slotId = getUUID();
    setAppDataSlot(slotId, {domain, protocol: url.protocol, port: url.port});
    mvelo.tabs.loadAppTab(`?slotId=${slotId}#/settings/watchlist/push`);
  }

  analyticsConsent() {
    if (shouldSeeConsentDialog()) {
      this.openApp('/analytics-consent');
    } else {
      this.openApp('/onboarding');
    }
  }
}
