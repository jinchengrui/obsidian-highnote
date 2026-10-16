import {test} from 'node:test';
import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {
  DEFAULT_FLOMO_CONFIG, FLOMO_VARIABLES, flomoCsv, flomoRows, flomoStamp,
  normalizeFlomoConfig, validateFlomoTemplate, type FlomoConfig, type FlomoRow,
} from '../src/flomo';
import type {Message, Thread} from '../src/model';

const DATE = '2026-10-14T16:30:00Z';
function message(id: string, body = id, createdAt = DATE, deleted = false): Message {
  return {id, body, createdAt, updatedAt: DATE, deleted};
}
function thread(id: string, messages: Message[] = [message(`${id}-primary`)], quote = '同一段原文'): Thread {
  return {schemaVersion: 1, id, revision: 1, filePath: '目录/笔记.md', fileMissing: false,
    anchor: {from: 0, to: quote.length, quote, before: '', after: '', state: 'attached'},
    resolved: false, createdAt: DATE, updatedAt: DATE, messages};
}
const config = (patch: Partial<FlomoConfig> = {}): FlomoConfig => ({...DEFAULT_FLOMO_CONFIG, ...patch});
const comments = (patch: Partial<FlomoConfig> = {}): FlomoConfig => config({preset: 'comments', labels: false, ...patch});

// Independent character-state CSV reader: it does not use the exporter's quoting logic.
function parseCsv(csv: string): string[][] {
  const records: string[][] = [];
  let record: string[] = [], field = '', state: 'plain' | 'quoted' | 'closed' = 'plain';
  const endField = () => { record.push(field); field = ''; state = 'plain'; };
  const endRecord = () => { endField(); records.push(record); record = []; };
  for (let index = csv.startsWith('\uFEFF') ? 1 : 0; index < csv.length; index++) {
    const char = csv[index]!;
    if (state === 'quoted') {
      if (char !== '"') field += char;
      else if (csv[index + 1] === '"') { field += '"'; index++; }
      else state = 'closed';
      continue;
    }
    if (char === ',') endField();
    else if (char === '\r' && csv[index + 1] === '\n') { endRecord(); index++; }
    else if (char === '\n') endRecord();
    else if (char === '"' && state === 'plain' && field === '') state = 'quoted';
    else {
      assert.equal(state, 'plain', 'unexpected character after closing quote');
      assert.notEqual(char, '"', 'unescaped quote');
      field += char;
    }
  }
  assert.notEqual(state, 'quoted', 'unclosed CSV field');
  if (field || record.length || state === 'closed') endRecord();
  return records;
}

test('flomo configuration normalizes only settings with exact defaults and bounded strings', async t => {
  await t.test('default values match the export contract and results are independent', () => {
    const expected: FlomoConfig = {group: 'thread', includeReplies: true, preset: 'context', labels: true,
      source: false, separator: 'blank', customSeparator: '\n\n', custom: false, template: '原文\n{上下文}\n\n想法\n{评论}'};
    assert.deepEqual(DEFAULT_FLOMO_CONFIG, expected);
    assert.deepEqual(FLOMO_VARIABLES, ['上下文', '评论', '来源', '记录日期']);
    for (const value of [undefined, null, false, 0, 'text', [], [expected]]) {
      assert.deepEqual(normalizeFlomoConfig(value), expected);
    }
    const first = normalizeFlomoConfig(null), second = normalizeFlomoConfig(null);
    first.template = 'modified';
    assert.notStrictEqual(first, second);
    assert.deepEqual(second, expected);
    assert.deepEqual(DEFAULT_FLOMO_CONFIG, expected);
  });
  await t.test('legal values round trip without coercion or mutation', () => {
    for (const separator of ['blank', 'line', 'rule', 'custom'] as const) {
      const raw = {group: 'message', includeReplies: false, preset: 'comments', labels: false, source: true,
        separator, customSeparator: '', custom: true, template: ''} as const;
      assert.deepEqual(normalizeFlomoConfig(Object.freeze(raw)), raw);
    }
    assert.deepEqual(normalizeFlomoConfig({group: 'MESSAGE', includeReplies: 'false', preset: 1,
      labels: null, source: 1, separator: 'other', customSeparator: {}, custom: 'true', template: 42}), DEFAULT_FLOMO_CONFIG);
  });
  await t.test('oversized settings reset as a whole; syntax errors stay visible for validation', () => {
    const maxTemplate = '文'.repeat(50_000), maxSeparator = '字'.repeat(10_000);
    assert.equal(normalizeFlomoConfig({template: maxTemplate}).template, maxTemplate);
    assert.equal(normalizeFlomoConfig({customSeparator: maxSeparator}).customSeparator, maxSeparator);
    assert.equal(normalizeFlomoConfig({template: `${maxTemplate}文`}).template, DEFAULT_FLOMO_CONFIG.template);
    assert.equal(normalizeFlomoConfig({customSeparator: `${maxSeparator}字`}).customSeparator, '\n\n');
    const raw = {custom: true, template: '{未知}'};
    assert.deepEqual(normalizeFlomoConfig(raw), config(raw));
    assert.notEqual(validateFlomoTemplate(normalizeFlomoConfig(raw).template), '');
  });
});

test('flomo templates accept only complete supported variables and reject malformed braces', async t => {
  await t.test('empty, literal and repeated supported variables are valid', () => {
    for (const text of ['', ' \n\t', '固定 #标签 /n \\n $& $$', ...FLOMO_VARIABLES.map(name => `{${name}}`),
      '{评论}{上下文}{来源}{记录日期}{评论}']) assert.equal(validateFlomoTemplate(text), '', text);
    assert.equal(validateFlomoTemplate('a'.repeat(50_000)), '');
  });
  await t.test('unknown, unmatched, empty and nested braces report errors', () => {
    for (const text of ['{作者}', '{标签}', '{连接符}', '{评论 }', '{ comment }', '{}', '{', '}',
      '{评论', '评论}', '{{评论}}', '{上下文{评论}}', '{评论}}', '{评论}{未知}', '{上\n下文}']) {
      assert.notEqual(validateFlomoTemplate(text), '', text);
    }
    assert.match(validateFlomoTemplate('a'.repeat(50_001)), /50000/u);
    const result = flomoRows([thread('a')], config({custom: true, template: '{未知}'}));
    assert.deepEqual(result, {rows: [], missing: 0, empty: 0, error: validateFlomoTemplate('{未知}')});
    assert.notEqual(flomoRows([], config({custom: true, template: 'a'.repeat(50_001)})).error, '');
    assert.equal(flomoRows([thread('a')], config({template: '{未知}'})).error, '');
  });
});

test('flomo timestamps use local calendar fields, timezones and valid midnight/epoch dates', async t => {
  await t.test('local fields are padded without slicing UTC', () => {
    const local = new Date(2026, 0, 2, 3, 4, 5);
    assert.equal(flomoStamp(local.toISOString()), '2026-01-02 03:04:05');
    assert.equal(flomoStamp('2026-01-02T03:04:05'), '2026-01-02 03:04:05');
    const year = new Date(2026, 0, 2, 3, 4, 5); year.setFullYear(42);
    assert.equal(flomoStamp(year.toISOString()), '0042-01-02 03:04:05');
    assert.equal(flomoStamp('2026-10-15T00:30:00+08:00'), flomoStamp(DATE));
    assert.equal(flomoStamp('2026-10-14T09:30:00-07:00'), flomoStamp(DATE));
    assert.equal(flomoStamp(new Date(2026, 9, 15, 0, 0, 0).toISOString()), '2026-10-15 00:00:00');
    assert.match(flomoStamp('1970-01-01T00:00:00Z'), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/u);
    assert.notEqual(flomoStamp('1969-12-31T23:59:59Z'), '');
  });
  await t.test('invalid and unrepresentable dates stay empty', () => {
    for (const date of ['', ' \n', 'not-a-date', '2026-13-01T00:00:00Z', 'Infinity',
      '+010000-06-01T00:00:00Z', '-000001-06-01T00:00:00Z']) assert.equal(flomoStamp(date), '', date);
  });
});

test('flomo presets preserve plain text and omit only disabled or blank blocks', async t => {
  await t.test('default context uses the saved original and retains Markdown/HTML/emoji/whitespace', () => {
    const body = '  **重点**, "引号" 🍊\n<script>文字</script>\n![[附件]]\n[链接](url)\n=1+1\n  ';
    const item = thread('a', [message('m', body)]);
    item.originalQuote = '  # 创建时原文\n<b>文字</b>  ';
    item.anchor.quote = '修改后摘录'; item.anchor.state = 'detached'; item.fileMissing = true; item.resolved = true;
    const result = flomoRows([item], config());
    assert.deepEqual(result, {rows: [{content: `原文\n${item.originalQuote}\n\n想法\n${body}`,
      created_at: flomoStamp(DATE), threadId: 'a', messageIds: ['m']}], missing: 0, empty: 0, error: ''});
    delete item.originalQuote;
    assert.equal(flomoRows([item], config()).rows[0]!.content, `原文\n修改后摘录\n\n想法\n${body}`);
  });
  await t.test('comments preset omits the whole original block; labels and source remain independent', () => {
    const item = thread('a', [message('m', '想法正文')], '摘录正文');
    item.filePath = '一层/二层/笔记 🍊.md';
    for (const [patch, expected] of [
      [{preset: 'comments'}, '想法\n想法正文'],
      [{labels: false}, '摘录正文\n\n想法正文'],
      [{preset: 'comments', labels: false}, '想法正文'],
      [{source: true}, '原文\n摘录正文\n\n想法\n想法正文\n\n来源：笔记 🍊.md'],
      [{preset: 'comments', labels: false, source: true}, '想法正文\n\n来源：笔记 🍊.md'],
    ] as [Partial<FlomoConfig>, string][]) assert.equal(flomoRows([item], config(patch)).rows[0]!.content, expected);
    item.originalQuote = ' \n\t'; item.filePath = '';
    assert.equal(flomoRows([item], config({source: true})).rows[0]!.content, '想法\n想法正文');
    item.originalQuote = '';
    assert.equal(flomoRows([item], config({labels: false})).rows[0]!.content, '想法正文');
  });
  await t.test('real line endings normalize to LF; textual slash-n/backslash-n remain literal', () => {
    const item = thread('a', [message('m', 'a\r\nb\rc\n/n \\n')], 'x\r\ny\rz');
    assert.equal(flomoRows([item], config()).rows[0]!.content, '原文\nx\ny\nz\n\n想法\na\nb\nc\n/n \\n');
    for (const body of ['=SUM(1,2)', '+1', '-2', '@name', '\t=1', '正文'.repeat(50_001)]) {
      item.messages[0]!.body = body;
      assert.equal(flomoRows([item], comments()).rows[0]!.content, body);
    }
  });
});

test('flomo joins messages only between bodies, with all separator choices and no trimming', () => {
  const item = thread('a', [message('p', '  A\nA2  ', '2026-01-01'), message('r', ' B ', '2026-01-02')]);
  for (const [separator, expectedJoin] of [['blank', '\n\n'], ['line', '\n'], ['rule', '\n\n———\n\n'],
    ['custom', '/n \\n {评论} $&\n下一次：\n']] as const) {
    const settings = comments({separator, customSeparator: '/n \\n {评论} $&\n下一次：\n'});
    assert.equal(flomoRows([item], settings).rows[0]!.content, `  A\nA2  ${expectedJoin} B `);
    assert.equal(flomoRows([item], {...settings, includeReplies: false}).rows[0]!.content, '  A\nA2  ');
    assert.deepEqual(flomoRows([item], {...settings, group: 'message'}).rows.map(row => row.content), ['  A\nA2  ', ' B ']);
  }
  assert.equal(flomoRows([item], comments({separator: 'custom', customSeparator: ''})).rows[0]!.content, '  A\nA2   B ');
  assert.equal(flomoRows([item], comments({separator: 'custom', customSeparator: '\r\n next \r'})).rows[0]!.content,
    '  A\nA2  \n next \n B ');
});

test('flomo custom replacement is literal, single-pass, and independent of presets/labels/source', async t => {
  await t.test('all variables substitute once without interpreting values or connection text', () => {
    const body = '{上下文} {来源} {记录日期} {评论} {未知} $& $1 $$ /n \\n\n<script>text</script>';
    const item = thread('a', [message('p', body, DATE), message('r', '回复 {评论}', '2026-10-16T00:00:00Z')]);
    item.originalQuote = '保存 {评论} {来源} {未知} $& /n \\n\n原文';
    item.filePath = '目录/文件{评论}.md';
    const template = '#标签\n{评论}\n{上下文}\n{来源}\n{记录日期}\n{评论}\n/n \\n $& $$';
    const separator = '\n{来源} $& /n \\n\n';
    const joined = `${body}${separator}回复 {评论}`;
    const expected = `#标签\n${joined}\n${item.originalQuote}\n文件{评论}.md\n${flomoStamp(DATE)}\n${joined}\n/n \\n $& $$`;
    for (const patch of [{}, {preset: 'comments', labels: false, source: true}] as Partial<FlomoConfig>[]) {
      const result = flomoRows([item], config({...patch, custom: true, template, separator: 'custom', customSeparator: separator}));
      assert.equal(result.error, ''); assert.equal(result.rows[0]!.content, expected);
    }
  });
  await t.test('missing values replace to empty; fixed headings and blank lines remain', () => {
    const item = thread('a', [message('m', '有评论', 'bad')], ''); item.filePath = '';
    const result = flomoRows([item], config({custom: true, template: '原文\r\n{上下文}\r\n\r\n来源：{来源}\n日期：{记录日期}'}));
    assert.equal(result.rows[0]!.content, '原文\n\n\n来源：\n日期：');
    assert.equal(result.rows[0]!.created_at, ''); assert.equal(result.missing, 1);
    assert.equal(flomoRows([item], config({custom: true, template: '固定文字'})).rows[0]!.content, '固定文字');
  });
});

test('flomo primary/reply identity survives sorting, deletion and blank bodies', async t => {
  await t.test('deleted original primary never promotes a remaining reply', () => {
    const item = thread('a', [message('p', '', '2026-01-01', true), message('r', '保留回复', '2026-01-02')]);
    for (const group of ['thread', 'message'] as const) {
      assert.deepEqual(flomoRows([item], comments({group, includeReplies: false})), {rows: [], missing: 0, empty: 0, error: ''});
      const result = flomoRows([item], comments({group}));
      assert.deepEqual(result.rows.map(row => row.messageIds), [['r']]);
      assert.equal(result.rows[0]!.created_at, flomoStamp('2026-01-02'));
      assert.equal(result.rows[0]!.content, '保留回复');
    }
  });
  await t.test('blank primary is counted but never promotes an earlier reply', () => {
    const item = thread('a', [message('p', ' \n\t', '2026-01-03'), message('r', '回复', '2026-01-01')]);
    for (const group of ['thread', 'message'] as const) {
      const hidden = flomoRows([item], comments({group, includeReplies: false}));
      assert.equal(hidden.rows.length, 0); assert.equal(hidden.empty, 1);
      const included = flomoRows([item], comments({group}));
      assert.deepEqual(included.rows[0]!.messageIds, ['r']); assert.equal(included.empty, 1);
      assert.equal(included.rows[0]!.created_at, flomoStamp('2026-01-01'));
    }
    item.messages[0]!.body = '主评论';
    const noReplies = flomoRows([item], comments({includeReplies: false}));
    assert.deepEqual(noReplies.rows[0]!.messageIds, ['p']);
    assert.equal(noReplies.rows[0]!.content, '主评论');
  });
});

test('flomo stable message IDs deduplicate globally without merging identical excerpts', async t => {
  await t.test('same and conflicting duplicate bodies use first occurrence in the supplied scope', () => {
    const first = thread('z', [message('same', '第一份', '2026-01-01'), message('same', '本讨论冲突', '2026-01-03')]);
    const second = thread('a', [message('same', '跨讨论冲突', '2026-01-04'), message('unique', '第二份', '2026-01-02')]);
    for (const group of ['thread', 'message'] as const) {
      const result = flomoRows([first, second, structuredClone(first)], comments({group}));
      assert.deepEqual(result.rows.map(row => row.messageIds), [['unique'], ['same']]);
      assert.deepEqual(result.rows.map(row => row.content), ['第二份', '第一份']);
      assert.deepEqual(result.rows.map(row => row.threadId), ['a', 'z']);
      assert.equal(result.empty, 0);
    }
  });
  await t.test('deleted and blank first occurrences reserve the ID; filtered replies reserve it too', () => {
    const first = thread('a', [message('p', '主评论'), message('deleted', '', DATE, true),
      message('blank', ' \t'), message('reply', '回复')]);
    const second = thread('b', [message('deleted', '旧副本'), message('blank', '冲突正文'), message('reply', '重复回复')]);
    const included = flomoRows([first, second], comments());
    assert.deepEqual(included.rows[0]!.messageIds, ['p', 'reply']);
    assert.equal(included.rows.length, 1); assert.equal(included.empty, 1);
    const excluded = flomoRows([first, thread('c', [message('reply', '伪主评论')])], comments({includeReplies: false}));
    assert.deepEqual(excluded.rows.map(row => row.messageIds), [['p']]); assert.equal(excluded.empty, 0);
  });
});

test('flomo empty counts unique selected live blank messages plus blank template rows', () => {
  const blank = thread('blank', [message('b1', ''), message('b2', ' \n\t'), message('b2', '重复空白'), message('d', '', DATE, true)]);
  const mixed = thread('mixed', [message('good', '正文'), message('b3', ' \r\n')]);
  for (const group of ['thread', 'message'] as const) {
    const regular = flomoRows([blank, mixed, thread('none', [])], config({group}));
    assert.equal(regular.rows.length, 1); assert.equal(regular.empty, 3); assert.equal(regular.missing, 0);
    assert.deepEqual(regular.rows[0]!.messageIds, ['good']);
    const filtered = flomoRows([blank, mixed], config({group, includeReplies: false}));
    assert.equal(filtered.empty, 1); assert.equal(filtered.rows.length, 1);
  }
  const emptyContext = thread('a', [message('p', '正文', 'bad'), message('r', '回复', 'bad')], ' \n');
  for (const template of ['', ' \n\t', '{上下文}', '{记录日期}']) {
    const one = flomoRows([emptyContext], config({custom: true, template}));
    const two = flomoRows([emptyContext], config({group: 'message', custom: true, template}));
    assert.deepEqual(one, {rows: [], empty: 1, missing: 0, error: ''});
    assert.deepEqual(two, {rows: [], empty: 2, missing: 0, error: ''});
  }
  assert.deepEqual(flomoRows([], config()), {rows: [], missing: 0, empty: 0, error: ''});
});

test('flomo row dates prefer the valid primary, then earliest valid reply; message dates stay individual', () => {
  const item = thread('a', [message('p', '主评论', '2026-01-03T01:02:03Z'),
    message('r-late', '较晚', '2026-01-02T01:02:03Z'), message('r-early', '较早', '2026-01-01T01:02:03Z'),
    message('invalid', '缺失', 'bad')]);
  const initial = flomoRows([item], comments());
  assert.equal(initial.rows[0]!.created_at, flomoStamp('2026-01-03T01:02:03Z'));
  assert.deepEqual(initial.rows[0]!.messageIds, ['r-early', 'r-late', 'p', 'invalid']);
  assert.equal(initial.missing, 0);
  item.messages[0]!.createdAt = 'bad';
  assert.equal(flomoRows([item], comments()).rows[0]!.created_at, flomoStamp('2026-01-01T01:02:03Z'));
  const individual = flomoRows([item], comments({group: 'message', custom: true, template: '{评论}|{记录日期}'}));
  assert.deepEqual(individual.rows.map(row => [row.messageIds[0], row.created_at]), [
    ['r-early', flomoStamp('2026-01-01T01:02:03Z')], ['r-late', flomoStamp('2026-01-02T01:02:03Z')], ['invalid', ''], ['p', ''],
  ]);
  for (const row of individual.rows) assert.ok(row.content.endsWith(`|${row.created_at}`));
  assert.equal(individual.missing, 2);
  const primaryOnly = flomoRows([item], comments({includeReplies: false}));
  assert.equal(primaryOnly.rows[0]!.created_at, ''); assert.equal(primaryOnly.missing, 1);
  for (const entry of item.messages) entry.createdAt = '';
  const allInvalid = flomoRows([item], comments());
  assert.equal(allInvalid.rows[0]!.created_at, ''); assert.equal(allInvalid.missing, 1);
  assert.equal(flomoRows([item], comments({group: 'message'})).missing, 4);
  item.messages[0]!.createdAt = '1970-01-01T00:00:00Z';
  assert.equal(flomoRows([item], comments()).rows[0]!.created_at, flomoStamp('1970-01-01T00:00:00Z'));
});

test('flomo ordering uses latest selected message for threads and ascending messages with ID ties', () => {
  const older = thread('z', [message('z-p', '旧主评论', '2026-01-01'), message('z-r', '最新回复', '2026-01-05'),
    message('z-blank', ' ', '2026-01-09'), message('z-delete', '删除', '2026-01-10', true)]);
  const tieB = thread('b', [message('b-p', 'b', '2026-01-04')]);
  const tieA = thread('a', [message('a-p', 'a', '2026-01-04')]);
  const unknownB = thread('unknown-b', [message('u-b', '缺失b', 'bad')]);
  const unknownA = thread('unknown-a', [message('u-a', '缺失a', '')]);
  const input = [unknownB, tieB, older, unknownA, tieA];
  assert.deepEqual(flomoRows(input, comments()).rows.map(row => row.threadId), ['z', 'a', 'b', 'unknown-a', 'unknown-b']);
  assert.deepEqual(flomoRows([...input].reverse(), comments()).rows.map(row => row.threadId), ['z', 'a', 'b', 'unknown-a', 'unknown-b']);
  assert.deepEqual(flomoRows(input, comments({includeReplies: false})).rows.map(row => row.threadId), ['a', 'b', 'z', 'unknown-a', 'unknown-b']);
  assert.deepEqual(flomoRows(input, comments({group: 'message'})).rows.map(row => row.messageIds[0]),
    ['z-p', 'z-r', 'a-p', 'b-p', 'u-a', 'u-b']);
  const tied = thread('t', [message('primary', 'p', '2026-01-03'), message('reply-z', 'z', '2026-01-01'),
    message('reply-a', 'a', '2026-01-01'), message('invalid-z', 'z', 'bad'), message('invalid-a', 'a', '')]);
  assert.deepEqual(flomoRows([tied], comments()).rows[0]!.messageIds, ['reply-a', 'reply-z', 'primary', 'invalid-a', 'invalid-z']);
});

test('flomo design fixture exports 5 discussions / 11 messages / 5 primaries without merging quotes', () => {
  const data = [3, 2, 1, 3, 2].map((count, index) => thread(`t-${index}`, Array.from({length: count}, (_, n) =>
    message(`t-${index}-m-${n}`, `第${index}段，第${n}次 🍊`, new Date(2026, 9, index + 1, n).toISOString()))));
  const grouped = flomoRows(data, config()), allMessages = flomoRows(data, config({group: 'message'}));
  assert.equal(grouped.rows.length, 5); assert.equal(allMessages.rows.length, 11);
  assert.equal(flomoRows(data, config({includeReplies: false})).rows.length, 5);
  assert.equal(flomoRows(data, config({group: 'message', includeReplies: false})).rows.length, 5);
  assert.deepEqual(grouped.rows.map(row => row.threadId), ['t-4', 't-3', 't-2', 't-1', 't-0']);
  assert.equal(grouped.rows.flatMap(row => row.messageIds).length, 11);
  assert.equal(new Set(allMessages.rows.flatMap(row => row.messageIds)).size, 11);
  for (const row of allMessages.rows) assert.ok(row.content.startsWith('原文\n同一段原文\n\n想法\n'));
  assert.deepEqual(parseCsv(flomoCsv(grouped.rows)), [['content', 'created_at'], ...grouped.rows.map(row => [row.content, row.created_at])]);
});

test('flomo CSV has a UTF-8 BOM, bare fixed header, quoted data, doubled quotes and CRLF records', async t => {
  await t.test('exact bytes and two-column parser round trip', () => {
    const rows: FlomoRow[] = [
      {content: '中文, "quoted" 🍊\n第二行\n\n第三行', created_at: '2026-10-15 00:30:00', threadId: 'a', messageIds: ['m']},
      {content: '=1+1 /n \\n {评论} $&', created_at: '', threadId: 'b', messageIds: ['n']},
    ];
    const before = structuredClone(rows), csv = flomoCsv(rows);
    assert.deepEqual([...Buffer.from(csv, 'utf8').subarray(0, 3)], [0xEF, 0xBB, 0xBF]);
    assert.equal(csv, '\uFEFFcontent,created_at\r\n"中文, ""quoted"" 🍊\n第二行\n\n第三行","2026-10-15 00:30:00"\r\n"=1+1 /n \\n {评论} $&",""\r\n');
    assert.deepEqual(parseCsv(csv), [['content', 'created_at'], ...rows.map(row => [row.content, row.created_at])]);
    assert.deepEqual(rows, before);
    assert.equal(flomoCsv([]), '\uFEFFcontent,created_at\r\n');
    assert.deepEqual(parseCsv(flomoCsv([])), [['content', 'created_at']]);
  });
  await t.test('LF normalization and empty/leading/trailing/special text remain inside one content field', () => {
    const bodies = ['', '\n', '\n\n', '"', ',,,', ' a ', 'a\r\nb\rc\n', '**bold** <b>x</b>',
      '+1', '-1', '@name', '\t=1', '👩🏽‍💻\u200d中文\u2028text'];
    const rows = bodies.map((content, index): FlomoRow => ({content, created_at: '', threadId: `${index}`, messageIds: []}));
    assert.deepEqual(parseCsv(flomoCsv(rows)), [['content', 'created_at'], ...bodies.map(body => [body.replace(/\r\n?/gu, '\n'), ''])]);
  });
});

test('flomo never mutates frozen inputs, messages, config or row metadata across repeated exports', () => {
  const item = thread('a', [message('p', '主评论', '2026-01-03'), message('r', '回复', '2026-01-01')]);
  const before = structuredClone(item);
  for (const entry of item.messages) Object.freeze(entry);
  Object.freeze(item.messages); Object.freeze(item.anchor); Object.freeze(item);
  const input = Object.freeze([item]), settings = Object.freeze(comments());
  const first = flomoRows(input, settings), second = flomoRows(input, settings);
  assert.deepEqual(first, second); assert.deepEqual(item, before);
  first.rows[0]!.messageIds.push('external');
  assert.deepEqual(second.rows[0]!.messageIds, ['r', 'p']);
  assert.deepEqual(item, before);
  for (const row of second.rows) { Object.freeze(row.messageIds); Object.freeze(row); }
  Object.freeze(second.rows);
  assert.equal(flomoCsv(second.rows), flomoCsv(flomoRows(input, settings).rows));
});

test('flomo synthetic performance sample processes 20000 messages without a timing threshold', t => {
  const data = Array.from({length: 5_000}, (_, index) => thread(`t-${String(index).padStart(5, '0')}`,
    Array.from({length: 4}, (_, reply) => message(`m-${index}-${reply}`, `讨论 ${index}, 回复 "${reply}" 🍊\n第二行`,
      new Date(2026, 0, 1, 0, index, reply).toISOString()))));
  const before = structuredClone(data), start = performance.now();
  const grouped = flomoRows(data, config()), individual = flomoRows(data, comments({group: 'message'}));
  const csv = flomoCsv(individual.rows), parsed = parseCsv(csv), elapsed = performance.now() - start;
  assert.equal(grouped.rows.length, 5_000); assert.equal(individual.rows.length, 20_000);
  assert.equal(grouped.rows.flatMap(row => row.messageIds).length, 20_000);
  assert.equal(parsed.length, 20_001); assert.deepEqual(parsed[0], ['content', 'created_at']);
  assert.equal(individual.rows[0]!.threadId, 't-04999'); assert.equal(individual.rows.at(-1)!.threadId, 't-00000');
  for (let index = 0; index < individual.rows.length; index++) {
    const row = individual.rows[index]!;
    assert.deepEqual(parsed[index + 1], [row.content, row.created_at]);
  }
  assert.equal(grouped.empty, 0); assert.equal(grouped.missing, 0); assert.equal(individual.error, '');
  assert.deepEqual(data, before);
  t.diagnostic(`20000 messages; thread/message export + CSV parse: ${elapsed.toFixed(1)} ms; CSV bytes: ${Buffer.byteLength(csv, 'utf8')}`);
});
