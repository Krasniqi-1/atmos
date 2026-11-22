import { mkdir, copyFile, readFile, writeFile } from 'node:fs/promises';

const source = new URL('../dist/', import.meta.url);
const output = new URL('../.vercel/output/', import.meta.url);
const assets = new URL('static/', output);
await mkdir(assets, { recursive: true });
for (const file of ['app.js', 'styles.css', 'favicon.svg']) {
  await copyFile(new URL(file, source), new URL(file, assets));
}
const html = await readFile(new URL('index.html', source), 'utf8');
await writeFile(new URL('index.html', assets), html.replace('<html ', '<html data-hosted-demo '));
await writeFile(new URL('config.json', output), JSON.stringify({ version: 3, routes: [{ src: '^/$', dest: '/index.html' }] }));
