import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { format } from 'node:util';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';

// Only inert command doubles run here. Real release/verifier CLIs still start
// fresh processes; each scenario owns a private socket, worker and filesystem.
export async function fixtureCommand(t, file, implementation, environmentKeys = []) {
  for (const key of environmentKeys) {
    if (!/^[A-Z_][A-Z_0-9]*$/.test(key)) throw Error('Invalid fixture environment key');
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tsr-command-'));
  const socket = path.join(dir, 'rpc.sock');
  const worker = new Worker(new URL(import.meta.url), {
    workerData: { dir, socket, source: implementation.toString(), environmentKeys }
  });
  t.after(async () => {
    await worker.terminate();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => {
    worker.once('message', resolve);
    worker.once('error', reject);
    worker.once('exit', code => reject(Error(`Fixture command server exited before readiness (${code})`)));
  });
  // NUL framing preserves empty arguments, spaces, quotes and newlines. Read
  // the selected environment at each invocation, including shell exports.
  const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
  fs.writeFileSync(file, `#!/bin/sh
set -eu
dir=${quote(dir)}
status=$(printf '%s\\0' "$$" ${environmentKeys.map(key => `"\${${key}+x}" "\${${key}-}"`).join(' ')} "$@" |
  /usr/bin/curl --disable --silent --show-error --fail --noproxy '*' --unix-socket "$dir/rpc.sock" --data-binary @- http://localhost/)
case "$status" in ''|*[!0-9]*) echo 'Invalid fixture command status' >&2; exit 1;; esac
/bin/cat "$dir/$$.stdout"
/bin/cat "$dir/$$.stderr" >&2
exit "$status"
`, { mode: 0o700 });
  return { worker, dir };
}

if (!isMainThread && workerData?.source) {
  const { dir, socket, source, environmentKeys } = workerData;
  const require = createRequire(import.meta.url);
  const invoke = new Function('require', 'process', 'console', `(${source})();`);
  const exited = Symbol('fixture process exit');
  const server = http.createServer(async (req, res) => {
    try {
      const chunks = [];
      let bytes = 0;
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > 128 * 1024) throw Error('Fixture command request too large');
        chunks.push(chunk);
      }
      const fields = Buffer.concat(chunks).toString('utf8').split('\0');
      if (fields.pop() !== '' || fields.length < environmentKeys.length * 2 + 1) throw Error('Invalid command frame');
      const pid = fields.shift();
      if (!/^\d+$/.test(pid)) throw Error('Invalid command process id');
      const env = {};
      for (const key of environmentKeys) {
        const present = fields.shift(), value = fields.shift();
        if (present === 'x') env[key] = value;
        else if (present !== '') throw Error('Invalid command environment frame');
      }
      const processDouble = {
        argv: ['node', 'fixture-command', ...fields], env, exitCode: 0,
        exit(code = 0) { this.exitCode = code; throw exited; }
      };
      let stdout = '', stderr = '';
      try {
        invoke(require, processDouble, {
          log: (...args) => { stdout += format(...args) + '\n'; },
          error: (...args) => { stderr += format(...args) + '\n'; }
        });
      } catch (error) {
        if (error !== exited) {
          processDouble.exitCode = 1;
          stderr += String(error?.stack || error) + '\n';
        }
      }
      const status = processDouble.exitCode;
      if (!Number.isInteger(status) || status < 0 || status > 255) throw Error('Invalid command exit status');
      fs.writeFileSync(path.join(dir, `${pid}.stdout`), stdout);
      fs.writeFileSync(path.join(dir, `${pid}.stderr`), stderr);
      res.end(String(status));
    } catch (error) {
      res.writeHead(500);
      res.end(String(error));
    }
  });
  server.listen(socket, () => parentPort.postMessage('ready'));
}
