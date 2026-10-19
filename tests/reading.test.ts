import {test} from 'node:test';
import assert from 'node:assert/strict';
import {selectionInSection, plainMarkdown, findUnique, renderedAnchorOffset} from '../src/reading-map';

test('reading selection maps plain text within its source section', () => {
  const source = '# 标题\n\n前文和目标文字后文';
  const result = selectionInSection(source, 2, 2, '目标文字');
  assert.deepEqual(result, {from: source.indexOf('目标文字'), to: source.indexOf('目标文字') + 4});
});
test('reading selection crossing bold syntax uses exact source positions', () => {
  const source = '# 标题\n\n前文**加粗文字**后文';
  const result = selectionInSection(source, 2, 2, '前文加粗文字后文');
  assert.ok(result);
  assert.equal(plainMarkdown(source.slice(result.from, result.to)), '前文加粗文字后文');
});
test('repeated reading text is rejected instead of binding to the first occurrence', () => {
  assert.equal(selectionInSection('同意，以及同意', 0, 0, '同意'), null);
  assert.equal(findUnique('aaaa', 'aa'), null);
});
test('unsupported mixed link selections are rejected instead of guessing source positions', () => {
  assert.equal(selectionInSection('前文[链接](https://example.com)后文', 0, 0, '前文链接后文'), null);
});

test('saved source positions disambiguate repeated rendered excerpts without guessing mismatched copies', () => {
  const source = '- **目标文字**，第一处\n- **目标文字**，第二处';
  const rendered = '目标文字，第一处目标文字，第二处';
  const from = source.lastIndexOf('目标文字');
  assert.equal(renderedAnchorOffset(source, rendered, from, from + 4), rendered.lastIndexOf('目标文字'));
  assert.equal(renderedAnchorOffset(source, rendered + '目标文字', from, from + 4), null);
  assert.equal(renderedAnchorOffset(source, '已改变的正文', from, from + 4), null);
});

test('callout headers and quote prefixes do not reject selected formatted prose', () => {
  for (const header of ['> [!tip] 判断标准', '> [!tip]+ 判断标准', '> [!tip]- 判断标准', '> [!tip]']) {
    const sentence = '一个真正有效的微习惯，是你**生病发烧时**也能完成的版本。';
    const selected = '一个真正有效的微习惯，是你生病发烧时也能完成的版本。';
    const source = '# 标题\n\n' + header + '\n>\n> ' + sentence;
    const from = source.indexOf('一个');
    assert.deepEqual(selectionInSection(source, 2, 4, selected), {from, to: from + sentence.length});
  }
  const source = '> [!note] 外层\n> > [!tip] 判断标准\n> > 一个**目标**。';
  assert.deepEqual(selectionInSection(source, 0, 2, '一个目标。'), {from: source.indexOf('一个'), to: source.length});
});

test('unselected link syntax does not block bold selections but selected links stay conservative', () => {
  const source = '> [!tip] [判断标准](https://example.com)\n>\n> 前文**目标**后文，见[说明](https://example.com)。';
  const from = source.indexOf('前文');
  assert.deepEqual(selectionInSection(source, 0, 2, '前文目标后文'), {from, to: from + '前文**目标**后文'.length});
  assert.equal(selectionInSection(source, 0, 2, '前文目标后文，见说明。'), null);
});

test('actual DOM offsets distinguish repeated callout text and round trip to the same occurrence', () => {
  const source = '> [!tip] 判断标准\n>\n> 先说明**目标文字**，再说明**目标文字**。';
  const rendered = '判断标准\n先说明目标文字，再说明目标文字。\n';
  const selected = '目标文字';
  const from = rendered.lastIndexOf(selected);
  const mapped = selectionInSection(source, 0, 2, selected, {text: rendered, from, to: from + selected.length});
  assert.deepEqual(mapped, {from: source.lastIndexOf(selected), to: source.lastIndexOf(selected) + selected.length});
  assert.equal(renderedAnchorOffset(source, rendered, mapped!.from, mapped!.to), from);
  assert.equal(selectionInSection(source, 0, 2, selected), null);
  assert.equal(selectionInSection(source, 0, 2, selected, {text: rendered + selected, from, to: from + selected.length}), null);
});

test('callout title and body copies map separately and keep UTF-16 positions for emoji', () => {
  const source = '> [!tip] 😀目标\n>\n> 一个**😀目标**。';
  const rendered = '😀目标\n一个😀目标。\n';
  const selected = '😀目标';
  const from = rendered.lastIndexOf(selected);
  assert.deepEqual(selectionInSection(source, 0, 2, selected, {text: rendered, from, to: from + selected.length}),
    {from: source.lastIndexOf(selected), to: source.lastIndexOf(selected) + selected.length});
});

test('exact literal text and invalid ranges remain safe', () => {
  for (const source of ['foo_bar', '价格 $20', 'a < b', '文字[括号]']) {
    assert.deepEqual(selectionInSection(source, 0, 0, source, {text: source, from: 0, to: source.length}), {from: 0, to: source.length});
  }
  assert.equal(selectionInSection('**同意**，同意', 0, 0, '同意'), null);
  assert.equal(selectionInSection('同意', 0, 0, '同意', {text: '同意', from: -1, to: 2}), null);
  assert.equal(selectionInSection('同意', 0, 0, '同意', {text: '同意', from: 0, to: 3}), null);
  assert.equal(selectionInSection('同意', 0, 0, ''), null);
});
