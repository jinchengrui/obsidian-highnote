import {execFileSync} from 'node:child_process';
import {mkdirSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';

// 对已运行的 Obsidian 专用测试 vault 执行；保留本轮笔记和导出文件以便排查。
// 不启动客户端、不构建插件，也不安装替身。screenshotsDir 省略时不截图。
const [cli, vault, screenshotsDir] = process.argv.slice(2);
if (!cli || !vault) throw new Error('用法：node scripts/verify-highlights-client.mjs /path/to/obsidian-cli test-vault-name [screenshotsDir]');
const pluginId = 'highnote';
const name = `标记回归${Date.now()}`;
const sourcePath = `${name}.md`;
const sameQuote = '同段原文可同时保留标记与评论。';
const mergeText = '甲乙丙丁戊己庚辛壬癸';
const lostQuote = '这句摘录删除后仍应保留。';
const source = `# 阅读限定与标记回归\n\n前文：${sameQuote}后文。\n\n合并范围：${mergeText}。\n\n失效原文：${lostQuote}\n\n普通正文用于完整同步。\n`;
const aPath = `${name}/甲/笔记.md`;
const bPath = `${name}/乙/笔记.md`;
const renamedPath = `${name}/甲/改名笔记.md`;
const missingPath = `${name}/待删除.md`;
const emptyPath = `${name}/空笔记.md`;
let currentStep = '初始化';
let originalAppearance;
let primaryId, commentId, mergedId, adjacentId, detachedId;
let extraIds;
let expectedSource = source;
const completed = [];

const call = (...args) => execFileSync(cli, [`vault=${vault}`, ...args], {
  encoding: 'utf8', timeout: 20000, maxBuffer: 16 * 1024 * 1024
}).trim();
function evaluate(code) {
  // 捕获被直接 await 的预期拒绝；UI 的异常仍由真实插件处理。
  const output = call('eval', `code=(async()=>{try{return JSON.stringify({ok:true,value:await (${code})});}catch(e){return JSON.stringify({ok:false,error:String(e?.stack??e)});}})()`);
  if (!output.startsWith('=> ')) throw new Error(`[${currentStep}] CLI eval 返回异常：${output}`);
  const result = JSON.parse(output.slice(3));
  if (!result.ok) throw new Error(`[${currentStep}] 客户端：${result.error}`);
  return result.value;
}
const inClient = body => evaluate(`(async()=>{
  const p=app.plugins.plugins[${JSON.stringify(pluginId)}];
  const leaf=app.workspace.getLeavesOfType('markdown').find(l=>l.view.file?.path===${JSON.stringify(sourcePath)});
  const root=leaf?.view.contentEl;
  const view=app.workspace.getLeavesOfType('highnote-comments')[0]?.view;
  ${body}
})()`);
const cdp = (method, params = {}) => JSON.parse(call('dev:cdp', `method=${method}`, `params=${JSON.stringify(params)}`));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(code, label = code) {
  for (let i = 0; i < 80; i++) {
    if (evaluate(code)) return;
    await pause(100);
  }
  throw new Error(`[${currentStep}] 等待超时：${label}`);
}
async function step(label, action) {
  currentStep = label;
  console.log(`执行：${label}`);
  try { await action(); completed.push(label); }
  catch (error) { throw new Error(`[${label}] ${error.message}`, {cause: error}); }
}
const getHighlight = id => inClient(`return p.store.getHighlight(${JSON.stringify(id)});`);
const highlightSelector = id => `[data-hn-highlight="${id}"]`;
const cardSelector = id => `[data-highlight-id="${id}"]`;
const readingHas = selector => `(()=>{const l=app.workspace.getLeavesOfType('markdown').find(l=>l.view.file?.path===${JSON.stringify(sourcePath)});return !!l?.view.contentEl.querySelector('.markdown-preview-view ${selector}');})()`;
async function activate(mode = 'preview', filePath = sourcePath) {
  evaluate(`(async()=>{
    const f=app.vault.getFileByPath(${JSON.stringify(filePath)});
    if(!f)throw new Error('找不到测试笔记');
    const l=app.workspace.getLeavesOfType('markdown').find(l=>l.view.file===f)??app.workspace.getLeaf('tab');
    await l.openFile(f);
    await l.setViewState({type:'markdown',state:{...l.view.getState(),mode:${JSON.stringify(mode)},source:true},active:true});
    await app.workspace.revealLeaf(l);
    require('electron').remote.getCurrentWindow().focus();
    return true;
  })()`);
  await until(`app.plugins.plugins['${pluginId}'].activePath===${JSON.stringify(filePath)} && app.plugins.plugins['${pluginId}'].canModify===${mode === 'preview'}`, `进入 ${mode} 模式`);
  await pause(150);
}
async function pane(kind, {scope = 'current', status = 'all', query = ''} = {}) {
  inClient(`
    await p.openSidebar();
    const v=app.workspace.getLeavesOfType('highnote-comments')[0].view;
    const tab=v.contentEl.querySelector('[data-hn-tab="${kind}"]');
    if(!tab)throw new Error('缺少 ${kind} 页签');
    tab.click();
    const set=(selector,value,event)=>{const el=v.contentEl.querySelector(selector);if(!el)throw new Error('缺少控件 '+selector);el.value=value;el.dispatchEvent(new Event(event,{bubbles:true}));};
    set('[aria-label="文档范围"]',${JSON.stringify(scope)},'change');
    if('${kind}'==='comments')set('[aria-label="评论状态"]',${JSON.stringify(['active','resolved'].includes(status)?status:'all')},'change');
    const locate=v.contentEl.querySelector('[aria-label="仅看无法定位"]');locate.checked=${JSON.stringify(['missing','detached'].includes(status))};locate.dispatchEvent(new Event('change'));
    set('[aria-label="搜索${kind === 'highlights' ? '标记' : '评论'}"]',${JSON.stringify(query)},'input');
    document.activeElement?.blur();
    return v.paneKind;
  `);
  assert.equal(inClient('return view.paneKind;'), kind);
  assert.equal(inClient(`return view.contentEl.querySelector('[data-hn-tab="${kind}"]').getAttribute('aria-selected');`), 'true');
}
function click(selector) {
  return evaluate(`(()=>{
    const el=document.querySelector(${JSON.stringify(selector)});if(!el)throw new Error('找不到按钮：'+${JSON.stringify(selector)});
    el.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,cancelable:true,button:0}));
    el.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,cancelable:true,button:0}));
    el.click();return true;
  })()`);
}
async function selectReading(quote) {
  await activate();
  await until(`(()=>{const l=app.workspace.getLeavesOfType('markdown').find(l=>l.view.file?.path===${JSON.stringify(sourcePath)});return [...l.view.contentEl.querySelectorAll('.markdown-preview-view p')].some(e=>e.textContent.includes(${JSON.stringify(quote)}));})()`, '阅读段落渲染');
  const selected = inClient(`
    const paragraphs=[...root.querySelectorAll('.markdown-preview-view p')].filter(el=>el.textContent.includes(${JSON.stringify(quote)}));
    if(paragraphs.length!==1)throw new Error('选区原文不是唯一段落');
    const el=paragraphs[0];el.scrollIntoView({block:'center'});
    const walker=document.createTreeWalker(el,NodeFilter.SHOW_TEXT);const points=[];let text='';
    for(let node=walker.nextNode();node;node=walker.nextNode()){for(let i=0;i<node.data.length;i++)points.push({node,offset:i});text+=node.data;}
    const from=text.indexOf(${JSON.stringify(quote)}),to=from+${quote.length};
    if(from<0||text.indexOf(${JSON.stringify(quote)},from+1)>=0)throw new Error('选区文字重复');
    const range=document.createRange();range.setStart(points[from].node,points[from].offset);range.setEnd(points[to-1].node,points[to-1].offset+1);
    const selection=document.getSelection();selection.removeAllRanges();selection.addRange(range);
    el.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,button:0}));return selection.toString();
  `);
  assert.equal(selected, quote);
  await until(`document.querySelectorAll('.hn-selection-toolbar').length===1`, '阅读选区工具栏');
}
async function addHighlight(quote) {
  await activate();
  return inClient(`
    const source=await app.vault.read(leaf.view.file);const from=source.indexOf(${JSON.stringify(quote)});
    if(from<0)throw new Error('找不到 API 标记原文');
    await p.highlight({filePath:leaf.view.file.path,source,from,to:from+${quote.length}});
    return p.store.viewHighlights(leaf.view.file.path).find(h=>h.anchor.from===from&&h.anchor.to===from+${quote.length})?.id;
  `);
}
async function assertSource() {
  await until(`(async()=>await app.vault.read(app.vault.getFileByPath(${JSON.stringify(sourcePath)}))===${JSON.stringify(expectedSource)})()`, 'Markdown 正文与预期一致');
}
async function assertAttached(id, quote) {
  const h = getHighlight(id);
  assert.ok(h, `标记 ${id} 仍存在`);
  assert.equal(h.anchor.state, 'attached', `原文 ${quote} 仍关联`);
  assert.equal(h.anchor.from, expectedSource.indexOf(quote));
  assert.equal(h.anchor.to, expectedSource.indexOf(quote) + quote.length);
  assert.equal(h.anchor.quote, quote);
  assert.equal(inClient(`return p.fileHighlights(${JSON.stringify(sourcePath)}).find(h=>h.id===${JSON.stringify(id)}).anchor.state;`), 'attached');
}
async function locate(id) {
  inClient(`await p.revealHighlight(${JSON.stringify(id)});return true;`);
  await pane('highlights');
  await until(`!!document.querySelector('${cardSelector(id)}')`, '标记卡片');
  const quoteButton = `${cardSelector(id)} button[aria-label="定位原文"], ${cardSelector(id)} button.hn-highlight-quote, ${cardSelector(id)} button.hn-quote`;
  click(quoteButton);
  await until(readingHas(highlightSelector(id)), '点击原文后阅读标记仍可见');
  assert.equal(inClient('return p.focusedHighlight;'), id);
}
async function reload() {
  inClient('await p.flushAnchors();await p.store.idle();return true;');
  call('plugin:reload', `id=${pluginId}`);
  await until(`!!app.plugins.plugins['${pluginId}']?.store.getHighlight('${primaryId}') && !!app.plugins.plugins['${pluginId}']?.store.get('${commentId}')`, 'reload 后两类数据加载');
  await activate();
  await locate(primaryId);
}
function screenshot(filename) {
  if (!screenshotsDir) return;
  const clip = evaluate(`(()=>{const r=document.querySelector('.workspace-split.mod-root').getBoundingClientRect();return {x:r.x,y:r.y,width:window.innerWidth-r.x,height:r.height,scale:1};})()`);
  writeFileSync(path.join(screenshotsDir, filename), Buffer.from(cdp('Page.captureScreenshot', {format: 'png', clip}).data, 'base64'));
}
function exportGroups(text) {
  // 导出器会转义 Markdown 标点，先还原再验证文件名、相对路径与摘录。
  return text.replace(/\\([^\p{L}\p{N}\s])/gu, '$1').split(/^## /m).slice(1).map(section => ({
    filename: section.split('\n')[0],
    filePath: /^相对路径：(.+)$/m.exec(section)?.[1],
    quotes: [...section.matchAll(/^> (.*)$/gm)].map(match => match[1]),
    text: section
  }));
}

try {
  await step('客户端准备与空数据导出', async () => {
    originalAppearance = inClient(`
      if(!p)throw new Error('请先安装并启用 highnote 插件');
      for(const method of ['highlight','requireReadingMode','exportHighlights','setHighlightColor','fileHighlights','revealHighlight','flushAnchors'])if(typeof p[method]!=='function')throw new Error('缺少插件 API：'+method);
      if(!('canModify' in p))throw new Error('缺少 canModify getter');
      if(p.openModals.size)throw new Error('已有弹窗，请在空闲测试客户端执行');
      const appearance={color:p.settings.highlightColor,light:document.body.classList.contains('theme-light'),dark:document.body.classList.contains('theme-dark')};
      await app.vault.createFolder(${JSON.stringify(name)});
      await app.vault.create(${JSON.stringify(sourcePath)},${JSON.stringify(source)});
      await app.vault.create(${JSON.stringify(emptyPath)},'这篇笔记没有标记。');return appearance;
    `);
    await activate();
    const empty = inClient(`
      const before=app.vault.getMarkdownFiles().map(f=>f.path).sort();
      const current=await p.exportHighlights('current');
      // 若 vault 已有其他回归数据，仅检查本轮空文档，不清除别人的标记。
      const allEmpty=p.store.viewHighlights().length===0;
      const all=allEmpty?await p.exportHighlights('all'):undefined;
      return {current:current?.path??null,all:all?.path??null,allEmpty,before,after:app.vault.getMarkdownFiles().map(f=>f.path).sort()};
    `);
    assert.equal(empty.current, null);assert.equal(empty.all, null);assert.deepEqual(empty.after, empty.before);
    console.log(empty.allEmpty ? '空导出：当前和全部均未创建文件' : '空导出：当前文档未创建文件；全部已有标记');
    await pane('highlights');
    assert.equal(inClient('return view.contentEl.querySelectorAll("[data-highlight-id]").length;'), 0);
  });

  await step('真实阅读选区、工具栏标记与评论保存', async () => {
    await selectReading(sameQuote);
    const metrics = evaluate(`(()=>{const t=document.querySelector('.hn-selection-toolbar');return {width:t.getBoundingClientRect().width,height:t.getBoundingClientRect().height,buttons:[...t.querySelectorAll('button')].map(b=>({label:b.getAttribute('aria-label'),iconWidth:b.querySelector('svg')?.getBoundingClientRect().width,iconHeight:b.querySelector('svg')?.getBoundingClientRect().height}))};})()`);
    assert.equal(metrics.width, 60);assert.equal(metrics.height, 30);
    assert.deepEqual(metrics.buttons.map(b => b.label), ['标记所选文字', '评论所选文字']);
    for (const button of metrics.buttons) { assert.equal(button.iconWidth, 18);assert.equal(button.iconHeight, 18); }
    click('.hn-selection-toolbar [aria-label="标记所选文字"]');
    await until(`app.plugins.plugins['${pluginId}'].store.viewHighlights(${JSON.stringify(sourcePath)}).length===1`, '工具栏保存标记');
    primaryId = inClient(`return p.store.viewHighlights(${JSON.stringify(sourcePath)})[0].id;`);
    await until(readingHas(highlightSelector(primaryId)), '首次标记渲染');
    await selectReading(sameQuote);
    click('.hn-selection-toolbar [aria-label="评论所选文字"]');
    await until(`!!document.querySelector('.hn-modal [aria-label="评论内容"]')`, '真实评论弹窗');
    evaluate(`(()=>{const t=document.querySelector('.hn-modal [aria-label="评论内容"]');t.value='同段评论通过真实保存按钮写入';t.dispatchEvent(new Event('input',{bubbles:true}));return true;})()`);
    click('.hn-modal .mod-cta');
    await until(`app.plugins.plugins['${pluginId}'].store.viewFile(${JSON.stringify(sourcePath)}).length===1 && !document.querySelector('.hn-modal')`, '评论保存并关闭');
    commentId = inClient(`return p.store.viewFile(${JSON.stringify(sourcePath)})[0].id;`);
    inClient('document.getSelection().removeAllRanges();return true;');
    await until(readingHas(`[data-hn-thread="${commentId}"]`), '同段评论下划线');
    const dual = inClient(`
      const hs=[...root.querySelectorAll('.markdown-preview-view ${highlightSelector(primaryId)}')];
      const ms=[...root.querySelectorAll('.markdown-preview-view [data-hn-thread="${commentId}"]')];
      return {highlight:hs.map(e=>e.textContent).join(''),comment:ms.map(e=>e.textContent).join(''),nested:ms.some(m=>hs.some(h=>h.contains(m)||m.contains(h))),background:getComputedStyle(hs[0]).backgroundColor,underline:ms.every(m=>getComputedStyle(m).textDecorationLine.includes('underline'))};
    `);
    assert.equal(dual.highlight, sameQuote);assert.equal(dual.comment, sameQuote);assert.equal(dual.nested, true);
    assert.equal(dual.underline, true);assert.ok(!['transparent', 'rgba(0, 0, 0, 0)'].includes(dual.background));
    await assertSource();
  });

  await step('精确重复幂等、部分重叠合并、相邻独立', async () => {
    const before = getHighlight(primaryId);
    assert.equal(await addHighlight(sameQuote), primaryId);
    assert.deepEqual(getHighlight(primaryId), before, '重复选择不改变 ID、时间、revision 或锚点');
    assert.equal(inClient(`return p.store.viewHighlights(${JSON.stringify(sourcePath)}).length;`), 1);
    mergedId = await addHighlight(mergeText.slice(0, 4));
    await addHighlight(mergeText.slice(2, 6));
    const merged = getHighlight(mergedId);
    assert.equal(merged.anchor.quote, mergeText.slice(0, 6));
    assert.equal(inClient(`return p.store.viewHighlights(${JSON.stringify(sourcePath)}).length;`), 2);
    adjacentId = await addHighlight(mergeText.slice(6, 8));
    assert.ok(adjacentId);assert.notEqual(adjacentId, mergedId);
    assert.equal(getHighlight(mergedId).anchor.to, getHighlight(adjacentId).anchor.from);
    assert.equal(inClient(`return p.store.viewHighlights(${JSON.stringify(sourcePath)}).length;`), 3);
    detachedId = await addHighlight(lostQuote);
    await assertAttached(primaryId, sameQuote);await assertSource();
  });

  await step('标记卡定位、删除确认与 280px 明暗界面', async () => {
    await locate(primaryId);
    assert.equal(evaluate(`document.querySelector('${cardSelector(primaryId)}').classList.contains('hn-highlight-card')`), true);
    const temporaryId = await addHighlight('普通正文用于完整同步。');
    await pane('highlights');
    click(`${cardSelector(temporaryId)} [aria-label="删除标记"]`);
    await until(`!!document.querySelector('.modal .mod-warning')`, '删除标记确认弹窗');
    assert.ok(getHighlight(temporaryId), '确认之前标记仍在');
    click('.modal .mod-warning');
    await until(`!app.plugins.plugins['${pluginId}'].store.getHighlight('${temporaryId}') && !document.querySelector('.modal .mod-warning')`, '确认删除完成');
    assert.equal(inClient(`return p.store.get('${commentId}').messages[0].body;`), '同段评论通过真实保存按钮写入');
    await locate(primaryId);
    if (screenshotsDir) mkdirSync(screenshotsDir, {recursive: true});
    const previousWidth = inClient(`const el=view.contentEl;const old=el.style.width;el.style.width='280px';await p.setHighlightColor('#ffe083');return old;`);
    try {
      for (const theme of ['light', 'dark']) {
        inClient(`document.body.classList.remove('theme-light','theme-dark');document.body.classList.add('theme-${theme}');return true;`);
        await pause(150);
        evaluate(`(()=>{for(const notice of document.querySelectorAll('.notice-container'))notice.remove();return true})()`);
        const layout = inClient(`
          const el=view.contentEl;const card=el.querySelector('${cardSelector(primaryId)}');
          const quote=card.querySelector('button[aria-label="定位原文"]')??card.querySelector('.hn-highlight-quote,.hn-quote');
          return {width:el.getBoundingClientRect().width,overflow:el.scrollWidth>el.clientWidth+2||card.scrollWidth>card.clientWidth+2,quoteOverflow:quote.scrollWidth>quote.clientWidth+2,theme:document.body.classList.contains('theme-${theme}')};
        `);
        assert.equal(layout.width, 280);assert.equal(layout.overflow, false);assert.equal(layout.quoteOverflow, false);assert.equal(layout.theme, true);
        screenshot(`标记与评论-${theme === 'light' ? '浅色' : '深色'}.png`);
      }
    } finally {
      inClient(`view.contentEl.style.width=${JSON.stringify(previousWidth)};document.body.classList.remove('theme-dark');document.body.classList.add('theme-light');return true;`);
    }
    await assertSource();
  });

  await step('已有 span 颜色变化与 reload 持久化', async () => {
    await locate(primaryId);
    const color = inClient(`
      const spans=[...root.querySelectorAll('.markdown-preview-view ${highlightSelector(primaryId)}')];
      const before=spans.map(e=>getComputedStyle(e).backgroundColor);
      await p.setHighlightColor('#80cfff');await new Promise(r=>requestAnimationFrame(r));
      return {before,after:spans.map(e=>getComputedStyle(e).backgroundColor),sameNodes:spans.every(e=>e.isConnected),setting:p.settings.highlightColor};
    `);
    assert.ok(color.before.length);assert.equal(color.sameNodes, true);assert.notDeepEqual(color.after, color.before);assert.equal(color.setting, '#80cfff');
    const saved = inClient(`return {highlights:p.store.viewHighlights(${JSON.stringify(sourcePath)}),comment:p.store.get('${commentId}')};`);
    await reload();
    assert.deepEqual(inClient(`return {highlights:p.store.viewHighlights(${JSON.stringify(sourcePath)}),comment:p.store.get('${commentId}')};`), saved);
    assert.equal(inClient('return p.settings.highlightColor;'), '#80cfff');
    assert.deepEqual(inClient(`return [...root.querySelectorAll('.markdown-preview-view ${highlightSelector(primaryId)}')].map(e=>getComputedStyle(e).backgroundColor);`), color.after);
    await assertSource();
  });

  await step('跨模式弹窗保存 guard 与源码只读界面', async () => {
    await selectReading(sameQuote);click('.hn-selection-toolbar [aria-label="评论所选文字"]');
    await until(`!!document.querySelector('.hn-modal textarea')`, '切换模式前打开评论弹窗');
    evaluate(`(()=>{const t=document.querySelector('.hn-modal textarea');t.value='源码模式不应保存这个评论';t.dispatchEvent(new Event('input'));return true;})()`);
    await activate('source');
    const guarded = inClient(`
      const before={threads:p.store.viewFile(${JSON.stringify(sourcePath)}),highlights:p.store.viewHighlights(${JSON.stringify(sourcePath)}),files:app.vault.getMarkdownFiles().map(f=>f.path).sort()};
      const modal=[...p.openModals].find(m=>m.contentEl.querySelector('[aria-label="评论内容"]'));
      if(!modal||typeof modal.save!=='function')throw new Error('MessageModal 的实际保存回调不可访问');
      const errors={};const rejected=async(key,action)=>{try{await action();errors[key]=null;}catch(e){errors[key]=e.message;}};
      try {
        // 调用弹窗原有的保存回调；catch 预期拒绝，避免事件处理器向 console.error 报告。
        await rejected('modal',()=>modal.save('源码模式不应保存这个评论'));
        await rejected('guard',()=>p.requireReadingMode());
        await rejected('highlight',()=>p.highlight({filePath:${JSON.stringify(sourcePath)},source:${JSON.stringify(source)},from:${source.indexOf(sameQuote)},to:${source.indexOf(sameQuote) + sameQuote.length}}));
        await rejected('current',()=>p.exportHighlights('current'));
        await rejected('all',()=>p.exportHighlights('all'));
        await rejected('remove',()=>p.removeHighlight('${primaryId}'));
      } finally {modal.close();}
      return {errors,before,after:{threads:p.store.viewFile(${JSON.stringify(sourcePath)}),highlights:p.store.viewHighlights(${JSON.stringify(sourcePath)}),files:app.vault.getMarkdownFiles().map(f=>f.path).sort()},modals:p.openModals.size};
    `);
    for (const [action, error] of Object.entries(guarded.errors)) assert.match(error ?? '', /阅读模式/u, `${action} 必须被阅读模式 guard 拒绝`);
    assert.deepEqual(guarded.after, guarded.before);assert.equal(guarded.modals, 0);
    await pane('comments');
    await until(`!!document.querySelector('[data-thread-id="${commentId}"]')`, '源码模式可查看评论');
    const readonly = inClient(`
      leaf.view.editor.focus();const from=leaf.view.editor.getValue().indexOf(${JSON.stringify(sameQuote)});
      leaf.view.editor.setSelection(leaf.view.editor.offsetToPos(from),leaf.view.editor.offsetToPos(from+${sameQuote.length}));
      root.querySelector('.cm-editor').dispatchEvent(new KeyboardEvent('keyup',{key:'ArrowRight',shiftKey:true,bubbles:true}));
      const card=view.contentEl.querySelector('[data-thread-id="${commentId}"]');const hint=view.contentEl.querySelector('.hn-reading-mode-hint');
      return {canModify:p.canModify,body:card.textContent,hint:!!hint&&!hint.hidden&&getComputedStyle(hint).display!=='none',mutations:card.querySelectorAll('textarea,input,[aria-haspopup="menu"],[aria-label="解决讨论"],[aria-label="重新打开讨论"],.hn-inline-reply,.hn-thread-more,.hn-message-more,.hn-resolve').length};
    `);
    assert.equal(readonly.canModify, false);assert.ok(readonly.body.includes('同段评论通过真实保存按钮写入'));assert.equal(readonly.hint, true);assert.equal(readonly.mutations, 0);
    await pause(250);
    assert.equal(evaluate(`document.querySelectorAll('.hn-selection-toolbar').length`), 0);
    assert.equal(inClient('return root.querySelectorAll(".hn-mark,.hn-highlight").length;'), 0);
    await pane('highlights');
    assert.equal(evaluate(`document.querySelectorAll('[data-highlight-id] [aria-label="删除标记"]').length`), 0);
    click('.hn-sidebar-more');
    assert.equal(evaluate(`[...document.querySelectorAll('.menu-item')].filter(e=>e.textContent.includes('导出')).every(e=>e.classList.contains('is-disabled'))`), true);
    evaluate(`(()=>{document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));return true})()`);
    click(`${cardSelector(primaryId)} button[aria-label="定位原文"]`);
    await pause(150);
    assert.equal(inClient('return p.canModify;'), false);assert.equal(getHighlight(primaryId).anchor.state, 'attached');
    assert.equal(inClient('return root.querySelectorAll(".hn-mark,.hn-highlight").length;'), 0);
    await assertSource();
  });

  await step('后台 replaceRange 前插与完整 setValue 同步保留新锚点', async () => {
    await activate('source');
    const front = '新增前插段落。\n\n';
    const changed = inClient(`
      const editor=leaf.view.editor;const before=editor.getValue();
      editor.replaceRange(${JSON.stringify(front)},{line:0,ch:0});
      await p.flushAnchors();return {before,after:editor.getValue()};
    `);
    assert.equal(changed.before, expectedSource);expectedSource = front + expectedSource;assert.equal(changed.after, expectedSource);
    await assertAttached(primaryId, sameQuote);await assertAttached(detachedId, lostQuote);
    assert.equal(inClient(`return p.store.get('${commentId}').anchor.from;`), expectedSource.indexOf(sameQuote));
    await assertSource();await activate();await locate(primaryId);await assertAttached(primaryId, sameQuote);
    await activate('source');
    const synced = `同步新增段落。\n\n${expectedSource.replace('普通正文用于完整同步。', '普通正文已更新但摘录不变。')}`;
    const sync = inClient(`const editor=leaf.view.editor;const before=editor.getValue();editor.setValue(${JSON.stringify(synced)});await p.flushAnchors();return {before,after:editor.getValue()};`);
    assert.equal(sync.before, expectedSource);expectedSource = synced;assert.equal(sync.after, expectedSource);
    for (const [id, quote] of [[primaryId, sameQuote], [mergedId, mergeText.slice(0, 6)], [adjacentId, mergeText.slice(6, 8)], [detachedId, lostQuote]]) await assertAttached(id, quote);
    assert.equal(inClient(`return p.store.get('${commentId}').anchor.state;`), 'attached');
    await assertSource();await activate();await locate(primaryId);await assertAttached(primaryId, sameQuote);
  });

  await step('真实删除标记原句后 detached 数据仍保留', async () => {
    await activate('source');
    const result = inClient(`
      const editor=leaf.view.editor;const source=editor.getValue();const from=source.indexOf(${JSON.stringify(lostQuote)});
      if(from<0)throw new Error('待删除摘录不存在');
      editor.replaceRange('',editor.offsetToPos(from),editor.offsetToPos(from+${lostQuote.length}));
      await p.flushAnchors();return editor.getValue();
    `);
    expectedSource = expectedSource.replace(lostQuote, '');assert.equal(result, expectedSource);
    assert.equal(getHighlight(detachedId).anchor.state, 'detached');assert.equal(getHighlight(detachedId).anchor.quote, lostQuote);
    await assertSource();await activate();await pane('highlights');
    assert.ok(evaluate(`document.querySelector('${cardSelector(detachedId)}').textContent.includes('原文已无法定位')`));
    assert.equal(evaluate(readingHas(highlightSelector(detachedId))), false);
    await assertAttached(primaryId, sameQuote);
  });

  await step('同名文件、后台独立删除与缺失文件状态', async () => {
    extraIds = inClient(`
      await app.vault.createFolder(${JSON.stringify(name + '/甲')});await app.vault.createFolder(${JSON.stringify(name + '/乙')});
      const aSource='甲目录摘录。保留原文。',bSource='乙目录摘录。保留原文。';
      const a=await app.vault.create(${JSON.stringify(aPath)},aSource),b=await app.vault.create(${JSON.stringify(bPath)},bSource);
      const ah=await p.store.createHighlight(a.path,aSource,0,6),bh=await p.store.createHighlight(b.path,bSource,0,6);
      const ac=await p.store.create(a.path,aSource,0,6,'甲目录同段评论'),bc=await p.store.create(b.path,bSource,0,6,'乙目录同段评论');
      await p.store.removeHighlight(ah.id);const commentSurvived=p.store.get(ac.id)?.messages[0].body;
      const replacement=await p.store.createHighlight(a.path,aSource,0,6);
      await p.store.remove(bc.id);const highlightSurvived=p.store.getHighlight(bh.id)?.anchor.quote;
      const missing=await app.vault.create(${JSON.stringify(missingPath)},'删除文件也保留摘录。');
      const missingSource=await app.vault.read(missing);const mh=await p.store.createHighlight(missing.path,missingSource,0,missingSource.length);
      await app.vault.delete(missing);return {a:replacement.id,b:bh.id,comment:ac.id,missing:mh.id,commentSurvived,highlightSurvived};
    `);
    assert.equal(extraIds.commentSurvived, '甲目录同段评论');assert.equal(extraIds.highlightSurvived, '乙目录摘录。');
    await until(`app.plugins.plugins['${pluginId}'].store.getHighlight('${extraIds.missing}')?.fileMissing===true`, '真实删文件后标记 missing');
    assert.equal(getHighlight(extraIds.missing).anchor.state, 'detached');
    assert.equal(evaluate(`(async()=>await app.vault.read(app.vault.getFileByPath(${JSON.stringify(aPath)})))()`), '甲目录摘录。保留原文。');
    assert.equal(evaluate(`(async()=>await app.vault.read(app.vault.getFileByPath(${JSON.stringify(bPath)})))()`), '乙目录摘录。保留原文。');
  });

  await step('current/all 导出、同名分组、筛选独立与防覆盖', async () => {
    await activate();
    const sentinelPath = `${name}-标记导出.md`;
    const sentinelText = '这份已有文件不能被覆盖。';
    evaluate(`(async()=>{await app.vault.create(${JSON.stringify(sentinelPath)},${JSON.stringify(sentinelText)});return true;})()`);
    const exportOne = async scope => {
      await activate();await pane('highlights', {status: 'missing', query: '不匹配任何原文的搜索条件'});
      assert.equal(inClient('return view.contentEl.querySelectorAll("[data-highlight-id]").length;'), 0);
      return inClient(`
        const before=JSON.stringify(p.store.viewHighlights());const file=await p.exportHighlights('${scope}');
        if(!file)throw new Error('有数据却未导出');
        return {path:file.path,text:await app.vault.read(file),before,after:JSON.stringify(p.store.viewHighlights())};
      `);
    };
    const first = await exportOne('current'),second = await exportOne('current'),all = await exportOne('all');
    assert.equal(first.path, `${name}-标记导出(1).md`);assert.equal(second.path, `${name}-标记导出(2).md`);
    assert.notEqual(first.path, second.path);assert.match(all.path, /^全部文档-标记导出(?:\(\d+\))?\.md$/u);
    for (const exported of [first, second, all]) { assert.equal(path.basename(exported.path), exported.path);assert.equal(exported.after, exported.before); }
    assert.equal(evaluate(`(async()=>await app.vault.read(app.vault.getFileByPath(${JSON.stringify(sentinelPath)})))()`), sentinelText);
    const current = exportGroups(first.text),groups = exportGroups(all.text);
    assert.equal(current.length, 1);assert.equal(current[0].filename, path.basename(sourcePath));assert.equal(current[0].filePath, sourcePath);
    assert.deepEqual(current[0].quotes.sort(), [sameQuote, mergeText.slice(0, 6), mergeText.slice(6, 8), lostQuote].sort());
    assert.ok(current[0].text.includes('已关联原文'));assert.ok(current[0].text.includes('原文位置失效'));
    for (const [filePath, quote] of [[aPath, '甲目录摘录。'], [bPath, '乙目录摘录。']]) {
      const group=groups.find(g=>g.filePath===filePath);assert.ok(group, `同名笔记按相对路径分组：${filePath}`);
      assert.equal(group.filename, '笔记.md');assert.deepEqual(group.quotes, [quote]);
    }
    assert.ok(groups.find(g => g.filePath === missingPath)?.text.includes('原文件已删除'));
    assert.ok(!first.text.includes('甲目录摘录'));assert.ok(!first.text.includes('乙目录摘录'));assert.ok(!first.text.includes('同段评论通过真实保存按钮写入'));
    assert.equal([...all.text.matchAll(/^### 标记 /gm)].length, JSON.parse(all.before).length);
    await activate('preview', emptyPath);
    const empty = inClient(`const before=app.vault.getMarkdownFiles().map(f=>f.path).sort();const result=await p.exportHighlights('current');return {result:result?.path??null,before,after:app.vault.getMarkdownFiles().map(f=>f.path).sort()};`);
    assert.equal(empty.result, null);assert.deepEqual(empty.after, empty.before);
    await activate();await assertSource();
  });

  await step('真实 rename 与最终 reload 保留评论、标记和颜色', async () => {
    evaluate(`(async()=>{await app.vault.rename(app.vault.getFileByPath(${JSON.stringify(aPath)}),${JSON.stringify(renamedPath)});return true;})()`);
    await until(`app.plugins.plugins['${pluginId}'].store.getHighlight('${extraIds.a}')?.filePath===${JSON.stringify(renamedPath)} && app.plugins.plugins['${pluginId}'].store.get('${extraIds.comment}')?.filePath===${JSON.stringify(renamedPath)}`, 'rename 同时移动评论和标记');
    assert.equal(inClient(`return p.store.viewHighlights(${JSON.stringify(aPath)}).length;`), 0);
    await reload();
    assert.equal(getHighlight(extraIds.a).filePath, renamedPath);assert.equal(getHighlight(extraIds.b).filePath, bPath);
    assert.equal(getHighlight(detachedId).anchor.state, 'detached');assert.equal(getHighlight(detachedId).anchor.quote, lostQuote);
    assert.equal(getHighlight(extraIds.missing).fileMissing, true);
    assert.equal(inClient(`return p.store.get('${commentId}').anchor.state;`), 'attached');
    assert.equal(inClient(`return p.store.get('${extraIds.comment}').filePath;`), renamedPath);
    assert.equal(inClient('return p.settings.highlightColor;'), '#80cfff');
    await assertAttached(primaryId, sameQuote);await assertSource();
  });
} finally {
  // 所有清理都针对真实实例与 UI；不遗留原型、window 全局或 console 替身。
  if (originalAppearance) {
    try {
      inClient(`
        if(p){for(const modal of [...p.openModals])modal.close();await p.setHighlightColor(${JSON.stringify(originalAppearance.color)});}
        document.getSelection()?.removeAllRanges();
        document.body.classList.toggle('theme-light',${originalAppearance.light});document.body.classList.toggle('theme-dark',${originalAppearance.dark});return true;
      `);
    } catch (error) { console.error(`清理失败：${error.message}`); }
  }
}
console.log(`通过：${completed.length} 个步骤。回归笔记：${sourcePath}${screenshotsDir ? `；截图：${screenshotsDir}` : ''}`);
