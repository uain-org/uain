"""Project upstream catalogue reads; no workbook importer or database writes.
Usage: PYTHONPATH=<pinned-incubator>/src python3 scripts/export-inactive-catalogue.py DB REVISION OUTPUT
"""
import json
import re
import sys
import subprocess
import uain_project_incubator.catalogue as upstream
from pathlib import Path
from uain_project_incubator.catalogue import search, stats

database, revision, output = sys.argv[1:]
assert re.fullmatch(r'[a-f0-9]{40}', revision), 'full upstream revision required'
upstream_root = Path(upstream.__file__).resolve().parents[2]
assert subprocess.check_output(['git', '-C', str(upstream_root), 'rev-parse', 'HEAD'], text=True).strip() == revision, 'loaded module revision differs'
subprocess.run(['git', '-C', str(upstream_root), 'diff', '--exit-code', 'HEAD', '--', 'src'], check=True, stdout=subprocess.DEVNULL)
report = stats(database)
expected_hash = '4419baef812bde5e33718e5e6acc76e1d7dde6fc95574ba79cd0c66955feb5d2'
assert report['source_sha256'] == expected_hash, 'approved workbook differs'
projects = []
for offset in range(0, 21600, 100):
    page = search(database, limit=100, offset=offset)
    for record in page['items']:
        fields = record['source_fields']
        projects.append({
            'id': record['stable_id'], 'title': record['title'],
            'summary': fields['Domain'] + ' · ' + fields['Sub-domain'],
            'kpi': fields['Ambitious KPI (readable)'], 'status': 'inactive',
            'progress': None, 'source_fields': fields, 'provenance': record['provenance'],
            'crew': {'namespace': record['stable_id'], 'planned_slots': 100,
                     'assigned_agents': 0, 'connected': False},
        })
assert len(projects) == 21600
assert len({p['id'] for p in projects}) == 21600
hashes = {p['provenance']['source_sha256'] for p in projects}
assert hashes == {expected_hash}, 'record provenance differs'
payload = {
    'schema': 'uain/inactive-project-catalogue/v1',
    'source': {'repository': 'https://github.com/nuah-org/uain-project-incubator',
               'revision': revision, 'workbook_sha256': hashes.pop()},
    'crew_roles': [{'role': role, 'count': count} for role, count in [
        ('planning coordinator', 1), ('evidence researcher', 24),
        ('measurement methods researcher', 25), ('implementation planner', 25),
        ('verification researcher', 25)]],
    'projects': projects,
}
Path(output).parent.mkdir(parents=True, exist_ok=True)
domains = {}
for project in projects:
    fields = project['source_fields']
    key = str(fields['Domain #'])
    domains.setdefault(key, {'id': key, 'name': fields['Domain'], 'projects': []})['projects'].append(project)
index = {k: v for k, v in payload.items() if k != 'projects'}
index['count'] = len(projects)
index['domains'] = []
for key, domain in domains.items():
    filename = 'domain-' + key + '.json'
    index['domains'].append({'id': key, 'name': domain['name'], 'count': len(domain['projects']), 'file': filename})
    Path(output).with_name(filename).write_text(json.dumps(domain['projects'], ensure_ascii=False, separators=(',', ':')) + '\n')
Path(output).write_text(json.dumps(index, ensure_ascii=False, separators=(',', ':')) + '\n')
