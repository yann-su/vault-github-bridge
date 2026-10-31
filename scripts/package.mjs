import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { zipSync } from 'fflate';

const manifest = JSON.parse(await readFile('manifest.json', 'utf8'));
const id = manifest.id, version = manifest.version;
const options = { level: 6, mtime: new Date('2020-01-01T00:00:00Z') };
await mkdir('release', { recursive: true });
const install = {};
for (const file of ['main.js', 'manifest.json', 'styles.css']) install[`${id}/${file}`] = new Uint8Array(await readFile(`dist/${file}`));
for (const file of ['README.md', 'TEST_REPORT.md', 'LICENSE', 'THIRD_PARTY_NOTICES.txt']) install[`${id}/${file}`] = new Uint8Array(await readFile(file));
await writeFile(`release/${id}-${version}.zip`, zipSync(install, options));
const source = {};
async function collect(path) {
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) await collect(child);
    else source[`${id}/${child.replaceAll('\\', '/')}`] = new Uint8Array(await readFile(child));
  }
}
for (const path of ['src', 'tests', 'scripts', '.github']) await collect(path);
for (const file of ['package.json', 'package-lock.json', 'tsconfig.json', 'esbuild.config.mjs', 'manifest.json', 'versions.json', 'styles.css', '.gitignore', 'README.md', 'RELEASE_NOTES.md', 'TEST_REPORT.md', 'CHANGELOG.md', 'LICENSE', 'THIRD_PARTY_NOTICES.txt']) {
  source[`${id}/${file}`] = new Uint8Array(await readFile(file));
}
await writeFile(`release/${id}-${version}-source.zip`, zipSync(source, options));
const checksums = [];
for (const file of [`${id}-${version}.zip`, `${id}-${version}-source.zip`]) {
  const bytes = await readFile(`release/${file}`);
  checksums.push(`${createHash('sha256').update(bytes).digest('hex')}  ${file}`);
  console.log(`${file}: ${bytes.length} bytes`);
}
await writeFile('release/SHA256SUMS.txt', checksums.join('\n') + '\n');
