import { PluginSettingTab, type App, type SettingDefinitionItem } from 'obsidian';
import { HIGHLIGHT_COLORS } from './highlight-colors';
import { CustomColorModal } from './color-picker';
import type HighnotePlugin from './main';
import type { FlomoConfig } from './flomo';
import {DATA_FOLDER, LEGACY_DATA_ROOT} from './model';

export const DEFAULT_HIGHLIGHT_COLOR = '#ffe083';
export interface AnnotationSettings { dataDirectory?: string; highlightColor: string; exportFormat: 'md' | 'html'; reviewExportFormat?: 'md' | 'html' | 'flomo_csv'; flomo?: FlomoConfig }

export function highlightColor(value: unknown): string {
  return typeof value === 'string' && /^#[a-f0-9]{6}$/iu.test(value) ? value.toLowerCase() : DEFAULT_HIGHLIGHT_COLOR;
}

export class AnnotationSettingsTab extends PluginSettingTab {
  private migrationSource = LEGACY_DATA_ROOT;
  private migrationTarget = DATA_FOLDER;
  private migrationBusy = false;
  private migrationStatus = '';
  constructor(app: App, private annotationPlugin: HighnotePlugin) { super(app, annotationPlugin); }
  getSettingDefinitions(): SettingDefinitionItem[] {
    const directory: SettingDefinitionItem = {name: '批注数据目录',
      desc: '默认 Highnote/annotations，电脑和手机应相同。使用 Obsidian Sync 时需开启“同步所有其他类型”。应用目录仅切换读取和保存位置；已有数据请在桌面端使用“迁移批注数据”。',
      render: setting => {
        setting.settingEl.addClass('hn-directory-setting');
        setting.settingEl.querySelectorAll('.hn-directory-status').forEach(element => element.remove());
        let value = this.annotationPlugin.dataFolder;
        let busy = false;
        setting.addText(text => {
          text.setPlaceholder('Highnote/annotations').setValue(value).onChange(next => { value = next; });
          text.inputEl.setAttribute('aria-label', '批注数据目录');
        });
        const status = setting.settingEl.createDiv({cls: 'hn-directory-status', attr: {role: 'status'}});
        const apply = async () => {
          if (busy) return;
          busy = true; status.setText('正在应用目录…');
          for (const input of setting.controlEl.querySelectorAll<HTMLInputElement | HTMLButtonElement>('input,button')) input.disabled = true;
          try { await this.annotationPlugin.setDataDirectory(value); this.update(); }
          catch (error) { status.setText(error instanceof Error ? error.message : '目录切换失败，请重试。'); }
          finally {
            busy = false;
            for (const input of setting.controlEl.querySelectorAll<HTMLInputElement | HTMLButtonElement>('input,button')) input.disabled = false;
          }
        };
        setting.addButton(button => button.setButtonText('应用').setCta().onClick(() => { void apply(); }));
        setting.addButton(button => button.setButtonText('恢复默认').onClick(() => { value = DATA_FOLDER; void apply(); }));
      }};
    if (this.annotationPlugin.isMobileReview) return [directory, {name: '手机版阅读回顾',
      desc: '支持查看、搜索和按日期回顾已有批注。评论与标记请在桌面端操作；将上面设置的目录同步到手机后，在回顾页点“刷新”。'}];
    const migration: SettingDefinitionItem = {name: '迁移批注数据',
      desc: '将源目录内的批注复制到目标目录，成功后自动切换。支持读取源目录下的 annotations 子目录；源文件保留为备份，同名不同内容不会覆盖。',
      render: setting => {
        setting.settingEl.addClass('hn-migration-setting');
        setting.settingEl.querySelectorAll('.hn-directory-status').forEach(element => element.remove());
        const field = (name: string, value: string, placeholder: string, change: (value: string) => void) => {
          const label = setting.controlEl.createEl('label', {cls: 'hn-migration-field'});
          label.createSpan({text: name});
          const input = label.createEl('input', {type: 'text', attr: {'aria-label': name, placeholder}});
          input.value = value;
          input.addEventListener('input', () => { input.removeAttribute('aria-invalid'); change(input.value); });
          return input;
        };
        const sourceInput = field('迁移源目录', this.migrationSource, LEGACY_DATA_ROOT, value => { this.migrationSource = value; });
        const targetInput = field('迁移目标目录', this.migrationTarget, DATA_FOLDER, value => { this.migrationTarget = value; });
        const status = setting.settingEl.createDiv({cls: 'hn-directory-status', text: this.migrationStatus, attr: {role: 'status'}});
        const controls = () => {
          for (const input of setting.controlEl.querySelectorAll<HTMLInputElement | HTMLButtonElement>('input,button')) input.disabled = this.migrationBusy;
        };
        const setStatus = (text: string) => { this.migrationStatus = text; status.setText(text); };
        const migrate = async () => {
          if (this.migrationBusy) return;
          for (const [value, input, message] of [
            [this.migrationSource, sourceInput, `请填写迁移源目录，例如 ${LEGACY_DATA_ROOT}。`],
            [this.migrationTarget, targetInput, `请填写迁移目标目录，例如 ${DATA_FOLDER}。`]
          ] as const) {
            if (!value.trim()) {
              setStatus(message); input.setAttribute('aria-invalid', 'true'); input.focus(); return;
            }
          }
          this.migrationBusy = true; controls(); setStatus('正在检查目录…');
          try {
            const result = await this.annotationPlugin.migrateDataDirectory(this.migrationSource, this.migrationTarget, progress => {
              const label = {checking: '正在检查', copying: '正在复制', verifying: '正在校验'}[progress.phase];
              setStatus(`${label}：${progress.completed} / ${progress.total} 个文件`);
            });
            setStatus(`迁移完成：新增 ${result.copied} 个，跳过 ${result.skipped} 个相同文件。已切换至 ${result.directory}；源文件保留为备份。`);
          } catch (error) {
            setStatus(`${error instanceof Error ? error.message : '迁移失败，请重试。'} 源数据保留；已复制的文件可在重试时复用。`);
          } finally { this.migrationBusy = false; this.update(); }
        };
        setting.addButton(button => button.setButtonText(this.migrationBusy ? '正在迁移…' : '迁移').setCta().onClick(() => { void migrate(); }));
        controls();
      }};
    return [directory, migration, {name: '标记颜色', desc: '所有标记共用此颜色，选择后立即更新。', render: setting => {
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
