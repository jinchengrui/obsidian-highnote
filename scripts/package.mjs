import {readFile, mkdir, copyFile} from 'node:fs/promises';
const manifest = JSON.parse(await readFile('manifest.json', 'utf8'));
const pkg = JSON.parse(await readFile('package.json', 'utf8'));
if (manifest.version !== pkg.version) throw new Error('Version mismatch');
const target = `dist/${manifest.id}`;
await mkdir(target, {recursive: true});
for (const file of ['main.js', 'manifest.json', 'styles.css']) {
  await copyFile(file, `${target}/${file}`);
}
console.log(`Prepared ${target}`);
