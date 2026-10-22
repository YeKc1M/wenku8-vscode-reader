// Opt-in Extension Host integration against the real site, no external browser or bridge.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vscode = require('vscode');
exports.run = async () => {
  fs.mkdirSync('artifacts', {recursive:true});
  const { NativeSession, SiteTransport } = require('../dist/session');
  const { WenkuClient } = require('../dist/client');
  const session = new NativeSession();
  const values = new Map();
  const store = {get:async k=>values.get(k),store:async(k,v)=>values.set(k,v),delete:async k=>values.delete(k)};
  const client = new WenkuClient(new SiteTransport(store,session));
  try {
    await session.verify();
    const deadline = Date.now() + 60000;
    let page;
    do {
      await new Promise(r=>setTimeout(r,1000));
      page = await session.snapshot().catch(()=>undefined);
      if (page && page.html.includes('name="password"')) break;
    } while (Date.now() < deadline);
    if (!page || !page.html.includes('name="password"')) throw new Error('REAL_SITE_VERIFICATION_REQUIRED');
    await session.completeVerification();
    const catalog = await client.catalog(3057);
    assert.ok(catalog.chapters.length > 10);
    assert.ok((await client.chapter(catalog.chapters[0].url)).paragraphs.length > 0);
    const imageChapter = catalog.chapters.find(c=>c.title==='插图');
    assert.ok((await client.chapter(imageChapter.url)).images.length>0);
    if (process.env.WENKU8_TEST_USERNAME && process.env.WENKU8_TEST_PASSWORD) {
      await client.login(process.env.WENKU8_TEST_USERNAME,process.env.WENKU8_TEST_PASSWORD);
      assert.ok((await client.search('败北')).books.some(b=>b.id===3057));
      const multiple = await client.search('少女');
      assert.ok(multiple.next);
      assert.ok((await client.list(multiple.next)).books.length>1);
      assert.ok((await client.shelf()).books.length>0);
    }
    for (const [theme,kind,name] of [['Default Light Modern',vscode.ColorThemeKind.Light,'light'],['Default Dark Modern',vscode.ColorThemeKind.Dark,'dark']]) {
      await vscode.workspace.getConfiguration('workbench').update('colorTheme',theme,vscode.ConfigurationTarget.Global);
      for(let i=0;i<30 && vscode.window.activeColorTheme.kind!==kind;i++) await new Promise(r=>setTimeout(r,100));
      await session.conceal();
      const result = await session.cdp.send('Page.captureScreenshot',{format:'png'});
      fs.writeFileSync(`artifacts/session-${name}-0.5.png`,Buffer.from(result.data,'base64'));
    }
    const state = await session.snapshot();
    assert.ok(state.html.includes('session.ts'));
    assert.ok(!state.html.includes('轻小说'));
    console.log('NATIVE_LIVE_PASSED',JSON.stringify({chapters:catalog.chapters.length,images:true,loginSearchShelfPagination:!!process.env.WENKU8_TEST_PASSWORD,darkLight:true}));
  } finally { session.dispose(); }
};
