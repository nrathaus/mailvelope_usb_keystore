# USB Keystore — Status and Handoff

Updated 2026-08-22 after a full browser-testing session. Companion to
[usb-keystore-plan.md](usb-keystore-plan.md), which holds the design and its rationale.

**Both Phase 0 unknowns are now settled and every requirement from the original ask is
verified in a real browser.** What remains is a real USB stick, one API decision, and the
things a tmpfs test directory structurally cannot exercise.

Branch `feature/usb-keystore`, 16 commits ahead of `master` (`ffaa27af`), working tree clean.
45 files, +5,465/-30. Unit suite: **597 tests, 31 suites**. `grunt eslint` clean. All bundles
build.

The first two commits are split so that `fd2450c6` (all new files) can never conflict on a
rebase and only `6a5330e7` needs attention. That split has since been diluted — later fixes
touched `keyring.js`, `pgpModel.js`, `menu.controller.js`, `Keyring.js` and `GenerateKey.js` —
so the hook footprint is now larger than the original +31/-2. Still worth keeping new-file and
hook-site changes in separate commits going forward.

## 1. Settled: the two Phase 0 questions

**An FSA `FileSystemDirectoryHandle` stored in IndexedDB by the app page IS usable from the MV3
service worker.** Proven by provisioning writing `/tmp/mailvelope-keystore/keystore.json` from
the background using a handle the page stored. **The planned offscreen-document fallback is not
needed — do not build it.**

**A `readwrite` grant CAN survive a browser restart**, if the user takes Chrome's persistent
option in the permission prompt ("allow on every visit" or similar). Confirmed by quitting and
reopening Chromium and finding the state still `READY`.

It does **not** survive an extension *reload*, which matters only during development. Because
that is the common case while working on this, `Reconnect` re-prompts for the stored handle
(one dialog) rather than reopening the directory picker.

## 2. Verified in a real browser

Chromium `151.0.7922.173`, native via pacman — deliberately not flatpak, whose portal sandbox
can hide `/run/media/…`. Extension ID `ifmmgibjjcicnmfdkgbjbnkebofjdabc`, loaded unpacked from
`build/chrome`. Test keystore on `/tmp`, `keystoreId 431ae6d3…`.

| Requirement | Evidence |
|---|---|
| Detect device presence and file accessibility | all states reached: `READY`, `ABSENT`, `PERMISSION_REQUIRED`, `WRONG_DEVICE` |
| Note when the device is unavailable | red `!` badge, amber banner, key list clears, all unprompted within the probe interval |
| Refuse to operate without the device | encryption refused with "The USB keystore is not available. Connect the device to use your keys." |
| **No crypto stored anywhere but the device** | a real key generated onto the device: `private.asc` 6,825 bytes / 1 block, `attributes.json` holding `default_key`. Profile grep for `BEGIN PGP` clean throughout; zero occurrences of `default_key` or the key fingerprint locally |
| Offer to add a keystore when absent | setup card plus the Key Storage settings page |
| Atomic writes | `.bak` rotation observed against the real File System Access API, not just the fake |
| Recovery | key returns on its own after reconnect, via the periodic probe |

## 3. Nine bugs found by running it

None were caught by 597 passing tests or by review. Recording them because the ratio stayed
roughly constant across the session, which suggests more remain.

1. **Destructive read.** A read that threw when the device was absent propagated into
   `init()`'s catch, which *deletes the keyring from the attribute map*. Reads now degrade to
   an empty keyring; writes still fail closed.
2. **Destructive write, same consequence.** `sanitizeKeyring()` writes the keyring back, and
   that write fails when the device is absent — reaching the same deletion by another route.
   Now deferred until the device is attached.
3. **No reload on return.** Nothing re-read the device when it came back, so the warning
   cleared while the UI still showed no keys — indistinguishable from data loss.
4. **Stale key list.** The keyring page only refreshed when the device returned, not when it
   went away, so it kept listing keys it could no longer use.
5. **The adopt flag defeated by a click event.** `onClick={this.handleChooseDirectory}` passed
   React's event into a parameter named `adopt`, making it truthy on every pick and silently
   disabling the identity guard added hours earlier. Now strictly coerced, in the component
   *and* in the background, which is the actual security boundary.
6. **The periodic probe never ran.** Its alarm listener was registered inside `state.init()`
   after an `await`. An MV3 service worker only receives events whose listeners were added
   during the initial synchronous evaluation of the script, so removal was only ever noticed at
   startup or when the user forced a check. Now registered at module scope in `install.js`.
   **No test can catch this** — jest's `chrome.alarms` mock accepts a late listener happily.
7. **"key not found" instead of "device disconnected."** Honest at the keyring layer, badly
   misleading at the user layer: for a keystore that is the only copy, it is the message most
   likely to make someone believe the key is gone, or generate a replacement.
8. **"Get started" in the toolbar menu** whenever the device was detached, inviting a user
   whose key was safe on the device to generate a replacement.
9. **Nested keystore.** Selecting the `mailvelope-keystore` folder itself — the only folder a
   user can actually see when reconnecting — created a second keystore inside the first, and
   provisioning silently minted a new identity, orphaning the original device.

### The pattern worth remembering

Bugs 1, 2, 4, 7 and 8 are all the same mistake: **an unreadable keystore being treated as an
empty one.** That is the inherent cost of making reads degrade to empty rather than throw —
which was the right call, since throwing deleted the keyring registry — but it pushes the
burden onto every consumer that asks "do I have keys?". An audit fixed the known cases;
`hasUsablePrivateKey`, the onboarding flow and the editor's recipient lookup are where to look
next.

## 4. Test coverage

`src/modules/usb`: **80.8% statements**, `guard.js` and `handlers.js` at 100%, `router.js` 98%,
`state.js` 91%, `install.js` 80%, `provision.js` 81%, `FsaBackend.js` 84%.

`handleStore.js` is at 0% — testing IndexedDB needs a `fake-indexeddb` dependency that is not
installed. It is however runtime-proven: the whole feature depends on it working.

Notable gaps: the *wiring* of the crypto gate is untested (`guard.test.js` covers the function,
nothing asserts `pgpModel`'s five call sites invoke it), and `GenerateKey.js`'s upload default
has no test — a component test there needs the port, keyring context and six children mocked.

**Discipline that paid off:** every new test was checked by reverting the production change and
confirming it fails. The first attempt at the GnuPG-exclusion tests passed while asserting
nothing, because the module mocks made `gpgme` unavailable so `initGPG()` deleted that keyring
regardless of USB mode. A new test that goes green on the first run deserves the revert check.

## 5. Remaining work

### Needs a real USB stick

`/tmp` is tmpfs: RAM-backed, case-sensitive, fast, wiped on reboot. It cannot exercise:

- torn writes from pulling a device mid-save (the `.tmp` → verify → `.bak` → `move` path)
- real removal timing and slow-media latency
- case-insensitive filesystems (FAT32/exFAT) — the reason directory names are hex, not base64
- the "mount point disappears entirely" removal mode (`/tmp` itself was picked, so only
  "contents gone" is reachable — re-provision against a subdirectory to test both)

### One open decision

`api.controller.hasPrivateKey` answers the **client API**, so a webmail provider asking "does
this user have a key?" gets `false` while the device is detached. Recommendation after review:
**leave it**, and note in the client-API JSDoc that these queries reflect currently-reachable
keys. The dangerous outcome is already prevented — a provider that responds by prompting key
generation gets a fail-closed write and a clear device error, so no replacement key can be
created. Throwing instead would be more honest but would change behaviour for third-party
integrations that cannot be tested from here.

### Not implemented

- Generate/import ordering is a nudge, not a gate. Nothing prevents generating a key *before*
  provisioning a device, which lands in the §3.1 residue case. The background fails closed once
  a keystore is configured, so this is UX rather than correctness.
- LevelDB residue is unmeasured, so the overwrite-before-delete heuristic remains unjustified.
- Phase 5: the Firefox native messaging host. Firefox reports `UNSUPPORTED` today.

### Still-open plan decisions

- Probe interval — 1 min is the practical Chrome MV3 alarm floor.
- Firefox: ship Chromium-only, or wait for the native host?
- Should USB mode force `security.password_cache` off rather than only purging on removal?

## 6. Working practices for the next session

**Verify the build actually loaded.** `config/webpack.background.js:38` stamps dev builds with
`${version} build: ${ISO timestamp}`, shown in the **footer, bottom-right of any Mailvelope
Options page** (UTC). Reload, check the stamp matches, *then* test. Several rounds were wasted
reasoning about behaviour from a stale bundle.

**Never run `grunt` while the extension is loaded.** The default task runs `clean`, which
deletes `build/`, invalidating the unpacked extension — Chromium then shows
`ERR_FILE_NOT_FOUND` and the extension has to be reloaded or re-added. Use `grunt webpack:dev`
mid-testing, or rebuild only between tests.

**Grep for the field, not for a pattern you assume contains it.** Time was lost hunting a
non-existent bug because `grep -rc` skipped LevelDB's `.log` as binary, and because the
extraction pattern assumed a JSON key order that Chrome does not preserve.

## 7. Environment gotcha for a fresh clone

`npm ci` fails with `EALLOWGIT`: **npm 12 defaults `allow-git=none`**, and this project has two
git dependencies (`gpgmejs`, `emailjs-mime-builder`) that the lockfile pins to `git+ssh://`.
With no SSH keys present, both the policy and the transport need handling:

```
GIT_CONFIG_COUNT=2 \
GIT_CONFIG_KEY_0=url.https://github.com/.insteadOf GIT_CONFIG_VALUE_0=ssh://git@github.com/ \
GIT_CONFIG_KEY_1=url.https://github.com/.insteadOf GIT_CONFIG_VALUE_1=git+ssh://git@github.com/ \
npm ci --allow-git=root
```

`allow-git=root` permits only git deps declared in this project's own `package.json`, narrower
than `all`. `.npmrc` is gitignored (line 98), so it can be made permanent there without
touching the repo.
