import { makeAnchor } from './anchors';
import { checkBody, deleteMessage, parseHighlight, parseThread, validNotePath, type Highlight, type Thread } from './model';

interface NoteThreads {
  schemaVersion: 2;
  filePath: string;
  revision: number;
  threads: Thread[];
  highlights: Highlight[];
}

interface StoredNote {
  key: string;
  raw: string;
  data: NoteThreads;
}

export interface ThreadFiles {
  list(): Promise<string[]>;
  read(key: string): Promise<string>;
  create(key: string, raw: string): Promise<void>;
  compareAndWrite(key: string, expected: string, next: string): Promise<void>;
}

export function parseNote(raw: string): NoteThreads {
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('评论数据格式不受支持；原文件已保留。');
  const note = value as Record<string, unknown>;
  if (note.schemaVersion !== 2 || typeof note.filePath !== 'string' || !validNotePath(note.filePath)
    || !Number.isSafeInteger(note.revision) || Number(note.revision) < 1 || !Array.isArray(note.threads)
    || ('highlights' in note && !Array.isArray(note.highlights))) {
    throw new Error('评论数据格式不受支持；原文件已保留。');
  }
  const ids = new Set<string>();
  const threads = note.threads.map((item: unknown) => {
    const thread = parseThread(JSON.stringify(item));
    if (thread.filePath !== note.filePath || ids.has(thread.id)) throw new Error('评论归属或标识冲突；原文件已保留。');
    ids.add(thread.id);
    return thread;
  });
  const highlights = ((note.highlights ?? []) as unknown[]).map(item => {
    const highlight = parseHighlight(JSON.stringify(item));
    if (highlight.filePath !== note.filePath || ids.has(highlight.id)) throw new Error('标记归属或标识冲突；原文件已保留。');
    ids.add(highlight.id);
    return highlight;
  });
  return {...note, schemaVersion: 2, filePath: note.filePath, revision: Number(note.revision), threads, highlights};
}

export async function noteKey(path: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(path));
  return `note-${[...new Uint8Array(digest).slice(0, 16)].map(byte => byte.toString(16).padStart(2, '0')).join('')}`;
}

export class ThreadStore {
  version = 0;
  private threads = new Map<string, Thread>();
  private byFile = new Map<string, Set<string>>();
  private highlights = new Map<string, Highlight>();
  private highlightsByFile = new Map<string, Set<string>>();
  private notes = new Map<string, StoredNote>();
  private parsedNotes = new Map<string, StoredNote>();
  private pendingMoves = new Map<string, {newPath: string; oldRaw: string; newRaw: string; emptyRaw: string}>();
  private fileExists?: (path: string) => boolean;
  private invalidKeys = new Set<string>();
  private tail: Promise<unknown> = Promise.resolve();
  constructor(private files: ThreadFiles, private changed: () => void, private error: (error: unknown) => void) {}

  all(): Thread[] { return [...this.threads.values()].map(t => structuredClone(t)); }
  viewAll(): readonly Thread[] { return [...this.threads.values()]; }
  viewFile(path: string): readonly Thread[] { return [...(this.byFile.get(path) ?? [])].map(id => this.threads.get(id)!); }
  paths(): string[] { return [...new Set([...this.byFile.keys(), ...this.highlightsByFile.keys()])]; }
  pathOf(id: string): string | undefined { return this.threads.get(id)?.filePath; }
  get(id: string): Thread | undefined {
    const thread = this.threads.get(id);
    return thread ? structuredClone(thread) : undefined;
  }
  forFile(path: string): Thread[] {
    return [...(this.byFile.get(path) ?? [])].map(id => structuredClone(this.threads.get(id)!));
  }

  viewHighlights(path?: string): readonly Highlight[] {
    return path === undefined ? [...this.highlights.values()]
      : [...(this.highlightsByFile.get(path) ?? [])].map(id => this.highlights.get(id)!);
  }
  allHighlights(): Highlight[] { return [...this.highlights.values()].map(highlight => structuredClone(highlight)); }
  fileHighlights(path: string): Highlight[] {
    return [...(this.highlightsByFile.get(path) ?? [])].map(id => structuredClone(this.highlights.get(id)!));
  }
  getHighlight(id: string): Highlight | undefined {
    const highlight = this.highlights.get(id);
    return highlight ? structuredClone(highlight) : undefined;
  }
  highlightPaths(): string[] { return [...this.highlightsByFile.keys()]; }

  async load(fileExists?: (path: string) => boolean): Promise<void> {
    await this.run(async () => {
      const keys = await this.files.list();
      const previousByKey = new Map([...this.parsedNotes, ...[...this.notes.values()].map(note => [note.key, note] as const)]);
      const notes = new Map<string, StoredNote>();
      const invalidKeys = new Set<string>();
      for (const key of keys) {
        try {
          const raw = await this.files.read(key);
          const previous = previousByKey.get(key);
          if (previous?.raw === raw) { notes.set(previous.data.filePath, previous); continue; }
          const data = parseNote(raw);
          if (await noteKey(data.filePath) !== key || notes.has(data.filePath)) throw new Error('评论文件名或路径冲突；原文件已保留。');
          notes.set(data.filePath, {key, raw, data});
        } catch (error) { invalidKeys.add(key); this.error(error); }
      }
      this.parsedNotes = new Map([...notes.values()].map(note => [note.key, note]));
      if (!fileExists && !this.pendingMoves.size) {
        for (const [path, note] of notes) if (!note.data.threads.length && !note.data.highlights.length) notes.delete(path);
      }
      const unchanged = notes.size === this.notes.size && [...notes].every(([path, note]) => this.notes.get(path) === note)
        && invalidKeys.size === this.invalidKeys.size && [...invalidKeys].every(key => this.invalidKeys.has(key));
      if (unchanged && !fileExists && !this.pendingMoves.size) return;
      this.notes = notes;
      this.invalidKeys = invalidKeys;
      this.fileExists = fileExists;
      for (const [oldPath, pending] of this.pendingMoves) {
        try {
          const old = notes.get(oldPath);
          const next = notes.get(pending.newPath);
          if (!old || !next) throw new Error('待恢复的迁移数据缺失或无效，已保留可读取的原数据。');
          await this.finishMove(oldPath, pending.newPath, old, next);
        } catch (error) { this.error(error); }
      }
      // A pending raw conflict must not fall back to recognizing a fresh migration pair.
      const pendingPaths = new Set([...this.pendingMoves].flatMap(([oldPath, pending]) => [oldPath, pending.newPath]));
      if (fileExists) {
        const candidates = new Map<string, StoredNote[]>();
        for (const [path, note] of notes) {
          if (pendingPaths.has(path) || fileExists(path) !== true) continue;
          for (const record of [...note.data.threads, ...note.data.highlights]) {
            const matching = candidates.get(record.id) ?? [];
            matching.push(note);
            candidates.set(record.id, matching);
          }
        }
        for (const [oldPath, old] of notes) {
          if (pendingPaths.has(oldPath) || fileExists(oldPath) !== false) continue;
          const id = old.data.threads[0]?.id ?? old.data.highlights[0]?.id;
          if (!id) continue;
          for (const next of candidates.get(id) ?? []) {
            const newPath = next.data.filePath;
            if (pendingPaths.has(newPath) || !sameMovedNote(old.data, next.data)) continue;
            try { await this.finishMove(oldPath, newPath, old, next); }
            catch (error) {
              this.error(error);
              pendingPaths.add(oldPath);
              pendingPaths.add(newPath);
            }
            break;
          }
        }
      }
      // Empty files remain on disk for atomic reuse, but need no record cache or migration.
      for (const [path, note] of notes) if (!note.data.threads.length && !note.data.highlights.length
        && !this.pendingMoves.has(path)) notes.delete(path);
      this.reindex();
      this.publish();
    });
  }

  create(filePath: string, source: string, from: number, to: number, body: string, beforeEdit?: () => void): Promise<Thread> {
    return this.run(async () => {
      beforeEdit?.();
      const now = new Date().toISOString();
      const thread: Thread = {schemaVersion: 1, id: crypto.randomUUID(), revision: 1, filePath,
        fileMissing: false, anchor: makeAnchor(source, from, to), originalQuote: source.slice(from, to), resolved: false, createdAt: now, updatedAt: now,
        messages: [{id: crypto.randomUUID(), body: checkBody(body), createdAt: now, updatedAt: now, deleted: false}]};
      await this.writeNote(filePath, threads => threads.push(thread));
      return structuredClone(thread);
    });
  }

  createHighlight(filePath: string, source: string, from: number, to: number, beforeEdit?: () => void): Promise<Highlight> {
    return this.run(async () => {
      beforeEdit?.();
      const anchor = makeAnchor(source, from, to);
      let result: Highlight | undefined;
      await this.writeNote(filePath, (_threads, highlights) => {
        // Expand repeatedly: an earlier item may overlap only after a later item extends the range.
        const eligible = highlights.filter(highlight => !highlight.fileMissing && highlight.anchor.state === 'attached'
          && highlight.anchor.from >= 0 && highlight.anchor.to > highlight.anchor.from && highlight.anchor.to <= source.length
          && source.slice(highlight.anchor.from, highlight.anchor.to) === highlight.anchor.quote);
        const merged = new Set<string>();
        let expanded: boolean;
        do {
          expanded = false;
          for (const highlight of eligible) {
            if (merged.has(highlight.id) || highlight.anchor.from >= to || highlight.anchor.to <= from) continue;
            merged.add(highlight.id);
            from = Math.min(from, highlight.anchor.from);
            to = Math.max(to, highlight.anchor.to);
            expanded = true;
          }
        } while (expanded);
        const first = highlights.find(highlight => merged.has(highlight.id));
        if (first && merged.size === 1 && first.anchor.from === anchor.from && first.anchor.to === anchor.to) {
          result = first;
          return;
        }
        const now = new Date().toISOString();
        if (!first) {
          result = {id: crypto.randomUUID(), revision: 1, filePath, fileMissing: false, anchor, originalQuote: anchor.quote,
            createdAt: now, updatedAt: now};
          highlights.push(result);
          return;
        }
        for (const highlight of highlights) if (merged.has(highlight.id)
          && Date.parse(highlight.createdAt) < Date.parse(first.createdAt)) first.createdAt = highlight.createdAt;
        first.anchor = makeAnchor(source, from, to);
        first.fileMissing = false;
        first.revision++;
        first.updatedAt = now;
        for (let index = highlights.length - 1; index >= 0; index--) {
          const highlight = highlights[index]!;
          if (highlight.id !== first.id && merged.has(highlight.id)) highlights.splice(index, 1);
        }
        result = first;
      });
      return structuredClone(result!);
    });
  }

  removeHighlight(id: string, beforeEdit?: () => void): Promise<void> {
    return this.run(async () => {
      beforeEdit?.();
      const current = this.highlights.get(id);
      if (!current) throw new Error('标记已不存在，请刷新后重试。');
      await this.writeNote(current.filePath, (_threads, highlights) => {
        const index = highlights.findIndex(highlight => highlight.id === id);
        if (index < 0) throw new Error('标记已不存在，请刷新后重试。');
        highlights.splice(index, 1);
      });
    });
  }

  updateHighlights(path: string, edit: (highlights: Highlight[]) => void): Promise<void> {
    return this.run(async () => {
      if (!this.notes.has(path)) return;
      await this.writeNote(path, (_threads, highlights) => {
        const before = new Map(highlights.map(highlight => [highlight.id, JSON.stringify(highlight)]));
        edit(highlights);
        const now = new Date().toISOString();
        for (const highlight of highlights) if (JSON.stringify(highlight) !== before.get(highlight.id)) {
          if (highlight.filePath !== path) throw new Error('标记归属不能在批量更新中修改。');
          highlight.revision++;
          highlight.updatedAt = now;
        }
      });
    });
  }

  update(id: string, edit: (thread: Thread) => void): Promise<void> {
    return this.run(async () => {
      const current = this.threads.get(id);
      if (!current) throw new Error('讨论已不存在，请刷新后重试。');
      await this.writeNote(current.filePath, threads => {
        const next = threads.find(t => t.id === id)!;
        const before = JSON.stringify(next);
        edit(next);
        if (JSON.stringify(next) === before) return;
        if (next.filePath !== current.filePath) throw new Error('请使用笔记重命名操作更新评论归属。');
        next.revision++;
        next.updatedAt = new Date().toISOString();
      });
    });
  }

  updateFile(path: string, edit: (threads: Thread[]) => void): Promise<void> {
    return this.run(async () => {
      if (!this.notes.has(path)) return;
      await this.writeNote(path, threads => {
        const before = new Map(threads.map(t => [t.id, JSON.stringify(t)]));
        edit(threads);
        const now = new Date().toISOString();
        for (const thread of threads) if (JSON.stringify(thread) !== before.get(thread.id)) {
          if (thread.filePath !== path) throw new Error('评论归属不能在批量更新中修改。');
          thread.revision++;
          thread.updatedAt = now;
        }
      });
    });
  }

  reply(id: string, body: string): Promise<void> {
    const text = checkBody(body);
    return this.update(id, thread => {
      const now = new Date().toISOString();
      thread.messages.push({id: crypto.randomUUID(), body: text, deleted: false, createdAt: now, updatedAt: now});
    });
  }

  deleteMessage(id: string, messageId: string, confirmedLast: boolean, beforeEdit?: () => void): Promise<boolean> {
    return this.run(async () => {
      beforeEdit?.();
      const current = this.threads.get(id);
      if (!current) throw new Error('讨论已不存在，请刷新后重试。');
      let removed = false;
      await this.writeNote(current.filePath, threads => {
        const thread = threads.find(t => t.id === id)!;
        const message = thread.messages.find(m => m.id === messageId);
        if (!message || message.deleted) throw new Error('消息已删除，请重新打开菜单。');
        const last = thread.messages.filter(m => !m.deleted).length === 1;
        if (last && !confirmedLast) throw new Error('这已是最后一条消息，请重新确认删除空讨论。');
        deleteMessage(thread, messageId);
        if (thread.messages.every(m => m.deleted)) {
          threads.splice(threads.indexOf(thread), 1); removed = true;
        } else { thread.revision++; thread.updatedAt = new Date().toISOString(); }
      });
      return removed;
    });
  }

  moveFile(oldPath: string, newPath: string): Promise<void> {
    return this.run(async () => {
      if (oldPath === newPath) return;
      if (!validNotePath(newPath)) throw new Error('目标不是 Markdown 笔记，评论和标记已保留在原路径。');
      const pending = this.pendingMoves.get(oldPath);
      if (pending && pending.newPath !== newPath) throw new Error('原路径仍有待恢复迁移，原、新副本已保留，禁止迁移到其他路径。');
      if (pending) {
        const old = await this.readNote(oldPath, await noteKey(oldPath));
        const next = await this.readNote(newPath, await noteKey(newPath));
        if (!old || !next) throw new Error('待恢复的迁移数据缺失或无效，已保留可读取的原数据；禁止覆盖重建。');
        await this.finishMove(oldPath, newPath, old, next);
        this.reindex();
        this.publish();
        return;
      }
      const old = this.notes.get(oldPath);
      if (!old) return;
      const target = this.notes.get(newPath);
      if (target) {
        const confirmed = this.fileExists?.(oldPath) === false && this.fileExists?.(newPath) === true;
        if (!confirmed || !sameMovedNote(old.data, target.data)) {
          throw new Error('目标笔记已有评论或标记，已停止自动迁移以避免覆盖。');
        }
        await this.finishMove(oldPath, newPath, old, target);
        this.reindex();
        this.publish();
        return;
      }
      const moved = old.data.threads.map(t => ({...structuredClone(t), filePath: newPath, fileMissing: false,
        revision: t.revision + 1, updatedAt: new Date().toISOString()}));
      const movedHighlights = old.data.highlights.map(highlight => ({...structuredClone(highlight), filePath: newPath,
        fileMissing: false, revision: highlight.revision + 1, updatedAt: new Date().toISOString()}));
      const key = await noteKey(newPath);
      if (this.invalidKeys.has(key)) throw new Error('目标笔记评论或标记文件已损坏或版本不受支持，已停止迁移。');
      const existing = await this.readNote(newPath, key);
      if (existing && (existing.data.threads.length || existing.data.highlights.length)) {
        if (!sameMovedNote(old.data, existing.data)) throw new Error('目标笔记已有其他评论或标记数据，已停止迁移以避免覆盖。');
        await this.finishMove(oldPath, newPath, old, existing);
        this.reindex();
        this.publish();
        return;
      }
      const data: NoteThreads = {...structuredClone(old.data), filePath: newPath, revision: 1, threads: moved, highlights: movedHighlights};
      const raw = JSON.stringify(data, null, 2);
      parseNote(raw);
      if (existing) await this.files.compareAndWrite(key, existing.raw, raw);
      else await this.files.create(key, raw);
      await this.finishMove(oldPath, newPath, old, {key, raw, data});
      this.reindex();
      this.publish();
    });
  }

  remove(id: string, beforeEdit?: () => void): Promise<void> {
    return this.run(async () => {
      beforeEdit?.();
      const current = this.threads.get(id);
      if (!current) throw new Error('讨论已不存在，请刷新后重试。');
      await this.writeNote(current.filePath, threads => {
        const index = threads.findIndex(t => t.id === id);
        if (index < 0) throw new Error('讨论已不存在，请刷新后重试。');
        threads.splice(index, 1);
      });
    });
  }
  idle(): Promise<unknown> { return this.tail; }

  private async finishMove(oldPath: string, newPath: string, old: StoredNote, next: StoredNote): Promise<void> {
    const pending = this.pendingMoves.get(oldPath);
    const retired = !!pending && old.raw === pending.emptyRaw;
    const emptyRaw = pending?.emptyRaw ?? JSON.stringify({...old.data, revision: old.data.revision + 1,
      threads: [], highlights: []}, null, 2);
    try {
      if ((pending && (pending.newPath !== newPath || (!retired && (pending.oldRaw !== old.raw || pending.newRaw !== next.raw))))
        || (!retired && !sameMovedNote(old.data, next.data))) {
        throw new Error('迁移快照或完整内容冲突，原、新副本已保留，已停止恢复以避免覆盖。');
      }
      if (!pending) this.pendingMoves.set(oldPath, {newPath, oldRaw: old.raw, newRaw: next.raw, emptyRaw});
      if (await this.files.read(old.key) !== old.raw || await this.files.read(next.key) !== next.raw) {
        throw new Error('迁移原、新副本的原始数据已变化，两份数据已保留，已停止恢复以避免覆盖。');
      }
      // The compare and retirement share one atomic write; never trash a concurrently edited file.
      if (!retired) await this.files.compareAndWrite(old.key, old.raw, emptyRaw);
    } catch (error) {
      const failure = new Error(`新路径评论和标记已写入，但原路径数据仍保留。原、新副本已保留，请刷新数据恢复迁移：${error instanceof Error ? error.message : String(error)}`);
      this.error(failure);
      throw failure;
    }
    this.pendingMoves.delete(oldPath);
    this.notes.delete(oldPath);
    if (next.data.threads.length || next.data.highlights.length) this.notes.set(newPath, next);
    else this.notes.delete(newPath);
  }

  private async writeNote(path: string, edit: (threads: Thread[], highlights: Highlight[]) => void): Promise<void> {
    let current = this.notes.get(path);
    const key = current?.key ?? await noteKey(path);
    if (this.invalidKeys.has(key)) throw new Error('评论文件已损坏或版本不受支持；禁止覆盖原文件。');
    if (!current) {
      current = await this.readNote(path, key);
      if (current && (current.data.threads.length || current.data.highlights.length)) {
        throw new Error('评论文件已由其他窗口或同步工具修改。已停止保存，请刷新后重试；输入草稿仍保留。');
      }
    }
    const data: NoteThreads = current ? structuredClone(current.data)
      : {schemaVersion: 2, filePath: path, revision: 0, threads: [], highlights: []};
    const before = JSON.stringify(data);
    edit(data.threads, data.highlights);
    if (JSON.stringify(data) === before) return;
    data.revision++;
    const raw = JSON.stringify(data, null, 2);
    parseNote(raw);
    try {
      if (current) await this.files.compareAndWrite(key, current.raw, raw);
      else await this.files.create(key, raw);
    } catch (error) { this.error(error); throw error; }
    if (data.threads.length || data.highlights.length) this.notes.set(path, {key, raw, data});
    else this.notes.delete(path);
    this.reindexFile(path);
    this.publish();
  }

  private async readNote(path: string, key: string): Promise<StoredNote | undefined> {
    let raw: string;
    try { raw = await this.files.read(key); }
    catch (error) {
      if (error instanceof Error && /不存在/u.test(error.message)) return undefined;
      throw error;
    }
    const data = parseNote(raw);
    if (data.filePath !== path) throw new Error('评论文件名或路径冲突；禁止覆盖原文件。');
    return {key, raw, data};
  }

  private publish(): void { this.version++; this.changed(); }

  private reindexFile(path: string): void {
    for (const id of this.byFile.get(path) ?? []) this.threads.delete(id);
    for (const id of this.highlightsByFile.get(path) ?? []) this.highlights.delete(id);
    this.byFile.delete(path);
    this.highlightsByFile.delete(path);
    const note = this.notes.get(path);
    if (!note) return;
    const ids = new Set<string>();
    for (const thread of note.data.threads) {
      if (this.threads.has(thread.id)) { this.error(new Error(`重复评论标识 ${thread.id}，请检查评论文件。`)); continue; }
      this.threads.set(thread.id, thread);
      ids.add(thread.id);
    }
    if (ids.size) this.byFile.set(path, ids);
    const highlightIds = new Set<string>();
    for (const highlight of note.data.highlights) {
      if (this.highlights.has(highlight.id)) { this.error(new Error(`重复标记标识 ${highlight.id}，请检查标记文件。`)); continue; }
      this.highlights.set(highlight.id, highlight);
      highlightIds.add(highlight.id);
    }
    if (highlightIds.size) this.highlightsByFile.set(path, highlightIds);
  }

  private reindex(): void {
    this.threads = new Map();
    this.byFile = new Map();
    this.highlights = new Map();
    this.highlightsByFile = new Map();
    const paths = [...this.notes.keys()];
    if (this.fileExists) paths.sort((left, right) => Number(this.fileExists!(right) === true) - Number(this.fileExists!(left) === true));
    for (const path of paths) this.reindexFile(path);
  }

  private run<T>(action: () => Promise<T>): Promise<T> {
    const pending = this.tail.then(action);
    this.tail = pending.catch(() => undefined);
    return pending;
  }
}

/** A retry may have a new migration timestamp, but must match the complete saved payload. */
function sameMovedRecord(expected: Thread | Highlight, actual: Thread | Highlight): boolean {
  return samePayload({...expected, updatedAt: ''}, {...actual, updatedAt: ''});
}

function sameMovedNote(old: NoteThreads, next: NoteThreads): boolean {
  if (old.filePath === next.filePath || next.revision !== 1 || !old.threads.length && !old.highlights.length) return false;
  const matching = (before: (Thread | Highlight)[], after: (Thread | Highlight)[]) => before.length === after.length
    && before.every(record => after.some(candidate => candidate.fileMissing === false
      && sameMovedRecord({...record, filePath: next.filePath, fileMissing: false, revision: record.revision + 1}, candidate)));
  return matching(old.threads, next.threads) && matching(old.highlights, next.highlights)
    && samePayload({...old, filePath: '', revision: 0, threads: [], highlights: []},
      {...next, filePath: '', revision: 0, threads: [], highlights: []});
}

/** Compare every JSON field, including nested and unknown fields, independently of object key order. */
function samePayload(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
  if (Array.isArray(left) || Array.isArray(right)) return Array.isArray(left) && Array.isArray(right)
    && left.length === right.length && left.every((value, index) => samePayload(value, right[index]));
  const before = left as Record<string, unknown>;
  const after = right as Record<string, unknown>;
  const keys = Object.keys(before);
  return keys.length === Object.keys(after).length
    && keys.every(key => Object.prototype.hasOwnProperty.call(after, key) && samePayload(before[key], after[key]));
}
