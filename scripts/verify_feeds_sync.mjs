import { readFileSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const sourcePath = path.join(root, 'data', 'feeds.json');
const targets = [
  path.join(root, 'public', 'data', 'feeds.json'),
  path.join(root, 'gcp', 'feed-proxy', 'feeds.json'),
  path.join(root, 'gcp', 'mcp-proxy', 'feeds.json')
];

const errors = [];
let sourceRaw;
try {
  sourceRaw = readFileSync(sourcePath, 'utf8');
} catch (error) {
  console.error(`Unable to read ${sourcePath}:`, error.message);
  process.exit(1);
}

const normalize = (raw) => JSON.stringify(JSON.parse(raw));
let sourceNormalized;
try {
  sourceNormalized = normalize(sourceRaw);
} catch (error) {
  console.error(`Failed to parse ${sourcePath}:`, error.message);
  process.exit(1);
}

targets.forEach((targetPath) => {
  try {
    const targetRaw = readFileSync(targetPath, 'utf8');
    const targetNormalized = normalize(targetRaw);
    if (targetNormalized !== sourceNormalized) {
      errors.push(`${targetPath} does not match data/feeds.json`);
    }
  } catch (error) {
    errors.push(`${targetPath} error: ${error.message}`);
  }
});

if (errors.length) {
  console.error('Feed registry parity check failed:');
  errors.forEach((err) => console.error(`- ${err}`));
  process.exit(1);
}

console.log('Feed registry parity check passed.');
