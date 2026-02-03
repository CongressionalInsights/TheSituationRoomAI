import fs from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const sourcePath = path.join(root, 'data', 'feeds.json');

const targets = [
  path.join(root, 'public', 'data', 'feeds.json'),
  path.join(root, 'gcp', 'feed-proxy', 'feeds.json'),
  path.join(root, 'gcp', 'mcp-proxy', 'feeds.json')
];

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function dirExists(dirPath) {
  try {
    const stat = await fs.stat(dirPath);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

async function run() {
  const raw = await fs.readFile(sourcePath, 'utf8');
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    console.error('Failed to parse data/feeds.json:', error.message);
    process.exit(1);
  }

  const output = `${JSON.stringify(parsed, null, 2)}\n`;

  for (const target of targets) {
    const dir = path.dirname(target);
    if (!(await dirExists(dir))) {
      console.error(`Missing directory for target: ${dir}`);
      process.exit(1);
    }
    await fs.writeFile(target, output, 'utf8');
  }

  const workerTarget = path.join(root, 'worker', 'feeds.json');
  if (await fileExists(workerTarget)) {
    await fs.writeFile(workerTarget, output, 'utf8');
  }

  console.log(`Synced feeds.json to ${targets.length} targets.`);
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
