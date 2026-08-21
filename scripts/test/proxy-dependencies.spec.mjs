import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const readJson = (...segments) => JSON.parse(
  fs.readFileSync(path.join(process.cwd(), ...segments), 'utf8')
);

test('ACLED proxy keeps an audit-patched adm-zip lockfile', () => {
  const manifest = readJson('gcp', 'acled-proxy', 'package.json');
  const lockfile = readJson('gcp', 'acled-proxy', 'package-lock.json');

  assert.equal(manifest.dependencies['adm-zip'], '^0.6.0');
  assert.equal(lockfile.packages[''].dependencies['adm-zip'], '^0.6.0');
  assert.equal(lockfile.packages['node_modules/adm-zip'].version, '0.6.0');
});

test('MCP proxy pins audit-patched SDK parser and transitive overrides', () => {
  const manifest = readJson('gcp', 'mcp-proxy', 'package.json');
  const lockfile = readJson('gcp', 'mcp-proxy', 'package-lock.json');

  assert.deepEqual(manifest.dependencies, {
    '@modelcontextprotocol/sdk': '^1.30.0',
    'fast-xml-parser': '^5.10.1',
    zod: '^4.4.3'
  });

  assert.deepEqual(manifest.overrides, {
    '@hono/node-server': '1.19.14',
    hono: '4.12.27',
    'express-rate-limit': '8.5.2',
    'ip-address': '10.2.0',
    'fast-uri': '3.1.2',
    qs: '6.15.2',
    'path-to-regexp': '8.4.2'
  });

  const lockedRoot = lockfile.packages[''];
  assert.deepEqual(lockedRoot.dependencies, manifest.dependencies);
  assert.equal(lockfile.packages['node_modules/@modelcontextprotocol/sdk'].version, '1.30.0');
  assert.equal(lockfile.packages['node_modules/fast-xml-parser'].version, '5.10.1');
  assert.equal(lockfile.packages['node_modules/zod'].version, '4.4.3');

  for (const [name, version] of Object.entries(manifest.overrides)) {
    assert.equal(lockfile.packages[`node_modules/${name}`].version, version);
  }
});

test('State connector keeps XML parser dependency lockfile aligned', () => {
  const manifest = readJson('gcp', 'state-connector', 'package.json');
  const lockfile = readJson('gcp', 'state-connector', 'package-lock.json');

  assert.deepEqual(manifest.dependencies, {
    'fast-xml-parser': '^5.10.1'
  });
  assert.deepEqual(lockfile.packages[''].dependencies, manifest.dependencies);
  assert.equal(lockfile.packages['node_modules/fast-xml-parser'].version, '5.10.1');
});
