import type {DataAdapter} from 'obsidian';
import {DATA_FOLDER, DATA_ROOT} from './model';
import type {ThreadFiles} from './store';

const NOTE_NAME = /^note-[a-f0-9]{32}\.json$/u;

/** Dot folders are outside the Vault index; DataAdapter.process provides atomic updates. */
export class NoteFiles implements ThreadFiles {
  private preparing: Promise<void> | null = null;
  private temporaryFiles = new Set<string>();
  constructor(private adapter: DataAdapter, private ready: () => void = () => {}) {}

  private async prepare(): Promise<void> {
    if (this.preparing) return this.preparing;
    const operation = (async () => {
      const root = await this.adapter.stat(DATA_ROOT);
      if (root && root.type !== 'folder') throw new Error(`“${DATA_ROOT}”被同名文件占用，评论数据未修改。`);
      const current = await this.adapter.stat(DATA_FOLDER);
      if (current && current.type !== 'folder') throw new Error(`“${DATA_FOLDER}”被同名文件占用，评论数据未修改。`);
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
    return `${DATA_FOLDER}/${key}.json`;
  }

  async list(): Promise<string[]> {
    await this.prepare();
    if (!await this.adapter.exists(DATA_FOLDER)) return [];
    const {files} = await this.adapter.list(DATA_FOLDER);
    return files.filter(path => NOTE_NAME.test(path.slice(DATA_FOLDER.length + 1)))
      .map(path => path.slice(DATA_FOLDER.length + 1, -5));
  }

  async read(key: string): Promise<string> {
    const path = this.path(key);
    if (!await this.adapter.exists(path)) throw new Error('评论文件不存在。');
    return this.adapter.read(path);
  }

  async create(key: string, raw: string): Promise<void> {
    const path = this.path(key);
    await this.prepare();
    if (!await this.adapter.exists(DATA_ROOT)) await this.adapter.mkdir(DATA_ROOT);
    if (!await this.adapter.exists(DATA_FOLDER)) await this.adapter.mkdir(DATA_FOLDER);
    this.ready();
    // copy refuses an existing destination; a plain write would overwrite concurrent creation.
    const temporary = `${DATA_FOLDER}/.create-${crypto.randomUUID()}.tmp`;
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
