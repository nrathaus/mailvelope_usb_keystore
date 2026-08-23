#!/usr/bin/env python3
# Copyright (C) 2026 Noam Rathaus
# Licensed under the GNU Affero General Public License version 3
"""Native messaging host for the Mailvelope USB keystore.

Firefox has no File System Access API, so an extension there cannot reach a
removable device at all. This host provides the same small set of operations the
in-browser backend offers -- probe, read, write, remove, list -- over the browser's
native messaging protocol.

Written in Python, and deliberately kept short and dependency-free, because this is
a program with the user's full filesystem authority that handles private keys. Being
readable in one sitting is worth more here than being clever.

SECURITY MODEL
--------------
A native host is the most dangerous component of this feature: the browser can ask
it to touch the filesystem as the user. The protocol therefore does not accept
arbitrary paths.

  * Every operation is confined to a `root` that must be BOTH under one of
    ALLOWED_ROOT_PREFIXES and an actual mount point. A root anywhere else --
    $HOME, /etc, / -- is refused, and so is a directory that merely sits under a
    prefix without being a mount, such as /run/media/<user>. That last case
    matters for correctness as much as security: it lives on local tmpfs, so a
    keystore written there would leave the keys on this machine while appearing
    to be on the device.
  * Relative paths are resolved and then checked to still be inside that root, so
    '..' cannot escape it, and symlinks are resolved before the check.
  * Only the file names this feature uses are writable; see SAFE_NAME.
  * Reads and writes are size-capped, so a hostile request cannot exhaust memory.

None of this defends against a user who is already running malicious code as
themselves. It defends against the realistic case: a bug or a compromise in the
extension turning into arbitrary file access.
"""

import json
import os
import struct
import sys
import tempfile

VERSION = 1

# Native messaging caps a single message at 1 MB in each direction. Stay well under
# it: a keyring of any sane size is far smaller, and the cap is a useful bound on
# what a single request can cost.
MAX_MESSAGE = 768 * 1024
MAX_FILE = 512 * 1024

# Roots must live directly under one of these. Removable media only: this is what
# stops the browser asking for $HOME or /etc.
ALLOWED_ROOT_PREFIXES = (
    '/run/media',      # udisks2, most current Linux desktops
    '/media',          # older Linux conventions
    '/mnt',            # manual mounts
    '/Volumes',        # macOS
)

# File names this host will create or overwrite. Anything else is refused, so a
# request cannot use the write path to drop a file of its choosing.
SAFE_NAME = ('keystore.json', 'README.txt', 'public.asc', 'private.asc',
             'attributes.json', 'autocrypt.json', 'meta.json')


class ProtocolError(Exception):
    """A request that will not be served, with a stable code for the extension."""

    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def read_message():
    """Read one native message, or None at end of stream."""
    header = sys.stdin.buffer.read(4)
    if len(header) < 4:
        return None
    length = struct.unpack('=I', header)[0]
    if length > MAX_MESSAGE:
        raise ProtocolError('too_large', f'message of {length} bytes exceeds the limit')
    payload = sys.stdin.buffer.read(length)
    return json.loads(payload.decode('utf-8'))


def write_message(message):
    """Write one native message."""
    encoded = json.dumps(message).encode('utf-8')
    if len(encoded) > MAX_MESSAGE:
        encoded = json.dumps({
            'error': 'too_large',
            'message': 'response exceeds the native messaging limit'
        }).encode('utf-8')
    sys.stdout.buffer.write(struct.pack('=I', len(encoded)))
    sys.stdout.buffer.write(encoded)
    sys.stdout.buffer.flush()


def check_root(root):
    """Validate a root directory and return its real path.

    A root must be under one of ALLOWED_ROOT_PREFIXES and be a mount point.
    """
    if not isinstance(root, str) or not root:
        raise ProtocolError('bad_root', 'root must be a non-empty string')
    real = os.path.realpath(root)
    under_prefix = any(real.startswith(prefix + os.sep) for prefix in ALLOWED_ROOT_PREFIXES)
    if not under_prefix:
        raise ProtocolError(
            'root_not_allowed',
            'root must be on removable media '
            f'(under one of {", ".join(ALLOWED_ROOT_PREFIXES)})'
        )
    if not os.path.isdir(real):
        raise ProtocolError('not_found', f'{root} is not a directory')
    # Must be an actual mount point, not merely a directory beneath the prefix.
    # /run/media/<user> is the container of a user's mount points and lives on local
    # tmpfs; accepting it would let a keystore be written there, leaving the keys on
    # this machine while appearing to be on the device -- the exact failure this
    # feature exists to prevent. Being a mount point is what makes a path a device.
    if not os.path.ismount(real):
        raise ProtocolError(
            'root_not_mounted',
            f'{root} is not a mounted device'
        )
    return real


def resolve(root, path):
    """Resolve a relative path inside root, refusing anything that escapes it."""
    if not isinstance(path, str) or not path:
        raise ProtocolError('bad_path', 'path must be a non-empty string')
    if os.path.isabs(path):
        raise ProtocolError('bad_path', 'path must be relative to the root')
    target = os.path.realpath(os.path.join(root, path))
    # realpath has resolved any symlinks, so this check also catches a link inside
    # the device pointing somewhere outside it.
    if target != root and not target.startswith(root + os.sep):
        raise ProtocolError('bad_path', 'path escapes the keystore root')
    return target


def op_hello(_request):
    return {
        'version': VERSION,
        'platform': sys.platform,
        'allowedRootPrefixes': list(ALLOWED_ROOT_PREFIXES)
    }


def op_list_devices(_request):
    """Removable media currently mounted.

    Firefox has no directory picker, so the extension cannot ask the user to choose
    a folder the way Chrome does. Enumerating the mounted devices here lets it offer
    a list instead, which needs no picker and is arguably clearer.
    """
    devices = []
    for prefix in ALLOWED_ROOT_PREFIXES:
        if not os.path.isdir(prefix):
            continue
        for entry in sorted(os.listdir(prefix)):
            path = os.path.join(prefix, entry)
            # udisks2 nests per-user: /run/media/<user>/<label>
            candidates = [path]
            if os.path.isdir(path) and prefix in ('/run/media', '/media'):
                try:
                    candidates += [os.path.join(path, sub)
                                   for sub in sorted(os.listdir(path))
                                   if os.path.isdir(os.path.join(path, sub))]
                except OSError:
                    pass
            for candidate in candidates:
                if not os.path.ismount(candidate):
                    continue
                devices.append({
                    'path': candidate,
                    'label': os.path.basename(candidate),
                    'writable': os.access(candidate, os.W_OK)
                })
    return {'devices': devices}


def op_probe(request):
    root = check_root(request.get('root'))
    return {'available': True, 'writable': os.access(root, os.W_OK)}


def op_read(request):
    root = check_root(request.get('root'))
    target = resolve(root, request.get('path'))
    if not os.path.isfile(target):
        raise ProtocolError('not_found', 'no such file')
    if os.path.getsize(target) > MAX_FILE:
        raise ProtocolError('too_large', 'file exceeds the size limit')
    with open(target, 'r', encoding='utf-8') as handle:
        return {'content': handle.read()}


def op_write(request):
    root = check_root(request.get('root'))
    target = resolve(root, request.get('path'))
    if os.path.basename(target) not in SAFE_NAME:
        raise ProtocolError('name_not_allowed',
                            f'{os.path.basename(target)} is not a keystore file')
    content = request.get('content')
    if not isinstance(content, str):
        raise ProtocolError('bad_content', 'content must be a string')
    if len(content.encode('utf-8')) > MAX_FILE:
        raise ProtocolError('too_large', 'content exceeds the size limit')
    os.makedirs(os.path.dirname(target), exist_ok=True)
    # Same staged write the in-browser backend performs: write beside the target,
    # flush to the device, keep the previous generation, then rename into place.
    # rename() within a directory is atomic on POSIX, so a reader sees either the
    # old file or the new one, never a partial write.
    directory = os.path.dirname(target)
    handle, staged = tempfile.mkstemp(dir=directory, prefix='.mvelo-', suffix='.tmp')
    try:
        with os.fdopen(handle, 'w', encoding='utf-8') as staged_file:
            staged_file.write(content)
            staged_file.flush()
            os.fsync(staged_file.fileno())
        if os.path.exists(target):
            backup = target + '.bak'
            if os.path.exists(backup):
                os.unlink(backup)
            os.replace(target, backup)
        os.replace(staged, target)
        staged = None
    finally:
        if staged and os.path.exists(staged):
            os.unlink(staged)
    return {'ok': True}


def op_remove(request):
    root = check_root(request.get('root'))
    target = resolve(root, request.get('path'))
    if os.path.basename(target) not in SAFE_NAME:
        raise ProtocolError('name_not_allowed', 'not a keystore file')
    if os.path.exists(target):
        os.unlink(target)
    return {'ok': True}


def op_list(request):
    root = check_root(request.get('root'))
    path = request.get('path')
    target = root if not path else resolve(root, path)
    if not os.path.isdir(target):
        return {'names': []}
    return {'names': sorted(os.listdir(target))}


OPERATIONS = {
    'hello': op_hello,
    'listDevices': op_list_devices,
    'probe': op_probe,
    'read': op_read,
    'write': op_write,
    'remove': op_remove,
    'list': op_list,
}


def handle(request):
    """Dispatch one request to a response, never raising."""
    request_id = request.get('id') if isinstance(request, dict) else None
    try:
        if not isinstance(request, dict):
            raise ProtocolError('bad_request', 'request must be an object')
        operation = OPERATIONS.get(request.get('op'))
        if not operation:
            raise ProtocolError('unknown_op', f"unknown operation {request.get('op')!r}")
        return {'id': request_id, 'result': operation(request)}
    except ProtocolError as error:
        return {'id': request_id, 'error': error.code, 'message': str(error)}
    except OSError as error:
        # Device pulled mid-operation lands here; report it as unavailable rather
        # than as a protocol fault, so the extension can treat it as absence.
        return {'id': request_id, 'error': 'io_error', 'message': error.strerror or str(error)}
    except Exception as error:  # noqa: BLE001 - a host that dies stops answering
        return {'id': request_id, 'error': 'internal', 'message': str(error)}


def main():
    while True:
        try:
            request = read_message()
        except ProtocolError as error:
            write_message({'error': error.code, 'message': str(error)})
            continue
        except (ValueError, struct.error) as error:
            write_message({'error': 'bad_message', 'message': str(error)})
            continue
        if request is None:
            return 0
        write_message(handle(request))


if __name__ == '__main__':
    sys.exit(main())
