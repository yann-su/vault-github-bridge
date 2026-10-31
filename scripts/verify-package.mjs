import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { unzipSync } from 'fflate';

const manifest = JSON.parse(await readFile('manifest.json', 'utf8'));
const prefix = `${manifest.id}/`, basename = `${manifest.id}-${manifest.version}`;
const sums = await readFile('release/SHA256SUMS.txt', 'utf8');
for (const name of [`${basename}.zip`, `${basename}-source.zip`]) {
  const bytes = await readFile(`release/${name}`);
  const hash = createHash('sha256').update(bytes).digest('hex');
  assert.ok(sums.includes(`${hash}  ${name}`));
  const files = unzipSync(bytes);
  for (const path of Object.keys(files)) assert.ok(path.startsWith(prefix) && !path.includes('../') && !path.includes('node_modules/'));
  const packaged = JSON.parse(new TextDecoder().decode(files[`${prefix}manifest.json`]));
  assert.equal(packaged.version, manifest.version);
  assert.equal(packaged.isDesktopOnly, false);
  if (name === `${basename}.zip`) {
    for (const asset of ['main.js', 'manifest.json', 'styles.css']) assert.deepEqual(Buffer.from(files[prefix + asset]), await readFile(`dist/${asset}`));
    for (const doc of ['README.md', 'TEST_REPORT.md', 'LICENSE', 'THIRD_PARTY_NOTICES.txt']) assert.ok(files[prefix + doc]);
    assert.ok(!Object.keys(files).some(path => /data\.json|state-\d\.json|\/objects\//.test(path)));
  }
  console.log(`${name}: manifest, files and SHA-256 verified (${Object.keys(files).length} entries).`);
}
