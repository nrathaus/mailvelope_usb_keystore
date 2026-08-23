#!/usr/bin/env bash
# Copyright (C) 2026 Noam Rathaus
# Licensed under the GNU Affero General Public License version 3
#
# Registers the Mailvelope USB keystore native messaging host with Firefox and,
# optionally, Chromium/Chrome.
#
# User-level only: everything is written under $HOME and no sudo is needed or
# accepted. A native messaging host runs with the user's authority, so installing
# one system-wide would extend that to every account on the machine for no benefit.
#
# Usage:
#   ./install.sh                          Firefox only
#   ./install.sh --chrome-id <extension>  also register for Chromium/Chrome
#   ./install.sh --uninstall              remove every manifest this wrote
#   ./install.sh --status                 show what is currently registered

set -euo pipefail

HOST_NAME='mailvelope_usb_keystore'
FIREFOX_EXT_ID='jid1-AQqSMBYb0a8ADg@jetpack'

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
HOST_PATH="$SCRIPT_DIR/$HOST_NAME.py"

# Firefox reads from one directory; the Chromium family has one per build.
FIREFOX_DIR="$HOME/.mozilla/native-messaging-hosts"
CHROMIUM_DIRS=(
  "$HOME/.config/chromium/NativeMessagingHosts"
  "$HOME/.config/google-chrome/NativeMessagingHosts"
  "$HOME/.config/google-chrome-unstable/NativeMessagingHosts"
  "$HOME/.config/BraveSoftware/Brave-Browser/NativeMessagingHosts"
)
# macOS puts them elsewhere.
if [[ "$(uname -s)" == 'Darwin' ]]; then
  FIREFOX_DIR="$HOME/Library/Application Support/Mozilla/NativeMessagingHosts"
  CHROMIUM_DIRS=(
    "$HOME/Library/Application Support/Chromium/NativeMessagingHosts"
    "$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
  )
fi

mode='install'
chrome_id=''
while [[ $# -gt 0 ]]; do
  case "$1" in
    --uninstall) mode='uninstall'; shift ;;
    --status)    mode='status'; shift ;;
    --chrome-id) chrome_id="${2:-}"; shift 2 ;;
    -h|--help)   sed -n '5,20p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

manifest_paths() {
  echo "$FIREFOX_DIR/$HOST_NAME.json"
  for dir in "${CHROMIUM_DIRS[@]}"; do
    echo "$dir/$HOST_NAME.json"
  done
}

case "$mode" in
status)
  echo "host script: $HOST_PATH"
  [[ -x "$HOST_PATH" ]] && echo "  executable: yes" || echo "  executable: NO (run chmod +x)"
  echo
  echo "registered manifests:"
  found=0
  while read -r path; do
    if [[ -f "$path" ]]; then
      echo "  $path"
      found=1
    fi
  done < <(manifest_paths)
  [[ $found -eq 0 ]] && echo "  (none)"
  exit 0
  ;;

uninstall)
  while read -r path; do
    if [[ -f "$path" ]]; then
      rm -f "$path"
      echo "removed $path"
    fi
  done < <(manifest_paths)
  echo "done. The host script itself was left in place."
  exit 0
  ;;
esac

# --- install ---------------------------------------------------------------

if [[ ! -f "$HOST_PATH" ]]; then
  echo "host script not found at $HOST_PATH" >&2
  exit 1
fi
chmod +x "$HOST_PATH"

if ! command -v python3 >/dev/null 2>&1; then
  echo "python3 is required but was not found on PATH" >&2
  exit 1
fi

# Firefox: bound by extension id. Mailvelope declares browser_specific_settings.
# gecko.id, so a temporary add-on loaded through about:debugging gets this same id
# rather than a random one -- which is why testing an unsigned build works.
mkdir -p "$FIREFOX_DIR"
cat > "$FIREFOX_DIR/$HOST_NAME.json" <<EOF
{
  "name": "$HOST_NAME",
  "description": "Mailvelope USB keystore file access",
  "path": "$HOST_PATH",
  "type": "stdio",
  "allowed_extensions": ["$FIREFOX_EXT_ID"]
}
EOF
echo "installed for Firefox: $FIREFOX_DIR/$HOST_NAME.json"

# Chromium family: bound by origin, so it needs the extension id, which differs
# between an unpacked load and a store install. Opt-in via --chrome-id, since
# guessing it would silently authorise the wrong extension.
if [[ -n "$chrome_id" ]]; then
  for dir in "${CHROMIUM_DIRS[@]}"; do
    parent="$(dirname "$dir")"
    [[ -d "$parent" ]] || continue
    mkdir -p "$dir"
    cat > "$dir/$HOST_NAME.json" <<EOF
{
  "name": "$HOST_NAME",
  "description": "Mailvelope USB keystore file access",
  "path": "$HOST_PATH",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://$chrome_id/"]
}
EOF
    echo "installed for $(basename "$parent"): $dir/$HOST_NAME.json"
  done
fi

echo
echo "Restart the browser so it picks up the new host."
echo "Verify with: $0 --status"
