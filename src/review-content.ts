import {validNotePath} from './model';
import {dateLabel, localDay} from './review-model';
import type {ReviewEntry} from './review-model';

export interface ContentGroup {
  readonly key: string;
  readonly threadId?: string;
  readonly filePath: string;
  readonly quote: string;
  readonly original: boolean;
  readonly entries: readonly ReviewEntry[];
  readonly latest: string;
  readonly resolved: boolean;
  readonly fileMissing: boolean;
  readonly detached: boolean;
}

function timestamp(value: string): number {
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : Number.NEGATIVE_INFINITY;
}

function compare(left: number, right: number): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** 按讨论身份归组；调用方先取完整记录，再按查询命中的组键筛选。 */
export function contentGroups(entries: readonly ReviewEntry[], includeReplies = true): readonly ContentGroup[] {
  const grouped = new Map<string, {entry: ReviewEntry; time: number}[]>();
  const seen = new Set<string>();
  for (const entry of entries) {
    if ((!includeReplies && entry.kind === 'reply') || seen.has(entry.key)) continue;
    seen.add(entry.key);
    const key = entry.kind !== 'highlight' && entry.threadId !== undefined
      ? `thread:${entry.threadId}` : entry.key;
    let rows = grouped.get(key);
    if (!rows) { rows = []; grouped.set(key, rows); }
    // 只保存记录引用和排序时间，不读取或复制正文。
    rows.push({entry, time: timestamp(entry.createdAt)});
  }
  const groups: {group: ContentGroup; time: number}[] = [];
  for (const [key, rows] of grouped) {
    // ES2022 的稳定排序保留相同时间记录的输入顺序。
    rows.sort((left, right) => compare(left.time, right.time));
    const primary = rows.find(row => row.entry.kind === 'comment')?.entry ?? rows[0]!.entry;
    const excerpt = primary.original ? primary : rows.find(row => row.entry.original)?.entry ?? primary;
    const latest = rows.at(-1)!;
    const group: ContentGroup = Object.freeze({key,
      ...(primary.kind !== 'highlight' && primary.threadId !== undefined ? {threadId: primary.threadId} : {}),
      filePath: primary.filePath, quote: excerpt.quote, original: excerpt.original,
      entries: Object.freeze(rows.map(row => row.entry)), latest: latest.entry.createdAt,
      resolved: primary.resolved, fileMissing: primary.fileMissing, detached: primary.detached});
    groups.push({group, time: latest.time});
  }
  groups.sort((left, right) => compare(right.time, left.time));
  return Object.freeze(groups.map(row => row.group));
}

function textLines(value: string): string[] {
  return value.replace(/\r\n?|[\u2028\u2029]/gu, '\n').split('\n');
}

function escapeMarkdown(value: string): string {
  return value.replace(/([\\`*_{}[\]()<>#+.!|~^=$%:&@-])/gu, '\\$1');
}

function inlineMarkdown(value: string): string {
  return escapeMarkdown(textLines(value).join(' '));
}

/** 只开放加粗和普通列表，链接、嵌入、任务、HTML 等均作为文字保留。 */
function exportBody(body: string): string[] {
  return textLines(body).map(line => {
    const item = /^(?:([-+*]) |(\d+)\. )(.*)$/u.exec(line);
    const prefix = item ? item[2] ? `${Math.min(9999, Number(item[2]))}. ` : '- ' : '';
    const content = item ? item[3] ?? '' : line;
    const text = content.split(/(\*\*[^*\n]+\*\*)/u).map(token =>
      token.startsWith('**') && token.endsWith('**') && token.length > 4
        ? `**${escapeMarkdown(token.slice(2, -2))}**` : escapeMarkdown(token)).join('');
    return `${prefix}${text}${!item && text ? '  ' : ''}`;
  });
}

function htmlText(value: string): string {
  return value.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;').replace(/'/gu, '&#39;');
}

function bodyHtml(body: string): string {
  const bold = (value: string) => value.split(/(\*\*[^*\n]+\*\*)/u).map(token =>
    token.startsWith('**') && token.endsWith('**') && token.length > 4
      ? `<strong>${htmlText(token.slice(2, -2))}</strong>` : htmlText(token)).join('');
  const lines: string[] = [];
  let list: 'ol' | 'ul' | undefined;
  for (const line of textLines(body)) {
    const item = /^(?:([-+*]) |(\d+)\. )(.*)$/u.exec(line);
    if (item) {
      const kind = item[2] ? 'ol' : 'ul';
      const number = item[2] ? Math.min(9999, Number(item[2])) : undefined;
      if (kind !== list) {
        if (list) lines.push(`</${list}>`);
        lines.push(kind === 'ol' ? `<ol start="${number}">` : '<ul>');
        list = kind;
      }
      lines.push(`<li${number !== undefined ? ` value="${number}"` : ''}>${bold(item[3] ?? '')}</li>`);
    } else {
      if (list) { lines.push(`</${list}>`); list = undefined; }
      lines.push(line ? `<p>${bold(line)}</p>` : '<p class="paragraph-gap"><br></p>');
    }
  }
  if (list) lines.push(`</${list}>`);
  return lines.join('');
}

function fullTime(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '日期未知';
  const clock = [date.getHours(), date.getMinutes(), date.getSeconds()]
    .map(n => String(n).padStart(2, '0')).join(':');
  return `${dateLabel(localDay(value))} ${clock}`;
}

function edited(entry: ReviewEntry): boolean {
  return entry.updatedAt !== entry.createdAt && timestamp(entry.updatedAt) !== timestamp(entry.createdAt);
}

function state(entry: ReviewEntry): string {
  return [entry.kind === 'highlight' ? '' : entry.resolved ? '已解决' : '未解决',
    entry.fileMissing ? '原文件已删除' : '', entry.detached ? '原文位置失效' : '',
    !entry.fileMissing && !entry.detached ? '已关联原文' : ''].filter(Boolean).join(' · ');
}

/** 两种导出均放在笔记库根目录，链接只打开当前文件，不定位历史摘录。 */
function openPath(group: ContentGroup): string | undefined {
  if (group.fileMissing || !validNotePath(group.filePath)) return undefined;
  const path = group.filePath.split('/').map(part => encodeURIComponent(part)
    .replace(/[!'()*]/gu, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)).join('/');
  return `./${path}`;
}

function excerptLabel(group: ContentGroup): string {
  return group.original ? '创建时保存的原文' : '当前摘录（旧数据未保存原文）';
}

function exportMetadata(groups: readonly ContentGroup[], scopeLabel: string, exportedAt: Date): string[] {
  const count = groups.reduce((total, group) => total + group.entries.length, 0);
  return [`导出数量：${groups.length} 处摘录 · ${count} 条记录 · ${new Set(groups.map(group => group.filePath)).size} 篇文档`,
    `范围：${scopeLabel}`, `导出时间：${Number.isFinite(exportedAt.getTime()) ? fullTime(exportedAt.toISOString()) : '日期未知'}`,
    '保留导出时的内容与全部状态。原文件链接仅打开文件，不定位历史摘录。'];
}

/** 纯字符串导出；范围和筛选由调用方决定，详情只保留元数据，不重复正文。 */
export function exportContentMarkdown(title: string, groups: readonly ContentGroup[], scopeLabel: string,
  exportedAt = new Date()): string {
  const selected = groups.filter(group => group.entries.length > 0);
  const lines = [`# ${inlineMarkdown(title)}`, '',
    ...exportMetadata(selected, inlineMarkdown(scopeLabel), exportedAt).flatMap(line => [line, ''])];
  for (const group of selected) {
    lines.push(...textLines(group.quote).map(line => `> ${escapeMarkdown(line)}`), '');
    for (const entry of group.entries) {
      if (entry.kind !== 'highlight') lines.push(...exportBody(entry.body), '');
    }
    const detail = [`摘录来源：${excerptLabel(group)}`, ''];
    const path = openPath(group);
    if (path) detail.push(`[打开原文件](<${path}>)`, '');
    for (const [index, entry] of group.entries.entries()) {
      detail.push(`**记录 ${index + 1}**`, '', `创建时间：${fullTime(entry.createdAt)}`);
      if (edited(entry)) detail.push(`修改时间：${fullTime(entry.updatedAt)}（编辑过）`);
      detail.push(`相对路径：${inlineMarkdown(entry.filePath)}`, `状态：${state(entry)}`, '');
    }
    lines.push('> [!info]- 查看出处与记录', '>', ...detail.map(line => line ? `> ${line}` : '>'), '', '---', '');
  }
  return lines.join('\n');
}

/** 无脚本、外链依赖或客户端调用的离线阅读页。 */
export function exportContentHtml(title: string, groups: readonly ContentGroup[], scopeLabel: string,
  exportedAt = new Date(), dark = false): string {
  const selected = groups.filter(group => group.entries.length > 0);
  const time = (value: string) => `<time datetime="${htmlText(value)}">${htmlText(fullTime(value))}</time>`;
  const articles = selected.map(group => {
    const path = openPath(group);
    const details = group.entries.map((entry, index) => `<section class="record-meta"><h3>记录 ${index + 1}</h3><dl>`
      + `<dt>创建时间</dt><dd>${time(entry.createdAt)}</dd>`
      + (edited(entry) ? `<dt>修改时间</dt><dd>${time(entry.updatedAt)}（编辑过）</dd>` : '')
      + `<dt>相对路径</dt><dd>${htmlText(entry.filePath)}</dd><dt>状态</dt><dd>${htmlText(state(entry))}</dd></dl></section>`).join('');
    return `<article><blockquote class="quote">${htmlText(textLines(group.quote).join('\n'))}</blockquote>`
      + group.entries.filter(entry => entry.kind !== 'highlight')
        .map(entry => `<div class="message">${bodyHtml(entry.body)}</div>`).join('')
      + `<details><summary>查看出处与记录</summary><p>摘录来源：${htmlText(excerptLabel(group))}</p>`
      + (path ? `<p><a href="${htmlText(path)}">打开原文件</a></p>` : '') + details + '</details></article>';
  }).join('');
  return `<!doctype html><html lang="zh-CN"${dark ? ' data-theme="dark"' : ''}><head><meta charset="utf-8">`
    + '<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer">'
    + `<title>${htmlText(title)}</title><style>${CONTENT_CSS}</style></head><body><main><header><h1>${htmlText(title)}</h1>`
    + exportMetadata(selected, scopeLabel, exportedAt).map(line => `<p class="export-meta">${htmlText(line)}</p>`).join('')
    + `</header>${articles}</main></body></html>`;
}

const CONTENT_CSS = `
:root{color-scheme:light;--paper:#fff;--quote:#f7f7f9;--ink:#23262b;--muted:#626570;--line:#dddde4;--accent:#a798ce;--link:#665099}
*{box-sizing:border-box}
body{margin:0;background:var(--paper);color:var(--ink);font:15px/1.8 system-ui,-apple-system,"Segoe UI",sans-serif;overflow-wrap:anywhere}
main{max-width:760px;margin:32px auto;padding:0 20px}
h1{font-size:26px;line-height:1.4;margin:0 0 16px}
header{margin-bottom:24px}
.export-meta{color:var(--muted);font-size:12px;margin:4px 0;white-space:pre-wrap}
article{border:1px solid var(--line);border-radius:8px;padding:18px 20px;margin:14px 0}
.quote{margin:0 0 16px;padding:10px 12px;border-left:2px solid var(--accent);border-radius:0 5px 5px 0;background:var(--quote);color:var(--muted);white-space:pre-wrap}
.message+.message{margin-top:14px}
.message p{margin:0;white-space:pre-wrap}
.message p+p{margin-top:8px}
.message :is(ul,ol){padding-left:24px;margin:8px 0}
.message li{white-space:pre-wrap}
details{margin-top:16px;color:var(--muted);font-size:12px}
summary{cursor:pointer}
summary:focus-visible,a:focus-visible{outline:2px solid var(--accent);outline-offset:3px}
details p{margin:8px 0}
.record-meta{margin-top:12px}
.record-meta h3{font-size:12px;font-weight:600;margin:0 0 4px}
dl{display:grid;grid-template-columns:max-content minmax(0,1fr);gap:2px 12px;margin:0}
dd{margin:0;white-space:pre-wrap}
a{color:var(--link);text-underline-offset:3px}
@media(prefers-color-scheme:dark){:root{color-scheme:dark;--paper:#17181c;--quote:#23252b;--ink:#eee;--muted:#b7bbc6;--line:#444650;--accent:#a798ce;--link:#c5b1ee}}
:root[data-theme="dark"]{color-scheme:dark;--paper:#17181c;--quote:#23252b;--ink:#eee;--muted:#b7bbc6;--line:#444650;--accent:#a798ce;--link:#c5b1ee}
@media(max-width:480px){main{margin:20px auto;padding:0 12px}article{padding:14px}h1{font-size:23px}dl{gap:2px 8px}}
@media print{:root,:root[data-theme="dark"]{color-scheme:light;--paper:#fff;--quote:#f6f6f6;--ink:#000;--muted:#444;--line:#bbb;--accent:#999;--link:#000}main{max-width:none;margin:0;padding:0}article{border-radius:0;break-inside:auto}.quote,.message p,.record-meta{orphans:3;widows:3}details>summary{display:none}details>*,details:not([open])>*{display:block}details dl{display:grid}a{text-decoration:none}}
`;
