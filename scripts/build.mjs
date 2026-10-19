import * as esbuild from 'esbuild';
const watch = process.argv.includes('--watch');
const options = {
  entryPoints: ['src/main.ts'], bundle: true, outfile: 'main.js',
  format: 'cjs', target: 'es2022', platform: 'browser',
  // Obsidian supplies a CommonJS loader. Lower guarded imports to deferred
  // require calls instead of browser requests for the Electron/Node specifier.
  supported: {'dynamic-import': false},
  external: ['obsidian', 'electron', 'node:fs', '@codemirror/state', '@codemirror/view'],
  sourcemap: watch ? 'inline' : false,
  minify: !watch, logLevel: 'info',
  banner: {js: '/* Highnote | MIT License | Source available in the plugin repository. */'}
};
if (watch) {
  const context = await esbuild.context(options);
  await context.watch();
} else {
  await esbuild.build(options);
}
