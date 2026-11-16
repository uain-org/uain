"""Public native epoch history survives a reset; pending jobs do not."""
import unittest
from unittest.mock import patch
import database

class DatabaseTest(unittest.TestCase):
 def test_native_history_is_preserved_and_epoch_metadata_is_explicitly_retired(self):
  names={*database.KEEP,'members','native_epochs','native_proof_batches','native_events',
   'native_journal_cursors','native_journal_entries','native_publications',
   'native_research_documents','native_research_chunks','native_projection_queue'}
  before={'tables':{name:1 for name in names},'hashes':{name:'original' for name in names}}
  retired={**before,'hashes':{**before['hashes'],'native_epochs':'retired'}}
  with patch.object(database,'snapshot',side_effect=[before,retired]):plan=database.plan('uain','20261012_010203')
  for name in names-{'members','native_projection_queue'}:self.assertIn(name,plan['preserve'])
  self.assertEqual(plan['clear'],['members','native_projection_queue'])
  self.assertEqual(plan['preserved_hashes']['native_epochs'],'retired')
  self.assertEqual(plan['retire_native_at'],'2026-10-12 01:02:03+00:00')
 def test_unknown_native_table_requires_explicit_review(self):
  before={'tables':{name:0 for name in [*database.KEEP,'native_unreviewed_secret']}}
  with patch.object(database,'snapshot',return_value=before):
   with self.assertRaises(ValueError):database.plan('uain','20261012_010203')

if __name__=='__main__':unittest.main()
