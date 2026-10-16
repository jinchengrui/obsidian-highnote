import {test} from 'node:test';
import assert from 'node:assert/strict';
import {HIGHLIGHT_COLORS, hexToRgb, hsvToRgb, parseHighlightColor, rgbToHex, rgbToHsv} from '../src/highlight-colors';

test('custom colors accept only opaque six-digit hex values and presets stay selectable', () => {
  assert.equal(parseHighlightColor(' #AaBbCc '), '#aabbcc');
  assert.equal(parseHighlightColor('ffe083'), '#ffe083');
  for (const invalid of ['', 'none', 'transparent', '#fff', '#00000000', 'red', 'url(x)', '<script>']) {
    assert.equal(parseHighlightColor(invalid), null);
  }
  assert.equal(HIGHLIGHT_COLORS.length, 14);
  assert.equal(new Set(HIGHLIGHT_COLORS.map(color => color.value)).size, 14);
  for (const color of HIGHLIGHT_COLORS) assert.equal(parseHighlightColor(color.value), color.value);
});

test('visual picker preserves RGB values through HSV conversion, including gray and hue boundaries', () => {
  for (const hex of ['#000000', '#ffffff', '#808080', '#ff0000', '#00ff00', '#0000ff', '#ff6600', '#123abc', ...HIGHLIGHT_COLORS.map(c => c.value)]) {
    const rgb = hexToRgb(hex)!;
    assert.equal(rgbToHex(hsvToRgb(rgbToHsv(rgb))), hex);
  }
  for (let r = 0; r <= 255; r += 17) for (let g = 0; g <= 255; g += 17) for (let b = 0; b <= 255; b += 17) {
    assert.deepEqual(hsvToRgb(rgbToHsv({r, g, b})), {r, g, b});
  }
  assert.equal(hexToRgb('invalid'), null);
  assert.deepEqual(hsvToRgb({h: 360, s: 1, v: 1}), {r: 255, g: 0, b: 0});
  assert.deepEqual(hsvToRgb({h: -60, s: 1, v: 1}), {r: 255, g: 0, b: 255});
  assert.equal(rgbToHex({r: -10, g: 127.6, b: 300}), '#0080ff');
});
