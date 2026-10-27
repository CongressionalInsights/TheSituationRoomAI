import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

export function readBuildIdentity(root, env = process.env) {
  try {
    const manifest = JSON.parse(readFileSync(join(root, 'build-manifest.json')));
    if (manifest.schema !== 'tsr-feed-build/v1' || !/^[a-f0-9]{40}$/.test(manifest.sourceSha)
      || !Array.isArray(manifest.files) || !manifest.files.length
      || new Set(manifest.files.map(file => file.path)).size !== manifest.files.length) throw Error('Invalid manifest');
    const actual = manifest.files.map(file => {
      if (!/^[a-zA-Z0-9_.-]+$/.test(file.path) || file.path === 'build-manifest.json') throw Error('Invalid path');
      return { path: file.path, sha256: sha256(readFileSync(join(root, file.path))) };
    });
    const contentSha256 = sha256(JSON.stringify(actual));
    if (JSON.stringify(actual) !== JSON.stringify(manifest.files) || contentSha256 !== manifest.contentSha256) throw Error('Source bytes differ');
    return { available: true, schema: manifest.schema, sourceSha: manifest.sourceSha, contentSha256,
      service: env.K_SERVICE || null, revision: env.K_REVISION || null };
  } catch {
    return { available: false, error: 'build_identity_unverified' };
  }
}
