# USB-Resident Keystore — Implementation Plan

Branch: `feature/usb-keystore`

## 1. Goal

Mailvelope should be able to keep **all** OpenPGP key material on a removable USB device:

1. Detect whether the USB keystore device is present and whether the files it needs are readable/writable.
2. When the device becomes unavailable, say so clearly and stop all crypto operations.
3. Store **no** crypto information anywhere except the USB device.
4. When no USB keystore is configured, offer an option to add one.

### Constraint: the branch must track upstream `master`

Changes are kept **minimal and additive**, with all logic in new files and existing files
touched only at small hook points. Diff footprint is treated as a first-class design criterion,
not a tidiness preference — see §4 and §7. As built, the footprint is +31/-2 lines across
11 files, all additive.

### Priority ordering

Keeping key material — **especially private keys** — off the laptop/desktop outranks key
durability. **If the USB device is lost, losing the keys with it is an acceptable outcome.**

This is not a neutral trade-off to be balanced later; it decides every design question below.
No local copy, no remote copy, no backup stick. Where a choice exists between "less residue on
the machine" and "less chance of losing keys", the former always wins.

## 2. Platform constraints (this shapes everything)

A browser extension cannot open an arbitrary filesystem path such as `/media/usb0`. The
options available to an MV3 extension are:

| Mechanism | Read | Write | Chrome | Firefox | Verdict |
|---|---|---|---|---|---|
| **File System Access API** (`showDirectoryPicker`) | yes | yes | yes (86+) | **no** | Primary backend |
| **Native messaging host** | yes | yes | yes | yes | Secondary backend (required for Firefox) |
| `<input type="file" webkitdirectory>` | yes | **no** | yes | yes | Insufficient — no writes |
| **WebUSB** (`navigator.usb`) | — | — | yes | no | Rejected: the OS kernel claims mass-storage devices, so WebUSB cannot see or read a USB stick's filesystem |
| `chrome.fileSystem` | yes | yes | ChromeOS apps only | no | Not available to extensions |

Consequences that drive the design:

- **The directory picker only runs in a document.** `showDirectoryPicker()` lives on `Window`;
  the MV3 service worker cannot call it, and `requestPermission()` needs a user gesture.
  So provisioning and permission re-grants happen in the app page (`app/app.html`), never in
  the background.
- **A `FileSystemDirectoryHandle` cannot be sent over `chrome.runtime` messaging.** Runtime
  messages are JSON-serialized, not structured-cloned. The handle is therefore persisted to
  **IndexedDB by the app page**, and the service worker reads it back from IndexedDB — both
  live on the same `chrome-extension://<id>` origin. The port message only carries a signal
  ("a handle is stored"), not the handle.
- **Firefox has no File System Access API** (only OPFS, which is not the USB stick). Firefox
  support therefore requires the native messaging host, which is scoped as a separate phase.
  Until it exists, Firefox reports state `UNSUPPORTED` with an explanatory message rather than
  silently falling back to local storage.
- **There is no filesystem "device removed" event.** Presence is determined by *actively
  probing* a marker file, on a timer and before every operation.

### Phase 0 — de-risking spike (do this first, it is small)

Two assumptions must be confirmed empirically before building on them:

1. A `FileSystemDirectoryHandle` retrieved from IndexedDB **inside the MV3 service worker** can
   be used for `getFileHandle()` / `getFile()` / `createWritable()`.
2. Whether a `readwrite` grant on a `chrome-extension://` origin **survives a browser restart**.

If (1) fails, all USB I/O is routed through the existing offscreen document instead
(`mvelo.util.sendOffscreenMessage` already establishes that pattern in
[lib-mvelo.js:130](../src/lib/lib-mvelo.js#L130)); the rest of the design is unchanged.

If (2) fails, the UX gains one required click per browser session ("Unlock USB keystore"),
handled by the existing `PERMISSION_REQUIRED` state — no redesign, but it must be planned for
rather than discovered late.

## 3. Where key material lives today

Audit of every persistence site (from `grep` over `src/`), and what happens to each in USB mode:

| Location | Contents | Action |
|---|---|---|
| `mvelo.keyring.<id>.publicKeys` / `.privateKeys` — [KeyStoreLocal.js](../src/modules/KeyStoreLocal.js) | armored public + private keys | **Move to USB**, delete local copy after verified migration |
| `mvelo.keyring.attributes` — [keyring.js:26](../src/modules/keyring.js#L26) | `default_key`, `primary_key`, `sync_data` (fingerprint changelog), `key_binding` (email→fingerprint) | **Move to USB** per-keyring `attributes.json` |
| `mvelo.autocrypt.<id>` — [autocryptWrapper.js:152](../src/modules/autocryptWrapper.js#L152) | public keys harvested from Autocrypt headers | **Move to USB** `autocrypt.json` |
| `pwdCache` → `chrome.storage.session` — [pwdCache.js:92](../src/modules/pwdCache.js#L92) | **decrypted private keys and passphrases** | Memory-backed only; **purge on every transition to absent**. Confirm `storage.session` is never written to disk on both browsers |
| Sync server — [sync.controller.js:167](../src/controller/sync.controller.js#L167) | encrypted keyring + changelog uploaded to a remote server | **Block** for USB-backed keyrings |
| Key backup — [privateKey.controller.js:164](../src/controller/privateKey.controller.js#L164) (`sync.backup({backup})`) | **encrypted private key backup uploaded off-device** | **Block** for USB-backed keyrings |
| `mveloKeyServer.upload` — [app.controller.js:184](../src/controller/app.controller.js#L184) | own *public* key, explicit user action | Keep; public-only and user-initiated. Called out in the settings UI |
| GnuPG keyring — [KeyStoreGPG.js](../src/modules/KeyStoreGPG.js) | keys in the OS GnuPG home directory | **Open decision — see §9** |
| `mvelo.oauth.*`, Gmail tokens — [gmail.js:232](../src/modules/gmail.js#L232) | OAuth tokens (not PGP material) | Out of scope, documented |
| `mvelo.preferences`, `mvelo.watchlist`, `localStorage` watchlist cache | settings only | Unaffected |

### 3.1 Deleting from `chrome.storage.local` does not erase the bytes from disk

This matters more than anything else in this section, given the priority ordering in §1. To be
unambiguous: **this is data written to persistent storage, not a memory artifact.**

**Chrome.** `storage.local` is a LevelDB database at
`<profile>/Local Extension Settings/<extension-id>/` (`MANIFEST-*`, `*.log`, `*.ldb`).

- `set()` appends the value to the write-ahead log (`.log`) and a memtable; when the memtable
  fills it is flushed to an immutable sorted table (`.ldb`). Both are on disk.
- `remove()` erases nothing. LevelDB is log-structured and append-only, so deletion appends a
  *tombstone*. Reads see the tombstone and report "not found" while the original value record
  remains in whichever `.log` / `.ldb` file it landed in.
- Those bytes go away only when **compaction** rewrites that file without them. Compaction is
  driven by write pressure, and a keyring is a *low-write* store — so a rarely-updated keyring
  may not be compacted for a very long time, or in practice never. The low write volume makes
  this worse, not better.
- Armored keys are plain ASCII with distinctive headers, so recovery requires no sophistication:
  `strings` plus a grep for `-----BEGIN PGP PRIVATE KEY BLOCK-----` over the profile directory.

**Firefox.** `storage.local` is backed by IndexedDB over SQLite, where `DELETE` releases pages
to the freelist and content persists until those pages are reused or the database is `VACUUM`ed.
Different substrate, same class of problem.

**Second layer, beyond reach.** Once compaction does unlink the old `.ldb`, the bytes sit in
unallocated space; on an SSD, wear-levelling means even an explicit overwrite may not touch the
original physical cells. No extension can address this.

So a migration that moves local private keys to the stick and calls `storage.remove()` leaves
those keys **recoverable from disk by anyone with filesystem access**, for an indeterminate
period. That is precisely the outcome the feature exists to prevent.

Mitigations, honestly ranked:

1. **Never write the keys locally in the first place.** In USB mode, key generation writes
   straight to the device (`KeyStoreUsb.generateKey` → USB), never through the local store. For
   a user setting up fresh, nothing is ever written locally and the problem does not arise.
   This is the only mitigation that is actually complete.
2. **Tell the truth in the UI.** Migration of pre-existing local keys must state plainly that
   copies may remain recoverable from the browser profile on disk, and that the durable fix is
   to generate a fresh key onto the device and revoke the old one.
3. **Overwrite-before-delete — weak, and partly counterproductive.** Because the store is
   append-only, re-`set()`ing a key to junk *appends* records rather than scrubbing old ones,
   so in the interim it **increases** the number of on-disk copies. It helps only indirectly, by
   adding write pressure that may trigger compaction sooner. It raises a probability and
   guarantees nothing. Include it only if measurement (below) shows it actually helps.

**Design rule.** `chrome.storage.session` *is* memory-only. If key material ever has to be
staged outside the USB device, session storage is the only acceptable place — never
`storage.local`.

**Recommendation:** offer migration, but make "generate a fresh key onto the USB device" the
primary path in the setup flow, with the residue caveat stated in the UI rather than buried
here. Given that key loss is acceptable but local residue is not, a fresh key costs nothing the
user has said they value.

#### Private browsing does not help

A natural question, worth answering in writing: no, running in a Firefox private window does not
make the keystore ephemeral.

- **`storage.local` has no private-browsing partition.** It is a single store per extension.
  An extension running in a private window reads and writes the *same* `storage.local` as normal
  browsing, and the data survives the window closing. Private browsing gives memory-only storage
  to **web content** (the visited origins' cookies, cache, `localStorage`, IndexedDB); it does
  not extend to an extension's own store. There is also one background context per extension,
  shared across normal and private windows.
- **Firefox disables extensions in private windows by default**, so Mailvelope would not run
  there at all without the user explicitly enabling "Run in Private Windows".
- **The residue is historical anyway.** The bytes at issue were written during earlier
  normal-mode use. How the browser is used *later* cannot unwrite them.

The one real (unrelated) benefit: private windows do make *webmail page* data more ephemeral —
cached message bodies, or decrypted plaintext a page stashes in its own storage. That concerns
message content, not key material.

What does address bytes already on disk:

- **Revoke the migrated key.** The strongest available response. Its limit must be stated:
  revocation prevents future use, but whoever recovers the private key can still decrypt
  *previously intercepted* ciphertext encrypted to it. It bounds future damage, not past.
- **Full-disk encryption.** The honest answer for the layer no extension can reach (unallocated
  blocks, SSD wear-levelled cells). FDE plus a USB keystore is genuine defence in depth for the
  threat model in §1, and the settings UI should say so.
- **A fresh browser profile** after migrating: deleting the old profile destroys the whole
  LevelDB and clears the logical layer, though unlinked blocks persist until overwritten.

#### Measure it, don't assume it (Phase 0)

The mechanism above is established LevelDB behaviour, but its *practical* severity here — how
long the residue actually survives for a keyring-sized, low-write store — should be measured,
not asserted. On a throwaway browser profile:

1. install the extension, generate a private key, confirm it is in `storage.local`
2. run the migration (or plain `storage.remove()`)
3. `grep -rl "BEGIN PGP PRIVATE KEY" "<profile>/Local Extension Settings/<id>/"`
4. repeat after forcing write pressure, and after a browser restart, to see whether and when
   compaction clears it
5. repeat step 3 with the overwrite-before-delete heuristic enabled, to establish whether
   mitigation 3 earns its place

This is cheap, definitive, and decides how strongly the UI has to warn.

### 3.2 The clean path: a new user generating straight onto the device

This is the primary supported scenario — fresh install, no keys to bring along, generate onto
the USB device. Traced through the code, **no armored private key ever touches
`chrome.storage.local`** on this path:

- `KeyringBase.generateKey` ([KeyringBase.js:319](../src/modules/KeyringBase.js#L319)) calls
  `keystore.generateKey()` (openpgp.js, pure in-memory computation), pushes the result into the
  in-memory `privateKeys` array, and optionally uploads the **public** key only.
  `KeyStoreUsb.store()` is then the sole act of persistence → the device.
- `uiLog` ([uiLog.js:9](../src/modules/uiLog.js#L9)) is an in-process array, never persisted,
  and records i18n event types rather than key material.
- `pwdCache` uses `chrome.storage.session`, which is memory-only.

So there is no residue, nothing to revoke, and no warning to show. The full-disk-encryption
advice in §3.1 becomes belt-and-braces rather than a necessity. Three conditions make this
guarantee real rather than incidental:

1. **Sequencing.** On a fresh install `keystore.backend` defaults to `local`, so the main
   keyring is built with `KeyStoreLocal`. A user who generates *before* provisioning the device
   writes locally and lands straight in the §3.1 residue case. The setup flow must therefore be
   *provision device → then generate*, and the UI must enforce that ordering rather than
   offering both as equal choices. In [KeyringSetup.js](../src/app/keyring/KeyringSetup.js), when
   USB mode is enabled but no device is configured, the generate and import cards are gated
   behind device setup.
2. **Generation must fail closed.** If the device is not `READY` when generation is requested,
   refuse with `USB_KEYSTORE_UNAVAILABLE`. Never fall back to `KeyStoreLocal` silently — that
   fallback is the difference between "clean by construction" and "clean if nothing goes wrong".
3. **Block the externally-triggered backup path.** Verified: `createKeyBackupContainer` is a
   **client-API** method ([client-api.js:403](../src/client-API/client-api.js#L403)) that a
   webmail provider page can invoke; it encrypts the private key and uploads it via
   `sync.backup()`. It is *not* part of the app's own generate flow, so a new user generating
   from the Mailvelope UI will not hit it — but because the trigger is external, the refusal has
   to live in `PrivateKeyController`, not in our UI.

#### What the USB device does and does not protect

Worth being precise, because "on a USB stick for secrecy" invites an overestimate: the device
provides **separation and portability, not confidentiality**. A private key written there is
protected only by its OpenPGP passphrase. With no passphrase, the stick holds a plaintext
private key and anyone who picks it up has the identity.

Consequences for the UI:

- In USB mode, key generation should **require** a passphrase and encourage a strong one — it is
  the only thing standing between a lost stick and a compromised key.
- Offering an encrypted volume on the device (LUKS, VeraCrypt, BitLocker To Go) is worth
  mentioning in the settings text as the way to get at-rest confidentiality. It is transparent
  to this feature: the picker simply targets the mounted volume, and `ABSENT` covers "present
  but not unlocked" with no extra code.
- One residual caveat that no design here removes: key material is in service-worker memory
  while in use, and the OS may swap those pages to disk. Encrypted swap or full-disk encryption
  is the only answer, which is a second reason to recommend FDE.

## 4. Core design decision: intercept the storage layer

**Overriding constraint: this branch must track upstream `master`.** Every line changed in an
existing file is a future rebase conflict, so the design is judged on diff footprint as much as
on correctness. All logic lives in new files; existing files get the smallest possible hook.

Three ways to attach a USB store, in increasing order of how little they disturb the tree:

1. **A new keyring** (`localhost|#|usb`) beside the main one. Rejected: the main keyring still
   exists locally (violating requirement 3 unless emptied anyway), and `MAIN_KEYRING_ID` is
   threaded through much of the app.
2. **A `KeyStoreUsb` class selected in `buildKeyring()`.** Workable — `buildKeyring()`
   ([keyring.js:182](../src/modules/keyring.js#L182)) already picks a keystore class per keyring,
   so it is a two-line hook there. But key *metadata* does not go through the keystore:
   `KeyringAttrMap` and `autocryptWrapper.Store` write straight to `mvelo.storage`, so this
   still requires edits in `keyring.js` and `autocryptWrapper.js`, and a new pref means touching
   `prefs.js` and `defaults.json`.
3. **Intercept `mvelo.storage` itself.** Every crypto persistence path in the audit of §3 —
   keys, keyring attributes, Autocrypt records — funnels through the three functions
   `mvelo.storage.{get,set,remove}` in [lib-mvelo.js:26](../src/lib/lib-mvelo.js#L26). Wrapping
   those at install time routes crypto keys to the device and passes everything else through to
   `chrome.storage.local`.

**Chosen: option 3.** `KeyStoreLocal`, `KeyringAttrMap` and `autocryptWrapper.Store` then work
**verbatim, unmodified** — they ask `mvelo.storage` for armored keys and get them, unaware of
the source. There is no `KeyStoreUsb` class, and no change at all to `keyring.js`,
`KeyStoreLocal.js`, `autocryptWrapper.js`, `prefs.js`, `defaults.json` or `constants.js`.

Two properties beyond the smaller diff make this the better design and not merely the cheaper
one:

- **Central enforcement.** Requirement 3 becomes one function deciding what is crypto and where
  it goes, rather than a rule re-implemented at each call site. The router **default-denies**:
  a key matching a crypto pattern goes to the device or fails, and only an explicit allowlist
  (`mvelo.preferences`, `mvelo.watchlist`, `mvelo.oauth.*`) passes through to local storage. A
  future upstream commit that adds a new crypto storage key is then caught by the router instead
  of silently writing to disk.
- **Fail-closed for free.** When the device is not `READY` the wrapper rejects, so every caller
  inherits the §3.2 fail-closed requirement without individually implementing it.

The cost is that the redirection is implicit — someone reading `KeyStoreLocal` sees no sign of
it. That is mitigated by a comment at the single install site and by this document, and is a
fair trade for a branch whose main risk is rebase friction.

The same technique covers the badge conflict from §6: the module also wraps
`mvelo.action.state`, so badge arbitration needs no edit to `uiLog.js`.

Configuration lives under its own storage key (`mvelo.usb.config`, on the allowlist and holding
no key material) rather than in `prefs`, which keeps `prefs.js`, `defaults.json` and the prefs
UI untouched.

### 4.2 On-device representation

The interceptor sees storage keys and values, so the router maps them to device files:

| Storage key | Device file | Format |
|---|---|---|
| `mvelo.keyring.<id>.publicKeys` | `keyrings/<enc>/public.asc` | value is an array of armored strings — join on write, split on read |
| `mvelo.keyring.<id>.privateKeys` | `keyrings/<enc>/private.asc` | as above |
| `mvelo.keyring.attributes` | `keyrings/attributes.json` | JSON verbatim |
| `mvelo.autocrypt.<id>` | `keyrings/<enc>/autocrypt.json` | JSON verbatim |

Keeping the key files as real `.asc` files is a deliberate choice: it costs a `join`/`split` and
means the stick stays usable for recovery with `gpg --import` if Mailvelope is unavailable.

### 4.1 The crypto library is orthogonal — with one exception

Mailvelope has two independent abstractions. This work touches only the first:

| Axis | Selector | Implementations | Question |
|---|---|---|---|
| Keystore | `KeyStoreBase` subclass, chosen in `buildKeyring()` | `KeyStoreLocal`, `KeyStoreGPG` | *Where do the key bytes live?* |
| PGP backend | `keyring.getPgpBackend()`, consumed only in [pgpModel.js](../src/modules/pgpModel.js) | [openpgpjs.js](../src/modules/openpgpjs.js), [gnupg.js](../src/modules/gnupg.js) | *Who does the crypto math?* |

The question that matters for a USB keystore is not "which library" but **does the library own
key storage, or does the caller hand it keys as data?**

- **openpgp.js is data-in/data-out.** It receives key objects from the keystore
  (`keyring.getPrivateKeyByIds()`, `keyring.keystore.getAllKeys()`) and never touches storage:
  armored text in via `readKey()`, `key.armor()` back out. `KeyStoreUsb` is therefore a drop-in
  — the library is unaware of where the bytes came from. Any equivalent library (openpgp.js v6,
  a WASM Sequoia/rPGP build) would work the same way. Swapping libraries is an unrelated
  migration and should not be bundled into this branch.
- **GnuPG owns its keyring, which is why it cannot be redirected.** [gnupg.js](../src/modules/gnupg.js)
  passes *fingerprints* to GPGME; keys never leave `~/.gnupg`. `KeyStoreGPG.store()` throws by
  design. There is no seam to point at a USB device from inside an extension — hence the
  decision to hide that keyring in USB mode (§9.2).

**The exception:** GnuPG *can* be pointed at removable media via `GNUPGHOME`. An extension
cannot set it, but the Phase 5 native messaging host could launch gpg with
`GNUPGHOME=<usb>/mailvelope-keystore/gnupg`, yielding real GnuPG-on-USB and Firefox support in
one move. Deliberately out of scope: it means shipping a native binary, and it inherits
`gpg-agent`'s lifecycle — a running agent caches unlocked secret keys in memory and keeps its
socket under `GNUPGHOME`, which complicates the "device removed" guarantees this plan is built
on. Revisit only if GnuPG parity becomes a requirement.

## 5. On-device layout

```
<user-picked directory>/
  mailvelope-keystore/
    keystore.json                 # {version, keystoreId (UUID), created, label}
    keyrings/
      <encoded-keyring-id>/
        meta.json                 # the real keyring id
        public.asc                # concatenated armored public keys
        private.asc               # concatenated armored private keys
        attributes.json           # default_key, sync_data, key_binding, sanitized
        autocrypt.json            # Autocrypt-discovered public keys
```

Notes:

- Keyring IDs contain `|#|` (`KEYRING_DELIMITER`), and `|` is not a legal filename character on
  Windows/FAT/exFAT — the most likely filesystems on a USB stick. Directory names are therefore
  an encoding of the id, with the true id recorded in `meta.json`.
- **Use hex or base32 for that encoding, not base64.** FAT32 and exFAT are *case-insensitive*.
  URL-safe base64 is case-sensitive, so two distinct keyring IDs can encode to names differing
  only in case and then collide on the device — silently mapping two keyrings onto one
  directory. Hex and base32 are single-case and immune to this.
- **Pick a subdirectory, not the volume root.** Chrome's File System Access blocklist rejects
  various sensitive locations, and a subdirectory keeps the picker predictable. The layout above
  already nests everything under `mailvelope-keystore/`.
- `keystore.json` carries a random `keystoreId`. The extension keeps a copy of that UUID in
  `chrome.storage.local` so it can distinguish "my keystore device" from "some other stick
  mounted at the same place" (state `WRONG_DEVICE`). The UUID is a random label, not key
  material, so keeping it locally does not violate requirement 3.

### Device formatting — a user choice, not a code concern

The File System Access API goes through the OS and exposes nothing about the underlying
filesystem: `FileSystemHandle` has no filesystem, label, or UUID accessor. **The extension
therefore cannot detect the format and should not try to enforce one.** Any volume the OS mounts
read-write works. Guidance belongs in the settings help text, not in code.

| Filesystem | Portability | Journaled | POSIX perms | Notes |
|---|---|---|---|---|
| **exFAT** | Windows, macOS, Linux (kernel 5.7+) | no | no | Best default — universal, no size limits |
| **FAT32** | universal, including old systems | no | no | Fine; 4 GB file limit is irrelevant at keyring sizes |
| **ext4** | Linux only in practice | **yes** | **yes** | Journaling and `chmod 600` on the private key, at the cost of portability |
| **NTFS** | Windows native, Linux ntfs3, macOS read-only | yes | partial | No advantage here |

Recommendation: **exFAT** if the stick will move between machines — portability is the reason to
use a USB keystore in the first place. **ext4** only for a Linux-only setup, where journaling
(better tolerance of a mid-write yank) and permission bits are worth losing portability for.
Note the extension cannot set permissions either way — FSA has no `chmod` — so POSIX perms only
help if the user sets them up.

**The format is the wrong layer to optimise for secrecy.** No filesystem in that table provides
confidentiality; on FAT32/exFAT everything is world-readable once mounted. Per §3.2, the key on
the device is protected only by its OpenPGP passphrase. For real at-rest protection, use an
encrypted volume — **VeraCrypt** for cross-platform, **LUKS** for Linux-only — and this is
entirely transparent to the implementation: the picker targets the mounted volume, and
"present but not unlocked" surfaces as `ABSENT` with no extra code.

**One detail this settles about presence detection.** Automounters differ in what they leave
behind on removal: the mount point may vanish (so the handle throws `NotFoundError`) or may
persist as an empty directory (so the handle still resolves and only the *contents* are gone).
Probing for `keystore.json` rather than merely resolving the directory handle covers both cases —
which is why §6 probes a marker file. It is also the only device-identity mechanism available,
since FSA exposes no volume UUID.

### Write integrity

A USB stick can be pulled mid-write, which would otherwise corrupt a keyring. Every write:

1. writes `private.asc.tmp`,
2. re-reads and parses it to confirm the expected key count,
3. rotates the previous generation to `private.asc.bak`,
4. `move()`s the temp file into place (`FileSystemFileHandle.move()`, Chrome 111+; fall back to
   write-and-swap where unavailable).

On load, a missing or unparsable primary file falls back to `.bak` and surfaces a warning.

## 6. Availability state machine

```
NOT_CONFIGURED   no USB keystore set up            → offer "Add USB keystore"
UNSUPPORTED      no usable backend (Firefox today) → explain, offer native host
PERMISSION_REQUIRED  handle stored, grant missing  → one-click re-grant in app page
ABSENT           handle + grant, marker unreadable → "USB keystore not available"
WRONG_DEVICE     readable, keystoreId mismatch     → "This is not your keystore device"
ERROR            I/O failure or corrupt keystore   → diagnostics
READY            everything usable
```

Probing (there is no removal event, so presence is always actively checked):

- read `mailvelope-keystore/keystore.json`; `NotFoundError` / `NotReadableError` → `ABSENT`
- a `chrome.alarms` periodic probe (Chrome MV3 floor is 0.5 min; use 1 min, configurable)
- a probe **before every keystore operation** — a single small file read
- a probe on app-page focus/`visibilitychange` and on action-menu open

On transition **to** `ABSENT` / `WRONG_DEVICE` / `ERROR`:

1. `keystore.clear()` — drop all key material from service-worker memory
2. purge `pwdCache` — it holds decrypted private keys and passphrases
3. red badge via the existing `mvelo.action.state({badge, badgeColor})` — **note the conflict:**
   [uiLog.js:42](../src/modules/uiLog.js#L42) already owns the badge, setting a green `Ok` on any
   user interaction and unconditionally clearing it 2s later, which would silently wipe the USB
   warning. Badge ownership needs arbitration: USB state takes priority, and `uiLog`'s
   `clearBadge()` must restore the USB badge rather than blanking it
4. broadcast `usb-status-changed` to every connected port (app, action menu, editor,
   decrypt/encrypt frames)
5. every crypto entry point rejects with `MvError(..., 'USB_KEYSTORE_UNAVAILABLE')`, mapped to
   a clear localized message in the existing error surfaces

On transition **to** `READY`: reload the keystore from the device and re-broadcast.

## 7. New and changed files

Everything self-contained lives under `src/modules/usb/` and `src/components/usb/`. Existing
files are touched only at the hook sites in the second table.

**New files** (all of the logic)

| File | Responsibility |
|---|---|
| `src/modules/usb/install.js` | `installUsbKeystore()` — wraps `mvelo.storage.{get,set,remove}` and `mvelo.action.state`; the single entry point |
| `src/modules/usb/guard.js` | refusal for the two paths that bypass storage entirely and upload key material remotely |
| `src/modules/usb/router.js` | storage-key → device-file mapping, crypto-pattern matching, allowlist default-deny (§4.2) |
| `src/modules/usb/state.js` | state machine, marker-file probing, `chrome.alarms`, transition broadcast, pwdCache purge |
| `src/modules/usb/backend.js` | backend interface: `probe()`, `readFile()`, `writeFile()`, `removeFile()`, `listDir()` |
| `src/modules/usb/FsaBackend.js` | File System Access implementation |
| `src/modules/usb/NativeBackend.js` | native messaging implementation (Phase 5) |
| `src/modules/usb/handleStore.js` | IndexedDB persistence of the directory handle — written by the app page, read by the service worker (§2) |
| `src/modules/usb/provision.js` | device setup, `keystore.json` creation, migration with verify-then-delete |
| `src/modules/usb/constants.js` | states, `USB_KEYSTORE_UNAVAILABLE`, storage keys — *not* `lib/constants.js` |
| `src/modules/usb/strings.js` | English UI strings — see the l10n note below |
| `src/modules/usb/handlers.js` | `registerUsbHandlers(controller)` — attaches all `this.on(...)` port events |
| `src/components/usb/KeyStorageSettings.js` | settings page, framed as a storage-location choice: this computer (default) or USB device, plus status, re-grant, migrate, disable, diagnostics |
| `src/components/usb/usbStatus.js` | status subscription with local fan-out, plus the `useUsbStatus` hook |
| `src/components/usb/UsbStatusBadge.js` | ambient "stored on …" indicator for the keyring page |
| `src/components/usb/UsbSetupCard.js` | the "Set up USB keystore" card (requirement 4) |
| `src/components/usb/UsbStatusBanner.js` | banner shown whenever state is not `READY` |
| `src/components/usb/UsbActionMenuRow.js` | action-menu warning row |

**Hook sites** (the complete diff against upstream)

| File | Change | Lines |
|---|---|---|
| [src/background.js](../src/background.js) | import + `await installUsbKeystore()` before `initKeyring()` | 2 |
| [src/controller/app.controller.js](../src/controller/app.controller.js) | import + `registerUsbHandlers(this)` in the constructor | 2 |
| [src/modules/pwdCache.js](../src/modules/pwdCache.js) | `export function clear() { cache.clear(); }` — the instance method exists, it is just not exported | 3 |
| [src/controller/privateKey.controller.js](../src/controller/privateKey.controller.js) | guard in `createPrivateKeyBackup` (§3.2 item 3) | 2 |
| [src/controller/sync.controller.js](../src/controller/sync.controller.js) | guard in `triggerSync` | 2 |
| [src/app/settings/Settings.js](../src/app/settings/Settings.js) | import + `NavPill` + `Route` for `/settings/key-storage` | 4 |
| [src/app/app.js](../src/app/app.js) | import + `<UsbStatusBanner />` so an unavailable device is noted on every page | 2 |
| [src/app/keyring/Keyring.js](../src/app/keyring/Keyring.js) | import + `<UsbStatusBadge />` in the page title | 2 |
| [src/components/action-menu/components/ActionMenuWrapper.js](../src/components/action-menu/components/ActionMenuWrapper.js) | pass `port` to `ActionMenuBase` | 1 |
| [src/app/keyring/KeyringSetup.js](../src/app/keyring/KeyringSetup.js) | import + `<UsbSetupCard />` | 2 |
| [src/components/action-menu/components/ActionMenuBase.js](../src/components/action-menu/components/ActionMenuBase.js) | import + `<UsbActionMenuRow />` | 2 |

**Actual footprint as built: +31/-2 lines across 11 files**, every hook additive, which is what
keeps rebases cheap. Deliberately **not** touched:
`keyring.js`, `KeyStoreLocal.js`, `keyStore.js`, `autocryptWrapper.js`, `prefs.js`,
`defaults.json`, `lib/constants.js`, `lib-mvelo.js`, `uiLog.js`, `locales/`.

**l10n note.** New strings stay in `src/modules/usb/strings.js` rather than
`locales/en/messages.json`. That file is large, shared, and *regenerated* upstream — recent
history (`Normalize l10n files to Weblate format`, `drop orphan and untranslated keys`) shows it
is rewritten wholesale, so added keys are a recurring conflict. English-only strings in our own
module cost nothing now; if the feature is ever upstreamed, moving them into `messages.json` is
mechanical.

## 8. Phasing

| Phase | Content | Reviewable output |
|---|---|---|
| **0** | Spike: FSA handle usable from the service worker; permission persistence across restart; **LevelDB residue measurement (§3.1)** | Findings, `go`/adjust decision |
| **1** | `UsbBackend` + `FsaBackend` + `handleStore` + state machine + probing + alarms | Status observable via a dev command; no keystore change yet |
| **2** | `KeyStoreUsb`, `buildKeyring()` wiring, atomic writes, migration with verify-then-delete | Keys actually live on the stick |
| **3** | Settings page, setup card, banner, badge, action-menu row, l10n | Full UX for requirements 1, 2, 4 |
| **4** | Enforcement: purge on absent, block sync/backup, `USB_KEYSTORE_UNAVAILABLE` plumbing, **storage-audit test** | Requirement 3 becomes testable |
| **5** | Native messaging host → Firefox support | Cross-browser parity |

### The requirement-3 audit test (Phase 4)

"No crypto anywhere else" should be a test, not a claim. A unit/integration test enumerates
every key in `chrome.storage.local` and `chrome.storage.session` after a scripted session
(generate key → import key → decrypt → remove key) and asserts:

- no key matches `^mvelo\.keyring\..*\.(public|private)Keys$`
- no key matches `^mvelo\.autocrypt\.`
- no serialized value anywhere contains `-----BEGIN PGP`
- `mvelo.keyring.attributes` contains no `default_key` / `sync_data` / `key_binding` entries

Jest already runs unit and integration projects ([jest.config.js](../jest.config.js)), so this
fits the existing harness.

## 9. Decisions

### Resolved

1. **Single point of failure — accepted.** Losing the stick means losing the keys, and that is
   acceptable. No clone-to-second-stick action, no local or remote backup copy of private keys.
   The USB `.bak` generation described in §5 stays, because it guards against a *torn write*
   (stick pulled mid-save) — a corruption failure on the device itself, not a second copy
   anywhere else.
2. **GnuPG keyring — hidden/disabled in USB mode.** GnuPG keeps secret keys in `~/.gnupg` on the
   machine, which is exactly what this feature exists to avoid. `prefer_gnupg` is ignored and
   the keyring is excluded from `getPreferredKeyringQueue()` while the USB backend is active.
3. **Migration — move and delete locally, but prefer generating fresh.** Local copies are
   deleted after a verified write to the stick. Because deletion does not erase the bytes from
   LevelDB (§3.1), the setup flow presents "generate a new key onto the device" as the
   recommended path, and the migration path carries an explicit residue warning.
4. **Remote sync and key backup — blocked in USB mode.** `createPrivateKeyBackup` →
   `sync.backup()` uploads an encrypted private key off-device; keyring sync uploads the
   keyring. Both are disabled for USB-backed keyrings. Note this goes beyond "nothing on the
   local machine" to "nothing outside the stick", per the original requirement 3.

5. **UI framing — a storage location, not a feature toggle.** Settings presents a
   radio choice, *This computer (default)* or *USB device*, so where keys live is
   always legible rather than implied by whether a feature is on. Selecting
   "USB device" only reveals the setup panel; nothing moves until a directory is
   chosen, so a mis-click cannot relocate key material. Status surfaces in four
   places: the settings panel, an app-wide banner, a badge on the keyring page, and
   the toolbar badge plus action-menu row when no Mailvelope page is open.

### Still open

6. **Probe interval.** 1 minute is the practical Chrome MV3 alarm floor. Because every keystore
   operation also probes, the timer only affects how fast a *passive* UI notices removal.
7. **Firefox timing.** Ship Phases 1–4 as Chrome-only with an explicit `UNSUPPORTED` state in
   Firefox, or hold the feature until the native host exists? **Recommendation: ship Chrome
   first** — the native host is a separate deliverable with its own install story.
8. **Password cache in USB mode.** `pwdCache` holds decrypted private keys and passphrases in
   `chrome.storage.session`. That store is documented as memory-only, but given the priority
   ordering it is worth deciding whether USB mode should force `security.password_cache` off
   rather than merely purging the cache when the device is removed.

## 10. Security notes

- The threat model deliberately trades away durability: it improves "attacker with the disk at
  rest" and accepts total key loss if the stick is lost. That is the stated intent (§1), and the
  settings UI should say so rather than imply the keys are safe.
- Key material is unavoidably in service-worker memory while in use. The design minimizes the
  window by clearing memory and the passphrase cache the moment the device goes away.
- `pwdCache` holds decrypted private keys. Confirming that `chrome.storage.session` is
  memory-only on both browsers is a Phase 4 verification item, not an assumption — see also
  open decision 7.
- **LevelDB residue (§3.1) is the weakest point in the whole design.** Everything else here is
  enforceable in code; that one is not fully fixable from inside an extension. Generating keys
  directly onto the device is the only path that avoids it completely.
- Blocking the remote sync/backup paths is essential: `createPrivateKeyBackup` currently
  uploads an encrypted private key backup to a sync server, which is exactly the off-device
  copy requirement 3 forbids.
