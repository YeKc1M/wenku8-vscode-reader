import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import { WenkuClient } from './client';
import { launchBrowser } from './browser';
import { Book, Catalog, Chapter, Content, SavedBook, bookId } from './model';

export function activate(context: vscode.ExtensionContext) {
  let panel: vscode.WebviewPanel | undefined;
  let current: { catalog: Catalog; chapter: Chapter; content: Content } | undefined;
  let hidden = false;
  let requestVersion = 0;
  let shelf = context.globalState.get<SavedBook[]>('books', []);
  let browserConnected = context.globalState.get<boolean>('browserConnected', false);
  const config = () => vscode.workspace.getConfiguration('wenku8');
  const client = new WenkuClient(() => ({ transport: config().get('transport', 'auto'), browserPort: config().get('browserPort', 9222), browserConnected }));
  let saveChain = Promise.resolve();
  const persist = () => { const snapshot = structuredClone(shelf); saveChain = saveChain.then(() => context.globalState.update('books', snapshot)).then(() => undefined); return saveChain; };
  const post = (message: object) => panel?.webview.postMessage(message);
  const settings = () => ({ fontSize: config().get('fontSize', 14), lineHeight: config().get('lineHeight', 1.9), showImages: config().get('showImages', false) });
  const sendState = () => post({ type: 'state', shelf, current, hidden, settings: settings() });
  const error = (e: unknown) => post({ type: 'error', message: e instanceof Error ? e.message : String(e) });
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
  async function connectBrowser() {
    const port = config().get<number>('browserPort', 9222);
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: '连接文库吧 Chrome 会话…' }, async () => {
      await launchBrowser(port, context.globalStorageUri.fsPath);
      client.browser.dispose();
      await client.browser.connect(port);
      browserConnected = true; await context.globalState.update('browserConnected', true); client.clear();
    });
    post({ type: 'notice', message: '已连接 Chrome。需要登录或验证时，请在 Chrome 中完成，然后回到此处重试。direct 模式请先在设置中切换为 auto 或 browser。' });
    vscode.window.showInformationMessage('已连接 Chrome。请在浏览器完成登录 / 验证后，回到阅读器重试。');
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
          case 'ready': sendState(); break;
          case 'open': if (typeof m.value === 'string') await openBook(bookId(m.value)); break;
          case 'search': {
            if (typeof m.query !== 'string') break;
            const version = ++requestVersion; post({ type: 'busy', message: '正在搜索书名…' });
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
          case 'connect': await connectBrowser(); break;
          case 'refresh': { client.clear(); if (current) await openBook(current.catalog.book.id); else sendState(); break; }
          case 'settings': await vscode.commands.executeCommand('workbench.action.openSettings', 'wenku8'); break;
        }
      } catch (e) { error(e); }
    });
    panel.onDidDispose(() => { ++requestVersion; panel = undefined; disposable.dispose(); });
  }
  context.subscriptions.push(
    vscode.commands.registerCommand('wenku8.open', show),
    vscode.commands.registerCommand('wenku8.addBook', async () => {
      const value = await vscode.window.showInputBox({ prompt: '输入文库吧书籍 ID 或 HTTPS 链接', placeHolder: 'https://www.wenku8.net/book/1.htm', validateInput: v => { try { bookId(v); return undefined; } catch { return '请输入书籍 ID 或文库吧 HTTPS 链接'; } } });
      if (value) { show(); await openBook(bookId(value)); }
    }),
    vscode.commands.registerCommand('wenku8.connectBrowser', async () => { try { await connectBrowser(); } catch (e) { vscode.window.showErrorMessage(String(e)); } }),
    vscode.commands.registerCommand('wenku8.hide', () => { ++requestVersion; hidden = true; post({ type: 'hidden', hidden }); }),
    vscode.workspace.onDidChangeConfiguration(e => { if (e.affectsConfiguration('wenku8')) post({ type: 'settings', settings: settings() }); }),
    { dispose: () => { panel?.dispose(); client.browser.dispose(); } }
  );
  // Expose read-only lifecycle information for extension-host smoke tests.
  return { isOpen: () => !!panel, bookCount: () => shelf.length };
}
