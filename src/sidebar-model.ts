import type { Highlight, Message, Thread } from './model';

type Annotation = Readonly<Thread> | Readonly<Highlight>;

export const MESSAGE_BATCH_SIZE = 40;

interface MessageBatchState {
  page: number;
  messageId: string;
  total: number;
  lastMessageId: string;
}

/** Keep independent, bounded page state and reuse live messages until the source changes. */
export class MessageBatches {
  private states = new Map<string, MessageBatchState>();
  private live = new WeakMap<Message[], {revision: number; messages: readonly Message[]}>();
  constructor(private readonly maxStates = 2048) {}

  private messages(thread: Readonly<Thread>): readonly Message[] {
    const cached = this.live.get(thread.messages);
    if (cached?.revision === thread.revision) return cached.messages;
    const messages = thread.messages.filter(message => !message.deleted);
    this.live.set(thread.messages, {revision: thread.revision, messages});
    return messages;
  }

  private remember(id: string, state: MessageBatchState): void {
    this.states.delete(id);
    if (this.states.size >= this.maxStates) this.states.delete(this.states.keys().next().value!);
    this.states.set(id, state);
  }

  get(thread: Readonly<Thread>): {messages: readonly Message[]; page: number; pages: number; start: number; total: number; messageId: string} {
    const messages = this.messages(thread);
    const lastMessageId = messages.at(-1)?.id ?? '';
    const state = this.states.get(thread.id) ?? {page: 0, messageId: '', total: messages.length, lastMessageId};
    if (messages.length > state.total && lastMessageId !== state.lastMessageId) state.messageId = lastMessageId;
    if (state.messageId) {
      const index = messages.findIndex(message => message.id === state.messageId);
      if (index >= 0) state.page = Math.floor(index / MESSAGE_BATCH_SIZE);
      else state.messageId = '';
    }
    const pages = Math.max(1, Math.ceil(messages.length / MESSAGE_BATCH_SIZE));
    state.page = Math.max(0, Math.min(state.page, pages - 1));
    state.total = messages.length;
    state.lastMessageId = lastMessageId;
    this.remember(thread.id, state);
    const start = state.page * MESSAGE_BATCH_SIZE;
    return {messages: messages.slice(start, start + MESSAGE_BATCH_SIZE), page: state.page, pages,
      start, total: messages.length, messageId: state.messageId};
  }

  setPage(thread: Readonly<Thread>, page: number): void {
    this.get(thread);
    const state = this.states.get(thread.id)!;
    state.page = page;
    state.messageId = '';
    this.get(thread);
  }

  reveal(thread: Readonly<Thread>, messageId: string): void {
    this.get(thread);
    const state = this.states.get(thread.id)!;
    state.messageId = messageId;
    this.remember(thread.id, state);
    this.get(thread);
  }

  delete(id: string): void { this.states.delete(id); }
}

export function cannotLocate(item: Annotation): boolean {
  return item.fileMissing || item.anchor.state !== 'attached';
}

/** Use the same order for rendering, revealing and previous/next navigation. */
export function annotationOrder(allFiles: boolean): (left: Annotation, right: Annotation) => number {
  return (left, right) => (allFiles ? left.filePath.localeCompare(right.filePath) : 0)
    || Number(cannotLocate(left)) - Number(cannotLocate(right))
    || (cannotLocate(left) ? 0 : left.anchor.from - right.anchor.from)
    || left.createdAt.localeCompare(right.createdAt)
    || left.id.localeCompare(right.id);
}

/** Add only as many parent directories as needed to distinguish duplicate names. */
export function fileLabels(paths: readonly string[]): Map<string, string> {
  const names = new Map<string, string[]>();
  for (const path of new Set(paths)) {
    const name = path.split('/').at(-1) ?? path;
    const group = names.get(name) ?? [];
    group.push(path);
    names.set(name, group);
  }
  const labels = new Map<string, string>();
  for (const group of names.values()) {
    const suffixCounts = new Map<string, number>();
    const partsByPath = new Map(group.map(path => [path, path.split('/')]));
    for (const parts of partsByPath.values()) {
      for (let depth = 1; depth <= parts.length; depth++) {
        const suffix = parts.slice(-depth).join('/');
        suffixCounts.set(suffix, (suffixCounts.get(suffix) ?? 0) + 1);
      }
    }
    for (const path of group) {
      const parts = partsByPath.get(path)!;
      let depth = 1;
      while (depth < parts.length && suffixCounts.get(parts.slice(-depth).join('/'))! > 1) depth++;
      labels.set(path, parts.slice(-depth).join('/'));
    }
  }
  return labels;
}
