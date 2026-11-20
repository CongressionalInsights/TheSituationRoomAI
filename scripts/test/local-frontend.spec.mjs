import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';

test('direct checkout serves current frontend source even when a generated manifest is present', async t => {
  // Bind an isolated fixture port while exercising the actual local server.
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import http from 'node:http';
    const listen = http.Server.prototype.listen;
    http.Server.prototype.listen = function () {
      return listen.call(this, 0, '127.0.0.1', () => console.log('FIXTURE_PORT=' + this.address().port));
    };
    globalThis.fetch = async () => { throw new Error('Provider calls are outside the local frontend fixture'); };
    await import('./server.mjs');
  `], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => child.kill());
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Local server did not bind')), 5000);
    let output = '';
    child.stdout.on('data', chunk => {
      output += chunk;
      const match = /FIXTURE_PORT=(\d+)/.exec(output);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    });
    child.once('error', reject);
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`Local server exited: ${code}`)); });
  });
  const base = `http://127.0.0.1:${port}/`;
  const response = await fetch(new URL('assets/manifest.json', base), { signal: AbortSignal.timeout(5000) });
  assert.equal(response.status, 200);
  const manifest = await response.json();
  assert.deepEqual(manifest, { 'app.bundle.js': 'app.js', 'styles.css': 'styles.css' });
  const source = await fetch(new URL(manifest['app.bundle.js'], base), { signal: AbortSignal.timeout(5000) });
  assert.match(source.headers.get('content-type'), /javascript/);
  assert.equal(await source.text(), readFileSync(new URL('../../public/app.js', import.meta.url), 'utf8'));
});
