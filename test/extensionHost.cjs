const assert = require('node:assert/strict');
const vscode = require('vscode');
const fs = require('node:fs');

exports.run = async () => {
  let delayed;
  let receiveDelayed;
  const received = new Promise(resolve => { receiveDelayed = resolve; });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, options) => {
      const url = String(input);
      if (!url.startsWith('https://www.wenku8.net/')) return originalFetch(input, options);
      const id = url.includes('/0/2/') ? 2 : 1;
      const html = url.endsWith('index.htm')
        ? `<div id="title">Fixture ${id}</div><div id="info">作者：Fixture</div><table><tr><td class="vcss">第一卷</td><td class="ccss"><a href="10.htm">开始</a></td><td class="ccss"><a href="11.htm">继续</a></td></tr></table>`
        : `<div id="title">测试章节</div><div id="content">${Array.from({ length: 150 }, (_, i) => `正文测试 ${i}<br>`).join('')}</div>`;
      if (id === 2 && !url.endsWith('index.htm')) { receiveDelayed(); await new Promise(resolve => { delayed = resolve; }); }
      return new Response(html, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  };
  const config = vscode.workspace.getConfiguration('wenku8');
  await config.update('hideOnBlur', false, vscode.ConfigurationTarget.Global);
  try {
    const ext = vscode.extensions.getExtension('local-reader.wenku8-vscode-reader');
    const api = await ext.activate();
    const run = (name, ...args) => vscode.commands.executeCommand(`wenku8.${name}`, ...args);
    const wait = async fn => { for (let i = 0; i < 50; i++) { if (fn()) return; await new Promise(r => setTimeout(r, 50)); } assert.fail('condition timed out'); };
    await run('readBook', 1);
    let editor = vscode.window.activeTextEditor;
    assert.equal(editor.document.uri.scheme, 'workspace-notes');
    assert.equal(editor.document.languageId, 'typescript');
    assert.ok(editor.document.getText().includes('正文测试'));
    assert.equal(api.isHidden(), false);
    await vscode.workspace.getConfiguration('workbench').update('colorTheme', 'Default Light Modern', vscode.ConfigurationTarget.Global);
    await wait(() => vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.Light);
    assert.ok(editor.document.getText().includes('正文测试'));
    await vscode.workspace.getConfiguration('workbench').update('colorTheme', 'Default Dark Modern', vscode.ConfigurationTarget.Global);
    await wait(() => vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.Dark);
    editor.revealRange(new vscode.Range(90, 0, 90, 0), vscode.TextEditorRevealType.AtTop);
    await wait(() => editor.visibleRanges[0]?.start.line >= 80);
    await run('hide');
    assert.equal(api.isHidden(), true);
    assert.ok(!vscode.window.tabGroups.all.flatMap(g => g.tabs).some(t => t.input instanceof vscode.TabInputText && t.input.uri.scheme === 'workspace-notes'));
    await run('open');
    editor = vscode.window.activeTextEditor;
    await wait(() => editor.visibleRanges[0]?.start.line >= 80);
    await run('next'); assert.equal(api.currentChapter(), 11);
    await run('previous'); assert.equal(api.currentChapter(), 10);
    await vscode.commands.executeCommand('workbench.action.splitEditorRight');
    assert.ok(vscode.window.tabGroups.all.flatMap(g => g.tabs).filter(t => t.input instanceof vscode.TabInputText && t.input.uri.scheme === 'workspace-notes').length >= 2);
    await run('hide');
    assert.ok(!vscode.window.visibleTextEditors.some(e => e.document.uri.scheme === 'workspace-notes'));
    const pending = run('readBook', 2);
    await received; await run('hide'); delayed(); await pending;
    assert.equal(api.isHidden(), true);
    assert.equal(api.currentChapter(), 10, 'hidden pending request cannot replace current chapter');
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.parse('workspace-notes:/workspace.ts'));
    await wait(() => !doc.getText().includes('正文测试'));
    assert.ok(doc.getText().includes('normalizeValues'));
    const result = { nativeDocument: true, language: editor.document.languageId, lightDarkThemes: true, resumeScroll: true, chapterNavigation: true, splitPanic: true, pendingRequestPanic: true, books: api.bookCount() };
    if (process.env.WENKU8_HOST_RESULT) fs.writeFileSync(process.env.WENKU8_HOST_RESULT, JSON.stringify(result, null, 2));
    console.log('WENKU8_EXTENSION_HOST_SMOKE_PASSED', result);
  } finally {
    delayed?.();
    globalThis.fetch = originalFetch;
  }
};
