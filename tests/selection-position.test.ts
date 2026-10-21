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

test('touch toolbar respects phone, tablet, split-pane and keyboard viewport bounds', async () => {
  const {touchToolbarPosition, TOUCH_TOOLBAR_SIZE} = await import('../src/selection-position');
  for (const [width,height] of [[440,956],[744,1133],[1133,744],[360,720],[440,380]]) {
    const bounds={left:10,right:width!-10,top:90,bottom:height!-50};
    const anchor={left:50,right:210,top:140,bottom:165};
    const position=touchToolbarPosition(anchor,bounds);
    assert.ok(position);assert.ok(position.left>=bounds.left);assert.ok(position.left+TOUCH_TOOLBAR_SIZE.width<=bounds.right);
    assert.ok(position.top>=bounds.top);assert.ok(position.top+TOUCH_TOOLBAR_SIZE.height<=bounds.bottom);
    assert.ok(position.top>anchor.bottom||position.top+TOUCH_TOOLBAR_SIZE.height<anchor.top);
  }
  assert.equal(touchToolbarPosition({left:10,right:20,top:40,bottom:60},{left:0,right:230,top:0,bottom:700}),null);
});
