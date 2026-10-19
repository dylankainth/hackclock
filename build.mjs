// Bundles the app into dist/: one self-contained index.html (JS, CSS and fonts
// inlined) plus the service worker, manifest and icons.
import { build } from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';

const root = new URL('./', import.meta.url).pathname;
const dist = root + 'dist/';
rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

const result = await build({
  entryPoints: [root + 'src/app.js'],
  bundle: true,
  minify: true,
  format: 'iife',
  target: 'es2020',
  write: false,
  legalComments: 'none',
});
const js = result.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');

const font = (weight) => {
  const b64 = readFileSync(root + `node_modules/@fontsource/barlow-semi-condensed/files/barlow-semi-condensed-latin-${weight}-normal.woff2`).toString('base64');
  return `@font-face{font-family:"Barlow Semi Condensed";font-style:normal;font-weight:${weight};font-display:swap;src:url(data:font/woff2;base64,${b64}) format("woff2")}`;
};
const css = readFileSync(root + 'src/styles.css', 'utf8').replace('/*__FONTS__*/', [500, 600, 700].map(font).join('\n'));

let html = readFileSync(root + 'src/index.html', 'utf8');
html = html.replace('<!--STYLE-->', () => `<style>${css}</style>`).replace('<!--SCRIPT-->', () => `<script>${js}</script>`);
writeFileSync(dist + 'index.html', html);

const hash = createHash('sha1').update(html).digest('hex').slice(0, 10);
writeFileSync(dist + 'sw.js', readFileSync(root + 'src/sw.js', 'utf8').replace('__BUILD__', hash));
copyFileSync(root + 'src/manifest.webmanifest', dist + 'manifest.webmanifest');
for (const f of ['icon.svg', 'icon-192.png', 'icon-512.png', 'icon-512-maskable.png', 'apple-touch-icon.png']) {
  copyFileSync(root + 'src/assets/' + f, dist + f);
}
console.log(`built dist/ (index.html ${(html.length / 1024).toFixed(0)} KB, build ${hash})`);
