(() => {
  'use strict';
  const vscode = acquireVsCodeApi();
  const previous = vscode.getState() || {};
  let state = { shelf: [], current: undefined, hidden: false, settings: {} };
  let sidebar = previous.sidebar ?? false;
  let busy = false;
  let restoring = false;
  let progressTimer;
  let lastAction;
  let searchResults;
  const app = document.getElementById('app');
  const make = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
  const send = message => vscode.postMessage(message);
  const button = (text, action, title, cls) => { const b = make('button', cls, text); b.type = 'button'; if (title) b.title = title; b.addEventListener('click', action); return b; };
  function act(message) { lastAction = message; send(message); }
  function notice(message, isError = false, retry = false) {
    const box = document.getElementById('notice'); box.replaceChildren(); box.hidden = !message;
    document.body.classList.toggle('has-notice', !!message);
    box.classList.toggle('error', isError); box.setAttribute('role', isError ? 'alert' : 'status');
    if (!message) return;
    box.append(make('span', 'message', message));
    if (retry) {
      box.append(button('重试', () => { if (lastAction) send(lastAction); else act({ type: 'refresh' }); }));
      box.append(button('连接 Chrome', () => send({ type: 'connect' })));
    }
    box.append(button('×', () => notice(''), '关闭提示'));
  }
  function saveUi(progress) {
    const c = state.current;
    vscode.setState({ sidebar, progress, bookId: c?.catalog.book.id, chapterId: c?.chapter.id });
  }
  function progressValue() { const r = document.querySelector('.reader'); return r ? r.scrollTop / Math.max(1, r.scrollHeight - r.clientHeight) : 0; }
  function reportProgress() {
    if (restoring || state.hidden || !state.current) return;
    const value = progressValue();
    saveUi(value);
    send({ type: 'progress', bookId: state.current.catalog.book.id, chapterId: state.current.chapter.id, value });
    const label = document.getElementById('progress'); if (label) label.textContent = `${Math.round(value * 100)}%`;
  }
  function render() {
    clearTimeout(progressTimer);
    app.replaceChildren();
    const header = make('header');
    header.append(make('span', 'breadcrumb', 'src  ›  workspace.ts  ›  workspace'));
    const actions = make('div', 'actions');
    if (state.current && !state.hidden) {
      actions.append(button('目录', () => { reportProgress(); sidebar = !sidebar; saveUi(progressValue()); const side = document.querySelector('aside'); if (side) side.hidden = !sidebar; }, '切换分卷目录'));
      actions.append(button('书架', () => { reportProgress(); act({ type: 'home' }); }));
      actions.append(button('隐藏', () => { reportProgress(); send({ type: 'hide' }); }, 'Esc / Ctrl+Alt+H（macOS: Cmd+Alt+H）'));
    }
    if (state.hidden) actions.append(button('继续', () => send({ type: 'resume' })));
    actions.append(button('连接 Chrome', () => send({ type: 'connect' }), '在本机 Chrome 中完成登录或安全验证'));
    actions.append(button('设置', () => send({ type: 'settings' })));
    header.append(actions); app.append(header);
    const banner = make('div'); banner.id = 'notice'; banner.hidden = true; banner.setAttribute('aria-live', 'polite'); app.append(banner);
    if (state.hidden) renderMask(); else if (state.current) renderReader(); else renderHome();
    applySettings();
  }
  function renderMask() {
    const mask = make('div', 'mask');
    ['// workspace utilities', '', 'export function resolveConfig(input: unknown) {', '  const config = input ?? {};', '  return Object.freeze(config);', '}', '', '// all checks passed'].forEach((text, i) => {
      const line = make('div', 'line'); line.append(make('span', 'number', String(i + 1)), make('span', text.startsWith('//') ? 'code comment' : 'code', text)); mask.append(line);
    });
    app.append(mask);
  }
  function renderHome() {
    const home = make('main', 'home');
    home.append(make('p', 'comment', '// your quiet reading workspace'));
    const title = make('h1'); title.append(make('span', 'keyword', 'const '), make('span', '', 'workspace '), make('span', 'comment', '= '), make('span', 'function', 'openBook'), document.createTextNode('();')); home.append(title);
    home.append(make('p', 'comment', '把故事放进编辑器。主题、字体与工作区保持一致。'));
    const forms = make('div', 'forms');
    function form(label, placeholder, submitText, handler) {
      const f = make('form'); const l = make('label', '', label); const input = make('input'); input.placeholder = placeholder; input.required = true; input.maxLength = 300; input.setAttribute('aria-label', label);
      const row = make('div', 'inputrow'); const b = button(submitText, () => {}, '', 'primary'); b.type = 'submit'; row.append(input, b); l.append(row); f.append(l);
      f.addEventListener('submit', e => { e.preventDefault(); if (input.value.trim()) handler(input.value.trim()); }); return f;
    }
    forms.append(form('打开书籍 · ID / 链接', '1 或 https://www.wenku8.net/book/1.htm', '打开', value => act({ type: 'open', value })));
    forms.append(form('搜索书名 · 需要网站登录', '输入书名', '搜索', query => act({ type: 'search', query })));
    home.append(forms);
    if (searchResults) {
      home.append(make('div', 'section-title', `搜索结果 · ${searchResults.length}`));
      if (!searchResults.length) home.append(make('p', 'empty', '未找到作品。可以用书籍链接或 ID 直接打开。'));
      searchResults.forEach(book => home.append(bookRow(book, false)));
    }
    home.append(make('div', 'section-title', `本地书架 · ${state.shelf.length}`));
    if (!state.shelf.length) {
      home.append(make('p', 'empty', '还没有书籍。输入书籍链接即可开始，阅读进度会自动保存。'));
      home.append(button('试读：文学少女（ID: 1）', () => act({ type: 'open', value: '1' })));
    } else state.shelf.forEach(book => home.append(bookRow(book, true)));
    const hint = make('div', 'hint');
    hint.append(make('p', '', '// 阅读快捷键：Alt+← / Alt+→ 切换章节，Esc 隐藏正文。'));
    hint.append(make('p', '', '// 连接 Chrome 后，请在浏览器中完成网站登录 / 验证，再回来重试。'));
    home.append(hint); app.append(home);
  }
  function bookRow(book, saved) {
    const row = make('div', 'book');
    const open = button('', () => act({ type: 'open', value: String(book.id) }), '', 'open-book');
    open.append(make('span', 'keyword', 'TS  '), make('span', '', book.title));
    open.append(make('small', '', `#${book.id}${saved && book.chapterId ? ` · 已有书签 · ${Math.round((book.progress || 0) * 100)}%` : ''}`)); row.append(open);
    if (saved) row.append(button('移除', () => send({ type: 'remove', id: book.id }), '从本地书架移除'));
    return row;
  }
  function renderReader() {
    const { catalog, chapter, content } = state.current;
    const workspace = make('div', 'workspace');
    const side = make('aside'); side.hidden = !sidebar; side.setAttribute('aria-label', '分卷目录');
    side.append(make('div', 'section-title', catalog.book.title));
    const groups = new Map();
    catalog.chapters.forEach(c => { const key = c.volume || '章节'; if (!groups.has(key)) groups.set(key, []); groups.get(key).push(c); });
    for (const [volume, chapters] of groups) {
      const details = make('details'); details.open = chapters.some(c => c.id === chapter.id); details.append(make('summary', '', volume));
      chapters.forEach(c => { const b = button(c.title, () => { reportProgress(); act({ type: 'chapter', id: c.id }); }, c.title, `chapter${c.id === chapter.id ? ' active' : ''}`); if (c.id === chapter.id) b.setAttribute('aria-current', 'page'); details.append(b); }); side.append(details);
    }
    const editor = make('main', 'editor');
    const reader = make('div', 'reader'); reader.tabIndex = 0; reader.setAttribute('aria-label', '章节正文');
    let lineNumber = 0;
    const addLine = (text, cls = '') => { const row = make('div', `line ${cls}`); row.append(make('span', 'number', String(++lineNumber)), make('span', 'code', text)); reader.append(row); };
    addLine(`// ${catalog.book.title}`, 'comment');
    addLine(`// ${chapter.volume}`, 'comment');
    addLine(`// ${chapter.title}`, 'comment');
    addLine(''); addLine('export const workspace = [', 'keyword');
    if (!content.paragraphs.length && content.images.length && !state.settings.showImages) addLine('// 本章为插图；在设置中开启显示插图。', 'comment');
    content.paragraphs.forEach(p => addLine(p, 'prose string'));
    addLine('];', 'keyword');
    if (state.settings.showImages) content.images.forEach(src => { const row = make('div', 'line'); row.append(make('span', 'number', String(++lineNumber))); const cell = make('div', 'code'); const img = make('img', 'illustration'); img.src = src; img.alt = '章节插图'; img.referrerPolicy = 'no-referrer'; cell.append(img); row.append(cell); reader.append(row); });
    const footer = make('footer');
    const nav = make('div'); const index = catalog.chapters.findIndex(c => c.id === chapter.id);
    const prev = button('← 上一章', () => step(-1)); prev.disabled = index === 0;
    const next = button('下一章 →', () => step(1)); next.disabled = index === catalog.chapters.length - 1;
    nav.append(prev, next); footer.append(nav, make('span', '', `${index + 1} / ${catalog.chapters.length}`));
    const progress = make('span', '', '0%'); progress.id = 'progress'; footer.append(progress);
    editor.append(reader, footer); workspace.append(side, editor); app.append(workspace);
    const saved = state.shelf.find(b => b.id === catalog.book.id);
    const ui = vscode.getState() || {};
    const value = ui.bookId === catalog.book.id && ui.chapterId === chapter.id ? ui.progress || 0 : saved?.progress || 0;
    restoring = true;
    requestAnimationFrame(() => { reader.scrollTop = value * Math.max(0, reader.scrollHeight - reader.clientHeight); progress.textContent = `${Math.round(value * 100)}%`; requestAnimationFrame(() => { restoring = false; }); });
    reader.addEventListener('scroll', () => { clearTimeout(progressTimer); if (!restoring) progressTimer = setTimeout(reportProgress, 250); });
  }
  function step(delta) { if (!busy) { reportProgress(); act({ type: 'step', delta }); } }
  function applySettings() {
    const reader = document.querySelector('.reader');
    if (reader) { reader.style.fontSize = `${state.settings.fontSize || 14}px`; reader.querySelectorAll('.line').forEach(line => { line.style.lineHeight = String(state.settings.lineHeight || 1.9); }); }
  }
  window.addEventListener('keydown', e => {
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) return;
    if (e.key === 'Escape' && state.current && !state.hidden) { e.preventDefault(); reportProgress(); send({ type: 'hide' }); }
    if (e.altKey && state.current && !state.hidden && ['ArrowLeft', 'ArrowRight'].includes(e.key)) { e.preventDefault(); step(e.key === 'ArrowRight' ? 1 : -1); }
  });
  window.addEventListener('message', event => {
    const m = event.data;
    switch (m.type) {
      case 'state': {
        busy = false;
        const before = state.current;
        if (before && (before.chapter.id !== m.current?.chapter.id || before.catalog.book.id !== m.current?.catalog.book.id)) vscode.setState({ sidebar });
        state = m; render(); break;
      }
      case 'busy': busy = true; notice(m.message); break;
      case 'error': busy = false; notice(m.message, true, true); break;
      case 'notice': notice(m.message); break;
      case 'results': busy = false; searchResults = m.books; render(); break;
      case 'hidden': { busy = false; notice(''); reportProgress(); state.hidden = m.hidden; render(); break; }
      case 'settings': { const value = progressValue(); state.settings = m.settings; saveUi(value); render(); break; }
    }
  });
  window.addEventListener('pagehide', reportProgress);
  render(); send({ type: 'ready' });
})();
