import {test} from 'node:test';
import assert from 'node:assert/strict';
import {annotationOrder, fileLabels, MessageBatches, MESSAGE_BATCH_SIZE} from '../src/sidebar-model';
import type {Thread} from '../src/model';

test('original order keeps missing and detached annotations at the end of each file', () => {
  const item = (id: string, path: string, from: number, state = 'attached', missing = false) =>
    ({id, filePath: path, anchor: {from, state}, fileMissing: missing, createdAt: '2026-01-01'} as Thread);
  const records = [item('lost', 'a.md', 0, 'detached'), item('later', 'a.md', 80),
    item('missing', 'b.md', 0, 'attached', true), item('earlier', 'a.md', 5), item('b', 'b.md', 90)];
  assert.deepEqual(records.sort(annotationOrder(true)).map(t => t.id), ['earlier', 'later', 'lost', 'b', 'missing']);
  assert.deepEqual(records.filter(t => t.filePath === 'a.md').sort(annotationOrder(false)).map(t => t.id), ['earlier', 'later', 'lost']);
});

test('duplicate names use sufficient parents even when immediate parents repeat', () => {
  const paths = ['笔记.md', '甲/笔记.md', '乙/笔记.md', '甲/阅读/同名.md', '乙/阅读/同名.md', '目录/唯一.md'];
  const labels = fileLabels(paths);
  assert.equal(labels.get('笔记.md'), '笔记.md');
  assert.equal(labels.get('甲/笔记.md'), '甲/笔记.md');
  assert.equal(labels.get('乙/笔记.md'), '乙/笔记.md');
  assert.equal(labels.get('甲/阅读/同名.md'), '甲/阅读/同名.md');
  assert.equal(labels.get('乙/阅读/同名.md'), '乙/阅读/同名.md');
  assert.equal(labels.get('目录/唯一.md'), '唯一.md');
  assert.equal(fileLabels(['a.md', 'a.md']).size, 1);
});

function discussion(id: string, count: number): Thread {
  return {id, revision: 1, messages: Array.from({length: count}, (_, index) => ({
    id: `${id}-${index}`, body: `第 ${index + 1} 条\n第二行\n第三行\n第四行全文`, deleted: false,
    createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z'
  }))} as Thread;
}

test('1000 live messages have 25 bounded batches and every complete body remains reachable', () => {
  const batches = new MessageBatches();
  const thread = discussion('long', 1000);
  assert.equal(batches.get(thread).messages.length, 40);
  assert.equal(batches.get(thread).pages, 25);
  const bodies: string[] = [];
  for (let page = 0; page < 25; page++) {
    batches.setPage(thread, page);
    const batch = batches.get(thread);
    assert.ok(batch.messages.length <= MESSAGE_BATCH_SIZE);
    assert.equal(batch.start, page * 40);
    bodies.push(...batch.messages.map(message => message.body));
  }
  assert.deepEqual(bodies, thread.messages.map(message => message.body));
});

test('message targeting survives preceding deletions and deleting the tail clamps its page', () => {
  const batches = new MessageBatches();
  const thread = discussion('long', 81);
  batches.reveal(thread, 'long-80');
  assert.equal(batches.get(thread).page, 2);
  thread.messages[0]!.deleted = true;
  thread.revision++;
  assert.equal(batches.get(thread).page, 1);
  assert.equal(batches.get(thread).messageId, 'long-80');
  assert.ok(batches.get(thread).messages.some(message => message.id === 'long-80'));
  thread.messages[80]!.deleted = true;
  thread.revision++;
  const corrected = batches.get(thread);
  assert.equal(corrected.page, 1);
  assert.equal(corrected.messageId, '');
  assert.equal(corrected.total, 79);
  assert.equal(corrected.messages.length, 39);
});

test('page-only tail deletion, partial tails and new replies keep page bounds correct', () => {
  const batches = new MessageBatches();
  const thread = discussion('long', 81);
  batches.setPage(thread, 2);
  assert.equal(batches.get(thread).messages.length, 1);
  thread.messages[80]!.deleted = true;
  thread.revision++;
  assert.equal(batches.get(thread).page, 1);
  const reply = {...thread.messages[0]!, id: 'new-reply', deleted: false, body: '新回复全文'};
  thread.messages.push(reply);
  thread.revision++;
  batches.reveal(thread, reply.id);
  assert.equal(batches.get(thread).page, 2);
  assert.deepEqual(batches.get(thread).messages.map(message => message.body), ['新回复全文']);
  for (const message of thread.messages) message.deleted = true;
  thread.revision++;
  assert.equal(batches.get(thread).page, 0);
  assert.deepEqual(batches.get(thread).messages, []);
});

test('discussion states are independent and cached messages refresh after edits or source replacement', () => {
  const batches = new MessageBatches();
  const first = discussion('first', 1000);
  const second = discussion('second', 1000);
  batches.setPage(first, 24);
  batches.setPage(second, 1);
  first.messages[960]!.body = '编辑后的全文';
  first.revision++;
  assert.equal(batches.get(first).messages[0]!.body, '编辑后的全文');
  assert.equal(batches.get(first).page, 24);
  assert.equal(batches.get(second).page, 1);
  const replacement = {...first, messages: first.messages.map(message => ({...message}))};
  replacement.messages[960]!.deleted = true;
  assert.equal(batches.get(replacement).messages[0]!.id, 'first-961');
  batches.delete(first.id);
  assert.equal(batches.get(first).page, 0);
});

test('batch state is capped and recently used discussions keep their page', () => {
  const batches = new MessageBatches(2);
  const first = discussion('first', 100);
  const second = discussion('second', 100);
  const third = discussion('third', 100);
  batches.setPage(first, 1);
  batches.setPage(second, 2);
  batches.get(first);
  batches.setPage(third, 1);
  assert.equal(batches.get(first).page, 1);
  assert.equal(batches.get(second).page, 0);
});

test('appended messages reveal the new tail while explicit targeting can return to an earlier message', () => {
  const batches = new MessageBatches();
  const thread = discussion('long', 1000);
  batches.get(thread);
  thread.messages.push({...thread.messages[0]!, id: 'appended', body: '外部新增全文'});
  thread.revision++;
  assert.equal(batches.get(thread).page, 25);
  assert.equal(batches.get(thread).messageId, 'appended');
  batches.reveal(thread, 'long-10');
  assert.equal(batches.get(thread).page, 0);
  assert.equal(batches.get(thread).messageId, 'long-10');
});
