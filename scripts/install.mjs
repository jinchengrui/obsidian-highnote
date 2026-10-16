import {access, copyFile, mkdir, realpath} from 'node:fs/promises';
import path from 'node:path';
const [vaultArg, configArg = '.obsidian'] = process.argv.slice(2);
if (!vaultArg || path.isAbsolute(configArg) || configArg.split(/[\\/]/u).includes('..')) {
  throw new Error('Usage: npm run install:local -- /absolute/path/to/test-vault [config-directory]');
}
const vault = await realpath(vaultArg);
const config = path.join(vault, configArg);
await access(config);
const resolvedConfig = await realpath(config);
if (path.relative(vault, resolvedConfig).startsWith('..')) throw new Error('Configuration must stay inside the vault');
const target = path.join(config, 'plugins', 'highnote');
await mkdir(target, {recursive: true});
const resolvedTarget = await realpath(target);
if (path.relative(vault, resolvedTarget).startsWith('..')) throw new Error('Plugin directory must stay inside the vault');
for (const file of ['main.js', 'manifest.json', 'styles.css']) await copyFile(file, path.join(target, file));
console.log('Copied the three plugin files. Disable and enable Highnote in the test vault to reload.');
