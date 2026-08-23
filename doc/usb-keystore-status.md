# USB Keystore — Status and Handoff

Paused 2026-08-23, mid-way through Firefox support. Companion to
[usb-keystore-plan.md](usb-keystore-plan.md), which holds the original design.

**Chrome/Chromium is done and verified on real hardware. Firefox is half-built** —
the native messaging host works and is tested; the extension side is wired but has
never been run.

Branch `feature/usb-keystore`, **25 commits** ahead of `master` (`ffaa27af`).
Unit suite: **611 tests, 33 suites**. Native host: **17 tests**. `grunt eslint`
clean. Both browser bundles build.

## 1. Uncommitted work — read this first

```
 M src/modules/usb/handlers.js          usb-list-devices, usb-select-device
 M src/modules/usb/provision.js         listDevices(), selectDevice()
 M src/modules/usb/state.js             backend selection, usesNativeHost(), devicePath
 M test/unit/modules/usb/handlers.test.js
?? native-host/                          the host, its tests, install script
?? src/modules/usb/NativeBackend.js
```

All of it passes tests and lints, but **none of the extension-side Firefox code has
ever executed**. Commit it as a work-in-progress or keep it in the tree; either way
do not mistake "tests pass" for "it works".

## 2. Chrome — verified on a real USB stick

SanDisk Cruzer Blade, **FAT32, confirmed case-insensitive**, mounted at
`/run/media/noamr/5AE6-4898`. Chromium `151.0.7922.173` (native, not flatpak —
flatpak's portal sandbox can hide `/run/media`). Extension ID
`ifmmgibjjcicnmfdkgbjbnkebofjdabc`, unpacked from `build/chrome`.

| Verified | Detail |
|---|---|
| Keys stored only on the device | profile grep for `BEGIN PGP` clean throughout; no `default_key`, not even the fingerprint |
| **Encrypt and decrypt with a device-resident key** | round-trips |
| Provisioning | fresh, and adopt-over-existing via the override |
| Physical removal | detected; both removal modes — contents gone, and mount point vanishing entirely |
| Reconnect | keys return automatically, page lands on the key list |
| Refusal when absent | clear "USB keystore is not available" |
| **Hex directory names on a case-insensitive filesystem** | `6c6f63616c…` decodes to `localhost\|#\|mailvelope`; validates choosing hex over base64 |
| `FileSystemFileHandle.move()` on FAT32 | works — no stray `.tmp` across many cycles |
| Permission across a browser restart | **survives**, if the user takes Chrome's persistent option in the prompt |
| Detection latency | ~1 s while a page is visible, 30 s alarm otherwise |

### Not verified on Chrome

- **Torn write.** Literally yanking the stick inside a ~7 KB write is not achievable
  by hand. Use the reproducible stand-in instead: `sudo mount -o remount,ro <mount>`,
  attempt a key operation, confirm `private.asc` survives intact. Then remount `rw`.
- **The `pwdCache` purge.** Unplug, replug, decrypt: it should *ask* for the
  passphrase. Asserted in code, never observed.
- **Migration.** `migrateLocalKeyMaterial()` deletes local keys after writing to the
  device. Only ever tested against a fake backend. The riskiest untested code left.
- **`WRONG_DEVICE`.** Needs a second stick or an edited `keystore.json`.

## 3. Firefox — host done, extension side untested

Firefox has no File System Access API, no directory picker, and OPFS is not the
device. A native messaging host is the only route.

### Done and tested

`native-host/mailvelope_usb_keystore.py` — Python 3, dependency-free, ~300 lines.
Chosen for auditability: it runs outside the browser sandbox with the user's
filesystem authority and handles private keys, so being readable in one sitting
matters more than elegance.

Operations: `hello`, `listDevices`, `probe`, `read`, `write`, `remove`, `list`.

**`listDevices` is the answer to Firefox's missing picker** — the host enumerates
mounted removable media and the UI offers a list. Arguably better than Chrome's
picker, and it means the full device path is available to display, which the File
System Access API deliberately withholds.

`native-host/test_host.py` — 17 tests, no dependencies, run with
`python3 native-host/test_host.py`. Verified working against the real stick:
read, write, remove, list, backup rotation, no staging files left behind.

**Security model.** The host is the most dangerous component here, so confinement is
enforced *in the host*, not in the extension:

- a `root` must be under `/run/media`, `/media`, `/mnt` or `/Volumes` **and be an
  actual mount point**
- relative paths only, resolved through `realpath`, then checked to still be inside
  the root — so `..` and symlinks cannot escape
- writes restricted to seven known keystore filenames
- reads and writes size-capped

All confinement tests are load-bearing (disabling a check fails them).

**The finding worth remembering:** the first version accepted `/run/media/<user>` —
under an allowed prefix but *not* a mount point, and on local tmpfs. A keystore
provisioned there would have left the keys on the machine while appearing to be on
the device: this feature's central promise, inverted. Only the adversarial test
caught it.

`native-host/install.sh` — user-level only, no sudo. `--status`, `--uninstall`,
`--chrome-id <id>` to also register for Chromium. Already installed on this machine
for Firefox and Chromium.

### Built but never run

- `src/modules/usb/NativeBackend.js` — the five-method interface over
  `chrome.runtime.sendNativeMessage`. One-shot rather than a long-lived
  `connectNative` port: each operation is self-contained, and a process spawn is
  inconsequential next to a USB read. Distinguishes "no helper installed" from "no
  device", since those need different messages.
- Backend selection in `state.js`: File System Access first, native host second.
- `usb-list-devices` / `usb-select-device` port events, `listDevices()` /
  `selectDevice()` in provision.

### Firefox work still to do

1. **Nothing calls the new events.** `KeyStorageSettings` still offers only the
   directory picker, which does not exist in Firefox. It needs a device-list UI
   driven by `usb-list-devices` + `usb-select-device` when `status.native` is true.
2. **`nativeMessaging` permission is optional** and never requested. `General.js`
   already has the request pattern (`chrome.permissions.request`) — copy it.
3. **`isSupported()` in `FsaBackend` returns false on Firefox** (correct), so the
   native backend is selected — but the Key Storage page still shows "this browser
   cannot access a USB keystore", which will now be wrong once the UI is finished.
4. **`NativeBackend` has 8% coverage.** Untested apart from what the host tests
   cover on the other side of the protocol.
5. **Then actually run it in Firefox**, which has never happened.

### Firefox baseline, already verified

The current build loads cleanly in Firefox 154 with an **empty console**, correctly
disables the USB option, and ordinary local-storage operation is unaffected. So the
feature degrades safely today; the work above is additive.

Load with a throwaway profile:
`firefox --no-remote --profile /tmp/mvelo-ff-profile &` then
`about:debugging#/runtime/this-firefox` → Load Temporary Add-on →
`build/firefox/manifest.json`. (`web-ext run` does **not** work with Firefox 154 —
`ECONNREFUSED` on the debugging port.)

## 4. Coverage

`src/modules/usb`: 76% statements. `guard.js`, `constants.js`, `handlers.js` at
100%, `router.js` 98%, `debugLog.js` 94%, `state.js` 90%, `FsaBackend.js` 85%,
`install.js` 80%, `provision.js` 75%.

Weak spots: `NativeBackend.js` 8% (new, untested), `handleStore.js` 0% (IndexedDB,
needs a `fake-indexeddb` dependency that is not installed — but runtime-proven,
since the whole Chrome path depends on it).

## 5. Bugs found by running it, not by testing it

Around a dozen, none caught by the test suite or by review. Several clustered into
two families worth knowing about, because more probably remain:

**"Unreadable read as empty."** Reads deliberately degrade to an empty keyring
rather than throwing — because throwing made `keyring.init()` *delete the keyring
from the attribute map*. That pushes the burden onto every consumer that asks "do I
have keys?", and each one got it wrong differently: "key not found" instead of
"device disconnected"; the toolbar menu offering "Get started"; the keyring page
claiming no key pair; `hasAnyPrivateKey` mis-answering. Same root, four symptoms.

**"UI trusting a status that arrived too early."** `transition()` notifies listeners
synchronously, so anything asynchronous it triggers has not finished when a view
reacts. Symptoms: the keyring page showing no keys after reconnect, the stale key
list, and a sticky `/keyring/setup` route that no key arrival could clear.

Two others worth singling out:

- **The periodic probe never ran.** Its alarm listener was registered inside
  `state.init()` after an `await`. An MV3 service worker only receives events whose
  listeners were registered during the initial synchronous evaluation. **No test can
  catch this** — jest's `chrome.alarms` mock accepts a late listener happily.
- **A test that enforced a bug.** `usb-provision` dropped the `adopt` flag, making
  the "use this folder anyway" override impossible, and the test asserted
  `toHaveBeenCalledWith({label})` — passing *because* of the bug. A revert check
  does not catch a wrong assertion, only a missing one.

## 6. Open decisions

- **client-API `hasPrivateKey`** reports `false` to a webmail page while the device
  is detached. Recommendation after review: **leave it**, and note in the JSDoc that
  these queries reflect currently-reachable keys. The dangerous outcome is already
  prevented — a provider that responds by prompting key generation gets a
  fail-closed write and a clear device error.
- **`password_cache` in USB mode.** Recommendation, revised after seeing it in use:
  **leave it on**. The USB-specific risk is already handled by the purge on removal;
  what remains is the ordinary cache tradeoff, which USB storage does not change.
- **Probe interval** — 30 s is Chrome's floor; 1 s polling while a page is visible.
  Cost: a visible page keeps the device from idling.

## 7. Working practices that cost time

- **Check the build stamp before trusting behaviour.**
  `config/webpack.background.js:38` stamps dev builds; it shows in the footer,
  bottom-right of any Options page (UTC). Several rounds were spent reasoning about
  a stale bundle.
- **Never run `grunt` while the extension is loaded.** The default task runs `clean`,
  which deletes `build/` and invalidates the unpacked extension —
  Chromium then shows `ERR_FILE_NOT_FOUND`. Use `grunt webpack:dev tmp2browser`
  mid-testing.
- **Do not disable a security guard against a real device.** Verifying the host's
  confinement tests were load-bearing wrote a file to the user's stick, because the
  test that was supposed to be blocked then succeeded. Use a scratch mount.
- **Grep for the field, not for a pattern you assume contains it.** Time was lost
  hunting a non-existent bug because `grep -rc` skipped LevelDB's `.log` as binary,
  and because an extraction pattern assumed a JSON key order Chrome does not
  preserve.

## 8. Environment

`npm ci` fails with `EALLOWGIT`: **npm 12 defaults `allow-git=none`**, and two
dependencies (`gpgmejs`, `emailjs-mime-builder`) are pinned to `git+ssh://` with no
SSH keys present:

```
GIT_CONFIG_COUNT=2 \
GIT_CONFIG_KEY_0=url.https://github.com/.insteadOf GIT_CONFIG_VALUE_0=ssh://git@github.com/ \
GIT_CONFIG_KEY_1=url.https://github.com/.insteadOf GIT_CONFIG_VALUE_1=git+ssh://git@github.com/ \
npm ci --allow-git=root
```

`.npmrc` is gitignored, so `allow-git=root` can be made permanent there.

Also note the kernel-module trap that stopped USB detection entirely: a
`linux-cachyos` upgrade removed the running kernel's module tree, so `usb-storage`
could not load and no `/dev/sd*` appeared. A reboot fixed it. If a stick enumerates
in `dmesg` but no block device appears, check `/lib/modules/$(uname -r)` exists.
