/** Intentionally renders only bold and lists. Everything else remains inert text. */
export function renderMessage(container: HTMLElement, body: string): void {
  let list: HTMLOListElement | HTMLUListElement | null = null;
  for (const line of body.split('\n')) {
    const item = /^(?:([-+*]) |(\d+)\. )(.*)$/u.exec(line);
    if (item) {
      const type = item[2] ? 'OL' : 'UL';
      if (!list || list.tagName !== type) {
        list = container.createEl(type === 'OL' ? 'ol' : 'ul');
        if (type === 'OL') (list as HTMLOListElement).start = Math.min(9999, Number(item[2]));
        container.append(list);
      }
      const li = list.createEl('li');
      renderBold(li, item[3] ?? '');
      list.append(li);
    } else {
      list = null;
      const p = container.createEl('p');
      if (!line) { p.addClass('hn-paragraph-gap'); p.append(p.createEl('br')); }
      else renderBold(p, line);
      container.append(p);
    }
  }
}

/** Merge messages for the vault overview without hiding content or rendering active markup. */
export function renderSummary(container: HTMLElement, bodies: readonly string[]): void {
  for (const [index, body] of bodies.entries()) {
    if (index) container.append(container.ownerDocument.createTextNode(' · '));
    const message = container.createSpan();
    const text = body.split('\n').map(line => line.trim().replace(/^[-+*] /u, '• ')).filter(Boolean).join(' ');
    renderBold(message, text);
  }
}

function renderBold(container: HTMLElement, text: string): void {
  const tokens = text.split(/(\*\*[^*\n]+\*\*)/u);
  for (const token of tokens) {
    if (token.startsWith('**') && token.endsWith('**') && token.length > 4) {
      const strong = container.createEl('strong');
      strong.textContent = token.slice(2, -2);
      container.append(strong);
    } else container.append(container.ownerDocument.createTextNode(token));
  }
}
