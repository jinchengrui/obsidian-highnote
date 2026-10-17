import type {Highlight, Thread} from './model';
import {commentTime} from './comment-time';
import {annotationOrder, cannotLocate, fileLabels} from './sidebar-model';

export type ExportFormat = 'md' | 'html';
export type ExportKind = 'comments' | 'highlights';
export interface ExportChoice {scope: 'current' | 'all'; kind: ExportKind; format: ExportFormat; name: string; sourcePath: string}

export function exportName(value: string): string {
  const name = value.trim().replace(/(?:\.(?:md|html|csv))+$/iu, '').trim();
  if (!name || name === '.' || name === '..' || /[<>:"/\\|?*]/u.test(name)
    || [...name].some(c => c.charCodeAt(0) < 32) || /[. ]$/u.test(name)
    || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(name) || [...name].length > 120) {
    throw new Error('请输入有效文件名，不含路径或特殊符号，最多 120 个字符。');
  }
  return name;
}
export function htmlText(value: string): string {
  return value.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;').replace(/"/gu, '&quot;').replace(/'/gu, '&#39;');
}
export function messageHtml(body: string): string {
  const bold = (value: string) => value.split(/(\*\*[^*\n]+\*\*)/u).map(token => token.startsWith('**') && token.endsWith('**') && token.length > 4
    ? `<strong>${htmlText(token.slice(2,-2))}</strong>` : htmlText(token)).join('');
  const lines: string[] = [];
  let list = '';
  for (const line of body.split('\n')) {
    const item = /^(?:([-+*]) |(\d+)\. )(.*)$/u.exec(line);
    if (item) {
      const kind = item[2] ? 'ol' : 'ul';
      if (kind !== list) {if (list) lines.push(`</${list}>`); lines.push(kind === 'ol' ? `<ol start="${Math.min(9999, Number(item[2]))}">` : '<ul>'); list = kind;}
      lines.push(`<li>${bold(item[3] ?? '')}</li>`);
    } else {
      if (list) {lines.push(`</${list}>`); list = '';}
      lines.push(line ? `<p>${bold(line)}</p>` : '<p class="paragraph-gap"><br></p>');
    }
  }
  if (list) lines.push(`</${list}>`);
  return lines.join('');
}

export function exportHtml(title: string, kind: ExportKind, records: readonly (Thread | Highlight)[], vault: string,
  exportedAt = new Date(), dark = false): string {
  const sorted = [...records].sort(annotationOrder(true));
  const paths = [...new Set(sorted.map(item => item.filePath))];
  const labels = fileLabels(paths);
  const grouped = new Map(paths.map(path => [path, [] as (Thread | Highlight)[]]));
  for (const record of sorted) grouped.get(record.filePath)!.push(record);
  const replies = kind === 'comments' ? sorted.reduce((count, item) => count + ('messages' in item ? item.messages.slice(1).filter(message => !message.deleted).length : 0), 0) : 0;
  const invalid = sorted.filter(cannotLocate).length;
  const label = kind === 'comments' ? '讨论' : '标记';
  const time = (value: string) => `<time datetime="${htmlText(value)}">${htmlText(commentTime(value).full)}</time>`;
  const message = (item: Thread['messages'][number], heading: string) => `<div class="message-head"><strong>${heading}</strong>${time(item.updatedAt)}${item.updatedAt !== item.createdAt ? '<span class="edited">编辑过</span>' : ''}</div><div class="richtext">${messageHtml(item.body)}</div>`;
  const nav: string[] = [], content: string[] = [];
  for (const [docIndex, path] of paths.entries()) {
    const items = grouped.get(path)!;
    const name = path.split('/').at(-1) ?? path;
    const id = `document-${docIndex}`;
    const link = `obsidian://open?vault=${encodeURIComponent(vault)}&file=${encodeURIComponent(path)}`;
    nav.push(`<a class="nav-item" href="#${id}" data-document="${id}"><span>${htmlText(labels.get(path) ?? name)}</span><small>${items.length}</small></a>`);
    const canOpen = items.some(item => !item.fileMissing);
    content.push(`<section class="document" id="${id}" data-path="${htmlText(path)}"><header class="doc-head"><div class="doc-label"><span>${items.length} 条${label}</span><div class="doc-actions">${canOpen ? `<a href="${htmlText(link)}">打开原文件 ↗</a>` : '<span>原文件已删除</span>'}<button type="button" class="copy-path">复制路径</button></div></div><h2>${htmlText(name)}</h2><p class="path">${htmlText(path)}</p></header>`);
    for (const [index, item] of items.entries()) {
      const state = 'resolved' in item && item.resolved ? 'resolved' : 'active';
      const status = 'resolved' in item ? item.resolved ? '✓ 已解决' : '○ 未解决' : '标记';
      const location = item.fileMissing ? '原文件已删除' : cannotLocate(item) ? '原文已无法定位' : '';
      content.push(`<article class="entry" data-state="${state}" data-invalid="${cannotLocate(item)}"><div class="entry-top"><span>${label} ${index+1}</span><span>${status}</span>${location ? `<span class="invalid">${location}</span>` : ''}</div><blockquote class="quote"><small>原文</small><p>${htmlText(item.anchor.quote)}</p></blockquote>`);
      if ('messages' in item) {
        if (item.messages[0] && !item.messages[0].deleted) content.push(message(item.messages[0], '评论'));
        const replies = item.messages.slice(1).map((reply,index) => ({reply,number:index+1})).filter(({reply}) => !reply.deleted);
        if (replies.length) content.push(`<details class="replies" open><summary>${replies.length} 条回复 · 按记录顺序</summary>${replies.map(({reply,number}) => `<div class="reply">${message(reply, `回复 ${number}`)}</div>`).join('')}</details>`);
      } else content.push(`<div class="message-head">保存时间 ${time(item.createdAt)}</div>${item.updatedAt !== item.createdAt ? `<div class="message-head">更新时间 ${time(item.updatedAt)}</div>` : ''}`);
      content.push(`<details class="record-info"><summary>查看记录信息</summary><p>定位状态：${location || '导出时未标记失效'}。此文件保留导出时的内容与状态。</p></details></article>`);
    }
    content.push('</section>');
  }
  return `<!doctype html><html lang="zh-CN" data-theme="${dark ? 'dark' : 'light'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>${htmlText(title)}</title><style>${READER_CSS}</style></head><body><main class="reader"><header class="heading"><div><p class="eyebrow">OBSIDIAN · 批注导出阅读版</p><h1>${htmlText(title)}</h1><p class="muted">导出时间：${htmlText(commentTime(exportedAt.toISOString()).full)}</p><p class="muted">所选范围内的全部已保存${kind === 'comments' ? '评论和回复' : '标记'}；不包含未提交草稿。</p></div><div class="heading-actions">${kind === 'comments' ? '<button id="toggle-replies" type="button">收起回复</button>' : ''}<button id="print" type="button">打印 / 存为 PDF</button><button id="theme" type="button" aria-label="切换明暗主题">◐</button><small id="print-count">将打印 ${sorted.length} 条${label}</small></div></header><div class="stats"><div><strong>${paths.length}</strong>篇文档</div><div><strong>${sorted.length}</strong>条${label}</div>${kind === 'comments' ? `<div><strong>${replies}</strong>条回复</div>` : ''}<div><strong>${invalid}</strong>条无法定位</div></div><div class="tools"><input id="search" type="search" placeholder="搜索原文${kind === 'comments' ? '、评论、回复' : ''}或文件路径" aria-label="搜索导出内容">${kind === 'comments' ? '<select id="status" aria-label="评论状态"><option value="all">全部状态</option><option value="active">未解决</option><option value="resolved">已解决</option></select>' : ''}<label><input id="invalid" type="checkbox">仅看无法定位</label><select id="density" aria-label="阅读密度"><option value="comfortable">舒展阅读</option><option value="compact">紧凑回顾</option></select><span id="match">${sorted.length} / ${sorted.length} 条${label}</span><button id="clear" type="button" hidden>清除筛选</button></div><div class="layout"><nav class="directory" aria-label="文档目录"><div class="directory-head">文档目录 <span id="doc-count">${paths.length} / ${paths.length} 篇</span></div>${nav.join('')}<p class="directory-note">按原文顺序整理。筛选只影响阅读与打印，文件仍保留全部数据。<br>笔记库：${htmlText(vault)}</p></nav><div class="content">${content.join('')}<div id="empty" hidden><h2>没有符合条件的记录</h2><p>请调整搜索或清除筛选。</p><button id="empty-clear" type="button">清除筛选</button></div></div></div><footer>这是导出时的快照；原文件链接只打开文件，不定位旧句子。</footer><div id="toast" role="status" hidden></div></main><script>(${readerRuntime.toString()})();</script></body></html>`;
}

/** Entirely self-contained: the exported file has no dependency on the plugin or network. */
function readerRuntime(): void {
  const doc = document;
  const root = doc.querySelector<HTMLElement>('.reader')!;
  const search = doc.querySelector<HTMLInputElement>('#search')!;
  const status = doc.querySelector<HTMLSelectElement>('#status');
  const invalid = doc.querySelector<HTMLInputElement>('#invalid')!;
  const clear = doc.querySelector<HTMLButtonElement>('#clear')!;
  const documents = [...doc.querySelectorAll<HTMLElement>('.document')];
  const entries = [...doc.querySelectorAll<HTMLElement>('.entry')];
  const nav = [...doc.querySelectorAll<HTMLAnchorElement>('.nav-item')];
  const kind = status ? '讨论' : '标记';
  const texts = new Map(entries.map(entry => [entry, `${entry.closest<HTMLElement>('.document')!.dataset.path}\n${entry.textContent}`.toLocaleLowerCase()]));
  let timer = 0;
  function clearMarks(): void {
    for (const mark of root.querySelectorAll<HTMLElement>('mark.search-hit')) {
      const parent = mark.parentNode!; mark.replaceWith(doc.createTextNode(mark.textContent ?? '')); parent.normalize();
    }
  }
  function highlight(node: HTMLElement, query: string): void {
    const walker = doc.createTreeWalker(node, NodeFilter.SHOW_TEXT);
    const nodes: Text[] = [];
    let current: Node | null;
    while ((current = walker.nextNode())) if (!current.parentElement?.closest('button,summary,.record-info,time,.message-head,.entry-top')) nodes.push(current as Text);
    for (const text of nodes) {
      const value = text.data; const lower = value.toLocaleLowerCase();
      let at = lower.indexOf(query), from = 0;
      if (at < 0) continue;
      // This function is serialized into standalone HTML. Its browser has no Obsidian helpers.
      const fragment = doc.createDocumentFragment();
      while (at >= 0) {
        fragment.append(doc.createTextNode(value.slice(from,at)));
        // Keep user text inert; createEl is unavailable in the standalone browser export.
        const mark = doc.createElement('mark'); mark.className = 'search-hit'; mark.textContent = value.slice(at,at+query.length); fragment.append(mark);
        from = at+query.length; at = lower.indexOf(query,from);
      }
      fragment.append(doc.createTextNode(value.slice(from))); text.replaceWith(fragment);
    }
  }
  function filter(): void {
    window.clearTimeout(timer); clearMarks();
    const query = search.value.trim().toLocaleLowerCase();
    let matches = 0, docs = 0;
    for (const entry of entries) {
      entry.hidden = Boolean((query && !texts.get(entry)!.includes(query)) || (status && status.value !== 'all' && entry.dataset.state !== status.value) || (invalid.checked && entry.dataset.invalid !== 'true'));
      if (!entry.hidden) {matches++; if (query) {highlight(entry,query); for (const replies of entry.querySelectorAll<HTMLDetailsElement>('.replies')) replies.open = true;}}
    }
    for (const [index, section] of documents.entries()) {
      const count = [...section.querySelectorAll<HTMLElement>('.entry')].filter(entry => !entry.hidden).length;
      section.hidden = !count; nav[index]!.hidden = !count; nav[index]!.querySelector('small')!.textContent = String(count);
      if (count) {docs++; if (query) highlight(section.querySelector<HTMLElement>('.doc-head')!,query);}
    }
    doc.querySelector('#match')!.textContent = `${matches} / ${entries.length} 条${kind}`;
    doc.querySelector('#doc-count')!.textContent = `${docs} / ${documents.length} 篇`;
    doc.querySelector('#print-count')!.textContent = `将打印 ${matches} 条${kind}`;
    (doc.querySelector('#print') as HTMLButtonElement).disabled = !matches;
    (doc.querySelector('#empty') as HTMLElement).hidden = Boolean(matches);
    clear.hidden = !query && (!status || status.value === 'all') && !invalid.checked;
    syncReplyButton();
  }
  function reset(): void {search.value = ''; if (status) status.value = 'all'; invalid.checked = false; filter();}
  search.addEventListener('input', event => {if ('isComposing' in event && event.isComposing) return; window.clearTimeout(timer);timer = window.setTimeout(filter,120);});
  search.addEventListener('compositionend', filter);
  status?.addEventListener('change',filter); invalid.addEventListener('change',filter);
  clear.addEventListener('click',reset); doc.querySelector('#empty-clear')!.addEventListener('click',reset);
  doc.querySelector('#density')!.addEventListener('change',event => root.classList.toggle('compact',(event.target as HTMLSelectElement).value === 'compact'));
  doc.querySelector('#theme')!.addEventListener('click',() => doc.documentElement.dataset.theme = doc.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
  const toggle = doc.querySelector<HTMLButtonElement>('#toggle-replies');
  const replies = [...doc.querySelectorAll<HTMLDetailsElement>('.replies')];
  function syncReplyButton(): void {if (toggle) {toggle.disabled = !replies.length; toggle.textContent = replies.some(reply => reply.open) ? '收起回复' : '展开回复';}}
  toggle?.addEventListener('click',() => {const open = !replies.some(reply => reply.open);for (const reply of replies) reply.open = open;syncReplyButton();});
  for (const reply of replies) reply.addEventListener('toggle',syncReplyButton);
  let printStates: boolean[] | undefined;
  const beforePrint = () => {if (printStates) return;printStates = replies.map(reply => reply.open); for (const reply of replies) reply.open = true;};
  const afterPrint = () => {if (!printStates) return;for (const [index,reply] of replies.entries()) reply.open = printStates[index]!;printStates = undefined;syncReplyButton();};
  window.addEventListener('beforeprint',beforePrint);window.addEventListener('afterprint',afterPrint);
  doc.querySelector('#print')!.addEventListener('click',() => {filter();beforePrint();window.print();});
  for (const item of nav) item.addEventListener('click',() => {for (const other of nav) other.classList.toggle('current',other === item);});
  for (const button of doc.querySelectorAll<HTMLButtonElement>('.copy-path')) button.addEventListener('click',() => {
    const path = button.closest<HTMLElement>('.document')!.dataset.path!;
    void (async () => {
      const toast = doc.querySelector<HTMLElement>('#toast')!;
      try {await navigator.clipboard.writeText(path);toast.textContent = '路径已复制。';}
      catch {toast.textContent = `无法自动复制，请复制文件标题下方路径：${path}`;}
      toast.hidden = false;window.setTimeout(() => toast.hidden = true,5000);
    })();
  });
  syncReplyButton();
}

const READER_CSS = `
:root{color-scheme:light;--base:#f7f7f9;--surface:#fff;--text:#1a1a1a;--muted:#666;--border:#e4e6e8;--accent:#3370ff;--tint:#eaf2ff}
html[data-theme=dark]{color-scheme:dark;--base:#202328;--surface:#141517;--text:#eee;--muted:#a3a8b4;--border:#39393e;--tint:#23344f}
*{box-sizing:border-box}body{margin:0;padding:36px 32px;background:var(--base);color:var(--text);font-family:system-ui,'PingFang SC','Microsoft YaHei',sans-serif}h1,h2,p{margin:0}[hidden]{display:none!important}button,input,select{font:inherit}button,a,summary{cursor:pointer}button,select{border:1px solid var(--border);border-radius:8px;background:var(--surface);color:var(--muted);padding:8px 12px;font-size:12px}button:disabled{opacity:.5;cursor:default}a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}:focus-visible{outline:2px solid var(--accent);outline-offset:3px}.reader{max-width:1200px;margin:auto}.heading{display:flex;justify-content:space-between;gap:24px}.eyebrow{font-size:12px;color:var(--muted);letter-spacing:.08em;margin-bottom:10px}h1{font-size:36px;line-height:1.3;overflow-wrap:anywhere}.muted{font-size:13px;line-height:1.7;color:var(--muted);margin-top:8px}.heading-actions{display:flex;align-items:flex-start;justify-content:flex-end;gap:8px;flex-wrap:wrap;max-width:360px}.heading-actions small{flex-basis:100%;text-align:right;font-size:12px;color:var(--muted)}.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(100px,1fr));gap:16px;padding:18px 0;margin:25px 0 18px;border-block:1px solid var(--border)}.stats div{font-size:12px;color:var(--muted)}.stats strong{font-size:26px;margin-right:10px;color:var(--text)}.tools{display:flex;gap:9px;align-items:center;flex-wrap:wrap;margin-bottom:22px;font-size:12px;color:var(--muted)}#search{flex:1;min-width:240px;max-width:410px;padding:8px 12px;border:1px solid var(--border);border-radius:20px;background:var(--surface);color:var(--text);font-size:13px}.tools label{display:flex;align-items:center;gap:5px;white-space:nowrap}#match{margin-left:auto}.layout{display:grid;grid-template-columns:225px minmax(0,1fr);gap:32px}.directory{position:sticky;top:18px;align-self:start;max-height:calc(100vh - 36px);overflow:auto}.directory-head{display:flex;justify-content:space-between;font-size:12px;margin:4px 10px 12px}.nav-item{display:flex;gap:8px;justify-content:space-between;padding:10px;border:1px solid transparent;border-radius:8px;font-size:12px;line-height:1.75;color:var(--muted);overflow-wrap:anywhere}.nav-item:hover,.nav-item.current{background:var(--tint);border-color:var(--border);color:var(--text)}.nav-item small{flex-shrink:0}.directory-note{margin-top:15px;padding:15px 10px;border-top:1px solid var(--border);font-size:11px;line-height:1.8;color:var(--muted)}.content{min-width:0}.document{margin-bottom:40px;scroll-margin-top:20px}.doc-head{border-bottom:1px solid var(--border);padding-bottom:16px;margin-bottom:18px}.doc-label{display:flex;justify-content:space-between;gap:12px;font-size:11px;color:var(--muted);margin-bottom:10px}.doc-actions{display:flex;gap:10px;align-items:center;font-size:12px}.doc-actions button{padding:0;border:0;background:transparent;color:var(--accent)}h2{font-size:24px;line-height:1.5;overflow-wrap:anywhere}.path{font-size:12px;line-height:1.65;color:var(--muted);margin-top:8px;overflow-wrap:anywhere}.entry{padding:22px 24px;margin-bottom:14px;border:1px solid var(--border);border-radius:8px;background:var(--surface)}.entry-top{display:flex;gap:10px;flex-wrap:wrap;font-size:11px;color:var(--muted);margin-bottom:15px}.invalid{font-size:11px;color:#a76b00;background:#f9b93712;border:1px solid #e3ae5140;border-radius:4px;padding:1px 5px}html[data-theme=dark] .invalid{color:#dfba77}.quote{border-left:2px solid var(--border);padding-left:12px;margin:0 0 20px}.quote small{display:block;font-size:10px;color:var(--muted);margin-bottom:5px}.quote p{font-size:15px;line-height:1.75;white-space:pre-wrap;overflow-wrap:anywhere}.message-head{display:flex;align-items:center;flex-wrap:wrap;gap:8px;font-size:11px;line-height:1.65;color:var(--muted);margin-bottom:9px}.message-head strong{font-size:12px;color:var(--text)}.edited{padding:1px 4px;border-radius:4px;background:var(--base);font-size:10px}.richtext{font-size:17px;line-height:1.8;overflow-wrap:anywhere}.richtext p{white-space:pre-wrap;margin:0 0 10px}.richtext p:last-child{margin-bottom:0}.richtext .paragraph-gap{height:8px;margin:0}.richtext ul,.richtext ol{margin:5px 0 10px;padding-left:1.5em}.richtext li{white-space:pre-wrap;margin:2px 0}.replies{margin-top:20px;border-top:1px solid var(--border);padding-top:14px}.replies summary{font-size:12px;color:var(--muted);margin-bottom:14px}.reply{border-left:2px solid var(--border);padding:2px 0 2px 14px;margin-bottom:16px}.reply:last-child{margin-bottom:0}.reply .richtext{font-size:15px}.record-info{font-size:11px;color:var(--muted);margin-top:16px;border-top:1px solid var(--border);padding-top:10px}.record-info p{margin-top:6px;line-height:1.8}.search-hit{background:#ffe08380;color:var(--text);border-radius:2px}#empty{padding:60px 24px;text-align:center;background:var(--surface);border:1px solid var(--border);border-radius:8px}#empty p{margin:10px 0 18px;color:var(--muted)}footer{padding:20px 0;border-top:1px solid var(--border);font-size:11px;color:var(--muted)}#toast{position:fixed;bottom:24px;left:50%;transform:translateX(-50%);padding:12px 16px;border:1px solid var(--border);border-radius:8px;background:var(--surface);max-width:90vw;font-size:12px;overflow-wrap:anywhere}.compact .entry{padding:15px 18px;margin-bottom:10px}.compact .richtext{font-size:15px;line-height:1.65}.compact .quote{margin-bottom:13px}.compact .document{margin-bottom:28px}
@media(max-width:900px){.layout{grid-template-columns:185px minmax(0,1fr);gap:20px}.entry{padding:18px}#match{margin-left:0}}
@media(max-width:640px){body{padding:24px 14px}.heading{display:block}h1{font-size:29px}.heading-actions{justify-content:flex-start;max-width:none;margin-top:14px}.heading-actions small{text-align:left}.stats{gap:8px;grid-template-columns:repeat(4,minmax(0,1fr))}.stats strong{display:block;font-size:23px}.layout{display:block}.directory{position:static;max-height:none;margin-bottom:22px}.nav-item{display:inline-flex;width:calc(50% - 3px);vertical-align:top}.directory-note{display:none}.entry{padding:16px}#search{min-width:0;width:100%;max-width:none;flex-basis:100%}.doc-label{flex-wrap:wrap}h2{font-size:21px}.richtext{font-size:16px}}
@page{size:A4;margin:16mm}@media print{html[data-theme]{color-scheme:light;--base:#fff;--surface:#fff;--text:#111;--muted:#555;--border:#ddd}body{padding:0}.directory,.tools,.heading-actions,.doc-actions,#toast,#empty{display:none!important}.layout{display:block}.reader{max-width:none}h1{font-size:28px}.entry{break-inside:auto;padding:14px 18px}.doc-head,.message-head{break-after:avoid}.reply,.quote{break-inside:avoid}.richtext{font-size:12pt!important}.quote p{font-size:11pt}.stats{margin:16px 0}.replies>summary,.record-info{display:none}.entry,.document{box-shadow:none}}
`;
