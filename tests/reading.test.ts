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
