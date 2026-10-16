import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ThreadStore, type ThreadFiles} from '../src/store';

function disk() {
  const data = new Map<string, string>();
  const errors: unknown[] = [];
  const files: ThreadFiles = {
    list: async () => [...data.keys()],
    read: async key => {
      const value = data.get(key);
      if (value === undefined) throw new Error('不存在');
      return value;
    },
    create: async (key, raw) => {
      if (data.has(key)) throw new Error('duplicate');
      data.set(key, raw);
    },
    compareAndWrite: async (key, expected, next) => {
      if (data.get(key) !== expected) throw new Error('conflict');
      data.set(key, next);
    }
  };
  return {data, errors, files, store: () => new ThreadStore(files, () => {}, error => errors.push(error))};
}

test('multiple discussions and replies share one compact note file across reloads', async () => {
  const state = disk();
  const store = state.store();
  const first = await store.create('同一篇.md', '原文', 0, 2, '第一条');
  await store.create('同一篇.md', '原文', 0, 2, '第二条');
  await store.reply(first.id, '继续回复');
  assert.equal(state.data.size, 1);
  assert.match([...state.data.keys()][0]!, /^note-[a-f0-9]{32}$/u);
  await store.load();
  assert.equal(store.forFile('同一篇.md').length, 2);
  assert.deepEqual(store.get(first.id)?.messages.map(m => m.body), ['第一条', '继续回复']);
  assert.equal(state.errors.length, 0);
});

test('same basenames in different folders stay separate through rename and reload', async () => {
  const state = disk();
  const store = state.store();
  const a = await store.create('项目甲/笔记.md', '原文', 0, 2, '甲');
  const b = await store.create('项目乙/笔记.md', '原文', 0, 2, '乙');
  assert.equal(state.data.size, 2);
  await assert.rejects(store.moveFile(a.filePath, b.filePath), /目标笔记已有评论/u);
  await store.moveFile(a.filePath, '新目录/笔记.md');
  await store.load();
  assert.equal(state.data.size, 3);
  assert.equal(store.forFile(a.filePath).length, 0);
  assert.equal(store.get(a.id)?.filePath, '新目录/笔记.md');
  assert.equal(store.get(b.id)?.messages[0]?.body, '乙');
});

test('corrupt, mismatched and future-version aggregates are preserved and block writes', async () => {
  const state = disk();
  const store = state.store();
  const original = await store.create('损坏.md', '原文', 0, 2, '占位');
  const key = [...state.data.keys()][0]!;
  const valid = JSON.parse(state.data.get(key)!);
  const mismatched = {...valid, filePath: '其他.md', threads: valid.threads.map((t: object) => ({...t, filePath: '其他.md'}))};
  for (const raw of ['{bad', JSON.stringify({...valid, schemaVersion: 99}), JSON.stringify(mismatched)]) {
    state.data.set(key, raw);
    await store.load();
    assert.equal(store.get(original.id), undefined);
    await assert.rejects(store.create('损坏.md', '原文', 0, 2, '新评论'), /禁止覆盖/u);
    assert.equal(state.data.get(key), raw);
  }
});

test('removing one of two discussions keeps sibling; external edit blocks last deletion', async () => {
  const state = disk();
  const store = state.store();
  const first = await store.create('删除.md', '原文', 0, 2, '一');
  const second = await store.create('删除.md', '原文', 0, 2, '二');
  await store.remove(first.id);
  assert.equal(store.get(second.id)?.messages[0]?.body, '二');
  const key = [...state.data.keys()][0]!;
  state.data.set(key, state.data.get(key)! + '\n');
  await assert.rejects(store.remove(second.id), /conflict/u);
  assert.equal(store.get(second.id)?.messages[0]?.body, '二');
});

test('deleting the last live message removes only its discussion and preserves same-passage highlights', async () => {
  const state = disk(); const store = state.store();
  const thread = await store.create('笔记.md','原文',0,2,'主评论');
  const highlight = await store.createHighlight('笔记.md','原文',0,2);
  await store.reply(thread.id,'回复');
  const reply = store.get(thread.id)!.messages[1]!;
  assert.equal(await store.deleteMessage(thread.id,thread.messages[0]!.id,false),false);
  assert.equal(store.get(thread.id)!.messages[0]!.deleted,true);
  assert.equal(store.get(thread.id)!.messages[1]!.body,'回复');
  await assert.rejects(store.deleteMessage(thread.id,reply.id,false),/最后一条/u);
  assert.equal(await store.deleteMessage(thread.id,reply.id,true),true);
  assert.equal(store.get(thread.id),undefined);
  assert.ok(store.getHighlight(highlight.id)); assert.equal(state.data.size,1);
  await store.load(); assert.equal(store.viewAll().length,0); assert.ok(store.getHighlight(highlight.id));
  await store.removeHighlight(highlight.id); assert.equal(state.data.size,1);
  assert.deepEqual(JSON.parse([...state.data.values()][0]!).threads, []);
  assert.deepEqual(JSON.parse([...state.data.values()][0]!).highlights, []);
  assert.deepEqual(store.paths(), []); assert.deepEqual(store.highlightPaths(), []);
});

test('a newly queued reply survives deletion even if the earlier confirmation said last message', async () => {
  const state = disk(); const store = state.store();
  const thread = await store.create('笔记.md','原文',0,2,'主评论');
  await Promise.all([store.reply(thread.id,'新回复'),store.deleteMessage(thread.id,thread.messages[0]!.id,true)]);
  assert.equal(store.get(thread.id)!.messages[1]!.body,'新回复');
  const key = [...state.data.keys()][0]!; const before = store.get(thread.id);
  state.data.set(key,state.data.get(key)!+' ');
  await assert.rejects(store.deleteMessage(thread.id,before!.messages[1]!.id,true),/conflict/u);
  assert.deepEqual(store.get(thread.id),before);
});

test('the last message is atomically saved empty and the file is reused after reload without visible records', async () => {
  for (const reload of [false, true]) {
    const state = disk(); const store = state.store();
    const path = '空讨论.md';
    const thread = await store.create(path, '原文', 0, 2, '最后消息');
    const key = [...state.data.keys()][0]!;
    const revision = JSON.parse(state.data.get(key)!).revision;
    assert.equal(await store.deleteMessage(thread.id, thread.messages[0]!.id, true), true);
    const emptyRaw = state.data.get(key)!;
    assert.deepEqual(JSON.parse(emptyRaw), {schemaVersion: 2, filePath: path, revision: revision + 1, threads: [], highlights: []});
    const reused = reload ? state.store() : store;
    if (reload) await reused.load();
    assert.deepEqual(reused.paths(), []); assert.deepEqual(reused.highlightPaths(), []);
    assert.equal(reused.get(thread.id), undefined);
    const write = state.files.compareAndWrite;
    let comparisons = 0;
    state.files.compareAndWrite = async (id, expected, next) => {
      assert.equal(id, key); assert.equal(expected, emptyRaw); comparisons++;
      await write(id, expected, next);
    };
    const replacement = await reused.create(path, '原文', 0, 2, '重新创建');
    assert.equal(comparisons, 1); assert.equal(state.data.size, 1);
    assert.equal(JSON.parse(state.data.get(key)!).revision, revision + 2);
    assert.equal(reused.get(replacement.id)?.messages[0]?.body, '重新创建');
  }
});

test('external replies at the atomic last-message save block deletion and remain readable after restart', async () => {
  const state = disk(); const store = state.store();
  const thread = await store.create('原子删除.md', '原文', 0, 2, '最后消息');
  const key = [...state.data.keys()][0]!;
  const external = JSON.parse(state.data.get(key)!);
  external.revision++; external.threads[0].revision++;
  external.threads[0].messages.push({...external.threads[0].messages[0], id: crypto.randomUUID(), body: '并发新增'});
  const externalRaw = JSON.stringify(external);
  const write = state.files.compareAndWrite;
  state.files.compareAndWrite = async (id, expected, next) => {
    assert.deepEqual(JSON.parse(next).threads, []);
    state.data.set(id, externalRaw);
    await write(id, expected, next);
  };
  await assert.rejects(store.deleteMessage(thread.id, thread.messages[0]!.id, true), /conflict/u);
  assert.equal(state.data.get(key), externalRaw);
  assert.deepEqual(store.get(thread.id), thread);
  const restarted = state.store(); await restarted.load();
  assert.deepEqual(restarted.get(thread.id)?.messages.map(message => message.body), ['最后消息', '并发新增']);
});

test('recreating an empty note compares its latest disk state and never overwrites concurrent records', async () => {
  for (const timing of ['before read', 'before write']) {
    const state = disk(); const store = state.store();
    const path = '复用冲突.md';
    const old = await store.create(path, '原文', 0, 2, '已删除');
    const key = [...state.data.keys()][0]!;
    await store.remove(old.id);
    const writer = state.store(); await writer.load();
    const concurrent = await writer.create(path, '原文', 0, 2, '其他窗口');
    const concurrentRaw = state.data.get(key)!;
    if (timing === 'before write') {
      await writer.remove(concurrent.id);
      const write = state.files.compareAndWrite;
      state.files.compareAndWrite = async (id, expected, next) => {
        state.data.set(id, concurrentRaw);
        await write(id, expected, next);
      };
    }
    await assert.rejects(store.create(path, '原文', 0, 2, '不能覆盖'), /其他窗口|conflict/u);
    assert.equal(state.data.get(key), concurrentRaw);
    assert.deepEqual(store.paths(), []);
    const restarted = state.store(); await restarted.load();
    assert.equal(restarted.get(concurrent.id)?.messages[0]?.body, '其他窗口');
  }
});

test('empty notes are neither cached as active paths nor migrated on repeated rename events', async () => {
  const state = disk(); const store = state.store();
  const thread = await store.create('空路径.md', '原文', 0, 2, '最后消息');
  await store.remove(thread.id);
  const before = [...state.data];
  for (const current of [store, state.store()]) {
    await current.load();
    await current.moveFile('空路径.md', '其他路径.md');
    await current.moveFile('空路径.md', '其他路径.md');
    assert.deepEqual([...state.data], before); assert.deepEqual(current.paths(), []);
  }
});

test('moving back and repeated renames atomically reuse empty old paths after restart', async () => {
  const state = disk(); let store = state.store();
  const firstPath = '原名.md'; const secondPath = '新名.md'; const thirdPath = '再次改名.md';
  const thread = await store.create(firstPath, '原文', 0, 2, '原评论');
  const highlight = await store.createHighlight(firstPath, '原文', 0, 2);
  const firstKey = [...state.data.keys()][0]!;
  await store.moveFile(firstPath, secondPath);
  const firstEmpty = state.data.get(firstKey)!;
  assert.deepEqual(JSON.parse(firstEmpty).threads, []); assert.deepEqual(JSON.parse(firstEmpty).highlights, []);
  const afterFirstMove = [...state.data];
  await store.moveFile(firstPath, secondPath);
  assert.deepEqual([...state.data], afterFirstMove);
  store = state.store(); await store.load(path => path === secondPath);
  const write = state.files.compareAndWrite;
  let reused = false;
  state.files.compareAndWrite = async (key, expected, next) => {
    if (key === firstKey) {assert.equal(expected, firstEmpty); reused = true;}
    await write(key, expected, next);
  };
  await store.moveFile(secondPath, firstPath);
  state.files.compareAndWrite = write;
  assert.equal(reused, true); assert.equal(state.data.size, 2);
  assert.equal(store.get(thread.id)?.filePath, firstPath); assert.equal(store.getHighlight(highlight.id)?.filePath, firstPath);
  await store.moveFile(firstPath, thirdPath);
  await store.moveFile(thirdPath, secondPath);
  store = state.store(); await store.load(path => path === secondPath);
  const beforeReload = [...state.data];
  await store.load(path => path === secondPath);
  assert.deepEqual([...state.data], beforeReload);
  assert.equal(state.data.size, 3); assert.deepEqual(store.paths(), [secondPath]);
  assert.deepEqual(store.highlightPaths(), [secondPath]);
  assert.equal(store.get(thread.id)?.revision, thread.revision + 4);
  assert.equal(store.getHighlight(highlight.id)?.revision, highlight.revision + 4);
  const recreated = await store.create(firstPath, '原文', 0, 2, '旧路径新记录');
  assert.equal(state.data.size, 3);
  await assert.rejects(store.moveFile(secondPath, firstPath), /目标笔记已有/u);
  assert.equal(store.get(recreated.id)?.messages[0]?.body, '旧路径新记录');
  assert.equal(store.get(thread.id)?.messages[0]?.body, '原评论');
  assert.equal(state.errors.length, 0);
});

test('a source reply arriving after migration checks conflicts with the atomic empty write and survives restart', async () => {
  const state = disk(); const store = state.store();
  const oldPath = '迁移原路径.md'; const newPath = '迁移新路径.md';
  const thread = await store.create(oldPath, '原文', 0, 2, '原消息');
  const highlight = await store.createHighlight(oldPath, '原文', 0, 2);
  const oldKey = [...state.data.keys()][0]!; const oldRaw = state.data.get(oldKey)!;
  const external = JSON.parse(oldRaw); external.revision++; external.threads[0].revision++;
  external.threads[0].messages.push({...external.threads[0].messages[0], id: crypto.randomUUID(), body: '迁移期间并发回复'});
  const externalRaw = JSON.stringify(external);
  const write = state.files.compareAndWrite;
  state.files.compareAndWrite = async (key, expected, next) => {
    assert.equal(key, oldKey); assert.equal(expected, oldRaw);
    assert.deepEqual(JSON.parse(next).threads, []); assert.deepEqual(JSON.parse(next).highlights, []);
    state.data.set(key, externalRaw);
    await write(key, expected, next);
  };
  await assert.rejects(store.moveFile(oldPath, newPath), /原路径数据仍保留/u);
  state.files.compareAndWrite = write;
  assert.equal(state.data.get(oldKey), externalRaw); assert.equal(state.data.size, 2);
  const newKey = [...state.data.keys()].find(key => key !== oldKey)!; const newRaw = state.data.get(newKey)!;
  await assert.rejects(store.moveFile(oldPath, newPath), /避免覆盖/u);
  const restarted = state.store(); await restarted.load(path => path === newPath);
  assert.equal(state.data.get(oldKey), externalRaw); assert.equal(state.data.get(newKey), newRaw);
  assert.equal(restarted.get(thread.id)?.filePath, newPath);
  assert.equal(restarted.getHighlight(highlight.id)?.filePath, newPath);
  await assert.rejects(restarted.moveFile(oldPath, newPath), /避免覆盖/u);
  assert.equal(state.data.get(oldKey), externalRaw);
  assert.deepEqual(JSON.parse(state.data.get(oldKey)!).threads[0].messages.map((message: {body: string}) => message.body),
    ['原消息', '迁移期间并发回复']);
});

test('source retirement that succeeded before an error completes on retry, refresh or restart with updated target data', async () => {
  for (const recovery of ['retry', 'refresh', 'restart']) {
    const state = disk(); const store = state.store();
    const oldPath = '响应异常原名.md'; const newPath = '响应异常新名.md';
    const thread = await store.create(oldPath, '原文', 0, 2, '原消息');
    const oldKey = [...state.data.keys()][0]!;
    const write = state.files.compareAndWrite;
    state.files.compareAndWrite = async (key, expected, next) => {
      await write(key, expected, next);
      if (key === oldKey) throw new Error('saved but response failed');
    };
    await assert.rejects(store.moveFile(oldPath, newPath), /原路径数据仍保留/u);
    state.files.compareAndWrite = write;
    const emptyRaw = state.data.get(oldKey)!;
    assert.deepEqual(JSON.parse(emptyRaw).threads, []);
    const writer = state.store(); await writer.load(path => path === newPath);
    await writer.reply(thread.id, '新路径新增');
    const newKey = [...state.data.keys()].find(key => key !== oldKey)!; const newRaw = state.data.get(newKey)!;
    const recovered = recovery === 'restart' ? state.store() : store;
    if (recovery === 'retry') await recovered.moveFile(oldPath, newPath);
    else await recovered.load(path => path === newPath);
    assert.equal(state.data.get(oldKey), emptyRaw); assert.equal(state.data.get(newKey), newRaw);
    assert.deepEqual(recovered.paths(), [newPath]);
    assert.deepEqual(recovered.get(thread.id)?.messages.map(message => message.body), ['原消息', '新路径新增']);
    const before = [...state.data];
    await recovered.load(path => path === newPath);
    await recovered.moveFile(oldPath, newPath);
    assert.deepEqual([...state.data], before);
  }
});

test('an empty destination changed before its atomic reuse preserves both independent copies', async () => {
  const state = disk(); const store = state.store();
  const oldPath = '目标复用原路径.md'; const newPath = '目标复用空路径.md';
  const thread = await store.create(oldPath, '原文', 0, 2, '原评论');
  const placeholder = await store.create(newPath, '原文', 0, 2, '先前评论');
  const oldKey = [...state.data.keys()][0]!; const oldRaw = state.data.get(oldKey)!;
  const newKey = [...state.data.keys()].find(key => key !== oldKey)!;
  const externalRaw = state.data.get(newKey)!;
  await store.remove(placeholder.id);
  const write = state.files.compareAndWrite;
  state.files.compareAndWrite = async (key, expected, next) => {
    if (key === newKey) state.data.set(key, externalRaw);
    await write(key, expected, next);
  };
  await assert.rejects(store.moveFile(oldPath, newPath), /conflict/u);
  assert.equal(state.data.get(oldKey), oldRaw); assert.equal(state.data.get(newKey), externalRaw);
  assert.equal(store.get(thread.id)?.filePath, oldPath);
});

test('target writes after migration checks remain authoritative and reload never rebuilds the empty source', async () => {
  const state = disk(); const store = state.store();
  const oldPath = '目标并发原名.md'; const newPath = '目标并发新名.md';
  const thread = await store.create(oldPath, '原文', 0, 2, '原消息');
  const oldKey = [...state.data.keys()][0]!;
  let newRaw = '';
  const write = state.files.compareAndWrite;
  state.files.compareAndWrite = async (key, expected, next) => {
    const newKey = [...state.data.keys()].find(id => id !== oldKey)!;
    const target = JSON.parse(state.data.get(newKey)!);
    target.revision++; target.threads[0].revision++;
    target.threads[0].messages.push({...target.threads[0].messages[0], id: crypto.randomUUID(), body: '目标并发回复'});
    newRaw = JSON.stringify(target);
    state.data.set(newKey, newRaw);
    await write(key, expected, next);
  };
  await store.moveFile(oldPath, newPath);
  state.files.compareAndWrite = write;
  const emptyRaw = state.data.get(oldKey)!;
  const newKey = [...state.data.keys()].find(key => key !== oldKey)!;
  assert.equal(state.data.get(newKey), newRaw); assert.deepEqual(JSON.parse(emptyRaw).threads, []);
  const restarted = state.store(); await restarted.load(path => path === newPath);
  assert.deepEqual(restarted.get(thread.id)?.messages.map(message => message.body), ['原消息', '目标并发回复']);
  await restarted.moveFile(oldPath, newPath);
  assert.equal(state.data.get(oldKey), emptyRaw); assert.equal(state.data.get(newKey), newRaw);
});
