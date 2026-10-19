import type {DataAdapter} from 'obsidian';
import {DATA_FOLDER} from './model';
import {dataDirectory, directoryParents} from './data-directory';
import type {ThreadFiles} from './store';

const NOTE_NAME = /^note-[a-f0-9]{32}\.json$/u;

/** DataAdapter also supports hidden directories and atomic file updates. */
export class NoteFiles implements ThreadFiles {
  private preparing: Promise<void> | null = null;
  private temporaryFiles = new Set<string>();
  readonly directory: string;
  constructor(private adapter: DataAdapter, private ready: () => void = () => {}, directory = DATA_FOLDER) {
    this.directory = dataDirectory(directory);
  }

  private async prepare(): Promise<void> {
    if (this.preparing) return this.preparing;
    const operation = (async () => {
      for (const path of directoryParents(this.directory)) {
        const current = await this.adapter.stat(path);
        if (current && current.type !== 'folder') throw new Error(`“${path}”被同名文件占用，评论数据未修改。`);
      }
      const current = await this.adapter.stat(this.directory);
      if (current) this.ready();
      for (const path of this.temporaryFiles) if (await this.adapter.exists(path)) {
        await this.adapter.remove(path); this.temporaryFiles.delete(path);
      }
    })();
    this.preparing = operation;
    try { await operation; } finally { if (this.preparing === operation) this.preparing = null; }
  }

  private path(key: string): string {
    if (!/^note-[a-f0-9]{32}$/u.test(key)) throw new Error('评论文件标识无效。');
    return `${this.directory}/${key}.json`;
  }

  async list(): Promise<string[]> {
    await this.prepare();
    if (!await this.adapter.exists(this.directory)) return [];
    const {files} = await this.adapter.list(this.directory);
    return files.filter(path => path.startsWith(this.directory + '/') && NOTE_NAME.test(path.slice(this.directory.length + 1)))
      .map(path => path.slice(this.directory.length + 1, -5));
  }

  async read(key: string): Promise<string> {
    const path = this.path(key);
    if (!await this.adapter.exists(path)) throw new Error('评论文件不存在。');
    return this.adapter.read(path);
  }

  async create(key: string, raw: string): Promise<void> {
    const path = this.path(key);
    await this.prepare();
    for (const parent of directoryParents(this.directory)) if (!await this.adapter.exists(parent)) await this.adapter.mkdir(parent);
    this.ready();
    // copy refuses an existing destination; a plain write would overwrite concurrent creation.
    const temporary = `${this.directory}/.create-${crypto.randomUUID()}.tmp`;
    this.temporaryFiles.add(temporary);
    try {
      await this.adapter.write(temporary, raw);
      await this.adapter.copy(temporary, path);
    } finally {
      try {
        if (await this.adapter.exists(temporary)) await this.adapter.remove(temporary);
        this.temporaryFiles.delete(temporary);
      } catch { /* Keep the committed note successful; retry temporary cleanup on the next load. */ }
    }
  }

  async compareAndWrite(key: string, expected: string, next: string): Promise<void> {
    const path = this.path(key);
    if (!await this.adapter.exists(path)) throw new Error('评论文件已移动或删除，请重新加载数据。');
    await this.adapter.process(path, current => {
      if (current !== expected) throw new Error('评论文件已由其他窗口或同步工具修改。已停止保存，请重新加载后重试；输入草稿仍保留。');
      return next;
    });
  }
}
