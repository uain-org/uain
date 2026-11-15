/**
 * Compile the contracts with solcjs, pinned to 0.8.26. Foundry is not
 * required: the tests and the anchor script both use this output.
 *
 *   node scripts/compile.mjs          writes build/<Name>.json
 *
 * Also importable: `compile()` returns { [Name]: { abi, bytecode } } for the
 * deployable contracts in SOURCES only. The draft token in DRAFT_SOURCES is
 * never part of the default build and never written to build/: a deploy-ready
 * artifact of a token that must not be deployed would be one command from a
 * deployment. `compileDraft()` compiles it in memory, for its own test.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const solc = require('solc');

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** The contracts the default build compiles and writes to build/. */
export const SOURCES = {
  'src/LedgerAnchor.sol': 'LedgerAnchor',
};

/** Draft contracts that must not be deployed. Compiled only by their own tests. */
export const DRAFT_SOURCES = {
  'draft/UAINCredits.sol': 'UAINCredits',
};

function findImport(path) {
  try {
    if (path.startsWith('@openzeppelin/'))
      return { contents: readFileSync(require.resolve(path), 'utf8') };
    return { contents: readFileSync(join(root, path), 'utf8') };
  } catch {
    return { error: `not found: ${path}` };
  }
}

export function compile(sources = SOURCES) {
  const input = {
    language: 'Solidity',
    sources: Object.fromEntries(
      Object.keys(sources).map((p) => [p, { content: readFileSync(join(root, p), 'utf8') }]),
    ),
    settings: {
      evmVersion: 'cancun',
      optimizer: { enabled: true, runs: 200 },
      outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object', 'evm.deployedBytecode.immutableReferences'] } },
    },
  };
  const out = JSON.parse(solc.compile(JSON.stringify(input), { import: findImport }));
  const errors = (out.errors ?? []).filter((e) => e.severity === 'error');
  if (errors.length) throw new Error(errors.map((e) => e.formattedMessage).join('\n'));
  const result = {};
  for (const [path, name] of Object.entries(sources)) {
    const c = out.contracts[path][name];
    result[name] = {
      abi: c.abi, bytecode: `0x${c.evm.bytecode.object}`,
      deployedBytecode: `0x${c.evm.deployedBytecode.object}`,
      immutableReferences: c.evm.deployedBytecode.immutableReferences,
      compiler: solc.version(),
    };
  }
  return result;
}

/** In memory only: the draft is never written to disk by any script. */
export const compileDraft = () => compile(DRAFT_SOURCES);

/**
 * Write build/<Name>.json for the default sources only. Removes a
 * UAINCredits.json left by an older build, so a stale deploy-ready artifact
 * of the draft token does not linger in a working copy.
 */
export function writeBuild(outDir = join(root, 'build')) {
  const built = compile();
  mkdirSync(outDir, { recursive: true });
  for (const name of Object.values(DRAFT_SOURCES)) rmSync(join(outDir, `${name}.json`), { force: true });
  for (const [name, artefact] of Object.entries(built)) {
    writeFileSync(join(outDir, `${name}.json`), JSON.stringify(artefact, null, 2));
    console.log(`build/${name}.json  ${(artefact.bytecode.length - 2) / 2} bytes`);
  }
  console.log(`solc ${solc.version()}`);
  return Object.keys(built);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) writeBuild();
