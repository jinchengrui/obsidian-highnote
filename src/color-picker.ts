import { Modal, type App } from 'obsidian';
import { hexToRgb, hsvToRgb, parseHighlightColor, rgbToHex, rgbToHsv, type RGB } from './highlight-colors';

export class CustomColorModal extends Modal {
  constructor(app: App, private initial: string, private save: (value: string) => Promise<void>, private report: (error: unknown) => void) { super(app); }
  onOpen(): void {
    this.setTitle('自定义标记颜色');
    this.modalEl.addClass('hn-color-picker-shell');
    this.contentEl.addClass('hn-custom-color-modal');
    let hsv = rgbToHsv(hexToRgb(this.initial) ?? {r: 255, g: 224, b: 131});
    let color = rgbToHex(hsvToRgb(hsv)), valid = true, busy = false;
    const panel = this.contentEl.createDiv({cls: 'hn-color-plane', attr: {
      role: 'group', tabindex: '0', 'aria-label': '饱和度与明度',
      'aria-description': '左右方向键调整饱和度，上下方向键调整明度，按住 Shift 加快调整。'
    }});
    const cursor = panel.createSpan({cls: 'hn-color-cursor', attr: {'aria-hidden': 'true'}});
    const strip = this.contentEl.createDiv({cls: 'hn-color-strip'});
    const swatch = strip.createSpan({cls: 'hn-custom-color-preview', attr: {role: 'img', 'aria-label': '颜色预览'}});
    const hue = strip.createEl('input', {cls: 'hn-color-hue', attr: {
      type: 'range', min: '0', max: '360', step: '1', 'aria-label': '色相'
    }});
    const fields = this.contentEl.createDiv({cls: 'hn-color-fields'});
    const field = (label: string, name: string, type: string) => {
      const wrapper = fields.createEl('label', {cls: 'hn-color-field'});
      wrapper.createSpan({text: label});
      return wrapper.createEl('input', {attr: {type, 'aria-label': name, spellcheck: 'false'}});
    };
    const hex = field('HEX', '自定义颜色值', 'text'); hex.maxLength = 7;
    const rgb = (['r', 'g', 'b'] as const).map(channel => {
      const input = field(channel.toUpperCase(), `${channel.toUpperCase()} 颜色值`, 'number');
      input.min = '0'; input.max = '255'; input.step = '1'; input.inputMode = 'numeric';
      return {channel, input};
    });
    const feedback = this.contentEl.createDiv({cls: 'hn-color-feedback', attr: {role: 'status', 'aria-live': 'polite'}});
    const actions = this.contentEl.createDiv({cls: 'hn-actions hn-color-picker-actions'});
    const cancel = actions.createEl('button', {text: '取消', attr: {type: 'button'}});
    const submit = actions.createEl('button', {text: '应用', cls: 'mod-cta', attr: {type: 'button'}});
    cancel.addEventListener('click', () => this.close());
    const refresh = (origin: 'hex' | 'rgb' | 'picker' = 'picker') => {
      const value = hsvToRgb(hsv);
      color = rgbToHex(value); valid = true;
      if (origin !== 'hex') hex.value = color;
      if (origin !== 'rgb') for (const item of rgb) item.input.value = String(value[item.channel]);
      for (const input of [hex, ...rgb.map(item => item.input)]) input.removeAttribute('aria-invalid');
      hue.value = String(hsv.h);
      hue.style.setProperty('--hn-hue-color', rgbToHex(hsvToRgb({h: hsv.h, s: 1, v: 1})));
      panel.style.setProperty('--hn-hue-color', rgbToHex(hsvToRgb({h: hsv.h, s: 1, v: 1})));
      cursor.style.left = `calc(${hsv.s * 100}% + ${6 - hsv.s * 12}px)`;
      cursor.style.top = `calc(${(1 - hsv.v) * 100}% + ${6 - (1 - hsv.v) * 12}px)`;
      panel.setAttribute('aria-label', `饱和度 ${Math.round(hsv.s * 100)}%，明度 ${Math.round(hsv.v * 100)}%`);
      swatch.style.setProperty('--hn-swatch-color', color);
      swatch.setAttribute('aria-label', `颜色预览 ${color}`);
      feedback.removeClass('is-error'); feedback.setText('应用后更新所有标记');
      submit.disabled = busy;
    };
    const invalid = (input: HTMLInputElement, message: string) => {
      valid = false; input.setAttribute('aria-invalid', 'true');
      feedback.addClass('is-error'); feedback.setText(message); submit.disabled = true;
    };
    const acceptRgb = (value: RGB, origin: 'hex' | 'rgb') => {
      const next = rgbToHsv(value);
      // Achromatic colors still retain the hue selected by the user.
      hsv = {...next, h: next.s === 0 ? hsv.h : next.h}; refresh(origin);
    };
    hex.addEventListener('input', () => {
      if (busy) return;
      const value = hexToRgb(hex.value);
      if (value) acceptRgb(value, 'hex'); else invalid(hex, '请输入六位 HEX 颜色值');
    });
    for (const item of rgb) item.input.addEventListener('input', () => {
      if (busy) return;
      const value: RGB = {r: 0, g: 0, b: 0};
      for (const entry of rgb) {
        const number = entry.input.valueAsNumber;
        if (!Number.isInteger(number) || number < 0 || number > 255) {
          invalid(entry.input, 'RGB 需为 0–255 的整数'); return;
        }
        value[entry.channel] = number;
      }
      acceptRgb(value, 'rgb');
    });
    hue.addEventListener('input', () => { if (!busy) { hsv.h = hue.valueAsNumber; refresh(); } });
    const selectPoint = (event: PointerEvent) => {
      const rect = panel.getBoundingClientRect();
      if (!rect.width || !rect.height || busy) return;
      hsv.s = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
      hsv.v = 1 - Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height));
      refresh();
    };
    let pointer: number | null = null;
    panel.addEventListener('pointerdown', event => {
      if (busy || !event.isPrimary || event.button !== 0) return;
      event.preventDefault(); panel.focus(); pointer = event.pointerId;
      panel.setPointerCapture(pointer); selectPoint(event);
    });
    panel.addEventListener('pointermove', event => { if (pointer === event.pointerId) selectPoint(event); });
    const release = (event: PointerEvent) => {
      if (pointer !== event.pointerId) return;
      if (panel.hasPointerCapture(event.pointerId)) panel.releasePointerCapture(event.pointerId);
      pointer = null;
    };
    panel.addEventListener('pointerup', release);
    panel.addEventListener('pointercancel', release);
    panel.addEventListener('lostpointercapture', () => { pointer = null; });
    panel.addEventListener('keydown', event => {
      if (busy || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
      event.preventDefault(); event.stopPropagation(); const step = event.shiftKey ? .1 : .01;
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') hsv.s = Math.max(0, Math.min(1, hsv.s + (event.key === 'ArrowRight' ? step : -step)));
      else hsv.v = Math.max(0, Math.min(1, hsv.v + (event.key === 'ArrowUp' ? step : -step)));
      refresh();
    });
    const apply = async () => {
      if (busy || !valid || !parseHighlightColor(color)) return;
      busy = true;
      for (const input of [hex, hue, ...rgb.map(item => item.input)]) input.disabled = true;
      panel.setAttribute('aria-disabled', 'true'); cancel.disabled = true; submit.disabled = true;
      try { await this.save(color); this.close(); }
      catch (error) { this.report(error); }
      finally {
        busy = false;
        for (const input of [hex, hue, ...rgb.map(item => item.input)]) input.disabled = false;
        panel.removeAttribute('aria-disabled'); cancel.disabled = false; submit.disabled = !valid;
      }
    };
    submit.addEventListener('click', () => { void apply(); });
    this.contentEl.addEventListener('keydown', event => {
      if (event.key === 'Enter' && !event.isComposing && [hex, hue, ...rgb.map(item => item.input)].some(input => input === event.target)) {
        event.preventDefault(); event.stopPropagation(); void apply();
      }
    });
    refresh(); panel.focus();
  }
  onClose(): void { this.contentEl.empty(); }
}
