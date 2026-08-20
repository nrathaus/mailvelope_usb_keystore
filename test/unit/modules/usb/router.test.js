/**
 * Copyright (C) 2026 Noam Rathaus
 * Licensed under the GNU Affero General Public License version 3
 */

import {
  classify, encodeKeyringId, isAllowedLocal, containsKeyMaterial, splitAttributes,
  mergeAttributes, serialize, deserialize, TARGET, KEYRING_ATTRIBUTES_KEY
} from '../../../../src/modules/usb/router';
import {MAIN_KEYRING_ID, GNUPG_KEYRING_ID} from '../../../../src/lib/constants';

const PRIVATE_ARMORED = '-----BEGIN PGP PRIVATE KEY BLOCK-----\nabc\n-----END PGP PRIVATE KEY BLOCK-----';
const PUBLIC_ARMORED = '-----BEGIN PGP PUBLIC KEY BLOCK-----\nxyz\n-----END PGP PUBLIC KEY BLOCK-----';

describe('usb/router', () => {
  describe('classify', () => {
    it('routes armored key arrays to the device as .asc files', () => {
      expect(classify(`mvelo.keyring.${MAIN_KEYRING_ID}.privateKeys`)).toEqual({
        target: TARGET.DEVICE,
        path: `mailvelope-keystore/keyrings/${encodeKeyringId(MAIN_KEYRING_ID)}/private.asc`,
        format: 'asc',
        keyringId: MAIN_KEYRING_ID
      });
      expect(classify(`mvelo.keyring.${MAIN_KEYRING_ID}.publicKeys`).path).toMatch(/\/public\.asc$/);
    });

    it('splits the keyring attribute map', () => {
      expect(classify(KEYRING_ATTRIBUTES_KEY).target).toBe(TARGET.SPLIT);
    });

    it('routes autocrypt records to the device', () => {
      const route = classify(`mvelo.autocrypt.${MAIN_KEYRING_ID}`);
      expect(route.target).toBe(TARGET.DEVICE);
      expect(route.format).toBe('json');
    });

    it('leaves settings and OAuth tokens local', () => {
      expect(classify('mvelo.preferences').target).toBe(TARGET.LOCAL);
      expect(classify('mvelo.watchlist').target).toBe(TARGET.LOCAL);
      expect(classify('mvelo.oauth.gmail').target).toBe(TARGET.LOCAL);
    });

    it('handles API keyring IDs containing dots', () => {
      const keyringId = 'example.co.uk|#|someapp';
      expect(classify(`mvelo.keyring.${keyringId}.privateKeys`).keyringId).toBe(keyringId);
    });
  });

  describe('encodeKeyringId', () => {
    it('produces a filesystem-safe single-case name', () => {
      const encoded = encodeKeyringId(MAIN_KEYRING_ID);
      expect(encoded).toMatch(/^[0-9a-f]+$/);
      expect(encoded).not.toContain('|');
    });

    it('round-trips', () => {
      const encoded = encodeKeyringId(MAIN_KEYRING_ID);
      const bytes = encoded.match(/../g).map(byte => parseInt(byte, 16));
      expect(new TextDecoder().decode(new Uint8Array(bytes))).toBe(MAIN_KEYRING_ID);
    });

    // FAT32 and exFAT are case-insensitive, so a case-sensitive encoding such as
    // base64 could map two distinct keyring IDs onto one directory.
    it('does not collide on case-insensitive filesystems', () => {
      expect(encodeKeyringId('AbC|#|x')).not.toBe(encodeKeyringId('aBc|#|x'));
    });
  });

  describe('leak safety net', () => {
    it('recognises known-safe storage keys', () => {
      expect(isAllowedLocal('mvelo.preferences')).toBe(true);
      expect(isAllowedLocal('mvelo.oauth.anything')).toBe(true);
      expect(isAllowedLocal('mvelo.something.new')).toBe(false);
    });

    it('detects armored key material at any depth', () => {
      expect(containsKeyMaterial(PRIVATE_ARMORED)).toBe(true);
      expect(containsKeyMaterial({a: {b: [PRIVATE_ARMORED]}})).toBe(true);
      expect(containsKeyMaterial(PUBLIC_ARMORED)).toBe(true);
    });

    it('does not flag ordinary values', () => {
      expect(containsKeyMaterial({hello: 'world'})).toBe(false);
      expect(containsKeyMaterial(undefined)).toBe(false);
      expect(containsKeyMaterial(null)).toBe(false);
    });
  });

  describe('attribute splitting', () => {
    const attributes = {
      [MAIN_KEYRING_ID]: {
        default_key: 'aabb',
        sanitized: true,
        key_binding: {'a@b.c': {fingerprint: 'ff', last_seen: 1}},
        sync_data: {eTag: '1', changeLog: {}, modified: false}
      },
      [GNUPG_KEYRING_ID]: {sanitized: true}
    };

    it('sends only crypto fields to the device', () => {
      const {device} = splitAttributes(attributes);
      expect(Object.keys(device[MAIN_KEYRING_ID]).sort()).toEqual(['default_key', 'key_binding', 'sync_data']);
      expect(device[GNUPG_KEYRING_ID]).toBeUndefined();
    });

    // keyring.init() reads this map to learn which keyrings exist. If the whole map
    // lived on the device, starting without it would leave the keyring subsystem
    // unable to initialise rather than merely without keys.
    it('keeps the keyring registry local', () => {
      const {local} = splitAttributes(attributes);
      expect(local[MAIN_KEYRING_ID]).toEqual({sanitized: true});
      expect(Object.keys(local)).toEqual([MAIN_KEYRING_ID, GNUPG_KEYRING_ID]);
    });

    it('lists a keyring locally even when it has no local attributes', () => {
      expect(Object.keys(splitAttributes({x: {default_key: 'a'}}).local)).toEqual(['x']);
    });

    it('produces an empty device map when there is no crypto metadata', () => {
      expect(splitAttributes({x: {sanitized: true}}).device).toEqual({});
    });

    it('round-trips through merge', () => {
      const {device, local} = splitAttributes(attributes);
      expect(mergeAttributes(local, device)).toEqual(attributes);
    });

    it('yields no crypto fields when the device is absent', () => {
      const {local} = splitAttributes(attributes);
      expect(mergeAttributes(local, {})[MAIN_KEYRING_ID]).toEqual({sanitized: true});
    });
  });

  describe('serialization', () => {
    it('round-trips armored keys, keeping the file gpg-importable', () => {
      const serialized = serialize([PRIVATE_ARMORED, PUBLIC_ARMORED], 'asc');
      expect(serialized).toContain('-----BEGIN PGP PRIVATE KEY BLOCK-----');
      expect(deserialize(serialized, 'asc')).toEqual([PRIVATE_ARMORED, PUBLIC_ARMORED]);
    });

    it('treats an empty or missing .asc file as an empty keyring', () => {
      expect(deserialize('', 'asc')).toEqual([]);
      expect(serialize([], 'asc')).toBe('');
    });

    it('round-trips JSON values', () => {
      expect(deserialize(serialize({a: 1}, 'json'), 'json')).toEqual({a: 1});
      expect(deserialize('', 'json')).toBeUndefined();
    });
  });
});
