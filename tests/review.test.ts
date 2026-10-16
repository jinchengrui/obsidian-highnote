import {test} from 'node:test';
import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import type {Highlight, Message, Thread} from '../src/model';
import {ReviewIndex, dateLabel, localDay} from '../src/review-model';

type Saved<T> = T & {originalQuote?: string};
const created = '2026-10-13T08:00:00Z';

function message(id: string, body = id, createdAt = created): Message {
  return {id, body, createdAt, updatedAt: createdAt, deleted: false};
}

function thread(id: string, messages = [message(`${id}-primary`)]): Saved<Thread> {
  return {schemaVersion: 1, id, revision: 1, filePath: `阅读/${id}.md`, fileMissing: false,
    anchor: {from: 0, to: 4, quote: '当前摘录', before: '', after: '', state: 'attached'},
    resolved: false, createdAt: created, updatedAt: created, messages};
}

function highlight(id: string): Saved<Highlight> {
  return {id, revision: 1, filePath: `标记/${id}.md`, fileMissing: false,
    anchor: {from: 0, to: 4, quote: '标记摘录', before: '', after: '', state: 'attached'},
    createdAt: created, updatedAt: created};
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

void test('跨日回复使用自己的创建时间，编辑不改变顺序，时间按 timestamp 而非字符串比较', () => {
  const item = thread('days', [message('primary', '主评论', '2026-10-13T08:00:00Z'),
    message('reply-day1', '较早回复', '2026-10-14T23:30:00+08:00'),
    message('reply-day2', '较晚回复', '2026-10-14T16:00:00Z')]);
  item.messages[0]!.updatedAt = '2026-10-16T00:00:00Z';
  const index = new ReviewIndex();
  index.sync([item], []);
  const entries = index.search('comments', '');
  assert.deepEqual(entries.map(entry => entry.id), ['reply-day2', 'reply-day1', 'primary']);
  assert.deepEqual(entries.map(entry => entry.kind), ['reply', 'reply', 'comment']);
  assert.equal(entries[2]!.createdAt, item.messages[0]!.createdAt);
  assert.equal(entries[2]!.updatedAt, item.messages[0]!.updatedAt);
  assert.deepEqual(index.search('comments', '', false).map(entry => entry.id), ['primary']);
});

void test('第一消息删除后剩余仍是回复，删除与全部删除的消息均排除', () => {
  const item = thread('deleted', [message('primary', '删除正文'), message('reply', '保留回复')]);
  item.messages[0]!.deleted = true;
  const empty = thread('empty', [{...message('empty-primary'), deleted: true}]);
  const index = new ReviewIndex();
  index.sync([item, empty], []);
  assert.deepEqual(index.search('comments', '').map(entry => [entry.id, entry.kind]), [['reply', 'reply']]);
  assert.equal(index.search('comments', '删除正文').length, 0);
  assert.equal(index.search('comments', '', false).length, 0);
  assert.equal(index.getThread('empty'), empty);
});

void test('所有解决、缺失、定位状态均进入回顾，标记正文是摘录', () => {
  const items: Thread[] = [];
  const marks: Highlight[] = [];
  for (const resolved of [false, true]) for (const fileMissing of [false, true]) for (const detached of [false, true]) {
    const item = thread(`${resolved}-${fileMissing}-${detached}`);
    item.resolved = resolved;
    item.fileMissing = fileMissing;
    item.anchor.state = detached ? 'detached' : 'attached';
    items.push(item);
  }
  for (const fileMissing of [false, true]) for (const detached of [false, true]) {
    const mark = highlight(`${fileMissing}-${detached}`);
    mark.fileMissing = fileMissing;
    mark.anchor.state = detached ? 'detached' : 'attached';
    marks.push(mark);
  }
  const index = new ReviewIndex();
  index.sync(items, marks);
  assert.equal(index.search('comments', '').length, 8);
  for (const item of items) {
    const entry = index.search('comments', '').find(row => row.threadId === item.id)!;
    assert.deepEqual([entry.resolved, entry.fileMissing, entry.detached],
      [item.resolved, item.fileMissing, item.anchor.state === 'detached']);
  }
  assert.equal(index.search('highlights', '').length, 4);
  for (const entry of index.search('highlights', '', false)) {
    assert.equal(entry.body, entry.quote);
    assert.equal(entry.resolved, false);
    assert.equal(entry.threadId, undefined);
  }
});

void test('originalQuote 优先且回复共享摘录，搜索同时涵盖保存摘录和当前 anchor', () => {
  const item = thread('original', [message('primary', '正文'), message('reply', '回复')]);
  item.originalQuote = '初始保存 Passage';
  item.anchor.quote = '重定位 Current';
  const mark = highlight('original');
  mark.originalQuote = '标记保存 Original';
  mark.anchor.quote = '标记现在 Anchor';
  const fallback = thread('fallback');
  const emptyOriginal = highlight('empty-saved');
  emptyOriginal.originalQuote = '';
  const index = new ReviewIndex();
  index.sync([item, fallback], [mark, emptyOriginal]);
  for (const query of ['初始保存', 'PASSAGE', '重定位', 'current']) {
    const entries = index.search('comments', query);
    assert.equal(entries.length, 2);
    assert.ok(entries.every(entry => entry.original && entry.quote === item.originalQuote));
  }
  const fallbackEntry = index.search('comments', 'fallback')[0]!;
  assert.equal(fallbackEntry.quote, fallback.anchor.quote);
  assert.equal(fallbackEntry.original, false);
  assert.equal(index.search('highlights', 'Original')[0]!.body, mark.originalQuote);
  assert.equal(index.search('highlights', 'Anchor')[0]!.quote, mark.originalQuote);
  assert.equal(index.search('highlights', 'empty-saved')[0]!.original, true);
  assert.equal(index.search('highlights', 'empty-saved')[0]!.quote, '');
});

void test('搜索正文、相对路径和 filename，忽略大小写及首尾空白，缓存只读结果身份', () => {
  const item = thread('index', [message('body', '正文 OnlyBody')]);
  item.filePath = 'Books/Folder/UniqueNote.md';
  const index = new ReviewIndex();
  assert.equal(index.version, 0);
  assert.equal(index.sync([], []), false);
  assert.equal(index.sync([item], []), true);
  const result = index.search('comments', 'ONLYBODY');
  assert.equal(result, index.search('comments', ' onlybody '));
  assert.equal(result.length, 1);
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result[0]));
  assert.equal(index.search('comments', 'Folder/Unique').length, 1);
  assert.equal(index.search('comments', 'uniquenote.md').length, 1);
  assert.equal(index.search('highlights', 'OnlyBody').length, 0);
  assert.equal(index.search('comments', '不存在'), index.search('comments', '不存在'));
  assert.equal(index.sync([item], []), false);
  assert.equal(index.search('comments', 'OnlyBody'), result);
  assert.equal(index.version, 1);
});

void test('同一引用 revision 更新和新引用触发刷新，未变化消息保持对象身份', () => {
  const a = thread('a', [message('a-primary', '原主正文'), message('a-reply', '原回复')]);
  const b = thread('b');
  const index = new ReviewIndex();
  index.sync([a, b], []);
  const before = index.search('comments', '');
  const first = before.find(entry => entry.id === 'a-primary')!;
  const untouched = before.find(entry => entry.threadId === b.id)!;
  a.messages[1]!.body = '修改回复';
  a.messages[1]!.updatedAt = '2026-10-16T01:00:00Z';
  a.revision++;
  assert.equal(index.sync([a, b], []), true);
  const after = index.search('comments', '');
  assert.notEqual(after, before);
  assert.equal(after.find(entry => entry.id === first.id), first);
  assert.equal(after.find(entry => entry.id === untouched.id), untouched);
  assert.equal(before.find(entry => entry.id === 'a-reply')!.body, '原回复');
  assert.equal(index.search('comments', '原回复').length, 0);
  assert.equal(index.search('comments', '修改回复')[0]!.updatedAt, a.messages[1]!.updatedAt);
  const next = {...a, filePath: '新路径/重命名.md'};
  assert.equal(index.sync([next, b], []), true);
  assert.equal(index.getThread(a.id), next);
  assert.equal(index.search('comments', '重命名').length, 2);
  assert.equal(index.search('comments', '阅读/a.md').length, 0);
  assert.equal(index.version, 3);
});

void test('当前 anchor 单独变化仍使搜索缓存失效并保留未变的展示记录', () => {
  const item = thread('anchor');
  item.originalQuote = '固定保存摘录';
  const index = new ReviewIndex();
  index.sync([item], []);
  const before = index.search('comments', '当前摘录');
  item.anchor.quote = '新定位关键词';
  item.revision++;
  assert.equal(index.sync([item], []), true);
  assert.equal(index.search('comments', '当前摘录').length, 0);
  assert.equal(index.search('comments', '新定位关键词')[0], before[0]);
});

void test('增量索引移除消失和删除记录，合并/移动保留消息 key 且没有旧讨论残留', () => {
  const source = thread('source', [message('source-primary', '源评论'), message('moving', '移动回复')]);
  const target = thread('target', [message('target-primary', '目标评论')]);
  const mark = highlight('removed');
  const index = new ReviewIndex();
  index.sync([source, target], [mark]);
  const stableKey = index.search('comments', '移动回复')[0]!.key;
  target.messages.push(source.messages[1]!);
  target.revision++;
  assert.equal(index.sync([target], []), true);
  assert.equal(index.getThread('source'), undefined);
  assert.equal(index.search('comments', '源评论').length, 0);
  assert.equal(index.search('highlights', '').length, 0);
  const moved = index.search('comments', '移动回复');
  assert.equal(moved.length, 1);
  assert.equal(moved[0]!.key, stableKey);
  assert.equal(moved[0]!.threadId, target.id);
  assert.equal(moved[0]!.filePath, target.filePath);
  target.messages[1]!.deleted = true;
  target.revision++;
  index.sync([target], []);
  assert.equal(index.search('comments', '移动回复').length, 0);
  target.messages.push(message('new-reply', '新回复', '2026-10-17T00:00:00Z'));
  target.revision++;
  index.sync([target], []);
  assert.equal(index.search('comments', '')[0]!.id, 'new-reply');
  index.sync([], []);
  assert.equal(index.search('comments', '').length, 0);
  assert.equal(index.getThread(target.id), undefined);
});

void test('标记重命名、合并与删除更新搜索且保持未修改记录身份', () => {
  const a = highlight('a');
  const b = highlight('b');
  const index = new ReviewIndex();
  index.sync([], [a, b]);
  const untouched = index.search('highlights', '').find(entry => entry.id === b.id)!;
  const key = index.search('highlights', '').find(entry => entry.id === a.id)!.key;
  a.filePath = '新目录/新文件.md';
  a.anchor.quote = '合并后的摘录';
  a.revision++;
  index.sync([], [a, b]);
  assert.equal(index.search('highlights', '新文件')[0]!.key, key);
  assert.equal(index.search('highlights', '标记/a.md').length, 0);
  assert.equal(index.search('highlights', '').find(entry => entry.id === b.id), untouched);
  a.anchor.quote = '全部合并摘录';
  a.revision++;
  index.sync([], [a]);
  assert.deepEqual(index.search('highlights', '').map(entry => entry.id), [a.id]);
  assert.equal(index.search('highlights', '标记/b.md').length, 0);
});

void test('clear 清空源引用、查询和索引，版本只在数据变化时增加', () => {
  const item = thread('clear');
  const index = new ReviewIndex();
  index.sync([item], [highlight('clear')]);
  const prior = index.search('comments', '');
  index.clear();
  assert.equal(index.version, 2);
  assert.equal(index.getThread(item.id), undefined);
  assert.equal(index.search('comments', '').length, 0);
  assert.equal(index.search('highlights', '').length, 0);
  assert.equal(prior.length, 1);
  index.clear();
  assert.equal(index.version, 2);
  assert.equal(index.sync([item], []), true);
  assert.equal(index.search('comments', '').length, 1);
  assert.equal(index.version, 3);
});

void test('日期助手按本地自然日处理东西半球和夏令时边界，日标签不二次偏移', () => {
  inTimezone('Asia/Shanghai', () => {
    assert.equal(localDay('2026-10-14T15:59:59Z'), '2026-10-14');
    assert.equal(localDay('2026-10-14T16:00:00Z'), '2026-10-15');
    assert.equal(dateLabel('2026-10-15'), '2026年10月15日');
  });
  inTimezone('America/Los_Angeles', () => {
    assert.equal(localDay('2026-10-15T06:59:59Z'), '2026-10-14');
    assert.equal(localDay('2026-10-15T07:00:00Z'), '2026-10-15');
    assert.equal(localDay('2026-03-08T09:59:59Z'), '2026-03-08');
    assert.equal(localDay('2026-03-08T10:00:00Z'), '2026-03-08');
    assert.equal(dateLabel('2026-10-15'), '2026年10月15日');
  });
  assert.equal(localDay('invalid'), '');
  assert.equal(dateLabel('2026-02-30'), '日期未知');
  assert.equal(dateLabel('2026-13-01'), '日期未知');
});

void test('最多两万条的合成性能记录：缓存身份、增量更新不重读未变化正文', t => {
  const total = 20_000;
  let reads = 0;
  const base = Date.parse(created);
  const items = Array.from({length: total}, (_, i) => {
    const value = message(`m-${i}`, '', new Date(base + i * 1000).toISOString());
    const body = `合成正文 ${i} ${'长正文用来记录阅读想法。'.repeat(28)}`;
    assert.ok(Buffer.byteLength(body, 'utf8') >= 1000 && Buffer.byteLength(body, 'utf8') < 1100);
    Object.defineProperty(value, 'body', {enumerable: true, get: () => { reads++; return body; }});
    return thread(`synthetic-${i}`, [value]);
  });
  const index = new ReviewIndex();
  let start = performance.now();
  index.sync(items, []);
  const initialMs = performance.now() - start;
  assert.equal(reads, total);
  const before = index.search('comments', '');
  assert.equal(before.length, total);
  start = performance.now();
  const searched = index.search('comments', '合成正文');
  const searchMs = performance.now() - start;
  start = performance.now();
  for (let i = 0; i < 1000; i++) assert.equal(index.search('comments', '合成正文'), searched);
  const cachedMs = performance.now() - start;
  start = performance.now();
  assert.equal(index.sync([...items], []), false);
  const unchangedMs = performance.now() - start;
  assert.equal(reads, total);
  assert.equal(index.search('comments', ''), before);
  const middle = Math.floor(total / 2);
  const changed = {...items[middle]!, revision: 2, messages: [message(`m-${middle}`, '增量新正文', '2026-10-20T00:00:00Z')]};
  const next = [...items];
  next[middle] = changed;
  start = performance.now();
  assert.equal(index.sync(next, []), true);
  const incrementalMs = performance.now() - start;
  const after = index.search('comments', '');
  assert.notEqual(after, before);
  assert.equal(after[0]!.id, `m-${middle}`);
  assert.equal(after[1], before[0]);
  assert.equal(reads, total, '增量刷新不再读取其他 19999 条正文');
  assert.equal(index.search('comments', '合成正文').length, total - 1);
  assert.equal(index.search('comments', '增量新正文').length, 1);
  assert.equal(index.version, 2);
  t.diagnostic(`20000 条，每条约 1 KB：初次同步 ${initialMs.toFixed(2)} ms，首次搜索 ${searchMs.toFixed(2)} ms，`
    + `1000 次缓存 ${cachedMs.toFixed(2)} ms，同输入同步 ${unchangedMs.toFixed(2)} ms，单条增量 ${incrementalMs.toFixed(2)} ms；未设耗时门槛。`);
});
