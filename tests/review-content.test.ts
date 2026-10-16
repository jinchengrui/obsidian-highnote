import {test} from 'node:test';
import assert from 'node:assert/strict';
import type {Highlight, Message, Thread} from '../src/model';
import type {ReviewEntry} from '../src/review-model';
import {ReviewIndex} from '../src/review-model';
import {contentGroups, exportContentHtml, exportContentMarkdown} from '../src/review-content';
import type {ContentGroup} from '../src/review-content';

const created = '2026-10-13T08:00:00Z';
const exported = new Date('2026-10-15T12:30:00Z');

function message(id: string, body = id, createdAt = created): Message {
  return {id, body, createdAt, updatedAt: createdAt, deleted: false};
}

function thread(id: string, messages = [message(`${id}-primary`)]): Thread {
  return {schemaVersion: 1, id, revision: 1, filePath: `阅读/${id}.md`, fileMissing: false,
    anchor: {from: 0, to: 4, quote: '当前摘录', before: '', after: '', state: 'attached'},
    originalQuote: '创建时的原文', resolved: false, createdAt: created, updatedAt: created, messages};
}

function highlight(id: string): Highlight {
  return {id, revision: 1, filePath: `标记/${id}.md`, fileMissing: false,
    anchor: {from: 0, to: 4, quote: '当前标记', before: '', after: '', state: 'attached'},
    originalQuote: '创建时的原文', createdAt: created, updatedAt: created};
}

function entry(id: string, overrides: Partial<ReviewEntry> = {}): ReviewEntry {
  return {key: `comment:${id}`, kind: 'comment', id, threadId: id, filePath: `阅读/${id}.md`,
    body: id, quote: '创建时的原文', original: true, createdAt: created, updatedAt: created,
    resolved: false, fileMissing: false, detached: false, ...overrides};
}

function indexed(threads: readonly Thread[], highlights: readonly Highlight[] = []): ReviewIndex {
  const index = new ReviewIndex();
  index.sync(threads, highlights);
  return index;
}

function inTimezone<T>(timezone: string, operation: () => T): T {
  const previous = process.env.TZ;
  process.env.TZ = timezone;
  try { return operation(); }
  finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
}

function formats(groups: readonly ContentGroup[]): readonly string[] {
  return [exportContentMarkdown('阅读回顾', groups, '全部文档', exported),
    exportContentHtml('阅读回顾', groups, '全部文档', exported)];
}

test('同一讨论跨回复归组，相同摘录的不同讨论与每个标记均独立', () => {
  const a = thread('a', [message('primary-a'), message('reply-a')]);
  const b = thread('b');
  const index = indexed([a, b], [highlight('a'), highlight('b')]);
  const rows = [...index.search('comments', '', true), ...index.search('highlights', '', true)];
  const groups = contentGroups(rows);
  assert.equal(groups.length, 4);
  assert.deepEqual(new Set(groups.map(group => group.key)), new Set(['thread:a', 'thread:b', 'highlight:a', 'highlight:b']));
  assert.ok(groups.every(group => group.quote === '创建时的原文' && group.original));
  const discussion = groups.find(group => group.key === 'thread:a')!;
  assert.equal(discussion.threadId, 'a');
  assert.deepEqual(discussion.entries.map(row => row.id), ['primary-a', 'reply-a']);
  for (const row of rows) assert.ok(groups.some(group => group.entries.includes(row)), '分组复用原始记录引用');
  for (const group of groups.filter(group => group.key.startsWith('highlight:'))) {
    assert.equal(group.threadId, undefined);
    assert.equal(group.entries.length, 1);
    assert.equal(group.entries[0]!.kind, 'highlight');
  }
});

test('消息 timestamp 升序与 stable tie，分组按最新纳入消息倒序，编辑不改排序', () => {
  const primary = entry('primary', {threadId: 'a', createdAt: '2026-10-13T08:00:00Z', updatedAt: '2030-01-01T00:00:00Z'});
  const older = entry('older', {kind: 'reply', threadId: 'a', createdAt: '2026-10-14T23:30:00+08:00'});
  const tie1 = entry('tie-1', {kind: 'reply', threadId: 'a', createdAt: '2026-10-15T00:00:00+08:00'});
  const tie2 = entry('tie-2', {kind: 'reply', threadId: 'a', createdAt: '2026-10-14T16:00:00Z'});
  const middle = entry('middle', {createdAt: '2026-10-14T15:45:00Z'});
  const rows = Object.freeze([tie1, older, middle, tie2, primary]);
  const groups = contentGroups(rows);
  assert.deepEqual(groups.map(group => group.key), ['thread:a', 'thread:middle']);
  assert.deepEqual(groups[0]!.entries.map(row => row.id), ['primary', 'older', 'tie-1', 'tie-2']);
  assert.equal(groups[0]!.latest, tie2.createdAt);
  const primaryOnly = contentGroups(rows, false);
  assert.deepEqual(primaryOnly.map(group => group.key), ['thread:middle', 'thread:a']);
  assert.equal(primaryOnly[1]!.latest, primary.createdAt);
  assert.deepEqual(primaryOnly[1]!.entries, [primary]);
  const sameTime = contentGroups([entry('second'), entry('first')]);
  assert.deepEqual(sameTime.map(group => group.threadId), ['second', 'first']);
  assert.deepEqual(rows, [tie1, older, middle, tie2, primary]);
});

test('删除主评论不提升回复，关闭回复后无孤立组，删除记录没有日期或占位残留', () => {
  const removed = message('deleted-primary', '已删除正文', '2020-01-01T01:02:03Z');
  removed.deleted = true;
  const removedReply = {...message('deleted-reply', '删除回复正文', '2021-01-01T01:02:03Z'), deleted: true};
  const retained = message('retained', '保留的唯一回复', '2026-10-14T03:00:00Z');
  retained.updatedAt = '2026-10-14T04:00:00Z';
  const a = thread('deleted', [removed, removedReply, retained]);
  const allDeleted = thread('all-deleted', [{...message('no-entry', '全部删除'), deleted: true}]);
  const index = indexed([a, allDeleted]);
  const groups = contentGroups(index.search('comments', '', true));
  assert.equal(groups.length, 1);
  assert.equal(groups[0]!.entries[0]!.kind, 'reply');
  assert.equal(groups[0]!.latest, retained.createdAt);
  assert.deepEqual(contentGroups(index.search('comments', '', true), false), []);
  assert.deepEqual(contentGroups(index.search('comments', '', false)), []);
  for (const result of formats(groups)) {
    assert.equal(result.split('保留的唯一回复').length - 1, 1);
    assert.match(result, /编辑过/u);
    assert.doesNotMatch(result, /已删除正文|删除回复正文|全部删除|2020年|2021年|该消息已删除|主评论已删除/u);
    assert.match(result, /1 处摘录 · 1 条记录 · 1 篇文档/u);
  }
});

test('旧数据保留当前摘录与 original=false，保存摘录优先且状态和日期不改源对象', () => {
  const saved = thread('saved', [message('saved-primary'), message('saved-reply')]);
  saved.originalQuote = '历史原文';
  saved.anchor.quote = '重定位后的原文';
  saved.resolved = true;
  saved.fileMissing = true;
  saved.anchor.state = 'detached';
  const legacy = thread('legacy');
  delete legacy.originalQuote;
  const mark = highlight('legacy');
  delete mark.originalQuote;
  const before = structuredClone([saved, legacy, mark]);
  const index = indexed([saved, legacy], [mark]);
  const groups = contentGroups([...index.search('comments', '', true), ...index.search('highlights', '', true)]);
  const savedGroup = groups.find(group => group.threadId === 'saved')!;
  assert.equal(savedGroup.quote, '历史原文');
  assert.equal(savedGroup.original, true);
  assert.deepEqual([savedGroup.resolved, savedGroup.fileMissing, savedGroup.detached], [true, true, true]);
  assert.ok(savedGroup.entries.every(row => row.createdAt === created && row.updatedAt === created));
  assert.equal(groups.find(group => group.threadId === 'legacy')!.quote, legacy.anchor.quote);
  assert.equal(groups.find(group => group.threadId === 'legacy')!.original, false);
  assert.equal(groups.find(group => group.key === 'highlight:legacy')!.quote, mark.anchor.quote);
  assert.equal(groups.find(group => group.key === 'highlight:legacy')!.original, false);
  for (const result of formats(groups)) {
    assert.match(result, /创建时保存的原文/u);
    assert.match(result, /旧数据未保存原文/u);
    assert.doesNotMatch(result, /重定位后的原文/u);
  }
  assert.deepEqual([saved, legacy, mark], before);
  const partial = contentGroups([entry('fallback', {threadId: 'mixed', original: false, quote: '当前引用'}),
    entry('saved-reply', {threadId: 'mixed', kind: 'reply', quote: '保存引用', original: true})])[0]!;
  assert.equal(partial.quote, '保存引用');
  assert.equal(partial.original, true);
});

test('解决、文件缺失、脱离原文的全部组合均保留，纯标记没有评论处理状态', () => {
  const threads: Thread[] = [];
  const marks: Highlight[] = [];
  for (const resolved of [false, true]) for (const fileMissing of [false, true]) for (const detached of [false, true]) {
    const item = thread(`${resolved}-${fileMissing}-${detached}`);
    item.resolved = resolved;
    item.fileMissing = fileMissing;
    item.anchor.state = detached ? 'detached' : 'attached';
    threads.push(item);
  }
  for (const fileMissing of [false, true]) for (const detached of [false, true]) {
    const item = highlight(`${fileMissing}-${detached}`);
    item.fileMissing = fileMissing;
    item.anchor.state = detached ? 'detached' : 'attached';
    marks.push(item);
  }
  const index = indexed(threads, marks);
  const discussions = contentGroups(index.search('comments', '', true));
  const highlights = contentGroups(index.search('highlights', '', true), false);
  assert.equal(discussions.length, 8);
  assert.equal(highlights.length, 4);
  for (const group of discussions) {
    const source = threads.find(item => item.id === group.threadId)!;
    assert.deepEqual([group.resolved, group.fileMissing, group.detached],
      [source.resolved, source.fileMissing, source.anchor.state === 'detached']);
    for (const result of formats([group])) {
      assert.match(result, source.resolved ? /已解决/u : /未解决/u);
      assert.equal(result.includes('原文件已删除'), source.fileMissing);
      assert.equal(result.includes('原文位置失效'), source.anchor.state === 'detached');
      assert.equal(result.includes('打开原文件'), !source.fileMissing);
    }
  }
  for (const result of formats(highlights)) assert.doesNotMatch(result, /已解决|未解决/u);
});

test('只读结果冻结容器且复用 entry，重复 key 不增加记录，缺失 threadId 不猜测合并', () => {
  const primary = Object.freeze(entry('primary'));
  const reply = Object.freeze(entry('reply', {kind: 'reply', threadId: 'primary'}));
  const rows = Object.freeze([reply, primary, reply, primary]);
  const groups = contentGroups(rows);
  assert.ok(Object.isFrozen(groups));
  assert.ok(Object.isFrozen(groups[0]));
  assert.ok(Object.isFrozen(groups[0]!.entries));
  assert.deepEqual(groups[0]!.entries, [reply, primary]);
  assert.equal(groups[0]!.entries[0], reply);
  assert.equal(groups[0]!.entries[1], primary);
  const missing = contentGroups([entry('a', {threadId: undefined}), entry('b', {threadId: undefined})]);
  assert.deepEqual(missing.map(group => group.key), ['comment:a', 'comment:b']);
  assert.ok(missing.every(group => group.threadId === undefined));
  assert.ok(Object.isFrozen(contentGroups([])));
});

test('调用方按命中组键筛选时保留完整历史，本文件输入不会补出其他文档', () => {
  const a = thread('a', [message('main', '主想法'), message('hit', '匹配文字', '2026-10-14T08:00:00Z'),
    message('later', '后续想法', '2026-10-15T08:00:00Z')]);
  const b = thread('b', [message('other', '其他文件')]);
  const index = indexed([a, b]);
  const wanted = new Set(contentGroups(index.search('comments', '匹配文字', true)).map(group => group.key));
  const selected = contentGroups(index.search('comments', '', true)).filter(group => wanted.has(group.key));
  assert.equal(selected.length, 1);
  assert.deepEqual(selected[0]!.entries.map(row => row.body), ['主想法', '匹配文字', '后续想法']);
  const fileGroups = contentGroups(index.search('comments', '', true).filter(row => row.filePath === a.filePath));
  assert.deepEqual(fileGroups.map(group => group.key), ['thread:a']);
  for (const result of formats(selected)) {
    assert.match(result, /主想法/u);
    assert.match(result, /后续想法/u);
    assert.doesNotMatch(result, /其他文件/u);
  }
});

test('两万条消息分组不读取正文，引用和排序完整，多组数量准确', t => {
  const total = 20_000;
  const base = Date.parse(created);
  let reads = 0;
  const bodies = Array.from({length: total}, (_, i) => `正文 ${i} ${'完整保存评论。'.repeat(120)}`);
  const rows = Object.freeze(Array.from({length: total}, (_, i) => {
    const row = entry(`massive-${i}`, {kind: i === 0 ? 'comment' : 'reply', threadId: 'massive',
      createdAt: new Date(base + i * 1000).toISOString()});
    Object.defineProperty(row, 'body', {enumerable: true, get: () => { reads++; return bodies[i]!; }});
    return Object.freeze(row);
  }).reverse());
  const start = performance.now();
  const groups = contentGroups(rows);
  const elapsed = performance.now() - start;
  assert.equal(reads, 0, '排序和分组不接触两万条正文');
  assert.equal(groups.length, 1);
  assert.equal(groups[0]!.entries.length, total);
  assert.equal(groups[0]!.latest, rows[0]!.createdAt);
  for (const [i, row] of groups[0]!.entries.entries()) {
    assert.equal(row, rows[total - i - 1]);
    assert.equal(row.body, bodies[i]);
  }
  assert.equal(reads, total);
  const onlyPrimary = contentGroups(rows, false);
  assert.equal(onlyPrimary.length, 1);
  assert.equal(onlyPrimary[0]!.entries.length, 1);
  assert.equal(onlyPrimary[0]!.entries[0], rows.at(-1));
  const separate = contentGroups(Array.from({length: total}, (_, i) => entry(`separate-${i}`)));
  assert.equal(separate.length, total);
  t.diagnostic(`20000 条约 1 KB 正文：分组 ${elapsed.toFixed(2)} ms，正文读取 0 次；未设耗时门槛。`);
});

test('导出原文在上、评论连续，正文只一次，折叠详情没有作者、回复引用或标签', () => {
  const large = `巨长消息起点 ${'保存原有文字。'.repeat(20_000)} 巨长消息终点`;
  const a = thread('layout', [message('primary', large, '2026-10-13T08:00:00Z'),
    message('reply', '连续的后续消息', '2026-10-14T08:00:00Z')]);
  a.originalQuote = '唯一原文';
  Object.assign(a.messages[0]!, {author: 'AUTHOR_SENTINEL', replyTo: 'TARGET_SENTINEL', tags: ['TAG_SENTINEL']});
  a.messages[0]!.updatedAt = '2026-10-13T09:00:00Z';
  const groups = contentGroups(indexed([a]).search('comments', '', true));
  const md = exportContentMarkdown('阅读回顾', groups, '单文件', exported);
  const html = exportContentHtml('阅读回顾', groups, '单文件', exported);
  for (const result of [md, html]) {
    assert.equal(result.split('唯一原文').length - 1, 1);
    assert.equal(result.split('巨长消息起点').length - 1, 1);
    assert.equal(result.split('巨长消息终点').length - 1, 1);
    assert.equal(result.split('连续的后续消息').length - 1, 1);
    assert.ok(result.indexOf('唯一原文') < result.indexOf('巨长消息起点'));
    assert.ok(result.indexOf('巨长消息终点') < result.indexOf('连续的后续消息'));
    assert.match(result, /范围：单文件/u);
    assert.doesNotMatch(result, /AUTHOR_SENTINEL|TARGET_SENTINEL|TAG_SENTINEL|作者|回复对象|回复引用|标签/u);
  }
  assert.match(md, /> \[!info\]- 查看出处与记录/u);
  const htmlDetail = html.slice(html.indexOf('<details>'));
  assert.match(htmlDetail, /<summary>查看出处与记录<\/summary>/u);
  assert.doesNotMatch(htmlDetail, /巨长消息|连续的后续消息|唯一原文|<details[^>]* open/u);
  const beforeDetails = html.slice(html.indexOf('<article>'), html.indexOf('<details>'));
  assert.doesNotMatch(beforeDetails, /<time|创建时间|修改时间|相对路径|状态/u);
  assert.equal((html.match(/<section class="record-meta">/gu) ?? []).length, 2);
  assert.match(htmlDetail, /datetime="2026-10-13T09:00:00Z"/u);
});

test('MD 将原文和执行性语法变为文字，正文仅加粗、列表生效且有序编号保留', () => {
  const body = '<script>alert(1)</script>\r\n![[嵌入]]\n[链接](javascript:run())\n# 注入标题\n'
    + '> [!danger] 注入callout\n```js\n---\n*斜体* ~~删除线~~ `代码`\n$$数学$$\n%%隐藏%%\n^block\n'
    + '![图片](https://example.com/p.png)\nhttps://example.com/path\n&copy;\n{原样} ${VAR} %s\n'
    + '**重点**\n- **项目**\n+ 另一项\n* 第三项\n12. **步骤**\n14. 跳号\n999999999999999999999. 上限\n- [x] 惰性任务';
  const a = thread('escaped', [message('primary', body)]);
  a.originalQuote = '[!warning]\n![[原文]]\n**原文加粗惰性**\n<script>quote</script>';
  const md = exportContentMarkdown('[标题]\n# 第二标题', contentGroups(indexed([a]).search('comments', '', true)),
    '> [!danger]\r\n# 恶意范围', exported);
  assert.equal((md.match(/^# /gmu) ?? []).length, 1);
  assert.match(md, /^# \\\[标题\\\] \\# 第二标题/gmu);
  for (const text of ['\\<script\\>alert\\(1\\)\\</script\\>', '\\!\\[\\[嵌入\\]\\]',
    '\\[链接\\]\\(javascript\\:run\\(\\)\\)', '\\> \\[\\!danger\\] 注入callout', '\\`\\`\\`js',
    '\\$\\$数学\\$\\$', '\\%\\%隐藏\\%\\%', '\\^block', 'https\\://example\\.com/path',
    '\\&copy;', '\\{原样\\} \\$\\{VAR\\} \\%s']) assert.ok(md.includes(text), text);
  assert.ok(md.includes('**重点**  \n- **项目**\n- 另一项\n- 第三项\n12. **步骤**\n14. 跳号\n9999. 上限\n- \\[x\\] 惰性任务'));
  assert.ok(md.includes('> \\*\\*原文加粗惰性\\*\\*'));
  assert.doesNotMatch(md, /^<script>|^```|^\$\$|^%%|^> \[!danger\]|^> \[!warning\]|!\[\[/gmu);
});

test('HTML 文字安全、仅加粗列表有样式，不执行链接、嵌入、脚本和占位变量', () => {
  const a = thread('html', [message('primary', '**重点**\r\n12. 步骤\n14. 跳号\n- 项目\n- [x] 任务\n'
    + '<img src="https://example.com/a.png" onerror="attack()">\n</style><script>attack()</script>\n'
    + '[运行](javascript:evil()) ![[嵌入]] $$数学$$ %%注释%% `代码`\n'
    + 'https://example.com/plain {评论} ${VAR} %s &copy;')]);
  a.originalQuote = '**原文惰性**\n<svg onload="attack()">原文 & 内容</svg>';
  const html = exportContentHtml('<title>标题</title>', contentGroups(indexed([a]).search('comments', '', true)),
    '</p><iframe src="https://example.com"></iframe>', exported);
  assert.ok(html.includes('<strong>重点</strong>'));
  assert.ok(html.includes('<ol start="12"><li value="12">步骤</li><li value="14">跳号</li></ol>'));
  assert.ok(html.includes('<ul><li>项目</li><li>[x] 任务</li></ul>'));
  assert.ok(html.includes('&lt;img src=&quot;https://example.com/a.png&quot; onerror=&quot;attack()&quot;&gt;'));
  assert.ok(html.includes('&lt;/style&gt;&lt;script&gt;attack()&lt;/script&gt;'));
  assert.ok(html.includes('[运行](javascript:evil()) ![[嵌入]] $$数学$$ %%注释%% `代码`'));
  assert.ok(html.includes('https://example.com/plain {评论} ${VAR} %s &amp;copy;'));
  assert.ok(html.includes('**原文惰性**\n&lt;svg onload=&quot;attack()&quot;&gt;原文 &amp; 内容&lt;/svg&gt;'));
  assert.doesNotMatch(html, /<(?:script|iframe|img|svg|math|link|input|button)\b|\son[a-z]+="|href="(?:https?:|javascript:|data:|obsidian:)/iu);
  assert.equal((html.match(/<style>/gu) ?? []).length, 1);
  assert.equal((html.match(/<title>/gu) ?? []).length, 1);
});

test('原文件链接只用编码后的 ./ 路径，危险路径和缺失文件不生成链接', () => {
  const path = '目录/javascript:笔记 [a] #?&%\'().md';
  const row = entry('path', {filePath: path});
  const groups = contentGroups([row]);
  const encoded = './' + path.split('/').map(part => encodeURIComponent(part)
    .replace(/[!'()*]/gu, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)).join('/');
  const md = exportContentMarkdown('回顾', groups, '全部文档', exported);
  const html = exportContentHtml('回顾', groups, '全部文档', exported);
  assert.ok(md.includes(`[打开原文件](<${encoded}>)`));
  assert.ok(html.includes(`<a href="${encoded}">打开原文件</a>`));
  assert.ok(encoded.includes('%23%3F%26%25%27%28%29'));
  for (const unsafe of ['../outside.md', './note.md', '/root.md', 'a//b.md', 'a\\b.md', '//example.com/a.md',
    'a\u0000b.md', 'https://example.com/a.md', 'script.html']) {
    for (const result of formats(contentGroups([entry('unsafe', {filePath: unsafe})]))) {
      assert.doesNotMatch(result, /打开原文件/u, unsafe);
    }
  }
  for (const result of formats(contentGroups([entry('missing', {filePath: path, fileMissing: true})]))) {
    assert.doesNotMatch(result, /打开原文件/u);
    assert.match(result, /原文件已删除/u);
  }
  const schemeName = contentGroups([entry('scheme', {filePath: 'javascript:alert(1).md'})]);
  assert.ok(exportContentHtml('回顾', schemeName, '全部文档', exported).includes('href="./javascript%3Aalert%281%29.md"'));
  const dataName = contentGroups([entry('data', {filePath: 'data:text/html,<script>.md'})]);
  assert.ok(exportContentHtml('回顾', dataName, '全部文档', exported).includes('href="./data%3Atext/html%2C%3Cscript%3E.md"'));
});

test('各条 createdAt 和 edited updatedAt 在本地时区展示，相同 timestamp 不误报编辑', () => {
  inTimezone('Asia/Shanghai', () => {
    const a = thread('time', [message('primary', '首条', '2026-10-14T16:30:00Z'),
      message('reply', '第二条', '2026-10-15T00:31:00+08:00')]);
    a.messages[0]!.updatedAt = '2026-10-14T17:00:00Z';
    a.messages[1]!.updatedAt = '2026-10-14T16:31:00Z';
    const groups = contentGroups(indexed([a]).search('comments', '', true));
    for (const result of formats(groups)) {
      assert.match(result, /2026年10月15日 00:30:00/u);
      assert.match(result, /2026年10月15日 00:31:00/u);
      assert.match(result, /2026年10月15日 01:00:00/u);
      assert.match(result, /2026年10月15日 20:30:00/u);
      assert.equal(result.split('编辑过').length - 1, 1);
    }
  });
});

test('标记仅呈现一份摘录；空集合不出组、正文、来源链接或虚构记录', () => {
  const a = highlight('single');
  a.originalQuote = '唯一标记摘录';
  const groups = contentGroups(indexed([], [a]).search('highlights', '', true));
  for (const result of formats(groups)) {
    assert.equal(result.split('唯一标记摘录').length - 1, 1);
    assert.doesNotMatch(result, /当前标记|已解决|未解决/u);
  }
  assert.doesNotMatch(exportContentHtml('标记', groups, '标记范围', exported), /class="message"/u);
  for (const result of formats(contentGroups([]))) {
    assert.match(result, /0 处摘录 · 0 条记录 · 0 篇文档/u);
    assert.doesNotMatch(result, /<article|<blockquote|<details|\[!info\]|打开原文件|记录 1/u);
  }
  const phantom: ContentGroup = {...groups[0]!, entries: []};
  for (const result of formats([phantom])) {
    assert.match(result, /0 处摘录 · 0 条记录 · 0 篇文档/u);
    assert.doesNotMatch(result, /唯一标记摘录|打开原文件/u);
  }
});

test('无效日期稳定落后，保留有效消息；HTML 自包含、系统主题与显式深色及打印样式', () => {
  const rows = [entry('invalid', {createdAt: 'invalid', updatedAt: 'invalid'}), entry('valid')];
  const groups = contentGroups(rows);
  assert.deepEqual(groups.map(group => group.threadId), ['valid', 'invalid']);
  assert.equal(groups[1]!.latest, 'invalid');
  const html = exportContentHtml('主题', groups, '全部文档', new Date('invalid'));
  assert.match(html, /日期未知/u);
  assert.match(html, /font:15px\/1\.8/u);
  assert.match(html, /max-width:760px/u);
  assert.match(html, /@media\(prefers-color-scheme:dark\)/u);
  assert.match(html, /@media print/u);
  assert.match(html, /details:not\(\[open\]\)>\*/u);
  assert.doesNotMatch(html, /<html[^>]*data-theme=|<script|@import|url\(/u);
  assert.match(exportContentHtml('主题', groups, '全部文档', exported, true), /<html lang="zh-CN" data-theme="dark">/u);
  assert.match(exportContentMarkdown('回顾', groups, '全部文档', new Date('invalid')), /日期未知/u);
});
