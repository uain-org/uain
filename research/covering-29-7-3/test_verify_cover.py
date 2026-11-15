import itertools
import unittest
from verify_cover import verify, MAX_BYTES


class CoverTests(unittest.TestCase):
    def test_small_exact_oracle(self):
        # Exhaustively compare every collection of edges on three vertices
        # against the direct set-union definition of point coverage.
        edges = list(itertools.combinations(range(3), 2))
        for bits in range(1, 1 << len(edges)):
            blocks = [b for i, b in enumerate(edges) if bits & (1 << i)]
            data = '\n'.join(' '.join(map(str, b)) for b in blocks).encode()
            actual = verify(data, v=3, k=2, t=1, max_blocks=3)
            covered = set().union(*map(set, blocks))
            self.assertEqual(actual['missing'], 3 - len(covered))
            self.assertEqual(actual['accepted'], len(covered) == 3)

    def test_real_incomplete_count(self):
        result = verify(b'0 1 2 3 4 5 6\n')
        self.assertFalse(result['accepted'])
        self.assertEqual(result['missing'], 3654 - 35)

    def test_truncated_valid_row_is_incomplete(self):
        self.assertEqual(verify(b'0 1 2 3 4 5 6')['missing'], 3619)

    def test_formats(self):
        for data in [b'', b'\n', b'# header\n', b'0 1 2 3 4 5\n',
                     b'0 1 2 3 4 5 6 7\n', b'0 1 2 3 4 5 06\n',
                     b'0 1 2 3 4 5 +6\n', b'0 1 2 3 4 5 -1\n',
                     b'0 1 2 3 4 5 6\n\n', b'0\t1 2 3 4 5 6\n',
                     b'0 1 2 3 4 5 6\x00', '0 1 2 3 4 5 ６'.encode()]:
            with self.subTest(data=data):
                result = verify(data)
                self.assertFalse(result['accepted'])
                self.assertIsNone(result['missing'])

    def test_duplicate_and_range(self):
        for data, error in [(b'0 1 2 3 4 5 5', 'duplicate_point'),
                            (b'0 1 2 3 4 5 29', 'out_of_range'),
                            (b'0 1 2 3 4 5 6\n6 5 4 3 2 1 0', 'duplicate_block')]:
            self.assertEqual(verify(data)['error'], error)

    def test_resources(self):
        self.assertEqual(verify(b'0' * (MAX_BYTES + 1))['error'], 'resource_limit')
        self.assertEqual(verify(b'0 1 2 3 4 5 6\n' * 131)['error'], 'block_count')
        self.assertEqual(verify(b'0 1 2 3 4 5 ' + b'9' * 10000)['error'], 'row_format')

    def test_crlf(self):
        self.assertEqual(verify(b'0 1 2 3 4 5 6\r\n')['missing'], 3619)


if __name__ == '__main__':
    unittest.main()
