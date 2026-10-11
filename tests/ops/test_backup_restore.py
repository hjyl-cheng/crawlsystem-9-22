import importlib.util
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

SCRIPTS = Path(__file__).resolve().parents[2] / 'docs/crawlsystem-infra-a1-s3/scripts'
sys.path.insert(0, str(SCRIPTS))
from backup_checks import snapshot_sql

spec = importlib.util.spec_from_file_location('restore', SCRIPTS / 'verify-local-restore.py')
restore = importlib.util.module_from_spec(spec)
spec.loader.exec_module(restore)


class RestoreChecks(unittest.TestCase):
    def setUp(self):
        self.expected = {'schema_digest': 'schema', 'tables': {'control.plans': {'rows': 2, 'digest': 'data'}}}

    def test_matching_snapshot(self):
        restore.compare_fingerprints(self.expected, self.expected)

    def test_changed_row_with_same_count(self):
        actual = {'schema_digest': 'schema', 'tables': {'control.plans': {'rows': 2, 'digest': 'changed'}}}
        with self.assertRaisesRegex(RuntimeError, 'content differs'):
            restore.compare_fingerprints(self.expected, actual)

    def test_missing_table(self):
        with self.assertRaisesRegex(RuntimeError, 'coverage differs'):
            restore.compare_fingerprints(self.expected, {'schema_digest': 'schema', 'tables': {}})

    def test_changed_schema(self):
        with self.assertRaisesRegex(RuntimeError, 'schema differs'):
            restore.compare_fingerprints(self.expected, {**self.expected, 'schema_digest': 'changed'})

    def test_changed_algorithm(self):
        with self.assertRaisesRegex(RuntimeError, 'algorithm differs'):
            restore.compare_fingerprints({**self.expected, 'row_digest': 'old'}, {**self.expected, 'row_digest': 'new'})

    def test_snapshot_injection_rejected(self):
        with self.assertRaises(ValueError):
            snapshot_sql("'; DELETE FROM control.plans; --")

    def test_checksum_path_traversal_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'SHA256SUMS'
            path.write_text('a' * 64 + '  ../secrets\n')
            with self.assertRaises(ValueError):
                restore.checksum_manifest(path)

    def test_duplicate_checksum_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'SHA256SUMS'
            path.write_text(('a' * 64 + '  data.dump\n') * 2)
            with self.assertRaises(ValueError):
                restore.checksum_manifest(path)

    def test_replaced_namespace_never_deleted(self):
        state = {'run_id': 'abc', 'namespace': 'ours', 'namespace_uid': 'old'}
        with patch.object(restore, 'obj', return_value={'items': [{'metadata': {'name': 'ours', 'uid': 'new'}}]}), patch.object(restore, 'k') as command:
            with self.assertRaisesRegex(RuntimeError, 'UID mismatch'):
                restore.cleanup(state)
            command.assert_not_called()

    def test_unrelated_namespace_never_deleted(self):
        with patch.object(restore, 'obj', return_value={'items': [{'metadata': {'name': 'unrelated'}}]}), patch.object(restore, 'k') as command:
            with self.assertRaisesRegex(RuntimeError, 'ownership mismatch'):
                restore.cleanup({'run_id': 'abc', 'namespace': 'ours'})
            command.assert_not_called()

    def test_finish_rejects_partial_restore(self):
        with self.assertRaisesRegex(RuntimeError, 'incomplete'):
            restore.finish({'metadata': {'databases': ['one', 'two']}, 'databases_restored': {'one': {}}, 'tests': {}})

    def test_large_search_indexes_get_individual_batches(self):
        lines = '; comment\n1; 0 1 INDEX public small a\n2; 0 2 INDEX public idx_creator_search_text a\n3; 0 3 CONSTRAINT public creator_search_current primary_key a\n4; 0 4 INDEX public another a\n'
        batches = restore.post_data_batches(lines)
        self.assertEqual([len(batch) for batch in batches], [1, 1, 1, 1])
        self.assertEqual(sum(map(len, batches)), 4)


if __name__ == '__main__':
    unittest.main()
