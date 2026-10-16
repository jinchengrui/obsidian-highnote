import { PluginSettingTab, type App, type SettingDefinitionItem } from 'obsidian';
import { HIGHLIGHT_COLORS } from './highlight-colors';
import { CustomColorModal } from './color-picker';
import type HighnotePlugin from './main';
import type { FlomoConfig } from './flomo';

export const DEFAULT_HIGHLIGHT_COLOR = '#ffe083';
export interface AnnotationSettings { highlightColor: string; exportFormat: 'md' | 'html'; reviewExportFormat?: 'md' | 'html' | 'flomo_csv'; flomo?: FlomoConfig }

export function highlightColor(value: unknown): string {
  return typeof value === 'string' && /^#[a-f0-9]{6}$/iu.test(value) ? value.toLowerCase() : DEFAULT_HIGHLIGHT_COLOR;
}

export class AnnotationSettingsTab extends PluginSettingTab {
  constructor(app: App, private annotationPlugin: HighnotePlugin) { super(app, annotationPlugin); }
  getSettingDefinitions(): SettingDefinitionItem[] {
    return [{name: '标记颜色', desc: '所有标记共用此颜色，选择后立即更新。', render: setting => {
      setting.settingEl.addClass('hn-color-setting');
      const colors = setting.controlEl.createDiv({cls: 'hn-color-palette', attr: {role: 'group', 'aria-label': '预设标记颜色'}});
      const buttons: HTMLButtonElement[] = [];
      for (const color of HIGHLIGHT_COLORS) {
        const selected = this.annotationPlugin.settings.highlightColor === color.value;
        const button = colors.createEl('button', {cls: 'hn-color-swatch', text: selected ? '✓' : '',
          attr: {type: 'button', 'aria-label': color.name, title: color.name, 'aria-pressed': String(selected), 'data-color': color.value}});
        button.style.setProperty('--hn-swatch-color', color.value);
        button.addEventListener('click', () => this.annotationPlugin.run(async () => {
          await this.annotationPlugin.setHighlightColor(color.value); this.update();
        }));
        buttons.push(button);
        button.addEventListener('keydown', event => {
          const index = buttons.indexOf(button);
          const next = event.key === 'ArrowRight' ? index + 1 : event.key === 'ArrowLeft' ? index - 1
            : event.key === 'ArrowDown' ? index + 7 : event.key === 'ArrowUp' ? index - 7
              : event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : null;
          if (next === null) return;
          event.preventDefault(); buttons[Math.max(0, Math.min(buttons.length - 1, next))]?.focus();
        });
      }
      const actions = setting.controlEl.createDiv({cls: 'hn-color-actions'});
      const custom = actions.createEl('button', {cls: 'hn-color-custom', text: '自定义', attr: {type: 'button'}});
      custom.createSpan({cls: 'hn-color-custom-icon', attr: {'aria-hidden': 'true'}});
      const current = this.annotationPlugin.settings.highlightColor;
      if (!HIGHLIGHT_COLORS.some(color => color.value === current)) {
        custom.addClass('is-selected');
        custom.createSpan({text: current, cls: 'hn-color-custom-value'});
      }
      custom.addEventListener('click', () => this.annotationPlugin.openModal(new CustomColorModal(this.app, current, async value => {
        await this.annotationPlugin.setHighlightColor(value); this.update();
      }, error => this.annotationPlugin.report(error))));
      const reset = actions.createEl('button', {text: '恢复默认', attr: {type: 'button'}});
      reset.addEventListener('click', () => this.annotationPlugin.run(async () => {
        await this.annotationPlugin.setHighlightColor(DEFAULT_HIGHLIGHT_COLOR); this.update();
      }));
    }}];
  }
}
