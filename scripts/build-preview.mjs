import { build } from 'esbuild';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

await import('./build-demo.mjs');
const output = new URL('../.vercel/output/', import.meta.url);
const handler = new URL('functions/api/v1/preview.func/', output);
await mkdir(handler, { recursive: true });
await build({
  entryPoints: [fileURLToPath(new URL('../hosted/preview.mjs', import.meta.url))],
  outfile: fileURLToPath(new URL('index.cjs', handler)),
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  footer: { js: 'module.exports = module.exports.default;' },
});
await writeFile(new URL('.vc-config.json', handler), JSON.stringify({
  runtime: 'nodejs22.x',
  handler: 'index.cjs',
  launcherType: 'Nodejs',
}));
await writeFile(new URL('config.json', output), JSON.stringify({
  version: 3,
  routes: [
    { src: '^/api/v1/(.*)$', dest: '/api/v1/preview' },
    { src: '^/$', dest: '/index.html' },
  ],
}));
