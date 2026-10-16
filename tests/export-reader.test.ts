import {test} from 'node:test';
import assert from 'node:assert/strict';
import {exportHtml, exportName, messageHtml} from '../src/export-reader';
import {makeAnchor} from '../src/anchors';
import type {Thread} from '../src/model';

const thread = (): Thread => ({schemaVersion:1,id:crypto.randomUUID(),revision:1,filePath:'目录/笔记 & #.md',fileMissing:false,
  anchor:makeAnchor('原文<script>保留',0,'原文<script>保留'.length),resolved:false,createdAt:'2026-10-14T01:00:00Z',updatedAt:'2026-10-14T01:00:00Z',
  messages:[{id:crypto.randomUUID(),body:'**加粗**\n1. 有序\n- 无序\n<script>alert(1)</script>\n![[嵌入]]',deleted:false,createdAt:'2026-10-14T01:00:00Z',updatedAt:'2026-10-14T02:00:00Z'}]});

test('HTML preserves messages, formatting, dates and inert source text without external dependencies', () => {
  const item = thread();item.messages.push({...item.messages[0]!,id:crypto.randomUUID(),body:'回复</script><script>attack()</script>'});
  const before = structuredClone(item); const html = exportHtml('标题<script>','comments',[item],'测试 & 笔记库',new Date(),true);
  assert.ok(html.includes('&lt;script&gt;'));assert.ok(html.includes('编辑过'));assert.ok(html.includes('<details class="replies" open>'));
  assert.ok(html.includes('<strong>加粗</strong>'));assert.ok(html.includes('<ol start="1">'));assert.ok(html.includes('<ul>'));
  assert.ok(html.includes('&lt;/script&gt;&lt;script&gt;attack()&lt;/script&gt;'));
  assert.equal((html.match(/<script>/gu) ?? []).length,1);
  assert.doesNotMatch(html,/<(?:script|link|img)[^>]+(?:src|href)="https?:/u);
  assert.ok(html.includes('vault='+encodeURIComponent('测试 & 笔记库')));assert.ok(html.includes('file='+encodeURIComponent(item.filePath)));
  assert.ok(html.includes('导出时未标记失效'));assert.deepEqual(item,before);
  assert.equal(messageHtml('[链接](javascript:evil)'),'<'+'p>[链接](javascript:evil)</p>');
});

test('missing sources have no open link and highlights omit comment controls', () => {
  const item = thread();item.fileMissing = true;item.anchor.state = 'detached';
  const html = exportHtml('评论','comments',[item],'库');assert.doesNotMatch(html,/href="obsidian:/u);assert.ok(html.includes('原文件已删除'));
  const {messages: _messages,resolved:_resolved,schemaVersion:_schema,...highlight} = item;
  const mark = exportHtml('标记','highlights',[highlight],'库');
  assert.doesNotMatch(mark,/id="status"|id="toggle-replies"|class="replies"/u);
  assert.ok(mark.includes('保存时间'));assert.ok(mark.includes('条标记'));
});

test('filename validates vault-root names and removes only format suffixes', () => {
  assert.equal(exportName(' 我的导出.html.md '),'我的导出');assert.equal(exportName('正常.名称'),'正常.名称');
  assert.equal(exportName('我的导出.csv.html.md'),'我的导出');
  for (const name of ['', '../其他目录', 'a/b', 'a\\b', 'a:b', '.', '..', 'NUL','con.txt','a\u0000b','文'.repeat(121),'名称.']) assert.throws(()=>exportName(name));
});

test('deleted main comments and replies leave no HTML placeholder, time or reply count', () => {
  const item = thread();
  const main = item.messages[0]!;
  main.deleted = true;main.body = '';main.createdAt = '2020-01-01T01:02:03Z';main.updatedAt = main.createdAt;
  item.messages.push({...main,id:crypto.randomUUID(),createdAt:'2021-01-01T01:02:03Z',updatedAt:'2021-01-01T01:02:03Z'});
  item.messages.push({...main,id:crypto.randomUUID(),deleted:false,body:'保留回复',createdAt:'2026-10-14T03:00:00Z',updatedAt:'2026-10-14T04:00:00Z'});
  const html = exportHtml('导出','comments',[item],'库');
  assert.ok(html.includes('保留回复'));assert.ok(html.includes('编辑过'));
  assert.doesNotMatch(html,/该消息已删除|2020年|2021年|<strong>评论<\/strong>/u);
  assert.ok(html.includes('1 条回复 · 按记录顺序'));
  assert.equal((html.match(/class="reply"/gu) ?? []).length,1);
});
