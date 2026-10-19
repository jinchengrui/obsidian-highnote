import {DATA_FOLDER} from './model';

/** Accept a portable vault-relative directory without resolving traversal. */
export function dataDirectory(value: unknown): string {
  if (typeof value !== 'string') throw new Error('请输入笔记库内的相对目录。');
  const path = value.trim().replace(/\/+$/u, '');
  const parts = path.split('/');
  if (!path || path.length > 500 || parts.some(part => !part || part === '.' || part === '..'
    || part !== part.trim() || part.endsWith('.') || /[\\:*?"<>|]/u.test(part)
    || [...part].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
    || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part))) {
    throw new Error('请使用笔记库内的相对目录，例如 Highnote/annotations；不能包含 .. 或特殊路径字符。');
  }
  return path;
}

export function savedDataDirectory(value: unknown): string {
  if (value === undefined) return DATA_FOLDER;
  return dataDirectory(value);
}

export function directoryParents(path: string): string[] {
  const parts = dataDirectory(path).split('/');
  return parts.map((_part, index) => parts.slice(0, index + 1).join('/'));
}

export function annotationDirectory(value: unknown, configDirectory: string): string {
  const path = dataDirectory(value);
  const lower = path.normalize('NFC').toLowerCase(), config = configDirectory.normalize('NFC').toLowerCase();
  if (lower === config || lower.startsWith(`${config}/`)) {
    throw new Error('请选择插件配置目录之外的独立批注目录，例如 Highnote/annotations。');
  }
  return path;
}
