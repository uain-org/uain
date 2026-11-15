import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import ts from 'typescript';

test('live Kalki projects remain visible and yellow in the live-only observatory', async () => {
  const source = await readFile(
    new URL('../../../lib/observatory/world.ts', import.meta.url),
    'utf8',
  );
  let code = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  // Orbital and feed helpers are outside this project-marker contract.
  code = code
    .replace(/import[\s\S]*?from 'satellite.js';/, '')
    .replace(
      /import[\s\S]*?from '@\/lib\/network\/globe-layers';/,
      'const hash01 = () => 0.5;',
    );
  const { World } = await import(
    'data:text/javascript;base64,' + Buffer.from(code).toString('base64')
  );
  const priorWindow = globalThis.window;
  globalThis.window = { matchMedia: () => ({ matches: true }) };
  try {
    const C = {
      Cartesian3: { fromDegrees: (lon, lat, height) => ({ lon, lat, height }) },
      Color: { fromCssColorString: (css) => css },
      ConstantPositionProperty: class {
        constructor(value) {
          this.value = value;
        }
      },
    };
    const viewer = {
      scene: { preUpdate: { addEventListener() {} } },
      entities: { add: (value) => value, remove() {} },
    };
    const world = new World(C, viewer);
    world.visible.missions = true; // The production Real preset enables this layer.
    const project = {
      id: 'health',
      title: 'Healthcare',
      opportunity: true,
      details: ['Read from Kalki; catalogue position, not a physical location'],
    };
    world.setProjects([project], 'cpj:', false);
    const live = world.contacts.get('cpj:health');
    assert.equal(live.sim, undefined);
    assert.equal(live.layer, 'missions');
    assert.equal(live.accent, '#ffd84d');
    assert.equal(world.listed(live), true);
    assert.equal(live.entity.show, true);
    world.setProjects([{ ...project, id: 'concept' }], 'cpj:');
    assert.equal(world.listed(world.contacts.get('cpj:concept')), false);
  } finally {
    globalThis.window = priorWindow;
  }
});
