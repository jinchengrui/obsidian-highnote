import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ChangeSet, EditorState, Transaction } from '@codemirror/state';
import { Window } from 'happy-dom';
import { makeAnchor, mapAnchor, observedEditorChange, relocateAnchor } from '../src/anchors';
import { deleteMessage, parseThread } from '../src/model';
import { ThreadStore, type ThreadFiles } from '../src/store';
import { renderMessage, renderSummary } from '../src/format';

function edit(source: string, from: number, to: number, insert: string) {
  const changes = ChangeSet.of({from, to, insert}, source.length);
  return {changes, after: source.slice(0, from) + insert + source.slice(to)};
}
function memoryStore() {
  const data = new Map<string, string>();
  const errors: unknown[] = [];
  const files: ThreadFiles = {
    list: () => Promise.resolve([...data.keys()]),
    read: id => data.has(id) ? Promise.resolve(data.get(id)!) : Promise.reject(new Error('不存在')),
    create: (id, text) => { if (data.has(id)) throw new Error('duplicate'); data.set(id, text); return Promise.resolve(); },
    compareAndWrite: (id, expected, next) => {
      if (data.get(id) !== expected) return Promise.reject(new Error('conflict'));
      data.set(id, next); return Promise.resolve();
    }
  };
  return {data, errors, store: new ThreadStore(files, () => {}, error => errors.push(error))};
}

test('insertion before a quote keeps the same passage, including Unicode', () => {
  const source = '标题\n🍊这里是评论原文，后面还有内容';
  const from = source.indexOf('这里');
  const anchor = makeAnchor(source, from, from + 7);
  const change = edit(source, 0, 0, '新增\n');
  const next = mapAnchor(anchor, source, change.after, change.changes);
  assert.equal(next.state, 'attached'); assert.equal(next.from, from + 3); assert.equal(next.quote, anchor.quote);
});
test('small edits inside the passage follow the observed editor transaction', () => {
  const source = '前文。评论原文。后文';
  const anchor = makeAnchor(source, 3, 7);
  const change = edit(source, 5, 5, '新的');
  const next = mapAnchor(anchor, source, change.after, change.changes);
  assert.equal(next.quote, '评论新的原文'); assert.equal(next.state, 'attached');
});
test('complete deletion or replacement detaches and preserves the original quote', () => {
  const source = '前文 原文 后文 原文';
  const anchor = makeAnchor(source, 3, 5);
  for (const insert of ['', '另一段', '原文']) {
    const change = edit(source, 3, 5, insert);
    const next = mapAnchor(anchor, source, change.after, change.changes);
    assert.equal(next.state, 'detached'); assert.equal(next.quote, '原文');
  }
});
test('focused background document synchronization preserves an unchanged original passage', () => {
  const source = '旧前文目标原文旧后文';
  const anchor = makeAnchor(source, 3, 7);
  const state = EditorState.create({doc: source});
  for (const after of ['新前文目标原文新后文', '新增前文目标原文新的后文']) {
    const transaction = state.update({changes: {from: 0, to: source.length, insert: after}});
    const change = observedEditorChange(transaction, 'note.md', 'note.md', 'note.md', true, true)!;
    assert.equal(change.userEdit, false);
    const next = mapAnchor(anchor, change.before, change.after, change.changes, change.userEdit);
    assert.equal(next.state, 'attached'); assert.equal(next.quote, anchor.quote);
    assert.equal(next.from, after.indexOf(anchor.quote));
    assert.equal(next.before, after.slice(0, next.from));
  }
});
test('focused user replacements remain destructive, including replacement with identical text', () => {
  const source = '前文目标原文后文';
  const anchor = makeAnchor(source, 2, 6);
  const state = EditorState.create({doc: source});
  for (const replacement of [
    {from: anchor.from, to: anchor.to, insert: '另一段'},
    {from: anchor.from, to: anchor.to, insert: anchor.quote},
    {from: 0, to: source.length, insert: '修改前文目标原文后文'}
  ]) {
    const transaction = state.update({changes: replacement, userEvent: 'input.paste'});
    const change = observedEditorChange(transaction, 'note.md', 'note.md', 'note.md', true, true)!;
    assert.equal(change.userEdit, true);
    const next = mapAnchor(anchor, change.before, change.after, change.changes, change.userEdit);
    assert.equal(next.state, 'detached'); assert.equal(next.quote, anchor.quote);
  }
});
test('background replacement rejects deleted passages and ambiguous identical copies', () => {
  for (const [source, from, to, after] of [
    ['前文原文后文', 2, 4, '前文另一段后文'],
    ['原文 原文', 0, 2, '原文'],
    ['原文 原文', 3, 5, '原文'],
    ['前文原文后文', 2, 4, '前文原文后文 原文']
  ] as const) {
    const anchor = makeAnchor(source, from, to);
    const change = edit(source, 0, source.length, after);
    const next = mapAnchor(anchor, source, change.after, change.changes, false);
    assert.equal(next.state, 'detached'); assert.equal(next.quote, anchor.quote);
  }
  const source = '前文原文后文 原文';
  const anchor = makeAnchor(source, 2, 4);
  const deletion = edit(source, 2, 4, '');
  assert.equal(mapAnchor(anchor, source, deletion.after, deletion.changes, false).state, 'detached');
});
test('editor observation isolates path switches and retains same-path background changes', () => {
  const state = EditorState.create({doc: '原文'});
  const transaction = state.update({changes: {from: 0, insert: '新增'}, userEvent: 'input.type'});
  for (const paths of [
    ['old.md', 'old.md', 'new.md'], ['old.md', 'new.md', 'new.md'],
    ['old.md', 'old.md', ''], ['', '', 'new.md']
  ] as const) assert.equal(observedEditorChange(transaction, paths[0], paths[1], paths[2], true, true), null);
  assert.equal(observedEditorChange(transaction, 'note.md', 'note.md', 'note.md', false, true)?.userEdit, false);
  assert.equal(observedEditorChange(state.update({selection: {anchor: 1}}), 'note.md', 'note.md', 'note.md', true, true), null);
});
test('user event hierarchy and remote/read-only flags determine transaction trust', () => {
  const state = EditorState.create({doc: '原文'});
  for (const userEvent of ['input.type.compose', 'input.complete', 'delete.selection', 'move.drop', 'undo', 'redo']) {
    const transaction = state.update({changes: {from: 0, to: 1, insert: '新'}, userEvent});
    assert.equal(observedEditorChange(transaction, 'note.md', 'note.md', 'note.md', true, true)?.userEdit, true);
  }
  const remote = state.update({changes: {from: 0, insert: '新增'}, userEvent: 'input.type', annotations: Transaction.remote.of(true)});
  assert.equal(observedEditorChange(remote, 'note.md', 'note.md', 'note.md', true, true)?.userEdit, false);
  const selectionEvent = state.update({changes: {from: 0, insert: '新增'}, userEvent: 'select.pointer'});
  assert.equal(observedEditorChange(selectionEvent, 'note.md', 'note.md', 'note.md', true, true)?.userEdit, false);
  const readOnly = EditorState.create({doc: '原文', extensions: EditorState.readOnly.of(true)});
  const transaction = readOnly.update({changes: {from: 0, insert: '新增'}, userEvent: 'input.type'});
  assert.equal(observedEditorChange(transaction, 'note.md', 'note.md', 'note.md', true, true)?.userEdit, false);
  const input = state.update({changes: {from: 0, insert: '新增'}, userEvent: 'input.type'});
  assert.equal(observedEditorChange(input, 'note.md', 'note.md', 'note.md', true, false)?.userEdit, false);
});
test('input followed by synchronization maps each transaction with its own origin', () => {
  const source = '前文目标原文后文';
  let anchor = makeAnchor(source, 2, 6);
  const state = EditorState.create({doc: source});
  const input = state.update({changes: {from: 4, insert: '新的'}, userEvent: 'input.type'});
  const after = `修改前文${input.state.doc.sliceString(2)}`;
  const synchronization = input.state.update({changes: {from: 0, to: input.state.doc.length, insert: after}});
  const origins: boolean[] = [];
  for (const transaction of [input, synchronization]) {
    const change = observedEditorChange(transaction, 'note.md', 'note.md', 'note.md', true, true)!;
    origins.push(change.userEdit);
    anchor = mapAnchor(anchor, change.before, change.after, change.changes, change.userEdit);
  }
  assert.deepEqual(origins, [true, false]);
  assert.equal(anchor.state, 'attached'); assert.equal(anchor.quote, '目标新的原文');
  assert.equal(anchor.from, 4);
});
test('external edits relocate only with strong context and reject ambiguous copies', () => {
  const source = '开始\n这是一段足够明确的前文上下文。目标文字。后文也有足够明确的上下文。\n结束';
  const from = source.indexOf('目标文字');
  const anchor = makeAnchor(source, from, from + 4);
  const next = relocateAnchor(`新增段落\n${source}`, anchor);
  assert.equal(next.state, 'attached');
  assert.equal(relocateAnchor(`${source}\n${source}`, anchor).state, 'detached');
  assert.equal(relocateAnchor('完全不同的段落中出现目标文字而已', anchor).state, 'detached');
});
test('detached comments stay detached on later relocation attempts', () => {
  const source = '原文';
  const anchor = {...makeAnchor(source, 0, 2), state: 'detached' as const};
  assert.equal(relocateAnchor(source, anchor).state, 'detached');
  const change = edit(source, 0, source.length, `新增${source}`);
  assert.equal(mapAnchor(anchor, source, change.after, change.changes, false).state, 'detached');
});
test('unique original quote at its saved position survives surrounding text edits', () => {
  const before = '一段前文目标原文一段后文';
  const anchor = makeAnchor(before, 4, 8);
  const after = '修改前文目标原文修改后文';
  const relocated = relocateAnchor(after, anchor);
  assert.equal(relocated.state, 'attached');
  assert.equal(relocated.from, anchor.from);
  assert.equal(relocated.before, '修改前文');
  assert.equal(relocateAnchor('修改前文另一原文修改后文', anchor).state, 'detached');
});
test('replies stay flat; deleting a message keeps later replies', async () => {
  const {store} = memoryStore();
  const thread = await store.create('笔记.md', '原文', 0, 2, '根消息');
  await store.reply(thread.id, '一层回复');
  const child = store.get(thread.id)!.messages[1]!.id;
  await store.reply(thread.id, '二次回复');
  await store.update(thread.id, t => deleteMessage(t, child));
  await store.load();
  const saved = store.get(thread.id)!;
  assert.equal(saved.messages.length, 3);
  assert.equal('replyTo' in saved.messages[2]!, false);
  assert.equal(saved.messages[1]!.body, '');
});
test('concurrent replies are serialized and both persisted', async () => {
  const {store} = memoryStore();
  const thread = await store.create('note.md', 'source', 0, 6, 'root');
  await Promise.all([store.reply(thread.id, 'one'), store.reply(thread.id, 'two')]);
  await store.load();
  assert.deepEqual(store.get(thread.id)!.messages.map(m => m.body), ['root', 'one', 'two']);
});
test('external changes cause a conflict instead of overwriting the file', async () => {
  const {store, data} = memoryStore();
  const thread = await store.create('note.md', 'source', 0, 6, 'root');
  const key = [...data.keys()][0]!;
  const external = data.get(key)! + '\n'; data.set(key, external);
  await assert.rejects(store.reply(thread.id, 'new reply'), /conflict/u);
  assert.equal(data.get(key), external); assert.equal(store.get(thread.id)!.messages.length, 1);
});
test('corrupt and future-version files are preserved and never treated as empty writable threads', async () => {
  const {store, data, errors} = memoryStore();
  const id = crypto.randomUUID(); data.set(id, '{bad');
  await store.load(); assert.equal(store.all().length, 0); assert.equal(data.get(id), '{bad'); assert.equal(errors.length, 1);
  await assert.rejects(store.update(id, t => {t.resolved = true;}));
  const thread = await store.create('note.md', 'source', 0, 6, 'root');
  assert.throws(() => parseThread(JSON.stringify({...thread, schemaVersion: 2})));
  assert.throws(() => parseThread(JSON.stringify({...thread, filePath: '../outside.md'})));
});
test('resolution remains independent of orphan state and file rename', async () => {
  const {store} = memoryStore();
  const thread = await store.create('note.md', 'source', 0, 6, 'root');
  await store.update(thread.id, t => {t.resolved = true; t.anchor.state = 'detached'; t.fileMissing = true;});
  await store.moveFile('note.md', 'new.md');
  assert.equal(store.get(thread.id)!.resolved, true);
});
test('limited formatting supports bold and lists without executable markup or links', () => {
  const window = new Window();
  const prototype = window.HTMLElement.prototype as unknown as {createEl: (tag: string) => HTMLElement; createSpan: () => HTMLElement; addClass: (name: string) => void};
  prototype.addClass = function(this: HTMLElement, name: string) { this.classList.add(name); };
  prototype.createEl = function (this: HTMLElement, tag: string) {
    const child = this.ownerDocument.createElement(tag); this.append(child); return child;
  };
  prototype.createSpan = function (this: HTMLElement) { return prototype.createEl.call(this, 'span'); };
  const div = window.document.createElement('div');
  renderMessage(div as unknown as HTMLElement, '**重点**\n- 第一条\n- 第二条\n1. 步骤\n<script>alert(1)</script>\n[x](https://example.com)\n![img](https://example.com/image)');
  assert.equal(div.querySelector('strong')?.textContent, '重点');
  assert.equal(div.querySelectorAll('ul li').length, 2); assert.equal(div.querySelectorAll('ol li').length, 1);
  assert.equal(div.querySelectorAll('script,a,img').length, 0);
  assert.ok(div.textContent.includes('<script>'));
  const summary = window.document.createElement('div');
  renderSummary(summary as unknown as HTMLElement, ['**重点**\n- 第一条\n- 第二条', '<script>alert(1)</script>\n[x](https://example.com)']);
  assert.equal(summary.querySelector('strong')?.textContent, '重点');
  assert.equal(summary.textContent, '重点 • 第一条 • 第二条 · <script>alert(1)</script> [x](https://example.com)');
  assert.equal(summary.querySelectorAll('script,a,img').length, 0);
  window.happyDOM.abort();
});
