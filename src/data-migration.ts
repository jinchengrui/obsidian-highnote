import type {DataAdapter} from 'obsidian';
import {annotationDirectory, directoryParents} from './data-directory';
import {NoteFiles} from './note-files';
import {noteKey, parseNote} from './store';

export interface MigrationProgress {phase: 'checking' | 'copying' | 'verifying'; completed: number; total: number}
export interface MigrationResult {copied: number; skipped: number; total: number; directory: string}
interface Entry {key: string; path: string; digest: string}

/** Copies raw JSON sequentially, retaining only fingerprints and IDs in memory.
 * Source files are never removed. Interrupted copies can be retried safely. */
export async function migrateAnnotations(adapter: DataAdapter, sourceValue: string, targetValue: string,
  options: {configDirectory: string; checkActive?: () => void; progress?: (progress: MigrationProgress) => void; yieldToUi?: () => Promise<void>}
): Promise<MigrationResult & {verify: () => Promise<void>}> {
  const source = annotationDirectory(sourceValue, options.configDirectory);
  const target = annotationDirectory(targetValue, options.configDirectory);
  const left = source.normalize('NFC').toLowerCase(), right = target.normalize('NFC').toLowerCase();
  if (left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`)) {
    throw new Error('源目录和目标目录必须不同，且不能互相包含。');
  }
  const check = () => options.checkActive?.();
  const progress = async (phase: MigrationProgress['phase'], completed: number, total: number) => {
    check();
    // Keep the settings responsive without rendering once per record.
    if (completed === 0 || completed === total || completed % 25 === 0) {
      options.progress?.({phase, completed, total});
      await options.yieldToUi?.();
      check();
    }
  };
  const scan = async (directory: string): Promise<string[]> => {
    check();
    for (const parent of directoryParents(directory)) {
      const info = await adapter.stat(parent);
      if (info && info.type !== 'folder') throw new Error(`“${parent}”被同名文件占用。`);
    }
    if (!await adapter.exists(directory)) return [];
    const {files} = await adapter.list(directory);
    return files.filter(path => {
      if (!path.startsWith(`${directory}/`)) return false;
      const name = path.slice(directory.length + 1);
      if (name.includes('/')) return false;
      if (/^note-.*\.json$/iu.test(name) && !/^note-[a-f0-9]{32}\.json$/u.test(name)) {
        throw new Error(`批注文件名不受支持：${path}。请先检查该文件。`);
      }
      return /^note-[a-f0-9]{32}\.json$/u.test(name);
    }).sort();
  };
  const sourcePaths = async () => [...await scan(source), ...await scan(`${source}/annotations`)].sort();
  const digest = async (raw: string) => {
    const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw));
    return [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2, '0')).join('');
  };
  const ids = new Map<string, string>();
  const inspect = async (path: string): Promise<Entry> => {
    check();
    try {
      const raw = await adapter.read(path), data = parseNote(raw);
      const key = path.slice(path.lastIndexOf('/') + 1, -5);
      if (key !== await noteKey(data.filePath)) throw new Error('文件名与笔记路径不匹配');
      for (const item of [...data.threads, ...data.highlights]) {
        const owner = ids.get(item.id);
        if (owner && owner !== key) throw new Error('存在重复的批注标识');
        ids.set(item.id, key);
      }
      return {key, path, digest: await digest(raw)};
    } catch (error) {
      throw new Error(`无法迁移“${path}”：${error instanceof Error ? error.message : '文件无法读取'}。`);
    }
  };
  await progress('checking', 0, 0);
  const paths = await sourcePaths();
  if (!paths.length) throw new Error('源目录及其 annotations 子目录中没有找到批注 JSON，请检查源目录。');
  const targets = await scan(target), sources: Entry[] = [], unique = new Map<string, Entry>();
  const expected = new Map<string, string>();
  for (const path of paths) {
    const entry = await inspect(path), previous = unique.get(entry.key);
    if (previous && previous.digest !== entry.digest) throw new Error(`源目录中有同名不同内容的批注：${entry.key}.json。未复制任何文件。`);
    sources.push(entry); unique.set(entry.key, entry);
    await progress('checking', sources.length, paths.length + targets.length);
  }
  for (const path of targets) {
    const entry = await inspect(path), from = unique.get(entry.key);
    if (from && from.digest !== entry.digest) throw new Error(`目标已有不同内容的批注：${entry.key}.json。未覆盖，请选择空目录或先处理冲突。`);
    expected.set(entry.key, entry.digest);
    await progress('checking', paths.length + expected.size, paths.length + targets.length);
  }
  const unchanged = async (path: string, fingerprint: string) => {
    check();
    if (await digest(await adapter.read(path)) !== fingerprint) {
      throw new Error(`迁移期间文件发生变化：${path}。目录未切换，请等待同步完成后重试。`);
    }
  };
  const files = new NoteFiles(adapter, undefined, target);
  let copied = 0, skipped = 0;
  await progress('copying', 0, unique.size);
  for (const entry of unique.values()) {
    check();
    const raw = await adapter.read(entry.path);
    if (await digest(raw) !== entry.digest) throw new Error(`源文件发生变化：${entry.path}。请等待同步完成后重试。`);
    check();
    if (expected.has(entry.key)) skipped++;
    else {
      // Exclusive creation also protects against files arriving via sync after preflight.
      await files.create(entry.key, raw); copied++;
      expected.set(entry.key, entry.digest);
    }
    await unchanged(`${target}/${entry.key}.json`, entry.digest);
    await progress('copying', copied + skipped, unique.size);
  }
  const verify = async () => {
    await progress('verifying', 0, sources.length + expected.size);
    const current = await sourcePaths(), currentTarget = await scan(target);
    if (current.length !== paths.length || current.some((path, i) => path !== paths[i])
      || currentTarget.length !== expected.size || currentTarget.some(path => !expected.has(path.slice(path.lastIndexOf('/') + 1, -5)))) {
      throw new Error('迁移期间目录内容发生变化。目录未切换，请等待同步完成后重试。');
    }
    let completed = 0;
    for (const entry of sources) {
      await unchanged(entry.path, entry.digest);
      await progress('verifying', ++completed, sources.length + expected.size);
    }
    for (const [key, fingerprint] of expected) {
      await unchanged(`${target}/${key}.json`, fingerprint);
      await progress('verifying', ++completed, sources.length + expected.size);
    }
    check();
  };
  return {copied, skipped, total: unique.size, directory: target, verify};
}
