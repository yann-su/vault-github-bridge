import { build } from 'esbuild';
import { mkdir, copyFile } from 'node:fs/promises';
await mkdir('dist', { recursive: true });
await build({
  entryPoints: ['src/main.ts'], bundle: true, external: ['obsidian', 'node:*'],
  platform: 'browser', format: 'cjs', target: 'es2022', outfile: 'dist/main.js',
  sourcemap: false, minify: false, banner: { js: '/* Vault GitHub Bridge — MIT License */' }
});
for (const file of ['manifest.json', 'styles.css']) await copyFile(file, `dist/${file}`);
