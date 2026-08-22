# USB Keystore — Status and Handoff

Re-verified 2026-08-22 from primary evidence (git, test runs, on-disk artefacts) rather than
from recollection. That round found and fixed a destructive bug and closed three of the five
implementation gaps — see §4. Companion to [usb-keystore-plan.md](usb-keystore-plan.md), which
holds the design and its rationale.

Branch `feature/usb-keystore`, 2 commits ahead of `master` (`ffaa27af`):

| Commit | Contents |
|---|---|
| `fd2450c6` | Add USB-resident keystore modules, UI and tests — 19 new files, +2,874 |
| `6a5330e7` | Wire the USB keystore into existing entry points — 11 files, +31/-2 |

Split so the first can never conflict on a rebase onto upstream (all new paths) and only the
second needs attention. Keep that split. **Uncommitted work from 2026-08-22 sits on top** (§4);
the hook footprint has grown beyond +31/-2 because `keyring.js` is now touched.

17 source files (11 in `src/modules/usb`, 6 in `src/components/usb`) and 4 test files.

## 1. Verified — automated and reproducible

| What | Evidence |
|---|---|
| Unit tests | 519 tests, 26 suites, 0 failures (`jest --selectProjects unit`) |
| No regression | count includes every pre-existing suite |
| Router enforcement | `router.test.js`, 20 assertions: classification, hex encoding, attribute split/merge, leak safety net, serialization |
| Availability state machine | `state.test.js`, 21 assertions against a fake backend: every transition, `assertUsable` re-probe semantics, listeners, recovery to READY |
| Storage interception | `install.test.js`, 19 assertions: device vs local routing, attribute splitting, fail-closed writes, degraded reads, leak block, purge on device loss, badge arbitration |
| **Requirement 3 as a test** | `install.test.js` "storage audit": after a scripted session, no armored key and no crypto attribute field (`default_key`, `primary_key`, `sync_data`, `key_binding`) appears in local storage — and it is all on the device instead |
| Guards | `guard.test.js`, 10 assertions: remote-upload refusal, passphrase requirement, error codes |
| GnuPG exclusion | 3 assertions in `keyring.test.js`, proven non-vacuous by reverting the production change and watching them fail |
| Lint | `grunt eslint` exits `Done.` |
| Compiles | app, background and all 11 component webpack bundles build |
| No SW-illegal code | background bundle emits no extra chunks and contains no `importScripts`, so no dynamic-import splitting survived |

## 2. Verified — runtime, from on-disk artefacts

| What | Evidence |
|---|---|
| **An FSA handle from IndexedDB works in the MV3 service worker** | `/tmp/mailvelope-keystore/keystore.json` exists (`keystoreId 431ae6d3…`, version 1, label `tmp`), written by `provision()` in the background using a handle the app page stored in IndexedDB. Build timestamp 17:42 precedes the file's 17:53, so this was current code. **The planned offscreen-document fallback is not needed.** |
| Provisioning end-to-end | same artefact: picker → IndexedDB → port message → background write |
| Handle persists in IndexedDB | `chrome-extension_ifmmgibjjcicnmfdkgbjbnkebofjdabc_0.indexeddb.leveldb`, 28K |
| USB mode still active | `mvelo.usb.config` holds `keystoreId 431ae6d3…`, no key material |
| Opt-in gating | local store holds `mvelo.keyring.…{public,private}Keys` as `[]`, written during keyring init *before* provisioning: until a keystore is configured the wrapper passes through to local, as intended |
| Attribute split | local `mvelo.keyring.attributes` is `{"localhost|#|mailvelope":{"sanitized":true}}` — registry and non-crypto flags only |
| **No key material on local disk** | `grep -rl "BEGIN PGP"` across the whole `Local Extension Settings` tree: clean |

Environment: Chromium `151.0.7922.173` (native via pacman — deliberately not flatpak, whose
portal sandbox can hide `/run/media/…` and would confound results). Extension ID
`ifmmgibjjcicnmfdkgbjbnkebofjdabc`, loaded unpacked from `build/chrome`.

## 3. Not verified

### Covered by unit tests, never seen in a real browser

`/tmp/mailvelope-keystore` holds 1 file and 0 keyring directories, so **no key has ever been
written to the device.** These behaviours are asserted against a fake backend but have never
run against the real File System Access API:

- key generation onto the device — nothing has ever written `private.asc`
- transition to `ABSENT` on removal, and the badge, banner and refusal that follow
- purge of in-memory keyrings and the passphrase cache
- return to `READY`, and `WRONG_DEVICE`
- fail-closed writes
- badge arbitration against `uiLog`

### Not covered at all

- **Permission persistence across a browser restart** — Phase 0's second question, still open.
  Cannot be told from disk: config and handle both persist, but whether the *grant* does needs
  the UI. Restart Chromium only, never the machine: `/tmp` is tmpfs.
- **`provision.js`** — `provision()`, `migrateLocalKeyMaterial()`, `inspectLocalKeyMaterial()`
  and `diagnostics()` have no unit tests. Provisioning is known to work from the manual run;
  migration is entirely unexercised.
- **UI components** — no rendering tests for any of `src/components/usb/`.

### Cannot be tested on `/tmp` at all

`/tmp` is tmpfs: RAM-backed, case-sensitive, fast, wiped on reboot. It cannot exercise torn
writes from pulling a device mid-save (the `.tmp` → verify → `.bak` → `move` path), real removal
timing, case-insensitive filesystems (FAT32/exFAT — the reason for hex rather than base64
directory names), or the "mount point disappears entirely" removal mode (`/tmp` itself was
picked, so only "contents gone" is reachable — re-provision against `/tmp/usbtest` for both).

**A real USB stick is required before this feature can be called done.**

### Still not implemented

| Gap | Plan ref | Consequence |
|---|---|---|
| Generate/import not gated behind device setup | §3.2.1 | `UsbSetupCard` offers the option but nothing enforces ordering: generating *before* provisioning writes a key locally and lands in the §3.1 residue case. `strings.generate_first_*` exists and is unused. The background now fails closed, so this is a UX ordering problem rather than a correctness hole |
| LevelDB residue not measured | §3.1 | migration residue severity unquantified; the overwrite-before-delete heuristic is unjustified either way |

## 4. Changed on 2026-08-22 (uncommitted)

### Bug found and fixed: a destructive read path

`wrappedGet` threw when the device was absent. `keyring.init()` wraps `buildKeyring()` in a
`try/catch` that **deletes the keyring from the attribute map** on failure
([keyring.js:116](../src/modules/keyring.js#L116)), so starting the browser with the device
unplugged would deregister the keyring — recoverable for the main keyring, permanent for
client-API keyrings, whose keys would then be stranded on the device.

`readDevice` now degrades to `undefined` (an empty keyring) instead of throwing, which is what
the plan intended and what the SPLIT branch already did. Writes still fail closed, so reading
empty and storing it back cannot destroy anything. Two tests in `install.test.js` cover it.

Found by writing the test, not by review — none of that code had ever executed.

### Gaps closed

- **Passphrase required in USB mode** (§3.2). Enforced in the background at *both* entry points,
  `app.controller.generateKey` and the client-API-driven `privateKey.controller.generateKey`, so
  a webmail page cannot bypass it. Code `USB_KEYSTORE_PASSPHRASE_REQUIRED`. `GenerateKey.js`
  already required a non-empty password, but that was UI-only validation.
- **GnuPG keyring hidden in USB mode** (§9.2). Excluded from `getPreferredKeyringQueue()`,
  `getAll()` and `getAllKeyringAttr()`, so it leaves key selection *and* the keyring selector.
  This required touching `keyring.js`, previously untouched on purpose.
- **Storage-audit test** (Phase 4). Requirement 3 is now asserted rather than claimed.

### A note on the first attempt at the GnuPG tests

They passed while asserting nothing: the module-level mocks make `gpgme` unavailable, so
`initGPG()` deleted the GnuPG keyring regardless of USB mode. Rewritten with per-case
`jest.doMock` (including `__esModule: true`, without which babel's interop breaks `new`), and
with `chrome.storage.session` seeded so `init()` *awaits* `initGPG()` instead of firing and
forgetting it. Then verified by reverting the production change and confirming they fail.

Worth remembering as a pattern: a new test that passes immediately against code it is supposed
to be exercising deserves the revert check.

## 5. Still-open decisions (plan §9)

- Probe interval — 1 min is the practical Chrome MV3 alarm floor.
- Firefox: ship Chromium-only with `UNSUPPORTED`, or wait for the Phase 5 native host?
- Should USB mode force `security.password_cache` off rather than only purging on removal?
  Leaning yes: caching decrypted keys undercuts the point of removing the device.

## 6. Minor

Stale empty `mvelo.keyring.*.{public,private}Keys` entries remain in local storage after
switching to USB. Harmless (`[]`) but `inspectLocalKeyMaterial()` will report them; decide
whether provisioning should clean them up.

## 7. Environment gotcha for a fresh clone

`npm ci` fails with `EALLOWGIT`: **npm 12 defaults `allow-git=none`**, and this project has two
git dependencies (`gpgmejs`, `emailjs-mime-builder`) that the lockfile pins to `git+ssh://`.
There are no SSH keys on this machine, so both the policy and the transport need handling:

```
GIT_CONFIG_COUNT=2 \
GIT_CONFIG_KEY_0=url.https://github.com/.insteadOf GIT_CONFIG_VALUE_0=ssh://git@github.com/ \
GIT_CONFIG_KEY_1=url.https://github.com/.insteadOf GIT_CONFIG_VALUE_1=git+ssh://git@github.com/ \
npm ci --allow-git=root
```

`allow-git=root` permits only git deps declared in this project's own `package.json`, narrower
than `all`. `.npmrc` is gitignored (line 98), so it can be made permanent there without touching
the repo. `allow-remote` is not a problem — all 1,353 other packages resolve to
`registry.npmjs.org`.
