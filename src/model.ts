export const LEGACY_DATA_ROOT = '.obsidian-highnote';
export const DATA_ROOT = 'Highnote';
export const DATA_FOLDER = `${DATA_ROOT}/annotations`;
export const SCHEMA_VERSION = 1;
export const MAX_BODY_LENGTH = 100_000;

export interface Anchor {
  from: number;
  to: number;
  quote: string;
  before: string;
  after: string;
  state: 'attached' | 'detached';
}

export interface Message {
  id: string;
  body: string;
  createdAt: string;
  updatedAt: string;
  deleted: boolean;
}

export interface Thread {
  schemaVersion: 1;
  id: string;
  revision: number;
  filePath: string;
  fileMissing: boolean;
  anchor: Anchor;
  originalQuote?: string;
  resolved: boolean;
  createdAt: string;
  updatedAt: string;
  messages: Message[];
}

export interface Highlight {
  id: string;
  revision: number;
  filePath: string;
  fileMissing: boolean;
  anchor: Anchor;
  originalQuote?: string;
  createdAt: string;
  updatedAt: string;
}

export function checkBody(body: string): string {
  const result = body.trim();
  if (!result || result.length > MAX_BODY_LENGTH) throw new Error('评论不能为空，且不能超过 100000 个字符。');
  return result;
}

export function validNotePath(path: string): boolean {
  return path.endsWith('.md') && !path.startsWith('/') && !path.includes('\\')
    && !path.split('/').some(part => part === '..' || part === '.' || !part)
    && ![...path].some(character => character.charCodeAt(0) < 32);
}

export function parseThread(raw: string): Thread {
  const value: unknown = JSON.parse(raw);
  if (!record(value) || value.schemaVersion !== SCHEMA_VERSION || !id(value.id)
    || !Number.isSafeInteger(value.revision) || Number(value.revision) < 0
    || typeof value.filePath !== 'string' || !validNotePath(value.filePath)
    || typeof value.fileMissing !== 'boolean' || typeof value.resolved !== 'boolean'
    || !date(value.createdAt) || !date(value.updatedAt) || !record(value.anchor)
    || !Array.isArray(value.messages) || value.messages.length === 0) {
    throw new Error('评论数据格式不受支持；已保留原文件。');
  }
  if (!validAnchor(value.anchor) || !validOriginalQuote(value)) throw new Error('原文位置数据无效。');
  const seen = new Set<string>();
  for (const m of value.messages) {
    if (!record(m) || !id(m.id) || seen.has(m.id) || typeof m.body !== 'string'
      || typeof m.deleted !== 'boolean' || !date(m.createdAt) || !date(m.updatedAt)
      || (m.deleted && m.body !== '') || m.body.length > MAX_BODY_LENGTH) {
      throw new Error('回复数据无效；已保留原文件。');
    }
    seen.add(m.id);
  }
  return value as unknown as Thread;
}

export function parseHighlight(raw: string): Highlight {
  const value: unknown = JSON.parse(raw);
  if (!record(value) || !id(value.id) || !Number.isSafeInteger(value.revision) || Number(value.revision) < 1
    || typeof value.filePath !== 'string' || !validNotePath(value.filePath)
    || typeof value.fileMissing !== 'boolean' || !date(value.createdAt) || !date(value.updatedAt)
    || !validAnchor(value.anchor) || !validOriginalQuote(value)) throw new Error('标记数据无效；已保留原文件。');
  return value as unknown as Highlight;
}

function validAnchor(value: unknown): value is Anchor {
  return record(value) && Number.isSafeInteger(value.from) && Number.isSafeInteger(value.to) && Number(value.from) >= 0
    && Number(value.to) >= Number(value.from) && typeof value.quote === 'string' && value.quote.length > 0
    && typeof value.before === 'string' && typeof value.after === 'string'
    && (value.state === 'attached' || value.state === 'detached');
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function validOriginalQuote(value: Record<string, unknown>): boolean {
  return !('originalQuote' in value) || typeof value.originalQuote === 'string' && value.originalQuote.length > 0;
}
function id(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9-]{36}$/u.test(value);
}
function date(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

export function deleteMessage(thread: Thread, messageId: string): void {
  const message = thread.messages.find(m => m.id === messageId);
  if (!message) throw new Error('消息已不存在，请刷新后重试。');
  message.body = '';
  message.deleted = true;
  message.updatedAt = new Date().toISOString();
}
