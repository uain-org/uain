"""Every pinned custody tool's SOURCE_NAMES closure loads under `python -I`.

Fictional: compiles and executes the repository's own sources into fresh
modules in SOURCE_NAMES order, exactly as each bootstrap_sources() preload does,
in a child interpreter started with -I (no script directory on sys.path), so an
application module missing from a closure fails here instead of on the host.
No vault, key, network or root needed.
"""
import ast
import json
import subprocess
import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
TOOLS = ('project_organizations', 'central_reviewer_server', 'central_fund_manager', 'karma_launch',
         'central_launch', 'evidence_window_launch', 'survey_attester')
LOCAL = {p.stem for p in HERE.glob('*.py') if not p.stem.startswith('test_')}

CHILD = r'''
import json, sys, types
from pathlib import Path
directory, names = Path(sys.argv[1]), json.loads(sys.argv[2])
assert sys.flags.isolated and str(directory) not in sys.path
try:
    import pykeepass  # noqa: F401  (installed on the custody host)
except ImportError:
    sys.modules['pykeepass'] = types.SimpleNamespace(PyKeePass=object, create_database=object)
for name in names:
    module = types.ModuleType(name); module.__file__ = str(directory / (name + '.py')); sys.modules[name] = module
    try:
        exec(compile((directory / (name + '.py')).read_bytes(), module.__file__, 'exec', dont_inherit=True), module.__dict__)
    except ModuleNotFoundError as error:
        print(json.dumps(dict(module=name, missing=error.name))); sys.exit(3)
print(json.dumps(dict(ok=names)))
'''


def source_names(tool):
    tree = ast.parse((HERE / (tool + '.py')).read_text())
    for node in tree.body:
        if isinstance(node, ast.Assign) and any(getattr(t, 'id', None) == 'SOURCE_NAMES' for t in node.targets):
            return list(ast.literal_eval(node.value))
    raise AssertionError(tool + ' has no SOURCE_NAMES')


def top_level_local_imports(name):
    found = set()
    for node in ast.parse((HERE / (name + '.py')).read_text()).body:
        if isinstance(node, ast.Import):
            found.update(a.name for a in node.names)
        elif isinstance(node, ast.ImportFrom) and node.module and not node.level:
            found.add(node.module)
    return found & LOCAL


class PinnedClosureTests(unittest.TestCase):
    def test_every_closure_lists_its_top_level_application_imports_in_dependency_order(self):
        for tool in TOOLS:
            names = source_names(tool)
            self.assertEqual(names[-1], tool)
            for index, name in enumerate(names):
                for dependency in top_level_local_imports(name):
                    with self.subTest(tool=tool, module=name, imports=dependency):
                        self.assertIn(dependency, names[:index])

    def test_every_closure_preloads_under_isolated_python(self):
        for tool in TOOLS:
            names = source_names(tool)
            with self.subTest(tool=tool):
                result = subprocess.run([sys.executable, '-I', '-c', CHILD, str(HERE), json.dumps(names)],
                                        capture_output=True, text=True, timeout=60, cwd='/')
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr[-2000:])

    def test_guardian_quorum_is_pinned_wherever_native_admission_is(self):
        for tool in TOOLS:
            names = source_names(tool)
            if 'native_admission' in names:
                with self.subTest(tool=tool):
                    self.assertLess(names.index('guardian_quorum'), names.index('native_admission'))


if __name__ == '__main__':
    unittest.main()
