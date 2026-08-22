/**
 * Copyright (C) 2026 Noam Rathaus
 * Licensed under the GNU Affero General Public License version 3
 *
 * Covers the guards for paths that bypass storage entirely: remote uploads of key
 * material, and generating a key with no passphrase.
 */

jest.mock('../../../../src/modules/usb/state', () => ({isEnabled: jest.fn()}));

describe('usb/guard', () => {
  let guard; let state; let USB_KEYSTORE_UNAVAILABLE;

  beforeEach(() => {
    jest.resetModules();
    state = require('../../../../src/modules/usb/state');
    guard = require('../../../../src/modules/usb/guard');
    ({USB_KEYSTORE_UNAVAILABLE} = require('../../../../src/modules/usb/constants'));
  });

  describe('remote key storage', () => {
    it('is allowed when no USB keystore is configured, so upstream behaviour is unchanged', () => {
      state.isEnabled.mockReturnValue(false);
      expect(guard.isRemoteKeyStorageAllowed()).toBe(true);
      expect(() => guard.assertRemoteKeyStorageAllowed('private key backup')).not.toThrow();
    });

    // createPrivateKeyBackup uploads an encrypted private key to a sync server, and
    // keyring sync uploads the keyring. Both put key material outside the device.
    it('is refused while a USB keystore is configured', () => {
      state.isEnabled.mockReturnValue(true);
      expect(guard.isRemoteKeyStorageAllowed()).toBe(false);
      expect(() => guard.assertRemoteKeyStorageAllowed('private key backup'))
      .toThrow(/private key backup is not available/);
    });

    it('reports the USB error code so callers can map it to a message', () => {
      state.isEnabled.mockReturnValue(true);
      try {
        guard.assertRemoteKeyStorageAllowed('keyring sync');
        throw new Error('should have thrown');
      } catch (e) {
        expect(e.code).toBe(USB_KEYSTORE_UNAVAILABLE);
      }
    });
  });

  describe('passphrase requirement', () => {
    it('is not imposed when keys are stored locally', () => {
      state.isEnabled.mockReturnValue(false);
      expect(() => guard.assertPassphrase('')).not.toThrow();
      expect(() => guard.assertPassphrase(undefined)).not.toThrow();
    });

    // The device gives separation, not confidentiality: without a passphrase a lost
    // device hands over the identity outright.
    it('rejects an empty or missing passphrase in USB mode', () => {
      state.isEnabled.mockReturnValue(true);
      expect(() => guard.assertPassphrase('')).toThrow(/passphrase is required/);
      expect(() => guard.assertPassphrase(undefined)).toThrow(/passphrase is required/);
      expect(() => guard.assertPassphrase(null)).toThrow(/passphrase is required/);
    });

    it('accepts a passphrase in USB mode', () => {
      state.isEnabled.mockReturnValue(true);
      expect(() => guard.assertPassphrase('correct horse battery staple')).not.toThrow();
    });

    it('uses a distinct code so the UI can explain why generation was refused', () => {
      state.isEnabled.mockReturnValue(true);
      try {
        guard.assertPassphrase('');
        throw new Error('should have thrown');
      } catch (e) {
        expect(e.code).toBe('USB_KEYSTORE_PASSPHRASE_REQUIRED');
      }
    });
  });
});
