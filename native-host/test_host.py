#!/usr/bin/env python3
# Copyright (C) 2026 Noam Rathaus
# Licensed under the GNU Affero General Public License version 3
"""Tests for the USB keystore native messaging host.

This host runs with the user's full filesystem authority and is driven by the
browser, so the tests that matter most are the ones that try to escape the keystore
root. They are not hypothetical: the mount-point requirement exists because an
earlier version accepted /run/media/<user>, which is local tmpfs rather than the
device -- keys written there would have been on this machine while appearing to be
on the stick.

Run directly: python3 native-host/test_host.py
No dependencies, so it works wherever the host itself does.
"""

import importlib.util
import json
import os
import shutil
import struct
import subprocess
import sys
import tempfile
import unittest

HOST = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                    'mailvelope_usb_keystore.py')


def load_host():
    """Import the host as a module, for tests that call its functions directly."""
    spec = importlib.util.spec_from_file_location('mvelo_usb_keystore_host', HOST)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


host = load_host()


def call_raw(payload):
    """Send raw bytes down the host's stdin and decode whatever comes back."""
    process = subprocess.run([sys.executable, HOST], input=payload,
                             capture_output=True, check=False)
    responses, out = [], process.stdout
    while len(out) >= 4:
        length = struct.unpack('=I', out[:4])[0]
        responses.append(json.loads(out[4:4 + length]))
        out = out[4 + length:]
    return responses


def framed(request):
    """One request in the length-prefixed form the browser sends."""
    encoded = json.dumps(request).encode('utf-8')
    return struct.pack('=I', len(encoded)) + encoded


def call(*requests):
    """Send requests through the host exactly as a browser would."""
    return call_raw(b''.join(framed(request) for request in requests))


def one(request):
    responses = call(request)
    return responses[0] if responses else {'error': 'no_response'}


class Confinement(unittest.TestCase):
    """The host must refuse anything outside a mounted removable device."""

    def assertRefused(self, request, code=None):
        response = one(request)
        self.assertIn('error', response, f'should have been refused: {request}')
        if code:
            self.assertEqual(response['error'], code)
        return response

    def test_rejects_system_directories(self):
        for root in ('/etc', '/', '/usr', '/home', os.path.expanduser('~')):
            self.assertRefused({'op': 'list', 'root': root}, 'root_not_allowed')

    def test_rejects_the_prefix_itself(self):
        self.assertRefused({'op': 'list', 'root': '/run/media'}, 'root_not_allowed')

    # An earlier version allowed this. It is under an allowed prefix but is not a
    # mount point: it is local tmpfs holding the user's mount points.
    def test_rejects_a_directory_under_a_prefix_that_is_not_a_mount(self):
        root = f'/run/media/{os.environ.get("USER", "nobody")}'
        if not os.path.isdir(root):
            self.skipTest('no per-user media directory on this machine')
        self.assertRefused({'op': 'list', 'root': root}, 'root_not_mounted')

    def test_rejects_a_temporary_directory(self):
        with tempfile.TemporaryDirectory() as tmp:
            self.assertRefused({'op': 'list', 'root': tmp}, 'root_not_allowed')

    def test_rejects_nonsense_roots(self):
        for root in (None, '', 42, [], {}):
            self.assertRefused({'op': 'list', 'root': root})


class PathHandling(unittest.TestCase):
    """Path checks are exercised against a real mounted device when one exists."""

    @classmethod
    def setUpClass(cls):
        cls.root = None
        cls.skipped = 'no writable removable device mounted'
        response = one({'op': 'listDevices'})
        devices = response.get('result', {}).get('devices', [])
        for device in devices:
            if not device.get('writable'):
                continue
            # Never a device that holds a real keystore. These tests write and delete
            # files on whatever they are pointed at, and a stick carrying someone's
            # only copy of their keys is not a test fixture. Use the scratch tmpfs
            # device from the install notes instead.
            if os.path.isdir(os.path.join(device['path'], 'mailvelope-keystore')):
                cls.skipped = (f"{device['path']} holds a keystore; "
                               'mount a scratch device for these tests')
                continue
            cls.root = device['path']
            break

    def setUp(self):
        if not self.root:
            self.skipTest(self.skipped)

    def test_rejects_traversal(self):
        for path in ('../../../../etc/passwd',
                     'mailvelope-keystore/../../../../etc/hosts',
                     '..',
                     'a/../../..'):
            response = one({'op': 'read', 'root': self.root, 'path': path})
            self.assertIn('error', response, f'traversal not blocked: {path}')

    def test_rejects_absolute_paths(self):
        response = one({'op': 'read', 'root': self.root, 'path': '/etc/passwd'})
        self.assertEqual(response['error'], 'bad_path')

    # Without this, the write path could be used to drop a file of the caller's
    # choosing anywhere inside the device -- a shell script, a desktop entry.
    def test_only_writes_known_keystore_files(self):
        for name in ('evil.sh', 'autorun.inf', '.bashrc', 'index.html'):
            response = one({'op': 'write', 'root': self.root,
                            'path': f'mailvelope-keystore/{name}', 'content': 'x'})
            self.assertEqual(response['error'], 'name_not_allowed', name)

    def test_write_read_remove_round_trip(self):
        path = 'mailvelope-keystore/meta.json'
        content = json.dumps({'test': True})
        self.assertIn('result', one({'op': 'write', 'root': self.root,
                                     'path': path, 'content': content}))
        read = one({'op': 'read', 'root': self.root, 'path': path})
        self.assertEqual(read['result']['content'], content)
        self.assertIn('result', one({'op': 'remove', 'root': self.root, 'path': path}))
        self.assertEqual(one({'op': 'read', 'root': self.root,
                              'path': path})['error'], 'not_found')

    # The staged write keeps the previous generation, so an interrupted save leaves
    # something recoverable rather than a truncated file.
    def test_overwrite_keeps_a_backup(self):
        path = 'mailvelope-keystore/meta.json'
        try:
            one({'op': 'write', 'root': self.root, 'path': path, 'content': 'first'})
            one({'op': 'write', 'root': self.root, 'path': path, 'content': 'second'})
            self.assertEqual(one({'op': 'read', 'root': self.root,
                                  'path': path})['result']['content'], 'second')
            backup = one({'op': 'read', 'root': self.root, 'path': path + '.bak'})
            self.assertEqual(backup['result']['content'], 'first')
        finally:
            for p in (path, path + '.bak'):
                target = os.path.join(self.root, p)
                if os.path.exists(target):
                    os.unlink(target)

    # The whole point of chunking, over the real wire and a real filesystem: the
    # in-process tests cannot exercise the length-prefixed framing, and a FAT32 stick
    # is where the rename and fsync actually have to hold.
    def test_a_keyring_sized_file_survives_the_wire(self):
        path = 'mailvelope-keystore/meta.json'
        content = ('-----BEGIN PGP PUBLIC KEY BLOCK-----\n' +
                   'mQINBF\n' * 300 +
                   '-----END PGP PUBLIC KEY BLOCK-----\n') * 700
        data = content.encode('utf-8')
        self.assertGreater(len(data), 1024 * 1024)
        try:
            requests, offset = [], 0
            while offset < len(data):
                end = min(offset + host.CHUNK_BYTES, len(data))
                requests.append({'op': 'write', 'root': self.root, 'path': path,
                                 'content': data[offset:end].decode('utf-8'),
                                 'offset': offset, 'final': end >= len(data)})
                offset = end
            self.assertGreater(len(requests), 1, 'content must need more than one message')
            for response in call(*requests):
                self.assertIn('result', response)

            parts, offset = [], 0
            while True:
                chunk = one({'op': 'read', 'root': self.root, 'path': path,
                             'offset': offset})['result']
                parts.append(chunk['content'])
                if chunk['eof']:
                    break
                offset = chunk['nextOffset']
            self.assertEqual(''.join(parts), content)
        finally:
            one({'op': 'remove', 'root': self.root, 'path': path})
            backup = os.path.join(self.root, path + '.bak')
            if os.path.exists(backup):
                os.unlink(backup)

    def test_leaves_no_staging_files_behind(self):
        path = 'mailvelope-keystore/meta.json'
        try:
            one({'op': 'write', 'root': self.root, 'path': path, 'content': 'x'})
            names = one({'op': 'list', 'root': self.root,
                         'path': 'mailvelope-keystore'})['result']['names']
            self.assertEqual([n for n in names if n.startswith('.mvelo-')], [])
        finally:
            target = os.path.join(self.root, path)
            if os.path.exists(target):
                os.unlink(target)


class Chunking(unittest.TestCase):
    """The chunk bookkeeping, exercised in-process against a temporary directory.

    A browser drops a message from the host that exceeds 1 MB before the extension
    sees it, so a keyring of any size has to move in pieces. What can go wrong is
    bookkeeping: a chunk landing at the wrong offset, a half-written file published as
    if it were whole, or a character cut in half at a chunk boundary.

    The content operations refuse a root that is not a mounted removable device, and a
    test cannot mount one -- so these call them with the root check replaced by
    realpath. That check is what Confinement covers, in a real subprocess.
    """

    def setUp(self):
        self.root = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.root)
        self.original_check_root = host.check_root
        host.check_root = os.path.realpath
        self.addCleanup(self.restore_check_root)
        self.path = 'mailvelope-keystore/public.asc'
        self.target = os.path.join(self.root, self.path)

    def restore_check_root(self):
        host.check_root = self.original_check_root

    def write(self, content, offset=0, final=True):
        return host.op_write({'root': self.root, 'path': self.path,
                              'content': content, 'offset': offset, 'final': final})

    def read_all(self, max_bytes=None):
        """Read the way the extension does: from 0, following nextOffset."""
        parts, offset = [], 0
        while True:
            request = {'root': self.root, 'path': self.path, 'offset': offset}
            if max_bytes:
                request['maxBytes'] = max_bytes
            chunk = host.op_read(request)
            parts.append(chunk['content'])
            if chunk['eof']:
                return ''.join(parts)
            self.assertGreater(chunk['nextOffset'], offset, 'read made no progress')
            offset = chunk['nextOffset']

    def test_a_keyring_larger_than_one_message_round_trips(self):
        block = '-----BEGIN PGP PUBLIC KEY BLOCK-----\n' + 'mQINBF\n' * 300 + \
                '-----END PGP PUBLIC KEY BLOCK-----\n'
        keyring = block * 700
        data = keyring.encode('utf-8')
        self.assertGreater(len(data), 1024 * 1024, 'test content must exceed the 1 MB cap')
        offset = 0
        while offset < len(data):
            end = min(offset + host.CHUNK_BYTES, len(data))
            self.write(data[offset:end].decode('utf-8'), offset=offset, final=end >= len(data))
            offset = end
        self.assertEqual(self.read_all(), keyring)

    def test_only_the_final_chunk_publishes_the_file(self):
        self.write('first half ', final=False)
        self.assertFalse(os.path.exists(self.target), 'published before the last chunk')
        self.assertTrue(os.path.exists(host.part_path(self.target)), 'nothing staged')
        self.write('second half', offset=len('first half '), final=True)
        with open(self.target, encoding='utf-8') as handle:
            self.assertEqual(handle.read(), 'first half second half')

    def test_a_finished_write_leaves_no_staging_file(self):
        self.write('x' * 10, final=False)
        self.write('y' * 10, offset=10, final=True)
        self.assertEqual([n for n in os.listdir(os.path.dirname(self.target))
                          if n.startswith('.mvelo-')], [])

    # Out-of-order chunks would corrupt the file silently, so they are refused rather
    # than written where they claim to belong.
    def test_refuses_a_chunk_at_the_wrong_offset(self):
        self.write('abc', final=False)
        with self.assertRaises(host.ProtocolError) as caught:
            self.write('def', offset=99, final=True)
        self.assertEqual(caught.exception.code, 'bad_offset')

    def test_refuses_a_continuation_with_nothing_staged(self):
        with self.assertRaises(host.ProtocolError) as caught:
            self.write('def', offset=3, final=True)
        self.assertEqual(caught.exception.code, 'bad_offset')

    def test_an_unchunked_write_still_works(self):
        host.op_write({'root': self.root, 'path': self.path, 'content': 'plain'})
        self.assertEqual(self.read_all(), 'plain')

    def test_overwriting_a_chunked_write_keeps_a_backup(self):
        self.write('first')
        self.write('second')
        with open(self.target + '.bak', encoding='utf-8') as handle:
            self.assertEqual(handle.read(), 'first')

    # A chunk boundary falls on an arbitrary byte, and a user ID with a non-ASCII name
    # will eventually straddle one. Half a character cannot be sent as JSON text, so
    # the host stops short of it and reports how far it actually got.
    def test_a_read_boundary_inside_a_character_loses_nothing(self):
        content = 'a' + 'e\u0301' * 20  # each combining mark is two bytes
        self.write(content)
        # Three bytes reach into the middle of the two-byte mark, so only two come back.
        chunk = host.op_read({'root': self.root, 'path': self.path, 'maxBytes': 3})
        self.assertEqual(chunk['bytesRead'], 2, 'should stop before the split character')
        self.assertFalse(chunk['eof'])
        self.assertEqual(self.read_all(max_bytes=3), content)

    # The failure this actually caused: an extension build from before chunked reads
    # asked for the whole file, got the first chunk, and showed a 412-key keyring as
    # 132 keys -- with nothing anywhere reporting a problem.
    def test_refuses_to_answer_a_whole_file_request_with_a_prefix(self):
        self.write('x' * (host.CHUNK_BYTES + 1))
        with self.assertRaises(host.ProtocolError) as caught:
            host.op_read({'root': self.root, 'path': self.path})
        self.assertEqual(caught.exception.code, 'needs_chunked_read')

    # ...but a file that fits in one chunk has no prefix to hide, so the simple form
    # of the request keeps working.
    def test_serves_a_small_file_without_a_chunked_request(self):
        self.write('small enough')
        chunk = host.op_read({'root': self.root, 'path': self.path})
        self.assertEqual(chunk['content'], 'small enough')
        self.assertTrue(chunk['eof'])

    def test_reports_offsets_and_the_end_of_the_file(self):
        self.write('0123456789')
        chunk = host.op_read({'root': self.root, 'path': self.path, 'offset': 4, 'maxBytes': 3})
        self.assertEqual(chunk, {'content': '456', 'offset': 4, 'bytesRead': 3,
                                 'nextOffset': 7, 'size': 10, 'eof': False})
        end = host.op_read({'root': self.root, 'path': self.path, 'offset': 10})
        self.assertEqual(end['content'], '')
        self.assertTrue(end['eof'])

    def test_refuses_an_offset_past_the_end(self):
        self.write('short')
        for bad in (99, -1, 'x', True):
            with self.assertRaises(host.ProtocolError, msg=repr(bad)):
                host.op_read({'root': self.root, 'path': self.path, 'offset': bad})

    def test_refuses_a_file_that_is_not_text(self):
        os.makedirs(os.path.dirname(self.target), exist_ok=True)
        with open(self.target, 'wb') as handle:
            handle.write(b'\xff\xfe not utf-8')
        with self.assertRaises(host.ProtocolError) as caught:
            host.op_read({'root': self.root, 'path': self.path})
        self.assertEqual(caught.exception.code, 'bad_encoding')

    def test_removing_a_file_drops_its_staging_file(self):
        self.write('abandoned', final=False)
        host.op_remove({'root': self.root, 'path': self.path})
        self.assertEqual(os.listdir(os.path.dirname(self.target)), [])

    def test_refuses_content_beyond_the_file_limit(self):
        with self.assertRaises(host.ProtocolError) as caught:
            self.write('x', offset=host.MAX_FILE, final=True)
        self.assertEqual(caught.exception.code, 'too_large')

    # A response over the browser's cap is dropped before the extension sees it, so
    # an error in its place is the only way the failure is ever reported.
    def test_replaces_an_oversized_response_with_an_error(self):
        captured = []

        class Sink:
            @staticmethod
            def write(data):
                captured.append(data)

            @staticmethod
            def flush():
                pass

        original = sys.stdout
        sys.stdout = type('Out', (), {'buffer': Sink})
        try:
            host.write_message({'id': 7, 'result': {'content': 'x' * (host.MAX_RESPONSE + 1)}})
        finally:
            sys.stdout = original
        body = json.loads(b''.join(captured)[4:])
        self.assertEqual(body['error'], 'too_large')
        self.assertEqual(body['id'], 7)


class Protocol(unittest.TestCase):
    def test_hello_reports_a_version(self):
        result = one({'op': 'hello'})['result']
        self.assertIsInstance(result['version'], int)
        self.assertIn('allowedRootPrefixes', result)

    def test_unknown_operation(self):
        self.assertEqual(one({'op': 'exec'})['error'], 'unknown_op')

    def test_malformed_request(self):
        self.assertIn('error', one({'nope': 1}))

    def test_correlates_responses_by_id(self):
        responses = call({'id': 'a', 'op': 'hello'}, {'id': 'b', 'op': 'hello'})
        self.assertEqual([r['id'] for r in responses], ['a', 'b'])

    def test_hello_reports_the_chunk_size(self):
        result = one({'op': 'hello'})['result']
        self.assertIsInstance(result['chunkBytes'], int)
        self.assertLess(result['chunkBytes'], 1024 * 1024)
        self.assertGreater(result['maxFileBytes'], result['chunkBytes'])

    # Importing a public keyring sent one oversized message, and the body was left in
    # the pipe: the next read took message bytes for a length header, so one refused
    # message broke every request after it.
    def test_an_oversized_message_does_not_desynchronise_the_stream(self):
        oversized = host.MAX_MESSAGE + 1
        payload = struct.pack('=I', oversized) + b'{' + b'x' * (oversized - 1)
        responses = call_raw(payload + framed({'id': 'after', 'op': 'hello'}))
        self.assertEqual(responses[0]['error'], 'too_large')
        self.assertEqual(responses[1]['id'], 'after')
        self.assertIn('result', responses[1])

    def test_reports_a_message_that_ends_early(self):
        responses = call_raw(struct.pack('=I', 4096) + b'{"op":"hello"}')
        self.assertEqual(responses[0]['error'], 'bad_message')

    # A host that dies stops answering, so one bad request must not end the session.
    def test_survives_a_bad_request_mid_stream(self):
        responses = call({'id': 1, 'op': 'hello'},
                         {'id': 2, 'op': 'read', 'root': '/etc', 'path': 'passwd'},
                         {'id': 3, 'op': 'hello'})
        self.assertEqual(len(responses), 3)
        self.assertIn('result', responses[2])

    def test_list_devices_reports_only_mount_points(self):
        for device in one({'op': 'listDevices'})['result']['devices']:
            self.assertTrue(os.path.ismount(device['path']), device['path'])


if __name__ == '__main__':
    unittest.main(verbosity=2)
