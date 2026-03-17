import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();

function readFile(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function readJson(relativePath) {
  return JSON.parse(readFile(relativePath));
}

test('Node runtime stays pinned to .nvmrc across package manifests', () => {
  const expectedVersion = readFile('.nvmrc').trim();
  assert.equal(expectedVersion, '24');

  const packageFiles = [
    'package.json',
    'gcp/acled-proxy/package.json',
    'gcp/feed-proxy/package.json',
    'gcp/mcp-proxy/package.json',
    'gcp/openai-proxy/package.json',
    'gcp/opensky-proxy/package.json'
  ];

  packageFiles.forEach((relativePath) => {
    const pkg = readJson(relativePath);
    assert.equal(
      pkg.engines?.node,
      `${expectedVersion}.x`,
      `${relativePath} should pin engines.node to ${expectedVersion}.x`
    );
  });
});

test('Node-running workflows load the runtime from .nvmrc', () => {
  const workflowFiles = [
    '.github/workflows/deploy-feed-proxy.yml',
    '.github/workflows/deploy-mcp-proxy.yml',
    '.github/workflows/deploy-pages.yml',
    '.github/workflows/monitor-data-streams.yml'
  ];

  workflowFiles.forEach((relativePath) => {
    const workflow = readFile(relativePath);
    assert.match(
      workflow,
      /uses:\s+actions\/setup-node@v6/,
      `${relativePath} should use actions/setup-node@v6`
    );
    assert.match(
      workflow,
      /node-version-file:\s+\.nvmrc/,
      `${relativePath} should load Node from .nvmrc`
    );
  });
});
