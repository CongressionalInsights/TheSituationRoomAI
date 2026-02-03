import { build, context } from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, '..');

const entry = path.join(root, 'public', 'app.js');
const outfile = path.join(root, 'public', 'app.bundle.js');
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

if (watch) {
  const ctx = await context(options);
  await ctx.watch();
  console.log('Watching frontend bundle...');
} else {
  await build(options);
  console.log('Frontend bundle generated.');
}
