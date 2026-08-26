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

SIZE AND CHUNKING
-----------------
A browser caps a single message from a native host at 1 MB, in both Firefox and
Chrome. That cap belongs to the browser, not to this host: an oversized response is
dropped before the extension ever sees it, so it can only be stayed under, never
raised. A whole public keyring is one file here -- `gpg --export --armor` of a
sizeable keyring is comfortably several megabytes -- so both directions are chunked:
`read` takes a byte offset and returns one chunk, and `write` takes a byte offset and
a `final` flag, staging chunks in one part file and renaming it into place on the
last one. The atomicity guarantee is unchanged: the target is replaced by a rename
after the whole content has been staged and flushed.

None of this defends against a user who is already running malicious code as
themselves. It defends against the realistic case: a bug or a compromise in the
extension turning into arbitrary file access.
"""

import json
import os
import struct
import sys

VERSION = 1

# Bytes of file content carried by one message, in either direction.
#
# The binding constraint is the browser's 1 MB cap on a message from the host, so
# this leaves room for JSON escaping: armored key text carries a newline every 64
# characters and each becomes a two-byte \n, which is about 1.5% of expansion.
# Writes use the same size even though the inbound cap is far more generous (4 GB in
# Firefox, 1 MB in Chrome), so that one code path serves both browsers.
CHUNK_BYTES = 384 * 1024

# Hard ceiling on a response, checked after encoding. A response over the browser's
# cap is discarded by the browser, so replacing it with an error is the only way the
# extension learns anything at all.
MAX_RESPONSE = 768 * 1024

# Inbound cap. Only a bound on what one request can cost in memory now that writes
# are chunked -- a chunk plus its JSON overhead is under half a megabyte.
MAX_MESSAGE = 4 * 1024 * 1024

# Ceiling on a single keystore file. This has to allow for a keyring rather than a
# key: importing a public keyring exported with `gpg --export --armor` puts all of it
# in one public.asc.
MAX_FILE = 16 * 1024 * 1024

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


def read_exactly(count):
    """Read exactly count bytes, or None if the stream ends first."""
    parts, remaining = [], count
    while remaining:
        part = sys.stdin.buffer.read(remaining)
        if not part:
            return None
        parts.append(part)
        remaining -= len(part)
    return b''.join(parts)


def discard(count):
    """Consume and drop count bytes of a message that will not be served."""
    while count:
        part = sys.stdin.buffer.read(min(count, 64 * 1024))
        if not part:
            return
        count -= len(part)


def read_message():
    """Read one native message, or None at end of stream."""
    header = read_exactly(4)
    if header is None:
        return None
    length = struct.unpack('=I', header)[0]
    if length > MAX_MESSAGE:
        # Consume the body even though the message is refused. Leaving it in the pipe
        # made the next read take message bytes for a length header, so a single
        # oversized message desynchronised the host for the rest of the session and
        # every later request failed for an unrelated-looking reason.
        discard(length)
        raise ProtocolError('too_large', f'message of {length} bytes exceeds the limit')
    payload = read_exactly(length)
    if payload is None:
        raise ProtocolError('bad_message', f'stream ended inside a {length} byte message')
    return json.loads(payload.decode('utf-8'))


def write_message(message):
    """Write one native message."""
    # Compact separators: the browser's 1 MB cap counts every byte, and whitespace
    # between thousands of JSON tokens is not free.
    encoded = json.dumps(message, separators=(',', ':')).encode('utf-8')
    if len(encoded) > MAX_RESPONSE:
        encoded = json.dumps({
            'id': message.get('id') if isinstance(message, dict) else None,
            'error': 'too_large',
            'message': f'response of {len(encoded)} bytes exceeds the native messaging limit'
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


def as_offset(value):
    """Validate a byte offset from a request. Absent means the start of the file."""
    if value is None:
        return 0
    # bool is an int subclass, and True would silently mean offset 1.
    if not isinstance(value, int) or isinstance(value, bool) or value < 0:
        raise ProtocolError('bad_offset', 'offset must be a non-negative integer')
    return value


def decode_prefix(data):
    """Decode the longest whole-character UTF-8 prefix of data.

    A chunk boundary lands on an arbitrary byte, so the last character in the chunk
    may be cut in half. Trimming up to three trailing bytes finds the character
    boundary; the client is told how many bytes were actually decoded and asks for
    the rest from there, so nothing is lost. A file that is not valid UTF-8 at all
    still fails, as it must -- these files are text.

    Returns the text, and how many bytes of data it came from.
    """
    for trim in range(min(4, len(data) + 1)):
        candidate = data[:len(data) - trim] if trim else data
        try:
            return candidate.decode('utf-8'), len(candidate)
        except UnicodeDecodeError:
            continue
    raise ProtocolError('bad_encoding', 'file is not valid UTF-8 text')


def part_path(target):
    """Staging file for a chunked write of target.

    Derived from the target rather than random (as a single-message write once was),
    because each native message is served by a fresh process: the name is the only
    thing the next chunk has to find the staged content by. Two concurrent writes to
    one path would collide, which the offset check turns into an error rather than a
    corrupt file -- and the extension serialises its writes anyway.
    """
    return os.path.join(os.path.dirname(target), f'.mvelo-{os.path.basename(target)}.part')


def op_hello(_request):
    return {
        'version': VERSION,
        'platform': sys.platform,
        'allowedRootPrefixes': list(ALLOWED_ROOT_PREFIXES),
        'chunkBytes': CHUNK_BYTES,
        'maxFileBytes': MAX_FILE
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
    """One chunk of a file, starting at a byte offset.

    Chunked because the browser drops any response over 1 MB before the extension
    sees it. A caller reads from offset 0 and follows nextOffset until eof.
    """
    root = check_root(request.get('root'))
    target = resolve(root, request.get('path'))
    if not os.path.isfile(target):
        raise ProtocolError('not_found', 'no such file')
    size = os.path.getsize(target)
    if size > MAX_FILE:
        raise ProtocolError('too_large',
                            f'file of {size} bytes exceeds the {MAX_FILE} byte limit')
    offset = as_offset(request.get('offset'))
    if offset > size:
        raise ProtocolError('bad_offset', f'offset {offset} is past the end of a {size} byte file')
    limit = CHUNK_BYTES
    requested = request.get('maxBytes')
    if isinstance(requested, int) and not isinstance(requested, bool) and 0 < requested < limit:
        limit = requested
    with open(target, 'rb') as handle:
        handle.seek(offset)
        data = handle.read(limit)
    content, consumed = decode_prefix(data)
    if data and not consumed:
        # Cannot happen with a chunk of any real size, but a client that trusted
        # nextOffset would spin forever if it ever did.
        raise ProtocolError('bad_encoding', 'no whole character fits in the chunk')
    return {
        'content': content,
        'offset': offset,
        'bytesRead': consumed,
        'nextOffset': offset + consumed,
        'size': size,
        'eof': offset + consumed >= size
    }


def op_write(request):
    """Write one chunk of a file, and on the final chunk publish it.

    Chunks are appended to a staging file beside the target and only renamed into
    place once the last one has arrived and been flushed to the device -- the same
    staged write as before, spread over as many messages as the content needs.
    rename() within a directory is atomic on POSIX, so a reader sees either the old
    file or the complete new one, never a partial write.

    A write with neither offset nor final is one whole file, exactly as before.
    """
    root = check_root(request.get('root'))
    target = resolve(root, request.get('path'))
    if os.path.basename(target) not in SAFE_NAME:
        raise ProtocolError('name_not_allowed',
                            f'{os.path.basename(target)} is not a keystore file')
    content = request.get('content')
    if not isinstance(content, str):
        raise ProtocolError('bad_content', 'content must be a string')
    offset = as_offset(request.get('offset'))
    final = request.get('final', True) is not False
    data = content.encode('utf-8')
    if offset + len(data) > MAX_FILE:
        raise ProtocolError('too_large',
                            f'content of {offset + len(data)} bytes exceeds the '
                            f'{MAX_FILE} byte limit')
    os.makedirs(os.path.dirname(target), exist_ok=True)
    staged = part_path(target)
    if offset:
        if not os.path.isfile(staged):
            raise ProtocolError('bad_offset',
                                'no staged write to continue; start again at offset 0')
        staged_size = os.path.getsize(staged)
        if staged_size != offset:
            raise ProtocolError('bad_offset',
                                f'staged write holds {staged_size} bytes, '
                                f'chunk starts at {offset}')
    try:
        # offset 0 truncates, which also clears anything left behind by a write that
        # was abandoned midway -- a device pulled between chunks leaves the part file
        # on it, and the target it would have replaced untouched.
        with open(staged, 'ab' if offset else 'wb') as staged_file:
            staged_file.write(data)
            staged_file.flush()
            if final:
                # fsync flushes the file, not merely what this descriptor wrote, so
                # one at the end covers every chunk -- and each chunk paying for its
                # own would be felt on flash media.
                os.fsync(staged_file.fileno())
        if not final:
            return {'ok': True, 'staged': offset + len(data)}
        if os.path.exists(target):
            backup = target + '.bak'
            if os.path.exists(backup):
                os.unlink(backup)
            os.replace(target, backup)
        os.replace(staged, target)
        staged = None
    finally:
        # Only the failed final chunk cleans up: an incomplete write keeps its
        # staging file, because the next chunk is what continues it.
        if staged and final and os.path.exists(staged):
            os.unlink(staged)
    return {'ok': True}


def op_remove(request):
    root = check_root(request.get('root'))
    target = resolve(root, request.get('path'))
    if os.path.basename(target) not in SAFE_NAME:
        raise ProtocolError('name_not_allowed', 'not a keystore file')
    if os.path.exists(target):
        os.unlink(target)
    # A write abandoned midway leaves its staging file on the device. Deleting the
    # file it was going to become is as good a moment as any to drop it.
    staged = part_path(target)
    if os.path.exists(staged):
        os.unlink(staged)
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
