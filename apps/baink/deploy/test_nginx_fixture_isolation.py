"""Safety checks for real Nginx fixtures; never launch an unguarded config."""
import hashlib
import http.client
import importlib.util
import json
from pathlib import Path
import shutil
import socket
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch


spec = importlib.util.spec_from_file_location(
    'nginx_fixture_isolation', Path(__file__).with_name('nginx-fixture-isolation.py')
)
try:
    fixture = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(fixture)
except FileNotFoundError:
    fixture = None


class FixtureIsolation(unittest.TestCase):
    def setUp(self):
        self.assertIsNotNone(fixture, 'Nginx fixture isolation helper is missing')

    def test_all_temp_paths_are_contained_and_unique(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            config = b'events {} http {\n' + fixture.temp_directives(root) + b'}\n'
            paths = fixture.validate_config(config, root)
            self.assertEqual(set(paths), {
                'client_body_temp_path', 'proxy_temp_path', 'fastcgi_temp_path',
                'uwsgi_temp_path', 'scgi_temp_path',
            })
            self.assertEqual(len(set(paths.values())), 5)
            for path in paths.values():
                self.assertTrue(path.is_relative_to(root.resolve()))

    def test_omission_is_refused_before_syntax_or_start_process(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            config = root / 'nginx.conf'
            lines = fixture.temp_directives(root).splitlines(keepends=True)
            unsafe = [b'events {} http { proxy_temp_path /var/lib/nginx/proxy; }']
            unsafe += [b'events {} http {' + b''.join(line for line in lines if not line.startswith(name.encode() + b' ')) + b'}'
                       for name in fixture.TEMP_PATHS]
            unsafe += [b'events {} http {' + fixture.temp_directives(root).replace(
                str(root.resolve() / 'proxy').encode(), b'/var/lib/nginx/proxy') + b'}']
            for data in unsafe:
                config.write_bytes(data)
                with self.subTest(config=data):
                    with patch.object(fixture.subprocess, 'run', side_effect=AssertionError('unsafe launch')):
                        with self.assertRaises(ValueError):
                            fixture.syntax_check('/usr/sbin/nginx', config, root)
                    with patch.object(fixture.subprocess, 'Popen', side_effect=AssertionError('unsafe launch')):
                        with self.assertRaises(ValueError):
                            fixture.start('/usr/sbin/nginx', config, root)

    def test_escape_duplicate_nested_override_and_include_are_refused(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            good = fixture.temp_directives(root)
            cases = [
                good.replace(b'proxy_temp_path ', b'proxy_temp_path /var/lib/nginx/proxy; #'),
                good + b'proxy_temp_path /var/lib/nginx/proxy;',
                good.replace(b'proxy_temp_path ', b'proxy_temp_path $prefix/'),
                good + b'include /etc/nginx/conf.d/*.conf;',
                b'server { ' + good + b' }',
            ]
            for directives in cases:
                with self.subTest(directives=directives):
                    with self.assertRaises(ValueError):
                        fixture.validate_config(b'events {} http { ' + directives + b' }', root)

    def test_comment_does_not_supply_a_missing_path(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            directives = fixture.temp_directives(root)
            lines = directives.splitlines(keepends=True)
            missing = b''.join(b'# ' + line if line.startswith(b'proxy_temp_path ') else line for line in lines)
            with self.assertRaises(ValueError):
                fixture.validate_config(b'events {} http {\n' + missing + b'}', root)

    def test_symlink_root_and_symlink_temp_target_are_refused(self):
        with tempfile.TemporaryDirectory() as directory, tempfile.TemporaryDirectory() as outside:
            root = Path(directory)
            linked_root = root / 'linked-root'
            linked_root.symlink_to(outside, target_is_directory=True)
            with self.assertRaises(ValueError):
                fixture.temp_directives(linked_root)
            directives = fixture.temp_directives(root)
            paths = fixture.validate_config(b'events {} http {\n' + directives + b'}', root)
            paths['proxy_temp_path'].symlink_to(outside, target_is_directory=True)
            with self.assertRaises(ValueError):
                fixture.validate_config(b'events {} http {\n' + directives + b'}', root)

    def test_relative_path_and_dotdot_are_refused(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            directives = fixture.temp_directives(root)
            path = str(fixture.validate_config(b'http {' + directives + b'}', root)['proxy_temp_path']).encode()
            for bad in [b'proxy', str(root.resolve() / '..' / 'outside').encode()]:
                with self.assertRaises(ValueError):
                    fixture.validate_config(b'http {' + directives.replace(path, bad) + b'}', root)

    def test_real_nginx_large_body_and_global_temp_metadata_preserved(self):
        nginx = shutil.which('nginx')
        if not nginx:
            self.skipTest('actual Nginx binary unavailable; root Linux qualification is separate')
        # The unsafe predecessor is never executed. The guard runs before either process.
        before = fixture.snapshot_default_paths(nginx)
        body = bytes(range(256)) * 8192  # 2 MiB, deterministic and larger than proxy buffers.

        class Upstream(BaseHTTPRequestHandler):
            def do_GET(self):
                self.send_response(200)
                self.send_header('Content-Length', str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *args):
                pass

        upstream = ThreadingHTTPServer(('127.0.0.1', 0), Upstream)
        thread = threading.Thread(target=upstream.serve_forever, daemon=True)
        thread.start()
        try:
            with tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                with socket.socket() as listener:
                    listener.bind(('127.0.0.1', 0))
                    port = listener.getsockname()[1]
                config = root / 'nginx.conf'
                config.write_bytes((
                    f'daemon off; master_process off; pid {root.resolve()}/nginx.pid; '
                    f'error_log {root.resolve()}/error.log; events {{ worker_connections 64; }} '
                    'http { access_log off; '
                ).encode() + fixture.temp_directives(root) + (
                    f'server {{ listen 127.0.0.1:{port}; location / {{ '
                    f'proxy_pass http://127.0.0.1:{upstream.server_port}; '
                    'proxy_buffer_size 1k; proxy_buffers 4 1k; proxy_busy_buffers_size 2k; '
                    'proxy_temp_file_write_size 2k; } } }'
                ).encode())
                result = fixture.syntax_check(nginx, config, root)
                self.assertEqual(result.returncode, 0, result.stderr.decode())
                process = fixture.start(nginx, config, root)
                try:
                    for _ in range(100):
                        try:
                            with socket.create_connection(('127.0.0.1', port), timeout=.2):
                                break
                        except OSError:
                            self.assertIsNone(process.poll(), 'fixture Nginx exited before readiness')
                            time.sleep(.02)
                    conn = http.client.HTTPConnection('127.0.0.1', port, timeout=15)
                    conn.request('GET', '/')
                    response = conn.getresponse()
                    time.sleep(.1)  # Allow this isolated proxy to buffer the deterministic body.
                    received = response.read()
                    self.assertEqual(response.status, 200)
                    self.assertEqual(int(response.getheader('Content-Length')), len(body))
                    self.assertEqual(len(received), 2097152)
                    self.assertEqual(hashlib.sha256(received).digest(), hashlib.sha256(body).digest())
                    conn.close()
                finally:
                    process.terminate()
                    process.communicate(timeout=10)
                for path in fixture.validate_config(config.read_bytes(), root).values():
                    self.assertTrue(path.is_dir(), 'Nginx must initialize fixture-local temp paths')
                self.assertEqual(fixture.snapshot_default_paths(nginx), before)
                print('ISOLATION_RECEIPT ' + json.dumps({
                    'bytes': len(received), 'sha256': hashlib.sha256(received).hexdigest(),
                    'globalTempMetadataPreserved': True, 'defaultPaths': sorted(before),
                    'productionRequests': 0, 'productionConfigWrites': 0,
                }))
        finally:
            upstream.shutdown()
            upstream.server_close()
            thread.join(timeout=3)
            self.assertEqual(fixture.snapshot_default_paths(nginx), before)


if __name__ == '__main__':
    unittest.main()
