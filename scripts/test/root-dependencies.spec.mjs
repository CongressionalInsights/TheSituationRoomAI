import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const readJson = (...segments) => JSON.parse(
  fs.readFileSync(path.join(process.cwd(), ...segments), 'utf8')
);

test('root dev tooling pins manifest and lockfile versions together', () => {
  const manifest = readJson('package.json');
  const lockfile = readJson('package-lock.json');

  assert.deepEqual(manifest.devDependencies, {
    '@playwright/test': '^1.62.0',
    esbuild: '^0.28.1',
    playwright: '^1.62.0'
  });

  assert.deepEqual(lockfile.packages[''].devDependencies, manifest.devDependencies);
  assert.equal(lockfile.packages['node_modules/@playwright/test'].version, '1.62.0');
  assert.equal(lockfile.packages['node_modules/playwright'].version, '1.62.0');
  assert.equal(lockfile.packages['node_modules/esbuild'].version, '0.28.1');
});
