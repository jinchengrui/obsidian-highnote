import type {Highlight, Thread} from './model';

export type ReviewKind = 'comments' | 'highlights';

export function renamedSourcePath(path: string, oldPath: string, newPath: string): string {
  return path === oldPath || path.startsWith(`${oldPath}/`) ? newPath + path.slice(oldPath.length) : path;
}

export interface ReviewEntry {
  readonly key: string;
  readonly kind: 'comment' | 'reply' | 'highlight';
  readonly id: string;
  readonly threadId?: string;
  readonly filePath: string;
  readonly body: string;
  readonly quote: string;
  readonly original: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly resolved: boolean;
  readonly fileMissing: boolean;
  readonly detached: boolean;
}

interface SearchFields {
  quote: string;
  anchor: string;
  path: string;
}

interface IndexedEntry {
  entry: ReviewEntry;
  timestamp: number;
  fields: SearchFields;
  // 正文按需折叠大小写；同步时不复制所有正文。
  foldedBody?: string;
}

interface Snapshot<T> {
  source: T;
  revision: number;
  rows: Map<string, IndexedEntry>;
}

interface Delta {
  removed: Set<string>;
  added: IndexedEntry[];
}

/** 未保存原始摘录的旧数据回退到当前 anchor，不修改源对象。 */
function savedQuote(source: Thread | Highlight): {quote: string; original: boolean} {
  const originalQuote = source.originalQuote;
  return typeof originalQuote === 'string'
    ? {quote: originalQuote, original: true}
    : {quote: source.anchor.quote, original: false};
}

function timestamp(value: string): number {
  const result = Date.parse(value);
  return Number.isFinite(result) ? result : Number.NEGATIVE_INFINITY;
}

function order(left: IndexedEntry, right: IndexedEntry): number {
  return (left.timestamp === right.timestamp ? 0 : left.timestamp > right.timestamp ? -1 : 1)
    || (left.entry.key < right.entry.key ? -1 : left.entry.key > right.entry.key ? 1 : 0);
}

function sameEntry(left: ReviewEntry, right: ReviewEntry): boolean {
  return left.key === right.key && left.kind === right.kind && left.id === right.id
    && left.threadId === right.threadId && left.filePath === right.filePath
    && left.body === right.body && left.quote === right.quote && left.original === right.original
    && left.createdAt === right.createdAt && left.updatedAt === right.updatedAt
    && left.resolved === right.resolved && left.fileMissing === right.fileMissing
    && left.detached === right.detached;
}

function indexed(entry: ReviewEntry, fields: SearchFields, previous?: IndexedEntry): IndexedEntry {
  const unchanged = previous && sameEntry(previous.entry, entry);
  if (unchanged && previous.fields.quote === fields.quote
    && previous.fields.anchor === fields.anchor && previous.fields.path === fields.path) return previous;
  return {entry: unchanged ? previous.entry : Object.freeze(entry), timestamp: timestamp(entry.createdAt), fields,
    foldedBody: previous?.entry.body === entry.body ? previous.foldedBody : undefined};
}

function rows(source: Thread | Highlight, previous?: Map<string, IndexedEntry>): Map<string, IndexedEntry> {
  const excerpt = savedQuote(source);
  const shared = {filePath: source.filePath, ...excerpt, fileMissing: source.fileMissing,
    detached: source.anchor.state === 'detached'};
  const fields = {quote: excerpt.quote.toLowerCase(), anchor: source.anchor.quote.toLowerCase(),
    path: source.filePath.toLowerCase()};
  const next = new Map<string, IndexedEntry>();
  if ('messages' in source) {
    for (const [position, message] of source.messages.entries()) {
      if (message.deleted) continue;
      // key 不含讨论 ID 或消息位置，重命名、移动和合并不改变消息身份。
      const key = `comment:${message.id}`;
      const entry: ReviewEntry = {key, kind: position === 0 ? 'comment' : 'reply', id: message.id,
        threadId: source.id, ...shared, body: message.body, createdAt: message.createdAt,
        updatedAt: message.updatedAt, resolved: source.resolved};
      next.set(key, indexed(entry, fields, previous?.get(key)));
    }
  } else {
    const key = `highlight:${source.id}`;
    next.set(key, indexed({key, kind: 'highlight', id: source.id, ...shared, body: excerpt.quote,
      createdAt: source.createdAt, updatedAt: source.updatedAt, resolved: false}, fields, previous?.get(key)));
  }
  return next;
}

/** 只排序新增/变化记录，再线性合并；不重新排序全部历史。 */
function merge(current: readonly IndexedEntry[], delta: Delta): readonly IndexedEntry[] {
  if (!delta.removed.size && !delta.added.length) return current;
  const retained = current.filter(row => !delta.removed.has(row.entry.key));
  const added = delta.added.sort(order);
  const result: IndexedEntry[] = [];
  let left = 0;
  let right = 0;
  while (left < retained.length && right < added.length) {
    if (order(retained[left]!, added[right]!) <= 0) result.push(retained[left++]!);
    else result.push(added[right++]!);
  }
  while (left < retained.length) result.push(retained[left++]!);
  while (right < added.length) result.push(added[right++]!);
  return result;
}

/**
 * 输入必须含本次完整的已保存记录集合；省略的讨论/标记会从索引移除。
 * 原地修改对象须增加 revision；同一引用且 revision 不变视为未变化。
 * 遍历仅核对对象身份，正文和排序只处理增量。结果是稳定的只读快照。
 */
export class ReviewIndex {
  private threads = new Map<string, Snapshot<Thread>>();
  private highlights = new Map<string, Snapshot<Highlight>>();
  private comments: readonly IndexedEntry[] = [];
  private marks: readonly IndexedEntry[] = [];
  private cache = new Map<string, readonly ReviewEntry[]>();
  private generation = 0;

  get version(): number { return this.generation; }

  sync(threads: readonly Thread[], highlights: readonly Highlight[]): boolean {
    const comments: Delta = {removed: new Set(), added: []};
    const marks: Delta = {removed: new Set(), added: []};
    const threadsChanged = this.syncObjects(this.threads, threads, comments);
    const highlightsChanged = this.syncObjects(this.highlights, highlights, marks);
    if (!threadsChanged && !highlightsChanged) return false;
    this.comments = merge(this.comments, comments);
    this.marks = merge(this.marks, marks);
    this.cache.clear();
    this.generation++;
    return true;
  }

  search(kind: ReviewKind, query: string, includeReplies = true): readonly ReviewEntry[] {
    const needle = query.trim().toLowerCase();
    const key = JSON.stringify([kind, needle, kind === 'comments' && includeReplies]);
    const cached = this.cache.get(key);
    if (cached) return cached;
    const result: ReviewEntry[] = [];
    for (const row of kind === 'comments' ? this.comments : this.marks) {
      if (!includeReplies && row.entry.kind === 'reply') continue;
      if (needle && !row.fields.quote.includes(needle) && !row.fields.anchor.includes(needle)
        && !row.fields.path.includes(needle)) {
        row.foldedBody ??= row.entry.body.toLowerCase();
        if (!row.foldedBody.includes(needle)) continue;
      }
      result.push(row.entry);
    }
    const snapshot = Object.freeze(result);
    // 约束长时间输入搜索词时的缓存占用。
    if (this.cache.size >= 64) this.cache.delete(this.cache.keys().next().value!);
    this.cache.set(key, snapshot);
    return snapshot;
  }

  getThread(id: string): Readonly<Thread> | undefined { return this.threads.get(id)?.source; }

  clear(): void {
    const changed = this.threads.size > 0 || this.highlights.size > 0;
    this.threads.clear();
    this.highlights.clear();
    this.comments = [];
    this.marks = [];
    this.cache.clear();
    if (changed) this.generation++;
  }

  private syncObjects<T extends Thread | Highlight>(snapshots: Map<string, Snapshot<T>>,
    sources: readonly T[], delta: Delta): boolean {
    let changed = false;
    const incoming = new Map(sources.map(source => [source.id, source]));
    for (const [id, previous] of snapshots) {
      if (incoming.has(id)) continue;
      for (const key of previous.rows.keys()) delta.removed.add(key);
      snapshots.delete(id);
      changed = true;
    }
    for (const [id, source] of incoming) {
      const previous = snapshots.get(id);
      if (previous?.source === source && previous.revision === source.revision) continue;
      const next = rows(source, previous?.rows);
      if (previous) {
        for (const [key, row] of previous.rows) if (next.get(key) !== row) delta.removed.add(key);
      }
      for (const [key, row] of next) if (previous?.rows.get(key) !== row) delta.added.push(row);
      snapshots.set(id, {source, revision: source.revision, rows: next});
      changed = true;
    }
    return changed;
  }
}

/** ISO 时间戳转运行环境所在时区的自然日；不按 UTC 截断。 */
export function localDay(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  const pad = (number: number) => String(number).padStart(2, '0');
  return `${String(date.getFullYear()).padStart(4, '0')}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** 日键按日历字段格式化，避免将 YYYY-MM-DD 再解析成本地时间。 */
export function dateLabel(day: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(day);
  if (!match || !Number.isFinite(Date.parse(`${day}T12:00:00Z`))
    || new Date(`${day}T12:00:00Z`).toISOString().slice(0, 10) !== day) return '日期未知';
  return `${match[1]}年${Number(match[2])}月${Number(match[3])}日`;
}
