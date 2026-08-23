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

import json
import os
import struct
import subprocess
import sys
import tempfile
import unittest

HOST = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                    'mailvelope_usb_keystore.py')


def call(*requests):
    """Send requests through the host exactly as a browser would."""
    payload = b''
    for request in requests:
        encoded = json.dumps(request).encode('utf-8')
        payload += struct.pack('=I', len(encoded)) + encoded
    process = subprocess.run([sys.executable, HOST], input=payload,
                             capture_output=True, check=False)
    responses, out = [], process.stdout
    while len(out) >= 4:
        length = struct.unpack('=I', out[:4])[0]
        responses.append(json.loads(out[4:4 + length]))
        out = out[4 + length:]
    return responses


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
        response = one({'op': 'listDevices'})
        devices = response.get('result', {}).get('devices', [])
        writable = [d for d in devices if d.get('writable')]
        if writable:
            cls.root = writable[0]['path']

    def setUp(self):
        if not self.root:
            self.skipTest('no writable removable device mounted')

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

    def test_leaves_no_staging_files_behind(self):
        path = 'mailvelope-keystore/meta.json'
        try:
            one({'op': 'write', 'root': self.root, 'path': path, 'content': 'x'})
            names = one({'op': 'list', 'root': self.root,
                         'path': 'mailvelope-keystore'})['result']['names']
            self.assertEqual([n for n in names if n.endswith('.tmp')], [])
        finally:
            target = os.path.join(self.root, path)
            if os.path.exists(target):
                os.unlink(target)


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
