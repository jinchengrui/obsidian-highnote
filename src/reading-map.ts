export function plainMarkdown(source: string): string {
  return source
    .replace(/!\[([^\]]*)\]\([^\n)]*\)/gu, '$1')
    .replace(/\[([^\]]+)\]\([^\n)]*\)/gu, '$1')
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/gu, '$2')
    .replace(/\[\[([^\]]+)\]\]/gu, '$1')
    .replace(/^\s{0,3}(?:#{1,6}\s+|>\s?|[-+*]\s+|\d+[.)]\s+)/gmu, '')
    .replace(/(?:\*\*|__|~~|==|`)/gu, '')
    .replace(/[*_]/gu, '');
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

export function selectionInSection(source: string, lineStart: number, lineEnd: number, selection: string): {from: number; to: number} | null {
  const lines = source.split('\n');
  const base = lines.slice(0, lineStart).reduce((sum, line) => sum + line.length + 1, 0);
  const section = lines.slice(lineStart, lineEnd + 1).join('\n');
  const direct = findUnique(section, selection);
  if (direct !== null) return {from: base + direct, to: base + direct + selection.length};
  // Strip only supported syntax while retaining each character's exact source position.
  // Links, embeds, HTML, math and code blocks require the editor to disambiguate.
  if ([...section].some(char => '[]<>$`'.includes(char))) return null;
  const mapping: number[] = [];
  let normalized = '';
  const delimiter = /\*\*|__|~~|==|[*_]/gu;
  let sourceOffset = 0;
  for (const line of section.split('\n')) {
    const prefix = /^\s{0,3}(?:#{1,6}\s+|>\s?|[-+*]\s+|\d+[.)]\s+)/u.exec(line)?.[0].length ?? 0;
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
  if (offset === null) return null;
  const from = mapping[offset];
  const last = mapping[offset + selection.length - 1];
  if (from === undefined || last === undefined || plainMarkdown(section.slice(from, last + 1)) !== selection) return null;
  return {from: base + from, to: base + last + 1};
}
