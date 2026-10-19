import { Transaction, type ChangeDesc } from '@codemirror/state';
import type { Anchor } from './model';

const CONTEXT = 64;

/** Extract a single, same-file change without relying on focus as evidence of its origin. */
export function observedEditorChange(transaction: Transaction, previousPath: string, beforePath: string, path: string,
  focused: boolean, editable: boolean) {
  if (!path || previousPath !== beforePath || beforePath !== path || !transaction.docChanged) return null;
  const userEdit = focused && editable && !transaction.startState.readOnly
    && transaction.annotation(Transaction.remote) !== true
    && ['input', 'delete', 'move', 'undo', 'redo'].some(event => transaction.isUserEvent(event));
  // Replacing a selection with identical text is still a real user replacement.
  if (!userEdit && transaction.startState.doc.eq(transaction.state.doc)) return null;
  return {path, before: transaction.startState.doc.toString(), after: transaction.state.doc.toString(),
    changes: transaction.changes, userEdit};
}

export function makeAnchor(source: string, from: number, to: number): Anchor {
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to > source.length || from >= to) {
    throw new Error('请先选择一段 Markdown 原文。');
  }
  return {from, to, quote: source.slice(from, to), before: source.slice(Math.max(0, from - CONTEXT), from),
    after: source.slice(to, to + CONTEXT), state: 'attached'};
}

/** User replacements lose identity; background replacements may contain unchanged original text. */
export function mapAnchor(anchor: Anchor, before: string, after: string, changes: ChangeDesc, userEdit = true): Anchor {
  if (anchor.state === 'detached') return anchor;
  if (before.slice(anchor.from, anchor.to) !== anchor.quote) return relocateAnchor(after, anchor);
  let fullyReplaced = false;
  let preserved: Anchor | undefined;
  changes.iterChangedRanges((from, to, newFrom, newTo) => {
    if (from <= anchor.from && to >= anchor.to && to > from) {
      fullyReplaced = true;
      if (!userEdit) preserved = preservedReplacement(anchor, before, after, newFrom, newTo);
    }
  });
  if (fullyReplaced) return preserved ?? {...anchor, state: 'detached'};
  const from = changes.mapPos(anchor.from, 1);
  const to = changes.mapPos(anchor.to, -1);
  if (to <= from || to > after.length) return {...anchor, state: 'detached'};
  return makeAnchor(after, from, to);
}

function preservedReplacement(anchor: Anchor, before: string, after: string,
  newFrom: number, newTo: number): Anchor | undefined {
  // The quote must survive inside this replacement, uniquely in both snapshots.
  // Never bind a deleted passage to an identical copy elsewhere in the document.
  const occurrence = after.indexOf(anchor.quote);
  if (before.indexOf(anchor.quote) !== anchor.from || before.indexOf(anchor.quote, anchor.from + 1) >= 0
    || occurrence < newFrom || occurrence + anchor.quote.length > newTo
    || after.indexOf(anchor.quote, occurrence + 1) >= 0) return undefined;
  return makeAnchor(after, occurrence, occurrence + anchor.quote.length);
}

/** External edits have no reliable identity map: require a unique, strong context match. */
export function relocateAnchor(source: string, anchor: Anchor): Anchor {
  if (anchor.state === 'detached') return anchor;
  const occurrence = source.indexOf(anchor.quote);
  // A unique quote still at its saved position remains valid when surrounding prose changes.
  if (occurrence === anchor.from && source.indexOf(anchor.quote, occurrence + 1) < 0
    && source.slice(anchor.from, anchor.to) === anchor.quote) return makeAnchor(source, anchor.from, anchor.to);
  const candidates: number[] = [];
  for (let from = source.indexOf(anchor.quote); from >= 0; from = source.indexOf(anchor.quote, from + 1)) {
    const to = from + anchor.quote.length;
    const before = source.slice(Math.max(0, from - anchor.before.length), from);
    const after = source.slice(to, to + anchor.after.length);
    const left = matchingSuffix(before, anchor.before);
    const right = matchingPrefix(after, anchor.after);
    const exactLeft = before === anchor.before && (anchor.before.length > 0 || from === 0);
    const exactRight = after === anchor.after && (anchor.after.length > 0 || to === source.length);
    if ((exactLeft && exactRight) || (left >= 16 && right >= 16) || (left + right >= 48)) candidates.push(from);
    if (candidates.length > 1) return {...anchor, state: 'detached'};
  }
  const from = candidates[0];
  return from === undefined ? {...anchor, state: 'detached'} : makeAnchor(source, from, from + anchor.quote.length);
}

function matchingPrefix(a: string, b: string): number {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n++;
  return n;
}
function matchingSuffix(a: string, b: string): number {
  let n = 0;
  while (n < a.length && n < b.length && a[a.length - n - 1] === b[b.length - n - 1]) n++;
  return n;
}
