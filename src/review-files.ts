import type {DataAdapter} from 'obsidian';
import {DATA_FOLDER} from './model';
import {NoteFiles} from './note-files';
import type {ThreadFiles} from './store';

/** Mobile review never creates, repairs, renames or rewrites annotation data. */
export class ReviewFiles implements ThreadFiles {
  private files: NoteFiles;
  private cache = new Map<string, {stamp: string; raw: string}>();
  constructor(private adapter: DataAdapter, directory = DATA_FOLDER) { this.files = new NoteFiles(adapter, undefined, directory); }
  invalidate(): void { this.cache.clear(); }
  async list(): Promise<string[]> {
    const keys = await this.files.list();
    const present = new Set(keys);
    for (const key of this.cache.keys()) if (!present.has(key)) this.cache.delete(key);
    return keys;
  }
  async read(key: string): Promise<string> {
    if (!/^note-[a-f0-9]{32}$/u.test(key)) throw new Error('评论文件标识无效。');
    const path = `${this.files.directory}/${key}.json`;
    const stamp = async () => {
      const stat = await this.adapter.stat(path);
      return stat?.type === 'file' && Number.isFinite(stat.mtime) && Number.isFinite(stat.size)
        ? `${stat.ctime}:${stat.mtime}:${stat.size}` : null;
    };
    const before = await stamp(), cached = this.cache.get(key);
    if (before !== null && cached?.stamp === before) return cached.raw;
    const raw = await this.files.read(key);
    // A sync can replace the file while it is being read; never cache that
    // intermediate revision under the newer file's metadata.
    if (before !== null && before === await stamp()) this.cache.set(key, {stamp: before, raw});
    else this.cache.delete(key);
    return raw;
  }
  create(): Promise<void> { return Promise.reject(new Error('手机版仅支持阅读回顾，不能修改批注。')); }
  compareAndWrite(): Promise<void> { return this.create(); }
}
