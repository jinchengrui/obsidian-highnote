import {test} from 'node:test';
import assert from 'node:assert/strict';
import {makeAnchor} from '../src/anchors';
import {ThreadStore, type ThreadFiles} from '../src/store';

function disk() {
  const data = new Map<string, string>();
  const errors: unknown[] = [];
  const files: ThreadFiles = {
    list: async () => [...data.keys()],
    read: async key => {
      const raw = data.get(key);
      if (raw === undefined) throw new Error('不存在');
      return raw;
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

test('comments and highlights serialize into one v2 file and reload with independent clone accessors', async () => {
  const state = disk();
  const store = state.store();
  const [comment, first, duplicate] = await Promise.all([
    store.create('目录/笔记.md', '🍊原文段落', 2, 4, '保留评论'),
    store.createHighlight('目录/笔记.md', '🍊原文段落', 2, 4),
    store.createHighlight('目录/笔记.md', '🍊原文段落', 2, 4)
  ]);
  await store.reply(comment.id, '保留回复');
  assert.equal(first.id, duplicate.id);
  assert.equal(state.data.size, 1);
  const saved = JSON.parse([...state.data.values()][0]!);
  assert.equal(saved.schemaVersion, 2);
  assert.equal(saved.threads.length, 1);
  assert.equal(saved.highlights.length, 1);
  assert.deepEqual(Object.keys(saved.highlights[0]).sort(),
    ['id', 'revision', 'filePath', 'fileMissing', 'anchor', 'originalQuote', 'createdAt', 'updatedAt'].sort());

  const loaded = state.store();
  await loaded.load();
  assert.deepEqual(loaded.getHighlight(first.id), first);
  assert.deepEqual(loaded.get(comment.id)?.messages.map(message => message.body), ['保留评论', '保留回复']);
  assert.deepEqual(loaded.paths(), ['目录/笔记.md']);
  assert.deepEqual(loaded.highlightPaths(), ['目录/笔记.md']);
  assert.equal(loaded.viewHighlights().length, 1);
  assert.equal(loaded.viewHighlights('目录/笔记.md').length, 1);
  assert.deepEqual(loaded.viewHighlights('不存在.md'), []);
  for (const copy of [first, loaded.allHighlights()[0]!, loaded.fileHighlights('目录/笔记.md')[0]!, loaded.getHighlight(first.id)!]) {
    copy.anchor.quote = '篡改副本';
    copy.filePath = '其他.md';
  }
  assert.equal(loaded.getHighlight(duplicate.id)?.anchor.quote, '原文');
  assert.equal(loaded.getHighlight('不存在'), undefined);
  assert.deepEqual(loaded.fileHighlights('不存在.md'), []);
  assert.equal(state.errors.length, 0);
});

test('exact repeats do not write; transitive overlap keeps the first id and earliest creation time', async () => {
  const state = disk();
  const store = state.store();
  const path = '合并.md';
  const source = 'abcdefghijklmnop';
  const first = await store.createHighlight(path, source, 8, 12);
  const raw = [...state.data.values()][0]!;
  assert.deepEqual(await store.createHighlight(path, source, 8, 12), first);
  assert.equal([...state.data.values()][0], raw);
  const middle = await store.createHighlight(path, source, 4, 7);
  const left = await store.createHighlight(path, source, 0, 3);
  await store.updateHighlights(path, highlights => {
    highlights.find(highlight => highlight.id === first.id)!.createdAt = '2025-01-01T00:00:00Z';
    highlights.find(highlight => highlight.id === middle.id)!.anchor = makeAnchor(source, 2, 10);
    highlights.find(highlight => highlight.id === left.id)!.createdAt = '2023-01-01T00:00:00Z';
  });
  const revision = store.getHighlight(first.id)!.revision;
  const merged = await store.createHighlight(path, source, 0, 1);
  assert.equal(merged.id, first.id);
  assert.equal(merged.createdAt, '2023-01-01T00:00:00Z');
  assert.equal(merged.revision, revision + 1);
  assert.deepEqual(merged.anchor, makeAnchor(source, 0, 12));
  assert.equal(store.getHighlight(middle.id), undefined);
  assert.equal(store.getHighlight(left.id), undefined);
  await store.load();
  assert.deepEqual(store.fileHighlights(path), [merged]);
});

test('adjacent, detached, missing-file and stale quotes stay separate; invalid selections never persist', async () => {
  const state = disk();
  const store = state.store();
  const path = '边界.md';
  const source = 'abcdefghij';
  const detached = await store.createHighlight(path, source, 0, 2);
  const stale = await store.createHighlight(path, source, 2, 4);
  const attached = await store.createHighlight(path, source, 4, 6);
  await store.updateHighlights(path, highlights => {
    highlights.find(highlight => highlight.id === detached.id)!.anchor.state = 'detached';
    highlights.find(highlight => highlight.id === stale.id)!.anchor.quote = 'XX';
  });
  const added = await store.createHighlight(path, source, 1, 4);
  assert.ok(![detached.id, stale.id, attached.id].includes(added.id));
  assert.equal(store.fileHighlights(path).length, 4);
  await store.createHighlight(path, source, 6, 8);
  assert.equal(store.fileHighlights(path).length, 5);
  assert.equal(store.getHighlight(detached.id)?.anchor.state, 'detached');
  assert.equal(store.getHighlight(stale.id)?.anchor.quote, 'XX');
  assert.deepEqual(store.getHighlight(attached.id), attached);
  const missing = await store.createHighlight(path, source, 8, 10);
  await store.updateHighlights(path, highlights => {highlights.find(highlight => highlight.id === missing.id)!.fileMissing = true;});
  const missingBefore = store.getHighlight(missing.id)!;
  assert.equal(missingBefore.anchor.state, 'attached');
  const newAttached = await store.createHighlight(path, source, 8, 9);
  assert.notEqual(newAttached.id, missing.id);
  assert.deepEqual(store.getHighlight(missing.id), missingBefore);
  assert.equal(store.fileHighlights(path).length, 7);
  const raw = [...state.data.values()][0];
  for (const [from, to] of [[-1, 2], [2, 2], [0, 11], [0.5, 2]]) {
    await assert.rejects(store.createHighlight(path, source, from!, to!), /选择/u);
  }
  await assert.rejects(store.createHighlight('../外部.md', source, 0, 1));
  await assert.rejects(store.updateHighlights(path, highlights => {highlights[0]!.filePath = '其他.md';}), /批量更新/u);
  assert.equal([...state.data.values()][0], raw);
  assert.equal(store.getHighlight(detached.id)?.filePath, path);
  assert.equal(state.data.size, 1);
});

test('rename moves both kinds of data and highlight-only notes while rebuilding every path index', async () => {
  const state = disk();
  const store = state.store();
  const comment = await store.create('甲/笔记.md', '原文', 0, 2, '评论');
  const highlight = await store.createHighlight(comment.filePath, '原文', 0, 2);
  const other = await store.createHighlight('乙/笔记.md', '原文', 0, 2);
  await store.updateHighlights(comment.filePath, highlights => {
    highlights[0]!.fileMissing = true;
    highlights[0]!.anchor.state = 'detached';
  });
  const before = store.getHighlight(highlight.id)!;
  await assert.rejects(store.moveFile(comment.filePath, other.filePath), /目标笔记已有/u);
  await store.moveFile(comment.filePath, '新目录/笔记.md');
  await store.moveFile(other.filePath, '乙/更名.md');
  await store.load();
  const moved = store.getHighlight(highlight.id)!;
  assert.equal(state.data.size, 4);
  assert.deepEqual(store.viewFile(comment.filePath), []);
  assert.deepEqual(store.viewHighlights(comment.filePath), []);
  assert.deepEqual(store.paths().sort(), ['乙/更名.md', '新目录/笔记.md'].sort());
  assert.deepEqual(store.highlightPaths().sort(), store.paths().sort());
  assert.equal(store.pathOf(comment.id), '新目录/笔记.md');
  assert.equal(store.get(comment.id)?.messages[0]?.body, '评论');
  assert.equal(store.getHighlight(other.id)?.filePath, '乙/更名.md');
  assert.equal(moved.filePath, '新目录/笔记.md');
  assert.equal(moved.fileMissing, false);
  assert.equal(moved.revision, before.revision + 1);
  assert.equal(moved.createdAt, before.createdAt);
  assert.deepEqual(moved.anchor, before.anchor);
  assert.equal(store.viewFile('乙/更名.md').length, 0);
});

test('a partial rename retry rejects altered target highlights and recovers only the complete original payload', async () => {
  const state = disk();
  const store = state.store();
  const comment = await store.create('原路径.md', 'abcdef', 0, 2, '原评论');
  const highlight = await store.createHighlight(comment.filePath, 'abcdef', 2, 4);
  const oldKey = [...state.data.keys()][0]!;
  const oldRaw = state.data.get(oldKey)!;
  const write = state.files.compareAndWrite;
  state.files.compareAndWrite = async (key, expected, next) => {
    if (key === oldKey) throw new Error('conflict');
    await write(key, expected, next);
  };
  await assert.rejects(store.moveFile(comment.filePath, '新路径.md'), /原路径数据仍保留/u);
  state.files.compareAndWrite = write;
  const newKey = [...state.data.keys()].find(key => key !== oldKey)!;
  const movedRaw = state.data.get(newKey)!;
  const altered = JSON.parse(movedRaw);
  altered.highlights[0].anchor.quote = '篡改摘录';
  state.data.set(newKey, JSON.stringify(altered));
  await assert.rejects(store.moveFile(comment.filePath, '新路径.md'), /避免覆盖/u);
  assert.equal(state.data.get(oldKey), oldRaw);
  assert.deepEqual(store.getHighlight(highlight.id), highlight);
  state.data.set(newKey, movedRaw);
  await store.moveFile(comment.filePath, '新路径.md');
  await store.load();
  assert.equal(state.data.size, 2);
  assert.deepEqual(JSON.parse(state.data.get(oldKey)!).threads, []);
  assert.deepEqual(JSON.parse(state.data.get(oldKey)!).highlights, []);
  assert.equal(store.get(comment.id)?.messages[0]?.body, '原评论');
  assert.equal(store.getHighlight(highlight.id)?.anchor.quote, 'cd');
  assert.deepEqual(store.paths(), ['新路径.md']);
  assert.deepEqual(store.highlightPaths(), ['新路径.md']);
});

test('failed rename recovers on refresh, reload and matching retry without losing any saved payload', async () => {
  for (const mode of ['refresh', 'reload', 'pending without lookup', 'retry after refresh']) {
    const state = disk();
    const store = state.store();
    const oldPath = '恢复前.md';
    const newPath = '恢复后.md';
    const source = 'abcdefghij';
    const comment = await store.create(oldPath, source, 0, 2, '原评论');
    const other = await store.create(oldPath, source, 4, 6, '第二条评论');
    await store.reply(comment.id, '原回复');
    await store.reply(other.id, '第二条回复');
    await store.createHighlight(oldPath, source, 0, 2);
    await store.createHighlight(oldPath, source, 4, 6);
    const oldKey = [...state.data.keys()][0]!;
    const before = JSON.parse(state.data.get(oldKey)!);
    before.origin = {sourceDigest: 'source-digest', extra: {retained: true}};
    before.extra = {nested: ['complete', {payload: true}]};
    before.threads[0].origin = {sourceDigest: 'thread-digest'};
    before.threads[0].messages[1].extra = {retained: true};
    before.highlights[0].anchor.extra = {sourceDigest: 'anchor-digest'};
    before.threads[0].fileMissing = true;
    before.highlights[0].fileMissing = true;
    const oldRaw = JSON.stringify(before);
    state.data.set(oldKey, oldRaw);
    await store.load();
    const write = state.files.compareAndWrite;
    state.files.compareAndWrite = async (key, expected, next) => {
      if (key === oldKey) throw new Error('write unavailable');
      await write(key, expected, next);
    };
    await assert.rejects(store.moveFile(oldPath, newPath), /原路径数据仍保留/u);
    const newKey = [...state.data.keys()].find(key => key !== oldKey)!;
    const newRaw = state.data.get(newKey)!;
    const moved = JSON.parse(newRaw);
    const expected = {...before, filePath: newPath, revision: 1,
      threads: before.threads.map((thread: typeof comment, index: number) => ({...thread,
        filePath: newPath, fileMissing: false, revision: thread.revision + 1, updatedAt: moved.threads[index].updatedAt})),
      highlights: before.highlights.map((highlight: ReturnType<ThreadStore['allHighlights']>[number], index: number) => ({...highlight,
        filePath: newPath, fileMissing: false, revision: highlight.revision + 1, updatedAt: moved.highlights[index].updatedAt}))};
    assert.deepEqual(moved, expected, mode);
    assert.equal(state.data.get(oldKey), oldRaw, mode);
    const recovered = mode === 'reload' ? state.store() : store;
    const lookup = (path: string) => path === newPath;
    if (mode === 'retry after refresh') {
      await recovered.load(lookup);
      assert.equal(state.data.size, 2, mode);
      assert.equal(recovered.pathOf(comment.id), newPath, mode);
      state.files.compareAndWrite = write;
      await recovered.moveFile(oldPath, newPath);
    } else {
      state.files.compareAndWrite = write;
      await recovered.load(mode === 'pending without lookup' ? undefined : lookup);
    }
    assert.equal(state.data.size, 2, mode);
    assert.deepEqual(JSON.parse(state.data.get(oldKey)!), {...before, revision: before.revision + 1, threads: [], highlights: []}, mode);
    assert.equal(state.data.get(newKey), newRaw, mode);
    assert.deepEqual(recovered.paths(), [newPath], mode);
    assert.deepEqual(recovered.highlightPaths(), [newPath], mode);
    assert.deepEqual(recovered.all(), moved.threads, mode);
    assert.deepEqual(recovered.allHighlights(), moved.highlights, mode);
    assert.deepEqual(recovered.get(comment.id)?.messages.map(message => message.body), ['原评论', '原回复'], mode);
    assert.deepEqual(recovered.get(other.id)?.messages.map(message => message.body), ['第二条评论', '第二条回复'], mode);
  }
});

test('rename recovery preserves conflicts and independent notes while indexing the existing path first', async () => {
  const cases = ['old markdown exists', 'reload without lookup', 'changed reply', 'changed source digest',
    'changed aggregate extra', 'changed anchor', 'partial ids', 'changed record revision', 'changed aggregate revision',
    'pending old raw changed', 'pending new raw changed', 'target changes during confirmation', 'retirement fails again'];
  for (const scenario of cases) {
    const state = disk();
    const store = state.store();
    const oldPath = '冲突原路径.md';
    const newPath = '冲突新路径.md';
    const comment = await store.create(oldPath, 'abcdef', 0, 2, '保留评论');
    await store.reply(comment.id, '保留回复');
    const highlight = await store.createHighlight(oldPath, 'abcdef', 2, 4);
    const oldKey = [...state.data.keys()][0]!;
    const original = JSON.parse(state.data.get(oldKey)!);
    original.origin = {sourceDigest: 'original-digest'};
    original.extra = {retained: true};
    state.data.set(oldKey, JSON.stringify(original));
    await store.load();
    const write = state.files.compareAndWrite;
    state.files.compareAndWrite = async (key, expected, next) => {
      if (key === oldKey) throw new Error('write unavailable');
      await write(key, expected, next);
    };
    await assert.rejects(store.moveFile(oldPath, newPath), /原路径数据仍保留/u);
    const newKey = [...state.data.keys()].find(key => key !== oldKey)!;
    const next = JSON.parse(state.data.get(newKey)!);
    if (scenario === 'changed reply') next.threads[0].messages[1].body = '外部回复';
    if (scenario === 'changed source digest') next.origin.sourceDigest = 'other-digest';
    if (scenario === 'changed aggregate extra') next.extra.retained = false;
    if (scenario === 'changed anchor') next.highlights[0].anchor.state = 'detached';
    if (scenario === 'partial ids') next.highlights = [];
    if (scenario === 'changed record revision') next.threads[0].revision++;
    if (scenario === 'changed aggregate revision') next.revision++;
    if (scenario.startsWith('changed ') || scenario === 'partial ids') state.data.set(newKey, JSON.stringify(next));
    if (scenario === 'pending old raw changed') state.data.set(oldKey, state.data.get(oldKey)! + '\n');
    if (scenario === 'pending new raw changed') state.data.set(newKey, state.data.get(newKey)! + '\n');
    const oldRaw = state.data.get(oldKey)!;
    const newRaw = state.data.get(newKey)!;
    state.files.compareAndWrite = scenario === 'retirement fails again'
      ? async (key, expected, next) => {
        if (key === oldKey) throw new Error('write still unavailable');
        await write(key, expected, next);
      } : write;
    const pending = scenario.startsWith('pending ') || scenario === 'retirement fails again';
    const recovered = pending ? store : state.store();
    const lookup = scenario === 'reload without lookup' ? undefined
      : (path: string) => path === newPath || scenario === 'old markdown exists';
    if (scenario === 'target changes during confirmation') {
      const read = state.files.read;
      let targetReads = 0;
      state.files.read = async key => {
        if (key === newKey && ++targetReads === 2) state.data.set(newKey, newRaw + '\n');
        return read(key);
      };
    }
    const errorCount = state.errors.length;
    await recovered.load(lookup);
    assert.equal(state.data.size, 2, scenario);
    assert.equal(state.data.get(oldKey), oldRaw, scenario);
    const retainedNewRaw = scenario === 'target changes during confirmation' ? newRaw + '\n' : newRaw;
    assert.equal(state.data.get(newKey), retainedNewRaw, scenario);
    const preferNew = scenario !== 'old markdown exists' && scenario !== 'reload without lookup';
    assert.equal(recovered.pathOf(comment.id), preferNew ? newPath : oldPath, scenario);
    assert.equal(recovered.get(comment.id)?.messages[0]?.body, '保留评论', scenario);
    assert.deepEqual(recovered.get(comment.id), (preferNew ? next : original).threads[0], scenario);
    assert.equal(recovered.getHighlight(highlight.id)?.filePath,
      preferNew && scenario !== 'partial ids' ? newPath : oldPath, scenario);
    assert.ok(state.errors.length > errorCount, scenario);
    if (pending || scenario === 'target changes during confirmation') {
      assert.ok(state.errors.slice(errorCount).some(error => error instanceof Error && /原、新副本已保留/u.test(error.message)), scenario);
      if (scenario !== 'retirement fails again') {
        await assert.rejects(recovered.moveFile(oldPath, newPath), /避免覆盖/u);
        assert.equal(state.data.get(oldKey), oldRaw, scenario);
        assert.equal(state.data.get(newKey), retainedNewRaw, scenario);
      }
    }
  }
});

test('deleting the last comment or last highlight keeps the other kind until both are empty', async () => {
  for (const commentFirst of [true, false]) {
    const state = disk();
    const store = state.store();
    const path = '独立删除.md';
    const comment = await store.create(path, '原文', 0, 2, '评论');
    const highlight = await store.createHighlight(path, '原文', 0, 2);
    if (commentFirst) await store.remove(comment.id);
    else await store.removeHighlight(highlight.id);
    await store.load();
    assert.equal(state.data.size, 1);
    assert.deepEqual(store.paths(), [path]);
    assert.equal(store.get(comment.id) !== undefined, !commentFirst);
    assert.equal(store.getHighlight(highlight.id) !== undefined, commentFirst);
    assert.deepEqual(store.highlightPaths(), commentFirst ? [path] : []);
    if (commentFirst) await store.removeHighlight(highlight.id);
    else await store.remove(comment.id);
    await store.load();
    assert.equal(state.data.size, 1);
    assert.deepEqual(JSON.parse([...state.data.values()][0]!).threads, []);
    assert.deepEqual(JSON.parse([...state.data.values()][0]!).highlights, []);
    assert.deepEqual(store.paths(), []);
    assert.deepEqual(store.highlightPaths(), []);
    assert.deepEqual(store.viewHighlights(), []);
    assert.deepEqual(store.all(), []);
  }
});

test('external edits block highlight updates, merges and deletion without changing memory or losing comments', async () => {
  const state = disk();
  const store = state.store();
  const path = '冲突.md';
  const comment = await store.create(path, 'abcdef', 0, 2, '评论');
  const highlight = await store.createHighlight(path, 'abcdef', 0, 2);
  const key = [...state.data.keys()][0]!;
  const external = state.data.get(key)! + '\n';
  state.data.set(key, external);
  await assert.rejects(store.updateHighlights(path, highlights => {highlights[0]!.fileMissing = true;}), /conflict/u);
  await assert.rejects(store.createHighlight(path, 'abcdef', 1, 4), /conflict/u);
  await assert.rejects(store.removeHighlight(highlight.id), /conflict/u);
  assert.equal(state.data.get(key), external);
  assert.deepEqual(store.getHighlight(highlight.id), highlight);
  assert.equal(store.get(comment.id)?.messages[0]?.body, '评论');
  await store.load();
  await store.remove(comment.id);
  const highlightOnly = state.data.get(key)! + '\n';
  state.data.set(key, highlightOnly);
  await assert.rejects(store.removeHighlight(highlight.id), /conflict/u);
  assert.equal(state.data.get(key), highlightOnly);
  assert.deepEqual(store.getHighlight(highlight.id), highlight);
  await store.load();
  await store.removeHighlight(highlight.id);
  assert.equal(state.data.size, 1);
  assert.deepEqual(JSON.parse([...state.data.values()][0]!).threads, []);
  assert.deepEqual(JSON.parse([...state.data.values()][0]!).highlights, []);
});

test('legacy v2 without highlights stays untouched on load and retains complete comments when adding highlights', async () => {
  const state = disk();
  const store = state.store();
  const path = '旧版.md';
  const comment = await store.create(path, '原文', 0, 2, '原评论');
  await store.reply(comment.id, '原回复');
  await store.update(comment.id, thread => {thread.resolved = true;});
  const key = [...state.data.keys()][0]!;
  const legacy = JSON.parse(state.data.get(key)!);
  delete legacy.highlights;
  const raw = JSON.stringify(legacy);
  state.data.set(key, raw);
  await store.load();
  assert.deepEqual(store.allHighlights(), []);
  assert.deepEqual(store.get(comment.id), legacy.threads[0]);
  await store.updateHighlights(path, () => {});
  assert.equal(state.data.get(key), raw);
  const highlight = await store.createHighlight(path, '原文', 0, 2);
  const upgraded = JSON.parse(state.data.get(key)!);
  assert.equal(upgraded.schemaVersion, 2);
  assert.deepEqual(upgraded.threads, legacy.threads);
  assert.deepEqual(upgraded.highlights, [highlight]);
  await store.updateFile(path, threads => {threads[0]!.resolved = false;});
  await store.load();
  assert.equal(store.get(comment.id)?.resolved, false);
  assert.deepEqual(store.getHighlight(highlight.id), highlight);
});

test('invalid highlight aggregates preserve their raw data and block both comment and highlight writes', async () => {
  const state = disk();
  const store = state.store();
  const comment = await store.create('损坏.md', '原文', 0, 2, '评论');
  const highlight = await store.createHighlight(comment.filePath, '原文', 0, 2);
  const key = [...state.data.keys()][0]!;
  const valid = JSON.parse(state.data.get(key)!);
  const invalid = [null, {}, [{...highlight, filePath: '其他.md'}], [{...highlight, revision: -1}],
    [{...highlight, anchor: {...highlight.anchor, state: 'unknown'}}], [{...highlight, id: comment.id}], [highlight, highlight]];
  for (const highlights of invalid) {
    const raw = JSON.stringify({...valid, highlights});
    state.data.set(key, raw);
    await store.load();
    assert.equal(store.get(comment.id), undefined);
    assert.equal(store.getHighlight(highlight.id), undefined);
    await assert.rejects(store.createHighlight(comment.filePath, '原文', 0, 2), /禁止覆盖/u);
    await assert.rejects(store.create(comment.filePath, '原文', 0, 2, '新评论'), /禁止覆盖/u);
    assert.equal(state.data.get(key), raw);
  }
  assert.ok(state.errors.length >= invalid.length);
});

test('creation excerpts survive anchor edits, reply deletion, moves and reload; old records remain explicitly unsnapshotted', async () => {
  const state = disk(); const store = state.store();
  const t = await store.create('摘录.md', '最初原文', 0, 4, '评论');
  const h = await store.createHighlight(t.filePath, '最初原文', 0, 4);
  await store.reply(t.id, '后来回复');
  await store.update(t.id, item => {item.anchor = makeAnchor('修改后原文', 0, 5);});
  await store.updateHighlights(t.filePath, items => {items[0]!.anchor = makeAnchor('修改后原文', 0, 5);});
  await store.moveFile(t.filePath, '新目录/摘录.md'); await store.load();
  assert.equal(store.get(t.id)?.originalQuote, '最初原文');
  assert.equal(store.getHighlight(h.id)?.originalQuote, '最初原文');
  assert.equal(store.get(t.id)?.anchor.quote, '修改后原文');
  const key = [...state.data.keys()].find(key => JSON.parse(state.data.get(key)!).filePath === '新目录/摘录.md')!;
  const old = JSON.parse(state.data.get(key)!);
  delete old.threads[0].originalQuote; delete old.highlights[0].originalQuote;
  const raw = JSON.stringify(old); state.data.set(key, raw); await store.load();
  assert.equal(store.get(t.id)?.originalQuote, undefined); assert.equal(store.getHighlight(h.id)?.originalQuote, undefined);
  assert.equal(state.data.get(key), raw);
  const valid = JSON.parse(raw); valid.threads[0].originalQuote = 123;
  state.data.set(key, JSON.stringify(valid)); await store.load();
  assert.equal(store.get(t.id), undefined);
  await assert.rejects(store.reply(t.id, '不得覆盖'));
});
