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

function assertNodeCommandsUsePinnedRuntime(relativePath) {
  const lines = readFile(relativePath).split(/\r?\n/);
  let insideJobs = false;
  let currentJob = null;
  let sawSetupNode = false;

  lines.forEach((line, index) => {
    if (/^jobs:\s*$/.test(line)) {
      insideJobs = true;
      return;
    }

    if (!insideJobs) return;

    const jobMatch = line.match(/^  ([A-Za-z0-9_-]+):\s*$/);
    if (jobMatch) {
      currentJob = jobMatch[1];
      sawSetupNode = false;
      return;
    }

    if (/uses:\s+actions\/setup-node@v6/.test(line)) {
      const setupBlock = lines.slice(index, index + 5).join('\n');
      assert.match(
        setupBlock,
        /node-version-file:\s+\.nvmrc/,
        `${relativePath} ${currentJob || 'job'} setup-node should load .nvmrc`
      );
      sawSetupNode = true;
      return;
    }

    const command = line.trim();
    const runsNodeLocally = /^run:\s+(node|npm)\b/.test(command) || /^(node|npm)\b/.test(command);
    if (runsNodeLocally) {
      assert.ok(
        sawSetupNode,
        `${relativePath} ${currentJob || 'job'} runs ${command} before actions/setup-node@v6`
      );
    }
  });
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
    'gcp/opensky-proxy/package.json',
    'gcp/state-connector/package.json'
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
    '.github/workflows/deploy-state-connector.yml',
    '.github/workflows/deploy-pages.yml',
    '.github/workflows/monitor-data-streams.yml'
  ];

  workflowFiles.forEach((relativePath) => {
    assertNodeCommandsUsePinnedRuntime(relativePath);
  });
});
