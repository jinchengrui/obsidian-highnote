import {test} from 'node:test';
import assert from 'node:assert/strict';
import {exportBaseName, exportHighlightBaseName, exportHighlightsMarkdown, exportMarkdown} from '../src/export';
import {makeAnchor} from '../src/anchors';
import type {Highlight, Thread} from '../src/model';

function thread(path: string, body: string): Thread {
  const now = '2026-10-14T08:00:00Z';
  return {schemaVersion: 1, id: crypto.randomUUID(), revision: 1, filePath: path, fileMissing: false,
    anchor: makeAnchor('原文句子', 0, 4), resolved: false, createdAt: now, updatedAt: now,
    messages: [{id: crypto.randomUUID(), body, deleted: false, createdAt: now, updatedAt: now}]};
}
test('export groups same filenames by path and preserves all statuses and message order', () => {
  const a = thread('项目甲/笔记.md', '**重点**\n- 一\n- 二');
  const b = thread('项目乙/笔记.md', '另一篇');
  a.resolved = true;
  a.anchor.state = 'detached';
  a.messages[0]!.updatedAt = '2026-10-14T09:00:00Z';
  a.messages.push({...a.messages[0]!, id: crypto.randomUUID(), body: '', deleted: true});
  a.messages.push({...a.messages[0]!, id: crypto.randomUUID(), body: '后续回复', deleted: false});
  b.fileMissing = true;
  const md = exportMarkdown('全部文档-评论导出', [b, a], new Date('2026-10-14T10:00:00Z'));
  assert.ok(md.includes('项目甲/笔记\\.md'));
  assert.ok(md.includes('项目乙/笔记\\.md'));
  assert.ok(md.includes('已解决 · 原文位置失效'));
  assert.ok(md.includes('原文件已删除'));
  assert.ok(md.includes('> 原文句子'));
  assert.ok(md.includes('**重点**  \n- 一\n- 二'));
  assert.ok(md.includes('（编辑过）'));
  assert.ok(!md.includes('该消息已删除'));
  assert.ok(md.includes('后续回复'));
  assert.equal(md.match(/打开原文件/gu)?.length, 1);
});
test('export escapes active markup and limits generated filenames', () => {
  const a = thread('目录/笔记.md', '<script>text</script>\n![[秘密]]\n![image](https://example.com)\n# title\n1. **步骤**');
  a.anchor.quote = '[!warning]\n![[附件]]';
  const md = exportMarkdown('导出', [a]);
  assert.ok(md.includes('\\<script\\>'));
  assert.ok(md.includes('\\!\\[\\[秘密\\]\\]'));
  assert.ok(md.includes('\\# title'));
  assert.ok(md.includes('1. **步骤**'));
  assert.ok(md.includes('> \\[\\!warning\\]'));
  assert.equal(exportBaseName('all', ''), '全部文档-评论导出');
  assert.equal(exportBaseName('current', '目录/a:b?.md'), 'a_b_-评论导出');
  assert.ok([...exportBaseName('current', '文'.repeat(200)+'.md')].length < 100);
});

function highlight(path: string, from = 0): Highlight {
  const now = '2026-10-14T08:00:00Z';
  return {id: crypto.randomUUID(), revision: 1, filePath: path, fileMissing: false,
    anchor: makeAnchor('前文原文句子后文', from, from + 2), createdAt: now, updatedAt: now};
}

test('highlight export groups by relative path, sorts anchors and includes statuses and record timestamps without messages', () => {
  const first = highlight('A/笔记.md', 0);
  const second = highlight(first.filePath, 2);
  const missing = highlight('B/笔记.md');
  second.anchor.state = 'detached';
  second.updatedAt = '2026-10-14T09:00:00Z';
  missing.fileMissing = true;
  const highlights = [missing, second, first];
  const before = structuredClone(highlights);
  const md = exportHighlightsMarkdown('全部文档-标记导出', highlights, new Date('2026-10-14T10:00:00Z'));
  assert.ok(md.includes('共 2 篇文档，3 条标记。'));
  assert.ok(md.includes('相对路径：A/笔记\\.md'));
  assert.ok(md.includes('相对路径：B/笔记\\.md'));
  assert.equal(md.match(/## 笔记\\\.md/gu)?.length, 2);
  assert.ok(md.indexOf('> 前文') < md.indexOf('> 原文'));
  assert.ok(md.indexOf('A/') < md.indexOf('B/'));
  assert.ok(md.includes('状态：已关联原文'));
  assert.ok(md.includes('状态：原文位置失效'));
  assert.ok(md.includes('状态：原文件已删除'));
  for (const label of ['导出时间：', '创建时间：', '更新时间：']) assert.ok(md.includes(label));
  assert.equal(md.match(/创建时间：/gu)?.length, 3);
  assert.equal(md.match(/更新时间：/gu)?.length, 3);
  assert.equal(md.match(/打开原文件/gu)?.length, 1);
  assert.ok(md.includes('[打开原文件](<A/%E7%AC%94%E8%AE%B0.md>)'));
  assert.doesNotMatch(md, /####|回复|评论|已解决|未解决/gu);
  assert.deepEqual(highlights, before);
});

test('highlight export escapes source markup, makes safe filenames and handles an empty selection', () => {
  const item = highlight('目录/a #[(x)]%.md');
  item.anchor.quote = '[!warning]\n![[附件]]\n<script>text</script>\n![image](https://example.com)\n**重点**\n# title';
  const md = exportHighlightsMarkdown('[标题]\n#注入', [item]);
  assert.ok(md.includes('# \\[标题\\]'));
  assert.ok(md.includes('> \\[\\!warning\\]'));
  assert.ok(md.includes('> \\!\\[\\[附件\\]\\]'));
  assert.ok(md.includes('> \\<script\\>text\\</script\\>'));
  assert.ok(md.includes('> \\!\\[image\\]\\(https://example\\.com\\)'));
  assert.ok(md.includes('> \\*\\*重点\\*\\*'));
  assert.ok(md.includes('> \\# title'));
  assert.ok(md.includes('[打开原文件](<%E7%9B%AE%E5%BD%95/a%20%23%5B(x)%5D%25.md>)'));
  assert.equal(exportHighlightBaseName('all', ''), '全部文档-标记导出');
  assert.equal(exportHighlightBaseName('current', '目录/a:b?.md'), 'a_b_-标记导出');
  assert.equal(exportHighlightBaseName('current', '目录/.md'), '当前文档-标记导出');
  assert.equal(exportHighlightBaseName('current', '目录/a\u0000b.md'), 'a_b-标记导出');
  assert.ok([...exportHighlightBaseName('current', '🍊'.repeat(200) + '.md')].length < 100);
  const empty = exportHighlightsMarkdown('空标记', [], new Date('2026-10-14T10:00:00Z'));
  assert.ok(empty.includes('共 0 篇文档，0 条标记。'));
  assert.doesNotMatch(empty, /### 标记|打开原文件|回复|评论/gu);
});

test('Markdown omits deleted message headers while retaining remaining replies and original excerpt', () => {
  const item = thread('笔记.md','删除主评论');
  item.messages[0]!.deleted = true;item.messages[0]!.body = '';item.messages[0]!.createdAt = '2020-01-01T01:02:03Z';item.messages[0]!.updatedAt = item.messages[0]!.createdAt;
  item.messages.push({...item.messages[0]!,id:crypto.randomUUID(),deleted:false,body:'保留回复',createdAt:'2026-10-14T03:00:00Z',updatedAt:'2026-10-14T04:00:00Z'});
  const md = exportMarkdown('导出',[item]);
  assert.ok(md.includes('保留回复'));assert.ok(md.includes('> 原文句子'));assert.ok(md.includes('（编辑过）'));
  assert.doesNotMatch(md,/该消息已删除|2020年|#### 评论/u);
});
