export function plainMarkdown(source: string): string {
  return source
    .replace(/^ {0,3}(?:>[ \t]?)+(?:\[![^\]\n]+\][+-]?[ \t]*)?/gmu, '')
    .replace(/!\[([^\]]*)\]\([^\n)]*\)/gu, '$1')
    .replace(/\[([^\]]+)\]\([^\n)]*\)/gu, '$1')
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/gu, '$2')
    .replace(/\[\[([^\]]+)\]\]/gu, '$1')
    .replace(/^\s{0,3}(?:#{1,6}\s+|>\s?|[-+*]\s+|\d+[.)]\s+)/gmu, '')
    .replace(/(?:\*\*|__|~~|==|`)/gu, '')
    .replace(/[*_]/gu, '');
}

export interface RenderedSelection { text: string; from: number; to: number }

/** Remove layout whitespace while retaining UTF-16 positions used by DOM ranges. */
function compactText(text: string): {text: string; positions: number[]} {
  let compact = '';
  const positions: number[] = [];
  for (let i = 0; i < text.length; i++) {
    if (/\s/u.test(text[i]!)) continue;
    compact += text[i]; positions.push(i);
  }
  return {text: compact, positions};
}

export function findUnique(text: string, query: string): number | null {
  if (!query) return null;
  const from = text.indexOf(query);
  return from >= 0 && text.indexOf(query, from + 1) < 0 ? from : null;
}

/** Disambiguate repeated rendered text by its occurrence in the known source section. */
export function renderedAnchorOffset(section: string, rendered: string, from: number, to: number): number | null {
  if (from < 0 || to <= from || to > section.length) return null;
  const plain = plainMarkdown(section.slice(from, to));
  const unique = findUnique(rendered, plain);
  if (unique !== null) return unique;
  if (!plain) return null;
  const sourceText = plainMarkdown(section);
  const prefix = plainMarkdown(section.slice(0, from));
  if (sourceText.slice(prefix.length, prefix.length + plain.length) !== plain) return null;
  const occurrences = (text: string) => {
    const result: number[] = [];
    for (let offset = text.indexOf(plain); offset >= 0; offset = text.indexOf(plain, offset + 1)) result.push(offset);
    return result;
  };
  const before = occurrences(sourceText);
  const after = occurrences(rendered);
  const index = before.indexOf(prefix.length);
  return index >= 0 && before.length === after.length ? after[index] ?? null : null;
}

export function selectionInSection(source: string, lineStart: number, lineEnd: number, selection: string,
  rendered?: RenderedSelection): {from: number; to: number} | null {
  if (!selection.trim()) return null;
  const lines = source.split('\n');
  const base = lines.slice(0, lineStart).reduce((sum, line) => sum + line.length + 1, 0);
  const section = lines.slice(lineStart, lineEnd + 1).join('\n');
  const direct = findUnique(section, selection);
  // Block prefixes are structure, not selected text. In particular, a callout's
  // [!type] header must not reject formatted prose elsewhere in the same block.
  const mapping: number[] = [];
  let normalized = '';
  const delimiter = /\*\*|__|~~|==|[*_]/gu;
  let sourceOffset = 0;
  for (const line of section.split('\n')) {
    let prefix = /^ {0,3}(?:>[ \t]?)+/u.exec(line)?.[0].length ?? 0;
    if (prefix) prefix += /^\[![^\]\n]+\][+-]?[ \t]*/u.exec(line.slice(prefix))?.[0].length ?? 0;
    prefix += /^ {0,3}(?:#{1,6}[ \t]+|[-+*][ \t]+|\d+[.)][ \t]+)/u.exec(line.slice(prefix))?.[0].length ?? 0;
    const content = line.slice(prefix);
    const removed = new Set<number>();
    for (const match of content.matchAll(delimiter)) {
      for (let i = 0; i < match[0].length; i++) removed.add(match.index + i);
    }
    for (let i = prefix; i < line.length; i++) {
      if (!removed.has(i - prefix)) { normalized += line[i]; mapping.push(sourceOffset + i); }
    }
    sourceOffset += line.length;
    if (sourceOffset < section.length) { normalized += '\n'; mapping.push(sourceOffset); sourceOffset++; }
  }
  const offset = findUnique(normalized, selection);
  if (rendered) {
    if (!Number.isInteger(rendered.from) || !Number.isInteger(rendered.to)
      || rendered.from < 0 || rendered.to > rendered.text.length || rendered.from >= rendered.to
      || rendered.text.slice(rendered.from, rendered.to) !== selection) return null;
    const sourceText = compactText(normalized);
    const displayed = compactText(rendered.text);
    if (sourceText.text === displayed.text) {
      // The complete section agrees: use the actual range, including which copy
      // of repeated prose was selected, rather than binding its first match.
      const first = displayed.positions.findIndex(position => position >= rendered.from);
      let last = first;
      while (last + 1 < displayed.positions.length && displayed.positions[last + 1]! < rendered.to) last++;
      if (first < 0 || displayed.positions[first]! >= rendered.to) return null;
      const from = mapping[sourceText.positions[first]!];
      const to = mapping[sourceText.positions[last]!];
      if (from === undefined || to === undefined) return null;
      // Keep whitespace/formatting consistent with the decoration path as well
      // as saving. Unsupported render transformations must not create an
      // anchor whose underline cannot be restored later.
      if (plainMarkdown(section.slice(from, to + 1)) !== selection.trim()) return null;
      return {from: base + from, to: base + to + 1};
    }
    // A partial match is safe only when the selected text is unique on both
    // sides. Unsupported syntax outside the selected span can remain opaque.
    if (findUnique(rendered.text, selection) !== rendered.from) return null;
  }
  if (direct !== null && (offset !== null || !normalized.includes(selection))) {
    return {from: base + direct, to: base + direct + selection.length};
  }
  if (offset === null) {
    return null;
  }
  const from = mapping[offset];
  const last = mapping[offset + selection.length - 1];
  if (from === undefined || last === undefined) return null;
  const excerpt = section.slice(from, last + 1);
  if (/[[\]<>$`]/u.test(excerpt.replace(/^ {0,3}(?:>[ \t]?)+/gmu, '')) || plainMarkdown(excerpt) !== selection) return null;
  return {from: base + from, to: base + last + 1};
}
