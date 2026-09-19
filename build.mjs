import { build } from 'esbuild';
import { mkdir, readFile, writeFile, copyFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Repository root (this file lives at the root).
const root = dirname(fileURLToPath(import.meta.url));
const src = join(root, 'src');
const dist = join(root, 'dist');
await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

const browserCryptoShim = join(src, 'shims', 'crypto.cjs');
const browserBuiltinsPlugin = {
  name: 'browser-builtins',
  setup(build) {
    // @pokertools/engine/browser currently re-exports code that contains a
    // static require("crypto") in a Node-only fallback. Resolve it to a Web
    // Crypto shim so platform:'browser' can bundle the official browser entry.
    build.onResolve({ filter: /^(?:node:)?crypto$/ }, () => ({ path: browserCryptoShim }));
  },
};

await build({
  entryPoints: [join(src, 'app.js')],
  outfile: join(dist, 'app.js'),
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: ['es2022'],
  minify: false,
  sourcemap: false,
  legalComments: 'eof',
  plugins: [browserBuiltinsPlugin],
  define: {
    'process.env.NODE_ENV': '"production"',
  },
});

await copyFile(join(src, 'styles.css'), join(dist, 'styles.css'));
await copyFile(join(root, '.nojekyll'), join(dist, '.nojekyll'));
await copyFile(join(src, 'assets', 'favicon.svg'), join(dist, 'favicon.svg'));
await copyFile(join(src, 'assets', 'og-image.png'), join(dist, 'og-image.png'));
await copyFile(join(src, 'assets', 'og-image.svg'), join(dist, 'og-image.svg'));
await copyFile(join(src, 'env', 'arena-env.js'), join(dist, 'arena-env.js'));
const html = await readFile(join(src, 'index.html'), 'utf8');
await writeFile(join(dist, 'index.html'), html);

const css = await readFile(join(dist, 'styles.css'), 'utf8');
const js = await readFile(join(dist, 'app.js'), 'utf8');
const envBootstrap = await readFile(join(dist, 'arena-env.js'), 'utf8');
let single = html;
single = single.replace('<link rel="stylesheet" href="./styles.css" />', () => `<style>\n${css}\n</style>`);
single = single.replace('<script src="./arena-env.js"></script>', () => `<script>\n${envBootstrap}\n</script>`);
single = single.replace('<script type="module" src="./app.js"></script>', () => `<script type="module">\n${js}\n</script>`);
await writeFile(join(dist, 'pokertools-arena.html'), single);
// Keep a convenient root copy for repository downloads; it is generated.
await writeFile(join(root, 'pokertools-arena.html'), single);
console.log('Built dist/ with @pokertools/engine bundled locally.');
