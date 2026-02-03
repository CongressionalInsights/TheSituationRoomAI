import { build, context } from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import crypto from 'node:crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, '..');

const entry = path.join(root, 'public', 'app.js');
const outfile = path.join(root, 'public', 'app.bundle.js');
const assetsDir = path.join(root, 'public', 'assets');
const stylesPath = path.join(root, 'public', 'styles.css');
const manifestPath = path.join(assetsDir, 'manifest.json');
const watch = process.argv.includes('--watch');

const options = {
  entryPoints: [entry],
  outfile,
  bundle: true,
  format: 'esm',
  sourcemap: watch,
  minify: !watch,
  target: ['es2020'],
  logLevel: 'info'
};

const hashFile = (content) => crypto.createHash('sha256').update(content).digest('hex').slice(0, 12);

if (watch) {
  const ctx = await context(options);
  await ctx.watch();
  console.log('Watching frontend bundle...');
} else {
  await build(options);

  fs.mkdirSync(assetsDir, { recursive: true });

  const bundleContent = fs.readFileSync(outfile);
  const bundleHash = hashFile(bundleContent);
  const bundleName = `app.bundle.${bundleHash}.js`;
  const bundleTarget = path.join(assetsDir, bundleName);
  fs.writeFileSync(bundleTarget, bundleContent);

  let stylesHash = '';
  let stylesName = '';
  if (fs.existsSync(stylesPath)) {
    const stylesContent = fs.readFileSync(stylesPath);
    stylesHash = hashFile(stylesContent);
    stylesName = `styles.${stylesHash}.css`;
    fs.writeFileSync(path.join(assetsDir, stylesName), stylesContent);
  }

  const manifest = {
    'app.bundle.js': `assets/${bundleName}`,
    ...(stylesName ? { 'styles.css': `assets/${stylesName}` } : {})
  };
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  console.log('Frontend bundle generated.');
}
