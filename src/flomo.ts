import type {Message, Thread} from './model';

export interface FlomoConfig {
  group: 'thread' | 'message';
  includeReplies: boolean;
  preset: 'context' | 'comments';
  labels: boolean;
  source: boolean;
  separator: 'blank' | 'line' | 'rule' | 'custom';
  customSeparator: string;
  custom: boolean;
  template: string;
}

export interface FlomoRow {
  content: string;
  created_at: string;
  threadId: string;
  messageIds: string[];
}

export const FLOMO_VARIABLES = ['上下文', '评论', '来源', '记录日期'] as const;
export const FLOMO_COLUMNS = ['content', 'created_at'] as const;
export const DEFAULT_FLOMO_CONFIG: FlomoConfig = Object.freeze({
  group: 'thread', includeReplies: true, preset: 'context', labels: true, source: false,
  separator: 'blank', customSeparator: '\n\n', custom: false, template: '原文\n{上下文}\n\n想法\n{评论}',
});
const MAX_TEMPLATE_LENGTH = 50_000;
const MAX_SEPARATOR_LENGTH = 10_000;
const variableNames: ReadonlySet<string> = new Set(FLOMO_VARIABLES);

/** Normalize settings only; message bodies and excerpts are never truncated. */
export function normalizeFlomoConfig(value: unknown): FlomoConfig {
  const config = {...DEFAULT_FLOMO_CONFIG};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return config;
  const raw = value as Record<string, unknown>;
  if (raw.group === 'thread' || raw.group === 'message') config.group = raw.group;
  if (raw.preset === 'context' || raw.preset === 'comments') config.preset = raw.preset;
  if (raw.separator === 'blank' || raw.separator === 'line' || raw.separator === 'rule' || raw.separator === 'custom') {
    config.separator = raw.separator;
  }
  for (const key of ['includeReplies', 'labels', 'source', 'custom'] as const) {
    if (typeof raw[key] === 'boolean') config[key] = raw[key];
  }
  if (typeof raw.customSeparator === 'string' && raw.customSeparator.length <= MAX_SEPARATOR_LENGTH) {
    config.customSeparator = raw.customSeparator;
  }
  if (typeof raw.template === 'string' && raw.template.length <= MAX_TEMPLATE_LENGTH) config.template = raw.template;
  return config;
}

/** Empty templates are valid: their empty output is counted by flomoRows. */
export function validateFlomoTemplate(text: string): string {
  if (text.length > MAX_TEMPLATE_LENGTH) return '模板不能超过 50000 个字符。';
  for (const match of text.matchAll(/\{([^{}]*)\}|[{}]/gu)) {
    if (match[1] === undefined) return '模板大括号必须完整配对。';
    if (!variableNames.has(match[1])) return `不支持的模板变量：{${match[1]}}。`;
  }
  return '';
}

function timestamp(value: string): number {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return NaN;
  const year = new Date(time).getFullYear();
  return year >= 0 && year <= 9999 ? time : NaN;
}

/** Format in the host's local timezone, with no UTC slicing or date substitution. */
export function flomoStamp(value: string): string {
  const time = timestamp(value);
  if (!Number.isFinite(time)) return '';
  const date = new Date(time);
  const pad = (part: number) => String(part).padStart(2, '0');
  return `${String(date.getFullYear()).padStart(4, '0')}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

const plain = (text: string): string => text.replace(/\r\n?/gu, '\n');
const compareId = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
interface SelectedMessage { message: Message; primary: boolean; time: number }

function compareMessages(a: SelectedMessage, b: SelectedMessage): number {
  const first = Number.isFinite(a.time) ? a.time : Infinity;
  const second = Number.isFinite(b.time) ? b.time : Infinity;
  return (first === second ? 0 : first - second) || compareId(a.message.id, b.message.id);
}

function joiner(config: FlomoConfig): string {
  switch (config.separator) {
    case 'line': return '\n';
    case 'rule': return '\n\n———\n\n';
    case 'custom': return plain(config.customSeparator);
    default: return '\n\n';
  }
}

function contentFor(thread: Thread, comments: string, created: string, config: FlomoConfig): string {
  const context = plain(thread.originalQuote ?? thread.anchor.quote);
  const source = thread.filePath.split('/').at(-1) ?? '';
  if (config.custom) {
    const values: Record<string, string> = {'上下文': context, '评论': comments, '来源': source, '记录日期': created};
    // Callback replacement is literal and never scans variable values again.
    return plain(config.template).replace(/\{([^{}]*)\}/gu, (_match, name: string) => values[name]!);
  }
  const blocks: string[] = [];
  if (config.preset === 'context' && context.trim()) blocks.push(config.labels ? `原文\n${context}` : context);
  blocks.push(config.labels ? `想法\n${comments}` : comments);
  if (config.source && source.trim()) blocks.push(`来源：${source}`);
  return blocks.join('\n\n');
}

/**
 * First occurrence of a message ID wins globally, including deleted placeholders.
 * Primary identity is the original array position, before filtering or sorting.
 * empty counts unique, selected, undeleted blank messages, plus rows skipped for
 * blank template output. Excluded/deleted/duplicate messages and empty threads
 * do not increment it. missing counts only emitted rows with no valid date.
 * Threads sort by their latest selected nonblank message (descending); messages
 * within each thread sort by creation time (ascending, invalid last), then ID.
 */
export function flomoRows(threads: readonly Thread[], config: FlomoConfig): {
  rows: FlomoRow[]; missing: number; empty: number; error: string;
} {
  const error = config.custom ? validateFlomoTemplate(config.template) : '';
  if (error) return {rows: [], missing: 0, empty: 0, error};
  let missing = 0, empty = 0;
  const seen = new Set<string>();
  const selected: {thread: Thread; messages: SelectedMessage[]; latest: number}[] = [];
  for (const thread of threads) {
    const messages: SelectedMessage[] = [];
    let latest = -Infinity;
    for (const [index, message] of thread.messages.entries()) {
      if (seen.has(message.id)) continue;
      seen.add(message.id);
      if (message.deleted || (!config.includeReplies && index !== 0)) continue;
      if (!message.body.trim()) { empty++; continue; }
      const time = timestamp(message.createdAt);
      messages.push({message, primary: index === 0, time});
      if (Number.isFinite(time)) latest = Math.max(latest, time);
    }
    if (messages.length) selected.push({thread, messages: messages.sort(compareMessages), latest});
  }
  selected.sort((a, b) => (a.latest === b.latest ? 0 : b.latest - a.latest) || compareId(a.thread.id, b.thread.id));
  const rows: FlomoRow[] = [];
  const separator = joiner(config);
  for (const {thread, messages} of selected) {
    const units = config.group === 'thread' ? [messages] : messages.map(message => [message]);
    for (const unit of units) {
      const dated = unit.find(item => item.primary && Number.isFinite(item.time))
        ?? unit.find(item => Number.isFinite(item.time));
      const created = dated ? flomoStamp(dated.message.createdAt) : '';
      const comments = unit.map(item => plain(item.message.body)).join(separator);
      const content = contentFor(thread, comments, created, config);
      if (!content.trim()) { empty++; continue; }
      if (!created) missing++;
      rows.push({content, created_at: created, threadId: thread.id, messageIds: unit.map(item => item.message.id)});
    }
  }
  return {rows, missing, empty, error: ''};
}

/** UTF-8 BOM; bare fixed header; quoted fields; CRLF records; LF within content. */
export function flomoCsv(rows: readonly FlomoRow[]): string {
  const quote = (value: string) => `"${value.replace(/"/gu, '""')}"`;
  return `\uFEFF${FLOMO_COLUMNS.join(',')}\r\n`
    + rows.map(row => `${quote(plain(row.content))},${quote(row.created_at)}\r\n`).join('');
}
