# USB Keystore — Status and Handoff

Companion to [usb-keystore-plan.md](usb-keystore-plan.md), which holds the original
design and the reasoning behind it. This file is the state of the work.

**Both browsers are done and verified on real hardware.** Chrome/Chromium reaches the
device through the File System Access API; Firefox reaches the same device through a
native messaging host. The same physical keystore has been read by both, and neither
browser profile holds key material.

Branch `feature/usb-keystore`, **37 commits** ahead of `master` (`ffaa27af`), working
tree clean. Unit suite: **659 tests, 38 suites**. Native host: **17 tests**.
`grunt eslint` clean. Both bundles build.

## 1. What has been verified on real hardware

SanDisk Cruzer Blade, **FAT32, confirmed case-insensitive**, mounted at
`/run/media/noamr/5AE6-4898`. Chromium `151.0.7922.173` (native, not flatpak —
flatpak's portal sandbox can hide `/run/media`) and Firefox `154`.

| Verified | Detail |
|---|---|
| Keys stored only on the device | profile grep for `BEGIN PGP` clean throughout; no `default_key`, not even the fingerprint |
| Encrypt and decrypt with a device-resident key | round-trips, both browsers |
| Provisioning | fresh, and adopt-over-existing via the override |
| **Cross-browser portability** | one keystore, read by Chrome via FSA and by Firefox via the host, no key material in either profile |
| Physical removal | detected; both removal modes — contents gone, and mount point vanishing entirely |
| Reconnect | keys return automatically, page lands on the key list |
| Refusal when absent | clear "USB keystore is not available", raised *before* any passphrase prompt |
| **Passphrase and unlocked-key purge on removal** | unplug, replug, decrypt → prompts again, so neither outlives the device |
| **`WRONG_DEVICE`** | keys physically present and readable stay hidden; identity gates access, not readability |
| **`READ_ONLY`** | write-protected device keeps keys readable and decryption working, refuses changes, disables the controls that would make them |
| Hex directory names on a case-insensitive filesystem | `6c6f63616c…` decodes to `localhost\|#\|mailvelope`; validates hex over base64 |
| `FileSystemFileHandle.move()` on FAT32 | works — no stray `.tmp` across many cycles |
| Permission across a browser restart | **survives**, if the user takes Chrome's persistent option in the prompt |
| Detection latency | ~1 s while a page is visible, 30 s alarm otherwise |
| Migration of local keys onto a device that already has a keystore | merges both key sets; see §4 |

### Still not verified

- **Torn write.** Yanking the stick inside a ~7 KB write is not achievable by hand.
  The read-only stand-in (`mount -o remount,ro`) was run and found five bugs, but it
  exercises *refused* writes, not *interrupted* ones. The atomic-write path —
  stage, fsync, rotate to `.bak`, rename — is therefore reasoned about rather than
  observed. A scripted `usbreset` or a QEMU passthrough device could close this.
- **A genuinely second device.** `WRONG_DEVICE` was reached by editing the marker's
  `keystoreId`, which is what the extension actually checks, so the state machine is
  covered. Untested is the surrounding case: two sticks whose keystores are both
  real, and switching between them.

## 2. How each browser reaches the device

**Chromium** uses the File System Access API. `showDirectoryPicker()` for setup, and
the handle is persisted in IndexedDB — it is structured-cloneable but cannot cross
`chrome.runtime` messaging, so IndexedDB is what the app page and the service worker
share. No install step.

**Firefox** has no picker, and OPFS is not the device, so a native messaging host is
the only route. `native-host/mailvelope_usb_keystore.py` — Python 3,
dependency-free, ~300 lines, chosen for auditability: it runs outside the browser
sandbox with the user's filesystem authority and handles private keys, so being
readable in one sitting matters more than elegance.

Operations: `hello`, `listDevices`, `probe`, `read`, `write`, `remove`, `list`.

Two things the host path does *better* than the in-browser one:

- **`listDevices` replaces the missing picker** by enumerating mounted removable
  media, so the UI offers a list of actual devices rather than a file dialog.
- **The real path is available to display.** The File System Access API deliberately
  withholds it, so Chrome can only show the folder name.
- **`probe` reports writability directly**, which is the only way to know a device is
  write-protected *before* attempting a write. The FSA path can only discover it by
  failing, so there `READ_ONLY` is reached reactively.

Install with `native-host/install.sh` — user-level, no sudo. `--status`,
`--uninstall`, `--chrome-id <id>` to also register for Chromium.

**Security model.** The host is the most dangerous component here, so confinement is
enforced *in the host*, never in the extension:

- a `root` must be under `/run/media`, `/media`, `/mnt` or `/Volumes` **and be an
  actual mount point**
- relative paths only, resolved through `realpath`, then re-checked to be inside the
  root — so `..` and symlinks cannot escape
- writes restricted to seven known keystore filenames
- reads and writes size-capped

All confinement tests are load-bearing.

**The finding worth remembering:** the first version accepted `/run/media/<user>` —
under an allowed prefix but *not* a mount point, and on local tmpfs. A keystore
provisioned there would have left the keys on the machine while appearing to be on
the device: this feature's central promise, inverted. Only the adversarial test
caught it.

## 3. Testing either browser

Chromium: load `build/chrome` unpacked. Firefox, with a throwaway profile:

```
firefox --no-remote --profile /tmp/mvelo-ff-profile &
```

then `about:debugging#/runtime/this-firefox` → Load Temporary Add-on →
`build/firefox/manifest.json`. (`web-ext run` does **not** work with Firefox 154 —
`ECONNREFUSED` on the debugging port.)

A disposable stand-in device, for anything destructive — this is where guard-disabling
checks belong, not on a real stick:

```
sudo mkdir -p /run/media/$USER/SCRATCH
sudo mount -t tmpfs -o size=16M,uid=$(id -u),gid=$(id -g) tmpfs /run/media/$USER/SCRATCH
```

It satisfies the host's mount-point requirement, `umount` simulates removal, and
remounting `-o ro` simulates write protection.

## 4. Bugs found by running it, not by testing it

Around twenty, almost none caught by the test suite or by review. They cluster, and
the clusters are the useful part because more probably remain.

**"Unreadable read as empty."** Reads deliberately degrade to an empty keyring rather
than throwing — because throwing made `keyring.init()` *delete the keyring from the
attribute map*. That pushes the burden onto every consumer that asks "do I have
keys?", and each one got it wrong differently: "key not found" instead of "device
disconnected"; the toolbar menu offering "Get started"; the keyring page claiming no
key pair; `hasAnyPrivateKey` mis-answering. Same root, four symptoms.

**"UI trusting a status that arrived before the work behind it finished."**
`transition()` notifies listeners synchronously, so anything asynchronous it triggers
has not finished when a view reacts. Symptoms: the keyring page showing no keys after
reconnect, a stale key list, and a sticky `/keyring/setup` route that no key arrival
could clear.

**"One message for every failure state."** Components explained an unreachable
keystore with wording fixed at *not configured* or *not connected*, which names the
wrong remedy for most states that reach them. Worst case: the key-action gate's
heading said "Set up the device first" in every case it could render, though
`isUnavailable()` requires an enabled keystore — so a profile without one never
reaches it. Both now derive their text from `describeState()`.

Four singular ones worth keeping:

- **Migration overwrote an existing keystore.** Migrating local keys onto a device
  that already held a keystore replaced it. Recovered by union from `.bak`; both keys
  survived, but only because the atomic write keeps one generation. `mergeForDevice()`
  now merges, and device content wins conflicts.
- **The periodic probe never ran.** Its alarm listener was registered inside
  `state.init()` after an `await`. An MV3 service worker only receives events whose
  listeners were registered during initial synchronous evaluation. **No test can
  catch this** — jest's `chrome.alarms` mock accepts a late listener happily.
- **A test that enforced a bug.** `usb-provision` dropped the `adopt` flag, making the
  "use this folder anyway" override impossible, and the test asserted
  `toHaveBeenCalledWith({label})` — passing *because* of the bug. A revert check does
  not catch a wrong assertion, only a missing one.
- **Errors thrown into nothing.** The keyring UI's shape for key operations is
  "swallow a cancelled password dialog, rethrow the rest", and in an async handler a
  rethrow is an unhandled rejection. Eight call sites do this. Harmless while writes
  never failed; routine once the keystore is removable. Caught centrally by
  `UsbErrorToast` rather than by patching each site.

The read-only exercise was the single most productive test of the project: five
distinct bugs, none of them about the fail-safe it set out to check, which worked from
the start. Worth repeating for any state that is reachable but not exercised.

## 5. Coverage

`src/modules/usb` and `src/components/usb`: **71% statements**, 61% branch.

100%: `constants.js`, `guard.js`, `handlers.js`, `UsbKeyActionGate.js`,
`UsbSetupCard.js`, `UsbStatusBadge.js`. Then `router.js` 95%, `debugLog.js` 94%,
`state.js` 91%, `UsbDevicePicker.js` 89%, `FsaBackend.js` 85%, `install.js` 82%,
`provision.js` 76%, `usbStatus.js` 75%.

Weak spots, in the order worth addressing:

- `KeyStorageSettings.js` **2%** — the largest untested component, and the one that
  performs provisioning. Runtime-exercised heavily, but a regression here is silent.
- `NativeBackend.js` **55%** — the file operations are covered from the host side
  only, so the two halves of the protocol are never tested against each other.
- `handleStore.js` **0%** — IndexedDB, needs a `fake-indexeddb` dependency that is
  not installed. Runtime-proven, since the whole Chrome path depends on it.
- `UsbErrorToast.js` **5%**, `UsbStatusBanner.js` **17%** — the global rejection
  listener is worth a test; it is the only thing reporting several failures.

## 6. Open decisions

- **client-API `hasPrivateKey`** reports `false` to a webmail page while the device is
  detached. Recommendation: **leave it**, and note in the JSDoc that these queries
  reflect currently-reachable keys. The dangerous outcome is already prevented — a
  provider that responds by prompting key generation gets a fail-closed write and a
  clear device error.
- **`password_cache` in USB mode.** Recommendation, now that the purge has been
  observed working: **leave it on**. Cached material does not survive removal, so it
  cannot outlive the device; what remains is the ordinary cache tradeoff, which USB
  storage does not change.
- **Probe interval** — 30 s is Chrome's alarm floor; 1 s polling while a page is
  visible. Cost: a visible page keeps the device from idling.

## 7. Working practices that cost time

- **Check the build stamp before trusting behaviour.**
  `config/webpack.background.js:38` stamps dev builds; it shows in the footer,
  bottom-right of any Options page (UTC). Several rounds were spent reasoning about a
  stale bundle.
- **Never run bare `grunt` while the extension is loaded.** The default task runs
  `clean`, which deletes `build/` and invalidates the unpacked extension — Chromium
  then shows `ERR_FILE_NOT_FOUND`. Use `grunt webpack:dev tmp2browser` mid-testing.
- **Do not disable a security guard against a real device.** Verifying the host's
  confinement tests were load-bearing wrote a file to the user's stick, because the
  test that was supposed to block it then succeeded. Use the scratch mount in §3.
- **Grep for the field, not for a pattern you assume contains it.** Time was lost
  hunting a non-existent bug because `grep -rc` skipped LevelDB's `.log` as binary,
  and because an extraction pattern assumed a JSON key order Chrome does not preserve.
- **A passing test can be enforcing the bug.** Read the assertion, not just the
  result.

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

Two hardware traps that stopped USB detection entirely:

- A `linux-cachyos` upgrade removed the running kernel's module tree, so
  `usb-storage` could not load and no `/dev/sd*` appeared. A reboot fixed it. If a
  stick enumerates in `dmesg` but no block device appears, check
  `/lib/modules/$(uname -r)` exists.
- FAT mounts here carry `errors=remount-ro`, so a filesystem error silently turns
  the stick read-only mid-session. This is why `READ_ONLY` is a modelled state and
  not merely a failed write.
