import {readFile, stat} from 'node:fs/promises';
import {resolve, dirname, relative} from 'node:path';
import ts from 'typescript';

const root = resolve('.');
const missing = new Set();
const visited = new Set();
async function exists(path) {
  try { return (await stat(path)).isFile(); } catch { return false; }
}
async function visit(path) {
  if (visited.has(path)) return;
  visited.add(path);
  if (!await exists(path)) { missing.add(relative(root, path)); return; }
  const source = await readFile(path, 'utf8');
  for (const dependency of ts.preProcessFile(source, true, true).importedFiles) {
    if (!dependency.fileName.startsWith('.')) continue;
    const target = resolve(dirname(path), dependency.fileName);
    const candidates = [target, target + '.ts', target + '.tsx', resolve(target, 'index.ts')];
    let found;
    for (const candidate of candidates) if (await exists(candidate)) { found = candidate; break; }
    if (found) await visit(found);
    else missing.add(`${relative(root, path)} → ${dependency.fileName}`);
  }
}
await visit(resolve(root, 'src/main.ts'));
await visit(resolve(root, 'src/settings.ts'));
for (const name of ['scripts/build.mjs', 'scripts/package.mjs', 'scripts/install.mjs',
  'manifest.json', 'styles.css', 'tsconfig.json', 'versions.json']) {
  if (!await exists(resolve(root, name))) missing.add(name);
}
if (missing.size) {
  console.error('源码不完整，请复制完整源码包到仓库根目录。缺少：\n' + [...missing].sort().join('\n'));
  process.exitCode = 1;
} else console.log('源码完整性检查通过。');
