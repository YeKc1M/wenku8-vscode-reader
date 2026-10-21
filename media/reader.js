(() => {
  'use strict';
  const vscode = acquireVsCodeApi();
  const previous = vscode.getState() || {};
  let state = { auth: { status: 'loggedOut' }, shelf: [], current: undefined, hidden: false, settings: {} };
  let sidebar = previous.sidebar ?? false;
  let busy = false;
  let restoring = false;
  let progressTimer;
  let lastAction;
  let searchResults;
  let showLogin = false;
  let authMessage = '';
  let authActionPending = false;
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
      box.append(button('登录账号', () => { showLogin = true; renderAuthDialog(); }));
      box.append(button('在 VS Code 内完成验证', () => send({ type: 'verify' })));
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
    const auth = state.auth || { status: 'loggedOut' };
    actions.append(button(auth.status === 'loggedIn' ? `已登录 · ${auth.username || '文库吧账号'}` : '登录账号', () => { reportProgress(); showLogin = true; authMessage = ''; renderAuthDialog(); }));
    if (auth.status === 'verification') actions.append(button('验证完成，继续', () => send({ type: 'verified' })));
    if (auth.status === 'loggedIn') actions.append(button('退出登录', () => send({ type: 'logout' })));

    actions.append(button('设置', () => send({ type: 'settings' })));
    header.append(actions); app.append(header);
    const banner = make('div'); banner.id = 'notice'; banner.hidden = true; banner.setAttribute('aria-live', 'polite'); app.append(banner);
    if (state.hidden) renderMask(); else if (state.current) renderReader(); else renderHome();
    applySettings();
    if (showLogin) renderAuthDialog();
  }
  function renderAuthDialog() {
    document.getElementById('auth-dialog')?.remove();
    if (!showLogin) return;
    const dialog = make('dialog', 'auth-dialog'); dialog.id = 'auth-dialog';
    dialog.setAttribute('aria-labelledby', 'auth-title');
    const title = make('h2', '', '登录文库吧'); title.id = 'auth-title'; dialog.append(title);
    const auth = state.auth || { status: 'loggedOut' };
    const pending = authActionPending || ['loggingIn', 'restoring'].includes(auth.status);
    const labels = { loggedOut: '未登录', restoring: '正在恢复会话…', loggingIn: '正在登录…', verification: '等待网站验证', loggedIn: `已登录 · ${auth.username || '文库吧账号'}`, expired: '登录会话已过期，请重新登录。' };
    const status = make('p', 'comment', labels[auth.status] || '未登录'); status.setAttribute('role', 'status'); dialog.append(status);
    if (authMessage) { const message = make('p', 'auth-message', authMessage); message.setAttribute('role', 'alert'); dialog.append(message); }
    if (auth.status !== 'loggedIn') {
      const form = make('form', 'auth-form');
      const field = (label, type, name) => {
        const l = make('label', '', label); const input = make('input'); input.type = type; input.name = name; input.required = true; input.maxLength = 30; input.autocomplete = 'off'; input.disabled = pending; l.append(input); form.append(l); return input;
      };
      const username = field('账号 / 邮箱', 'text', 'username');
      const password = field('密码', 'password', 'password');
      const submit = button(pending ? '请稍候…' : '登录', () => {}, '', 'primary'); submit.type = 'submit'; submit.disabled = pending; form.append(submit);
      form.addEventListener('submit', event => {
        event.preventDefault(); if (pending || !username.value.trim() || !password.value) return;
        const credentials = { type: 'login', username: username.value.trim(), password: password.value };
        password.value = ''; authMessage = ''; authActionPending = true;
        send(credentials); delete credentials.password; renderAuthDialog();
      });
      dialog.append(form);
      dialog.append(make('p', 'comment', '仅保存登录会话，不保存密码。会话过期后需要重新输入。'));
      const verify = make('div', 'auth-actions');
      const open = button('在 VS Code 内完成验证', () => { authMessage = ''; authActionPending = true; send({ type: 'verify' }); renderAuthDialog(); }); open.disabled = pending;
      const done = button('验证完成，继续', () => { authMessage = ''; authActionPending = true; send({ type: 'verified' }); renderAuthDialog(); }); done.disabled = pending;
      verify.append(open, done); dialog.append(verify);
      dialog.append(make('p', 'comment', '需要验证码时，在独立的 VS Code 验证窗口中完成验证或登录，再返回继续。之后可手动最小化该窗口；请勿关闭，以保持阅读连接。'));
    }
    dialog.append(button('清除登录会话', () => { authActionPending = true; send({ type: 'logout' }); renderAuthDialog(); }));
    const close = button('关闭', () => { showLogin = false; dialog.close(); dialog.remove(); });
    dialog.append(close);
    dialog.addEventListener('cancel', () => { showLogin = false; dialog.querySelectorAll('input').forEach(input => { input.value = ''; }); });
    app.append(dialog); dialog.showModal();
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
    hint.append(make('p', '', '// 可在阅读器内登录；网站验证使用独立窗口，完成后可最小化。'));
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
    if (document.querySelector('dialog[open]') || ['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) return;
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
        state = m; if (state.auth?.status === 'loggedIn') showLogin = false; render(); break;
      }
      case 'busy': busy = true; notice(m.message); break;
      case 'error': {
        busy = false; authActionPending = false;
        if (m.authError || ['login', 'verification'].includes(m.code)) { showLogin = true; authMessage = m.message; renderAuthDialog(); }
        notice(m.message, true, !m.authError); break;
      }
      case 'auth': {
        if (state.current && !state.hidden) saveUi(progressValue());
        state.auth = m.auth;
        if (['loggingIn', 'restoring'].includes(m.auth.status)) authActionPending = true;
        else if (m.auth.status !== 'verification') authActionPending = false;
        if (m.auth.status === 'loggedIn') { showLogin = false; authMessage = ''; }
        render(); break;
      }
      case 'showLogin': showLogin = true; authMessage = ''; renderAuthDialog(); break;
      case 'verificationComplete': {
        busy = false; authActionPending = false; showLogin = !m.loggedIn;
        authMessage = m.loggedIn ? '' : '验证已完成，请重新输入账号密码登录。';
        renderAuthDialog(); notice(m.loggedIn ? '登录会话已确认，可以继续阅读或搜索。' : '验证已完成，请输入账号密码登录。'); break;
      }
      case 'notice': busy = false; authActionPending = false; if (showLogin) renderAuthDialog(); notice(m.message); break;
      case 'results': busy = false; searchResults = m.books; render(); break;
      case 'hidden': { busy = false; notice(''); reportProgress(); state.hidden = m.hidden; render(); break; }
      case 'settings': { const value = progressValue(); state.settings = m.settings; saveUi(value); render(); break; }
    }
  });
  window.addEventListener('pagehide', reportProgress);
  render(); send({ type: 'ready' });
})();
