import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import { SiteTransport } from './session';
import { WenkuClient } from './client';
import { Book, Catalog, Chapter, Content, ORIGIN, SavedBook, readingLink } from './model';
import { COVER, renderCode } from './reader';

const URI = vscode.Uri.parse('workspace-notes:/workspace.ts');
class DocumentProvider implements vscode.TextDocumentContentProvider, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.changed.event;
  text = COVER;
  provideTextDocumentContent() { return this.text; }
  set(text: string) { this.text = text; this.changed.fire(URI); }
  dispose() { this.changed.dispose(); this.text = COVER; }
}
class ShelfProvider implements vscode.TreeDataProvider<SavedBook>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;
  constructor(private readonly books: () => SavedBook[]) {}
  refresh() { this.changed.fire(); }
  getChildren() { return this.books(); }
  getTreeItem(book: SavedBook) {
    const item = new vscode.TreeItem(book.title);
    item.description = book.chapterId ? '继续' : undefined;
    item.iconPath = new vscode.ThemeIcon('file-code');
    item.command = { command: 'wenku8.readBook', title: '打开', arguments: [book.id] };
    item.contextValue = 'wenku8.book';
    return item;
  }
  dispose() { this.changed.dispose(); }
}
interface Current { catalog: Catalog; chapter: Chapter; content: Content }

export function activate(context: vscode.ExtensionContext) {
  const cfg = () => vscode.workspace.getConfiguration('wenku8');
  const transport = new SiteTransport(context.secrets);
  const client = new WenkuClient(transport);
  let shelf = context.globalState.get<SavedBook[]>('books', []);
  let current: Current | undefined;
  let hidden = true, epoch = 0, rendering = false;
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  let writes = Promise.resolve();
  const document = new DocumentProvider();
  const tree = new ShelfProvider(() => hidden ? [] : shelf);
  const images = new Set<vscode.WebviewPanel>();
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 0);
  status.text = '$(code)'; status.tooltip = 'Workspace Notes'; status.command = 'wenku8.open';
  const persist = () => {
    const books = structuredClone(shelf);
    writes = writes.catch(() => undefined).then(() => Promise.resolve(context.globalState.update('books', books)));
    return writes;
  };
  const progress = (editor: vscode.TextEditor) => {
    if (hidden || rendering || !current || editor.document.uri.toString() !== URI.toString()) return;
    const saved = shelf.find(b => b.id === current!.catalog.book.id);
    if (!saved) return;
    saved.line = editor.visibleRanges[0]?.start.line ?? 0;
    saved.progress = saved.line / Math.max(1, editor.document.lineCount - 1);
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { void persist().catch(report); }, 500);
  };
  const capture = () => { for (const editor of vscode.window.visibleTextEditors) progress(editor); };
  function report(error: unknown) {
    const message = error instanceof Error ? error.message : '读取失败，请重试。';
    if (/需要安全验证/.test(message)) void vscode.window.showErrorMessage(message, '在 VS Code 内验证').then(action => { if (action) void vscode.commands.executeCommand('wenku8.verify'); });
    else void vscode.window.showErrorMessage(message);
  }
  const command = (name: string, fn: (...args: any[]) => unknown) => vscode.commands.registerCommand(`wenku8.${name}`, async (...args: any[]) => {
    try { return await fn(...args); } catch (error) { report(error); }
  });
  async function closeReaderTabs() {
    const tabs = vscode.window.tabGroups.all.flatMap(group => group.tabs).filter(tab => tab.input instanceof vscode.TabInputText && tab.input.uri.toString() === URI.toString());
    if (tabs.length) await vscode.window.tabGroups.close(tabs, true);
  }
  async function showDocument(line?: number, ratio?: number, version = epoch) {
    if (!current || hidden || version !== epoch) return;
    rendering = true;
    try {
      const width = Math.max(20, Math.min(120, cfg().get('wrapColumn', 52)));
      document.set(renderCode(current.content, width));
      const doc = await vscode.workspace.openTextDocument(URI);
      if (hidden || version !== epoch) return;
      const editor = await vscode.window.showTextDocument(doc, { preview: true });
      if (hidden || version !== epoch) { if (hidden) await closeReaderTabs(); return; }
      // 等待内容提供器刷新已打开的文档，再按保存位置滚动。
      if (doc.getText() !== document.text) {
        await new Promise<void>(resolve => {
          const timer = setTimeout(() => { subscription.dispose(); resolve(); }, 1000);
          const subscription = vscode.workspace.onDidChangeTextDocument(e => {
            if (e.document.uri.toString() === URI.toString()) { clearTimeout(timer); subscription.dispose(); resolve(); }
          });
        });
      }
      if (hidden || version !== epoch) return;
      const target = Math.max(0, Math.min(doc.lineCount - 1, line ?? Math.round((ratio ?? 0) * (doc.lineCount - 1))));
      editor.selection = new vscode.Selection(target, 0, target, 0);
      editor.revealRange(new vscode.Range(target, 0, target, 0), vscode.TextEditorRevealType.AtTop);
      // 原生编辑器在主题切换或重新载入文档后会异步恢复旧视口。
      // 在目标位置可见前不采集滚动事件，避免把刚恢复的进度写成零。
      const deadline = Date.now() + 1200;
      while (!hidden && version === epoch && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 50));
        if (editor.visibleRanges.some(range => range.contains(new vscode.Position(target, 0)))) break;
        editor.revealRange(new vscode.Range(target, 0, target, 0), vscode.TextEditorRevealType.AtTop);
      }
      status.show(); tree.refresh();
    } finally { rendering = false; }
  }
  async function load(catalog: Catalog, chapter: Chapter, version: number, saved?: SavedBook) {
    const content = await client.chapter(chapter.url);
    if (version !== epoch) return;
    current = { catalog, chapter, content }; hidden = false;
    const resume = saved?.chapterId === chapter.id;
    shelf = [{ ...catalog.book, chapterId: chapter.id, line: resume ? saved?.line : 0, progress: resume ? saved?.progress : 0, updatedAt: Date.now() }, ...shelf.filter(b => b.id !== catalog.book.id)].slice(0, 100);
    await persist();
    if (version !== epoch) return;
    await showDocument(resume ? saved?.line : 0, resume ? saved?.progress : 0, version);
  }
  async function openBook(id: number, chapterId?: number) {
    capture();
    const version = ++epoch;
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: 'Workspace Notes' }, async () => {
      const catalog = await client.catalog(id);
      if (version !== epoch) return;
      const saved = shelf.find(b => b.id === id);
      const chapter = catalog.chapters.find(c => c.id === (chapterId ?? saved?.chapterId)) ?? catalog.chapters[0];
      await load(catalog, chapter, version, saved);
    });
  }
  async function add() {
    const value = await vscode.window.showInputBox({ prompt: '书籍 ID、书籍链接、目录或章节链接', placeHolder: '3057', ignoreFocusOut: true });
    if (value) { const link = readingLink(value); await openBook(link.id, link.chapterId); }
  }
  async function pickShelf() {
    const version = epoch;
    const picked = await vscode.window.showQuickPick([
      ...shelf.map(book => ({ label: book.title, description: book.author, id: book.id, action: '' })),
      { label: '$(add) 添加书籍', id: 0, action: 'add' },
      { label: '$(search) 搜索书名或作者', id: 0, action: 'search' },
      { label: '$(cloud-download) 导入网站书架', id: 0, action: 'importShelf' }
    ], { title: 'Workspace Notes', matchOnDescription: true });
    if (!picked || version !== epoch) return;
    if (picked.id) await openBook(picked.id);
    else await vscode.commands.executeCommand(`wenku8.${picked.action}`);
  }
  async function search() {
    const version = epoch;
    const query = await vscode.window.showInputBox({ prompt: '输入书名或作者，最多 50 字', ignoreFocusOut: true });
    if (!query || version !== epoch) return;
    const kind = await vscode.window.showQuickPick([{ label: '按书名', value: 'articlename' as const }, { label: '按作者', value: 'author' as const }], { title: '搜索条件' });
    if (!kind || version !== epoch) return;
    let result = await client.search(query, kind.value);
    while (version === epoch) {
      const picked = await vscode.window.showQuickPick([
        ...result.books.map(book => ({ label: book.title, id: book.id })),
        ...(result.next ? [{ label: '$(arrow-right) 下一页', id: 0 }] : [])
      ], { title: result.books.length ? '搜索结果' : '没有匹配的书籍', placeHolder: '选择书籍开始阅读' });
      if (!picked || version !== epoch) return;
      if (picked.id) { await openBook(picked.id); return; }
      result = await client.list(result.next!);
    }
  }
  async function hide() {
    capture(); ++epoch; hidden = true;
    document.set(COVER); status.hide(); tree.refresh();
    for (const panel of images) panel.dispose();
    const conceal = transport.conceal().catch(report);
    // 关闭所有分组中的阅读标签，包括未激活的拆分编辑器。
    await closeReaderTabs();
    await conceal;
    await persist();
  }
  async function step(delta: number) {
    if (!current || hidden) return;
    capture();
    const { catalog, chapter } = current;
    const index = catalog.chapters.findIndex(c => c.id === chapter.id);
    const next = catalog.chapters[index + delta];
    if (!next) { void vscode.window.showInformationMessage(delta > 0 ? '已到最后一章。' : '已到第一章。'); return; }
    await load(catalog, next, ++epoch);
  }
  async function importShelf() {
    const version = epoch;
    const group = await vscode.window.showQuickPick(Array.from({ length: 6 }, (_, id) => ({ label: id ? `第 ${id} 组书架` : '默认书架', id })), { title: '选择网站书架分组' });
    if (!group || version !== epoch) return;
    let result = await client.shelf(group.id);
    while (version === epoch) {
      const selected = await vscode.window.showQuickPick(result.books.map(book => ({ label: book.title, book, picked: true })), { canPickMany: true, title: '选择导入本地书架的书籍' });
      if (!selected || version !== epoch) return;
      for (const { book } of selected) if (!shelf.some(b => b.id === book.id)) shelf.push({ ...book, updatedAt: Date.now() });
      shelf = shelf.slice(0, 100); await persist(); tree.refresh();
      if (!result.next || await vscode.window.showQuickPick(['导入下一页', '完成'], { title: '当前页已导入' }) !== '导入下一页' || version !== epoch) return;
      result = await client.list(result.next);
    }
  }
  async function showImages() {
    if (hidden || !current) return;
    const sources = current.content.images;
    if (!sources.length) { void vscode.window.showInformationMessage('本章没有插图。'); return; }
    const panel = vscode.window.createWebviewPanel('wenku8.images', 'assets', vscode.ViewColumn.Active, { enableScripts: false, localResourceRoots: [] });
    images.add(panel); panel.onDidDispose(() => images.delete(panel));
    const nonce = randomBytes(16).toString('hex');
    const hosts = [...new Set(sources.map(s => new URL(s).origin))].join(' ');
    panel.webview.html = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${hosts}; style-src 'nonce-${nonce}'"><style nonce="${nonce}">body{background:var(--vscode-editor-background);color:var(--vscode-editor-foreground)}img{display:block;max-width:100%;margin:24px auto}</style></head><body>${sources.map(src => `<img referrerpolicy="no-referrer" src="${src.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')}" alt="" loading="lazy">`).join('')}</body></html>`;
  }
  context.subscriptions.push(document, tree, status,
    vscode.workspace.registerTextDocumentContentProvider('workspace-notes', document),
    vscode.window.registerTreeDataProvider('wenku8.notes', tree),
    command('open', async () => {
      if (current) {
        const saved = shelf.find(b => b.id === current!.catalog.book.id);
        hidden = false; await showDocument(saved?.line, saved?.progress);
      } else await pickShelf();
    }),
    command('addBook', add), command('readBook', openBook), command('search', search), command('importShelf', importShelf),
    command('catalog', async () => {
      if (!current || hidden) return;
      const version = epoch, catalog = current.catalog;
      const picked = await vscode.window.showQuickPick(catalog.chapters.map(c => ({ label: c.title, description: c.volume, chapter: c })), { title: catalog.book.title, matchOnDescription: true });
      if (picked && version === epoch) { capture(); await load(catalog, picked.chapter, ++epoch); }
    }),
    command('next', () => step(1)), command('previous', () => step(-1)), command('hide', hide),
    command('login', async () => {
      await hide();
      const username = await vscode.window.showInputBox({ prompt: '文库吧账号或邮箱', ignoreFocusOut: true });
      if (!username) return;
      let password = await vscode.window.showInputBox({ prompt: '文库吧密码，仅用于本次登录', password: true, ignoreFocusOut: true });
      if (!password) return;
      try { await client.login(username, password); }
      finally { password = undefined; }
      void vscode.window.showInformationMessage('登录成功。');
    }),
    command('verify', async () => { await hide(); await transport.verify(); void vscode.window.showInformationMessage('请在 VS Code 验证页完成安全验证或登录，然后执行「Wenku8: 验证完成」。'); }),
    command('verified', async () => { await transport.completeVerification(); client.clear(); void vscode.window.showInformationMessage('验证已完成，网站界面已替换为代码。现在可以添加书籍或搜索。'); }),
    command('logout', async () => { await hide(); await client.logout(); void vscode.window.showInformationMessage('已退出网站登录，本地书架和进度已保留。'); }),
    command('images', showImages),
    command('refresh', async () => { client.clear(); if (current && !hidden) await openBook(current.catalog.book.id, current.chapter.id); }),
    command('removeBook', async (book?: Book) => {
      const selected = book ?? (await vscode.window.showQuickPick(shelf.map(b => ({ label: b.title, book: b })), { title: '从本地书架移除' }))?.book;
      if (!selected) return;
      if (current?.catalog.book.id === selected.id) { await hide(); current = undefined; }
      shelf = shelf.filter(b => b.id !== selected.id); await persist(); tree.refresh();
    }),
    vscode.window.onDidChangeTextEditorVisibleRanges(e => progress(e.textEditor)),
    vscode.window.onDidChangeActiveTextEditor(editor => { if (editor) progress(editor); }),
    vscode.window.onDidChangeWindowState(state => { if (!state.focused && cfg().get('hideOnBlur', true)) void hide().catch(report); }),
    vscode.window.onDidChangeActiveColorTheme(() => { void transport.updateTheme().catch(report); }),
    { dispose: () => { capture(); clearTimeout(saveTimer); void persist().catch(report); for (const panel of images) panel.dispose(); client.clear(); transport.dispose(); } }
  );
  return { isHidden: () => hidden, bookCount: () => shelf.length, currentChapter: () => current?.chapter.id, savedProgress: () => shelf.map(({ id, line }) => ({ id, line })) };
}
