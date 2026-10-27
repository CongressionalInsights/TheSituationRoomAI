import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { sha256 } from '../gcp/feed-proxy/build-identity.js';

export function buildFeedManifest(root, sourceSha) {
  if (!/^[a-f0-9]{40}$/.test(sourceSha)) throw Error('Exact source SHA required');
  const files = fs.readdirSync(root, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name !== 'build-manifest.json')
    .map(entry => ({ path: entry.name, sha256: sha256(fs.readFileSync(path.join(root, entry.name))) }))
    .sort((a, b) => a.path.localeCompare(b.path, 'en'));
  if (!files.some(file => file.path === 'server.js') || !files.some(file => file.path === 'feeds.json')) throw Error('Incomplete source');
  return { schema: 'tsr-feed-build/v1', sourceSha, files, contentSha256: sha256(JSON.stringify(files)) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const sourceSha = process.argv[2];
  if (execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() !== sourceSha) throw Error('Checkout SHA mismatch');
  const root = path.resolve('gcp/feed-proxy');
  fs.writeFileSync(path.join(root, 'build-manifest.json'), JSON.stringify(buildFeedManifest(root, sourceSha), null, 2));
}
