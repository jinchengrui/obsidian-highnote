import {commentTime} from './comment-time';
import type {Highlight, Thread} from './model';
import {annotationOrder} from './sidebar-model';

export type ExportScope = 'current' | 'all';

/** Keep the destination in the vault root and short enough for common file systems. */
export function exportBaseName(scope: ExportScope, filePath: string): string {
  if (scope === 'all') return '全部文档-评论导出';
  const name = (filePath.split('/').at(-1) ?? '当前文档').replace(/\.md$/u, '');
  const safe = [...name.replace(/[<>:"/\\|?*]/gu, '_')].map(char => char.charCodeAt(0) < 32 ? '_' : char).slice(0, 48).join('').trim();
  return `${safe || '当前文档'}-评论导出`;
}

export function exportHighlightBaseName(scope: ExportScope, sourcePath: string): string {
  return exportBaseName(scope, sourcePath).replace(/-评论导出$/u, '-标记导出');
}

export function exportHighlightsMarkdown(title: string, highlights: readonly Highlight[], exportedAt = new Date()): string {
  const sorted = [...highlights].sort(annotationOrder(true));
  const lines = [`# ${escapeMarkdown(title)}`, '', `导出时间：${commentTime(exportedAt.toISOString()).full}`, '',
    `共 ${new Set(sorted.map(highlight => highlight.filePath)).size} 篇文档，${sorted.length} 条标记。`, '',
    '包含所选范围内的全部已保存标记，不受侧栏搜索和状态筛选影响。', '', ...documentDirectory(sorted)];
  let current = '';
  let index = 0;
  let documentIndex = 0;
  for (const highlight of sorted) {
    if (current !== highlight.filePath) {
      current = highlight.filePath; index = 0;
      lines.push(`<a id="document-${documentIndex++}"></a>`, '');
      lines.push(`## ${escapeMarkdown(current.split('/').at(-1) ?? current)}`, '', `相对路径：${escapeMarkdown(current)}`, '');
      if (!highlight.fileMissing) lines.push(`[打开原文件](<${current.split('/').map(part => encodeURIComponent(part)).join('/')}>)`, '');
    }
    lines.push(`### 标记 ${++index}`, '',
      `状态：${highlight.fileMissing ? '原文件已删除' : highlight.anchor.state === 'detached' ? '原文位置失效' : '已关联原文'}`, '',
      `创建时间：${commentTime(highlight.createdAt).full}`, '', `更新时间：${commentTime(highlight.updatedAt).full}`, '',
      '**原文摘录**', '', ...highlight.anchor.quote.split('\n').map(line => `> ${escapeMarkdown(line)}`), '', '---', '');
  }
  return lines.join('\n');
}

export function exportMarkdown(title: string, threads: readonly Thread[], exportedAt = new Date()): string {
  const sorted = [...threads].sort(annotationOrder(true));
  const lines = [`# ${escapeMarkdown(title)}`, '', `导出时间：${commentTime(exportedAt.toISOString()).full}`, '',
    `共 ${new Set(sorted.map(thread => thread.filePath)).size} 篇文档，${sorted.length} 条讨论。`, '',
    '包含所选范围内的全部已保存讨论，不受侧栏搜索和状态筛选影响。未提交草稿不包含在内。', '', ...documentDirectory(sorted)];
  let current = '';
  let index = 0;
  let documentIndex = 0;
  for (const thread of sorted) {
    if (current !== thread.filePath) {
      current = thread.filePath; index = 0;
      lines.push(`<a id="document-${documentIndex++}"></a>`, '');
      lines.push(`## ${escapeMarkdown(current.split('/').at(-1) ?? current)}`, '', `相对路径：${escapeMarkdown(current)}`, '');
      if (!thread.fileMissing) lines.push(`[打开原文件](<${current.split('/').map(part => encodeURIComponent(part)).join('/')}>)`, '');
    }
    lines.push(`### 讨论 ${++index}`, '',
      `状态：${thread.resolved ? '已解决' : '未解决'}${thread.fileMissing ? ' · 原文件已删除' : thread.anchor.state === 'detached' ? ' · 原文位置失效' : ''}`, '',
      '**原文摘录**', '', ...thread.anchor.quote.split('\n').map(line => `> ${escapeMarkdown(line)}`), '');
    for (const [number, message] of thread.messages.entries()) {
      if (message.deleted) continue;
      const edited = message.updatedAt !== message.createdAt;
      const date = commentTime(edited ? message.updatedAt : message.createdAt).full;
      const body = exportBody(message.body);
      if (number === 0) lines.push(`#### 评论 · ${date}${edited ? '（编辑过）' : ''}`, '', body, '');
      else lines.push(`> **回复 ${number} · ${date}${edited ? '（编辑过）' : ''}**`, '>',
        ...body.split('\n').map(line => `> ${line}`), '');
    }
    lines.push('---', '');
  }
  return lines.join('\n');
}

function documentDirectory(records: readonly {filePath: string}[]): string[] {
  const paths = [...new Set(records.map(item => item.filePath))];
  if (paths.length < 2) return [];
  return ['**文档目录**', '', ...paths.map((path,index) => `[${escapeMarkdown(path)}](#document-${index})  `), '', '---', ''];
}

/** Export the same small formatting subset as the sidebar, with links/embeds/HTML kept as text. */
function exportBody(body: string): string {
  return body.split('\n').map(line => {
    const item = /^(?:([-+*]) |(\d+)\. )(.*)$/u.exec(line);
    const prefix = item ? item[2] ? `${Math.min(9999, Number(item[2]))}. ` : '- ' : '';
    const content = item ? item[3] ?? '' : line;
    const text = content.split(/(\*\*[^*\n]+\*\*)/u).map(token =>
      token.startsWith('**') && token.endsWith('**') && token.length > 4
        ? `**${escapeMarkdown(token.slice(2, -2))}**` : escapeMarkdown(token)).join('');
    return `${prefix}${text}${!item && text ? '  ' : ''}`;
  }).join('\n');
}

function escapeMarkdown(value: string): string {
  return value.replace(/([\\`*_{}[\]()<>#+.!|~-])/gu, '\\$1');
}
