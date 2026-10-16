import {test} from 'node:test';
import assert from 'node:assert/strict';
import {toolbarPosition} from '../src/selection-position';

const bounds = {left: 100, right: 700, top: 80, bottom: 600};
test('toolbar sits above the selection without overlapping the text', () => {
  const anchor = {left: 200, right: 300, top: 200, bottom: 222};
  assert.deepEqual(toolbarPosition(anchor, bounds, 44, 42), {left: 228, top: 150});
});
test('top-edge selection places the toolbar below it', () => {
  const anchor = {left: 200, right: 300, top: 90, bottom: 112};
  assert.deepEqual(toolbarPosition(anchor, bounds, 44, 42), {left: 228, top: 120});
});
test('toolbar stays inside left and right pane boundaries', () => {
  assert.equal(toolbarPosition({left: 100, right: 102, top: 200, bottom: 222}, bounds, 44, 42)?.left, 108);
  assert.equal(toolbarPosition({left: 697, right: 700, top: 200, bottom: 222}, bounds, 44, 42)?.left, 648);
});
test('offscreen selections and tiny panes never leave an orphan toolbar', () => {
  assert.equal(toolbarPosition({left: 200, right: 300, top: 700, bottom: 722}, bounds, 44, 42), null);
  assert.equal(toolbarPosition({left: 200, right: 300, top: 200, bottom: 222}, {left: 100, right: 140, top: 80, bottom: 600}, 44, 42), null);
});
