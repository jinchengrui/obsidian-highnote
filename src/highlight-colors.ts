export const HIGHLIGHT_COLORS = [
  {name: '浅灰', value: '#eef0f3'}, {name: '浅红', value: '#f7b8bf'},
  {name: '浅橙', value: '#ffd7b0'}, {name: '浅黄', value: '#ffe083'},
  {name: '浅绿', value: '#c4efc4'}, {name: '浅蓝', value: '#c8d4ff'},
  {name: '浅紫', value: '#ddc6fa'}, {name: '灰色', value: '#cdd1da'},
  {name: '红色', value: '#f25b60'}, {name: '橙色', value: '#ff9a3c'},
  {name: '黄色', value: '#ffe324'}, {name: '绿色', value: '#59c653'},
  {name: '蓝色', value: '#8da4ff'}, {name: '紫色', value: '#b38aef'}
] as const;

export function parseHighlightColor(value: string): string | null {
  const trimmed = value.trim();
  return /^#?[a-f0-9]{6}$/iu.test(trimmed) ? `#${trimmed.replace(/^#/u, '').toLowerCase()}` : null;
}

export interface RGB { r: number; g: number; b: number }
export interface HSV { h: number; s: number; v: number }
const clamp = (value: number, max: number) => Math.max(0, Math.min(max, value));

export function hexToRgb(value: string): RGB | null {
  const hex = parseHighlightColor(value);
  if (!hex) return null;
  return {r: parseInt(hex.slice(1, 3), 16), g: parseInt(hex.slice(3, 5), 16), b: parseInt(hex.slice(5, 7), 16)};
}

export function rgbToHex(rgb: RGB): string {
  return '#' + [rgb.r, rgb.g, rgb.b].map(value => Math.round(clamp(value, 255)).toString(16).padStart(2, '0')).join('');
}

export function rgbToHsv({r, g, b}: RGB): HSV {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), delta = max - min;
  const hue = delta === 0 ? 0 : max === r ? (g - b) / delta : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4;
  return {h: (hue * 60 + 360) % 360, s: max === 0 ? 0 : delta / max, v: max};
}

export function hsvToRgb({h, s, v}: HSV): RGB {
  h = ((h % 360) + 360) % 360; s = clamp(s, 1); v = clamp(v, 1);
  const chroma = v * s, x = chroma * (1 - Math.abs(h / 60 % 2 - 1)), m = v - chroma;
  const [r, g, b] = h < 60 ? [chroma, x, 0] : h < 120 ? [x, chroma, 0] : h < 180 ? [0, chroma, x]
    : h < 240 ? [0, x, chroma] : h < 300 ? [x, 0, chroma] : [chroma, 0, x];
  return {r: Math.round((r + m) * 255), g: Math.round((g + m) * 255), b: Math.round((b + m) * 255)};
}
