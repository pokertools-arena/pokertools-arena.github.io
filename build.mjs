import { build } from 'esbuild';
import { mkdir, readFile, writeFile, copyFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Repository root (this file lives at the root).
const root = dirname(fileURLToPath(import.meta.url));
const src = join(root, 'src');
const dist = join(root, 'dist');
const { version } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
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
  loader: { '.mp3': 'dataurl' },
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
const htmlTemplate = await readFile(join(src, 'index.html'), 'utf8');
const html = htmlTemplate.replaceAll('__VERSION__', version);
if (html.includes('__VERSION__')) throw new Error('Build did not replace every version placeholder');
await writeFile(join(dist, 'index.html'), html);

const css = await readFile(join(dist, 'styles.css'), 'utf8');
const js = await readFile(join(dist, 'app.js'), 'utf8');
const envBootstrap = await readFile(join(dist, 'arena-env.js'), 'utf8');
let single = html;
// Match the asset references with an optional cache-busting query string
// (`./app.js?v=0.6.0`), so adding a version never silently breaks inlining.
const inlineAsset = (source, pattern, replacement) => {
  if (!pattern.test(source)) throw new Error(`Single-file build could not inline ${pattern}`);
  return source.replace(pattern, () => replacement);
};
single = inlineAsset(single, /<link rel="stylesheet" href="\.\/styles\.css(?:\?[^"]*)?"\s*\/>/, `<style>\n${css}\n</style>`);
single = inlineAsset(single, /<script src="\.\/arena-env\.js(?:\?[^"]*)?"\s*><\/script>/, `<script>\n${envBootstrap}\n</script>`);
single = inlineAsset(single, /<script type="module" src="\.\/app\.js(?:\?[^"]*)?"\s*><\/script>/, `<script type="module">\n${js}\n</script>`);
await writeFile(join(dist, 'pokertools-arena.html'), single);
// Keep a convenient root copy for repository downloads; it is generated.
await writeFile(join(root, 'pokertools-arena.html'), single);
console.log('Built dist/ with @pokertools/engine bundled locally.');
