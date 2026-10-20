import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import { WenkuClient } from './client';
import { BrowserSession } from './browser';
import { SiteError } from './network';
import { Catalog, Chapter, Content, SavedBook, bookId } from './model';

export function activate(context: vscode.ExtensionContext) {
  let panel: vscode.WebviewPanel | undefined;
  let webviewReady = false;
  let loginRequested = false;
  let current: { catalog: Catalog; chapter: Chapter; content: Content } | undefined;
  let hidden = false;
  let requestVersion = 0;
  let shelf = context.globalState.get<SavedBook[]>('books', []);
  const config = () => vscode.workspace.getConfiguration('wenku8');
  const client = new WenkuClient(context.secrets, new BrowserSession());
  const sessionReady = client.restore().catch(e => { void vscode.window.showErrorMessage(e instanceof Error ? e.message : '恢复登录会话失败，请重新登录。'); });
  void context.globalState.update('browserConnected', undefined);
  let saveChain = Promise.resolve();
  const persist = () => { const snapshot = structuredClone(shelf); saveChain = saveChain.then(() => context.globalState.update('books', snapshot)).then(() => undefined); return saveChain; };
  const post = (message: object) => panel?.webview.postMessage(message);
  const settings = () => ({ fontSize: config().get('fontSize', 14), lineHeight: config().get('lineHeight', 1.9), showImages: config().get('showImages', false) });
  const sendState = () => post({ type: 'state', shelf, current, hidden, auth: client.auth, settings: settings() });
  const error = (e: unknown, authError = false) => {
    if (e instanceof SiteError && e.code === 'cancelled') return;
    post({ type: 'error', message: e instanceof Error ? e.message : '操作失败，请重试。', code: e instanceof SiteError ? e.code : undefined, authError });
  };
  client.onAuthChanged = auth => post({ type: 'auth', auth });
  async function showLogin() {
    loginRequested = true; show(); await sessionReady;
    if (webviewReady) { post({ type: 'showLogin' }); loginRequested = false; }
  }
  async function loadChapter(catalog: Catalog, chapter: Chapter, progress = 0) {
    const version = ++requestVersion;
    post({ type: 'busy', message: '正在读取章节…' });
    try {
      const content = await client.chapter(chapter.url);
      if (version !== requestVersion || !panel) return;
      current = { catalog, chapter, content }; hidden = false;
      const previous = shelf.find(b => b.id === catalog.book.id);
      shelf = [{ ...previous, ...catalog.book, chapterId: chapter.id, progress, updatedAt: Date.now() }, ...shelf.filter(b => b.id !== catalog.book.id)].slice(0, 100);
      await persist();
      if (version !== requestVersion || !panel) return;
      panel.title = 'workspace.ts';
      sendState();
    } catch (e) { if (version === requestVersion) error(e); }
  }
  async function openBook(id: number) {
    const version = ++requestVersion;
    post({ type: 'busy', message: '正在读取分卷目录…' });
    try {
      const catalog = await client.catalog(id);
      if (version !== requestVersion || !panel) return;
      const saved = shelf.find(b => b.id === id);
      const chapter = catalog.chapters.find(c => c.id === saved?.chapterId) ?? catalog.chapters[0];
      await loadChapter(catalog, chapter, saved?.chapterId === chapter.id ? saved.progress : 0);
    } catch (e) { if (version === requestVersion) error(e); }
  }
  async function openVerification() {
    await sessionReady;
    await client.openVerification();
    post({ type: 'notice', message: '请在 VS Code 网站验证页中完成验证，然后返回阅读器点击「验证完成，继续」。密码不会被保存，需要时请重新输入。' });
  }
  async function logout() {
    ++requestVersion;
    post({ type: 'busy', message: '正在退出登录…' });
    try { await sessionReady; await client.logout(); sendState(); post({ type: 'notice', message: '已退出登录。书架和阅读进度已保留。' }); }
    catch (e) { sendState(); error(e, true); }
  }
  function show() {
    if (panel) { panel.reveal(); return; }
    panel = vscode.window.createWebviewPanel('wenku8.reader', 'workspace.ts', vscode.ViewColumn.Active, {
      enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')]
    });
    panel.iconPath = new vscode.ThemeIcon('file-code');
    const webview = panel.webview;
    const nonce = randomBytes(20).toString('hex');
    const resource = (name: string) => webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'media', name));
    webview.html = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} https://img.wenku8.com https://pic.wenku8.com https://img.wenku8.net https://pic.wenku8.net; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';"><link rel="stylesheet" href="${resource('reader.css')}"><title>workspace.ts</title></head><body><div id="app"></div><script nonce="${nonce}" src="${resource('reader.js')}"></script></body></html>`;
    const disposable = webview.onDidReceiveMessage(async (message: unknown) => {
      if (!message || typeof message !== 'object' || !('type' in message)) return;
      const m = message as Record<string, unknown>;
      try {
        switch (m.type) {
          case 'ready': {
            webviewReady = true; await sessionReady; sendState();
            if (loginRequested) { post({ type: 'showLogin' }); loginRequested = false; }
            break;
          }
          case 'open': await sessionReady; if (typeof m.value === 'string') await openBook(bookId(m.value)); break;
          case 'search': {
            if (typeof m.query !== 'string') break;
            await sessionReady; const version = ++requestVersion; post({ type: 'busy', message: '正在搜索书名…' });
            try { const books = await client.search(m.query); if (version === requestVersion) post({ type: 'results', books }); } catch (e) { if (version === requestVersion) error(e); }
            break;
          }
          case 'chapter': {
            if (!current || typeof m.id !== 'number') break;
            const chapter = current.catalog.chapters.find(c => c.id === m.id);
            if (chapter) await loadChapter(current.catalog, chapter);
            break;
          }
          case 'step': {
            if (!current || ![1, -1].includes(m.delta as number)) break;
            const index = current.catalog.chapters.findIndex(c => c.id === current!.chapter.id);
            const chapter = current.catalog.chapters[index + (m.delta as number)];
            if (chapter) await loadChapter(current.catalog, chapter);
            break;
          }
          case 'progress': {
            if (!current || m.bookId !== current.catalog.book.id || m.chapterId !== current.chapter.id || typeof m.value !== 'number' || !Number.isFinite(m.value)) break;
            const saved = shelf.find(b => b.id === m.bookId);
            if (saved) { saved.progress = Math.max(0, Math.min(1, m.value)); await persist(); }
            break;
          }
          case 'remove': {
            if (typeof m.id !== 'number') break;
            shelf = shelf.filter(b => b.id !== m.id);
            if (current?.catalog.book.id === m.id) { ++requestVersion; current = undefined; }
            await persist(); sendState(); break;
          }
          case 'hide': ++requestVersion; hidden = true; post({ type: 'hidden', hidden }); break;
          case 'resume': hidden = false; post({ type: 'hidden', hidden }); break;
          case 'home': ++requestVersion; current = undefined; sendState(); break;
          case 'login': {
            if (typeof m.username !== 'string' || typeof m.password !== 'string') break;
            const username = m.username, password = m.password;
            delete m.password;
            ++requestVersion;
            try { await sessionReady; await client.login(username, password); sendState(); post({ type: 'notice', message: '登录成功，可以搜索书名了。' }); }
            catch (e) { error(e, true); }
            break;
          }
          case 'logout': await logout(); break;
          case 'verify': try { await openVerification(); } catch (e) { error(e, true); } break;
          case 'verified': {
            try { await sessionReady; await client.continueVerification(); sendState(); post({ type: 'verificationComplete', loggedIn: client.auth.status === 'loggedIn' }); }
            catch (e) { error(e, true); }
            break;
          }
          case 'refresh': { client.clear(); if (current) await openBook(current.catalog.book.id); else sendState(); break; }
          case 'settings': await vscode.commands.executeCommand('workbench.action.openSettings', 'wenku8'); break;
        }
      } catch (e) { error(e); }
    });
    panel.onDidDispose(() => { ++requestVersion; panel = undefined; webviewReady = false; disposable.dispose(); });
  }
  context.subscriptions.push(
    vscode.commands.registerCommand('wenku8.open', show),
    vscode.commands.registerCommand('wenku8.addBook', async () => {
      const value = await vscode.window.showInputBox({ prompt: '输入文库吧书籍 ID 或 HTTPS 链接', placeHolder: 'https://www.wenku8.net/book/1.htm', validateInput: v => { try { bookId(v); return undefined; } catch { return '请输入书籍 ID 或文库吧 HTTPS 链接'; } } });
      if (value) { show(); await sessionReady; await openBook(bookId(value)); }
    }),
    vscode.commands.registerCommand('wenku8.login', showLogin),
    vscode.commands.registerCommand('wenku8.logout', logout),
    vscode.commands.registerCommand('wenku8.hide', () => { ++requestVersion; hidden = true; post({ type: 'hidden', hidden }); }),
    vscode.workspace.onDidChangeConfiguration(e => { if (e.affectsConfiguration('wenku8')) post({ type: 'settings', settings: settings() }); }),
    { dispose: () => { panel?.dispose(); client.dispose(); } }
  );
  // Expose read-only lifecycle information for extension-host smoke tests.
  return { isOpen: () => !!panel, bookCount: () => shelf.length, authStatus: () => client.auth.status };
}
