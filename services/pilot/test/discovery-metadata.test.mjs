import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const publicRoot = path.join(root, 'public');
const readJson = (name) => JSON.parse(readFileSync(path.join(publicRoot, name), 'utf8'));
const server = readJson('server.json');
const catalog = readJson('.well-known/ard.json');
const descriptor = readJson('.well-known/uain.json');
const skill = readFileSync(path.join(publicRoot, 'skills/uain-discovery/SKILL.md'), 'utf8');

const localPublicFile = (url) => {
  const parsed = new URL(url);
  assert.equal(parsed.origin, 'https://uain.global');
  return path.join(publicRoot, decodeURIComponent(parsed.pathname.slice(1)));
};

test('MCP Registry metadata describes the public remote, without claiming publication', () => {
  assert.equal(server.$schema, 'https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json');
  assert.equal(server.name, 'global.uain/network');
  assert.match(server.version, /^\d+\.\d+\.\d+$/);
  assert.ok(server.description.length <= 100);
  assert.deepEqual(server.remotes, [{ type: 'streamable-http', url: 'https://uain.global/mcp' }]);
  assert.equal(descriptor.discovery.external_registry_publication, 'not yet submitted');
});

test('ARD entries resolve to real artifacts and carry search examples', () => {
  assert.ok(Array.isArray(catalog.entries));
  assert.equal(catalog.entries.length, 2);
  const identifiers = new Set();
  for (const entry of catalog.entries) {
    assert.match(entry.identifier, /^urn:air:uain\.global:[a-z0-9-]+:[a-z0-9-]+$/);
    assert.ok(!identifiers.has(entry.identifier), `duplicate ${entry.identifier}`);
    identifiers.add(entry.identifier);
    assert.ok(entry.displayName && entry.description);
    assert.ok(['application/mcp-server-card+json', 'application/ai-skill+md'].includes(entry.type));
    assert.equal(entry.data, undefined, 'an ARD entry may use either url or data');
    assert.ok(existsSync(localPublicFile(entry.url)), `missing ${entry.url}`);
    assert.ok(entry.representativeQueries.length >= 2 && entry.representativeQueries.length <= 5);
  }
  assert.equal(catalog.entries[0].url, descriptor.discovery.mcp_registry_metadata);
  assert.equal(catalog.entries[1].url, descriptor.discovery.skill);
  assert.ok(existsSync(localPublicFile(descriptor.discovery.ard_catalog)));
});

test('portable skill has valid identifying frontmatter and a read-first path', () => {
  const frontmatter = skill.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  assert.ok(frontmatter, 'SKILL.md needs YAML frontmatter');
  assert.match(frontmatter[1], /^name: uain-discovery$/m);
  assert.match(frontmatter[1], /^description: .+$/m);
  assert.match(skill, /uain_find_tasks/);
  assert.match(skill, /tasks\/feed\.json/);
  assert.match(skill, /operator's approval/);
  assert.match(skill, /does not itself\s+prove that approval was given/);
  assert.match(skill, /private key/);
});
