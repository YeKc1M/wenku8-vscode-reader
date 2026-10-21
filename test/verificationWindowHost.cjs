// Optional desktop smoke test. Opens the site without credentials, then serves
// synthetic pages through CDP. Run via --extensionTestsPath, not node --test.
const assert = require('node:assert/strict');
const vscode = require('vscode');
const { promisify } = require('node:util');
const execFile = promisify(require('node:child_process').execFile);
const { BrowserSession } = require('../dist/browser');
const { WenkuClient } = require('../dist/client');
const { secrets } = require('./helpers.cjs');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) {
 const deadline = Date.now()+10000;
 while (Date.now()<deadline) { if(await check()) return; await pause(100); }
 throw new Error('Timed out waiting for browser window state');
}
exports.run = async () => {
 await require('./extensionHost.cjs').run();
 await vscode.commands.executeCommand('wenku8.open');
 const before = new Set(vscode.window.tabGroups.all);
 const browser = new BrowserSession();
 const client = new WenkuClient(secrets(),browser);
 try {
  await client.openVerification();
  const windows = vscode.window.tabGroups.all.filter(g=>!before.has(g));
  assert.equal(windows.length,1,'one auxiliary window created');
  assert.equal(windows[0].tabs.length,1,'only the verification tab was moved');
  const connection = browser.connection;
  const title = 'Wenku8 verification smoke';
  const fixture = `<title>${title}</title><a href="/logout.php">退出</a><div id="content">模拟正文</div>`;
  const pages = {
   '/so.php':'<div id="content"><a href="/book/1.htm">模拟作品</a></div>',
   '/novel/0/1/index.htm':'<div id="title">模拟作品</div><table><tr><td class="vcss">第一卷</td></tr><tr><td class="ccss"><a href="2.htm">模拟章节</a></td></tr></table>',
   '/novel/0/1/2.htm':'<div id="title">模拟章节</div><div id="content">模拟正文</div>'
  };
  connection.onEvent = (method,params) => {
   if(method==='Fetch.requestPaused') void connection.send('Fetch.fulfillRequest',{
    requestId:params.requestId,responseCode:200,
    responseHeaders:[{name:'Content-Type',value:'text/html; charset=utf-8'}],body:Buffer.from(pages[new URL(params.request.url).pathname]||fixture).toString('base64')
   });
  };
  await connection.send('Fetch.enable',{patterns:[{urlPattern:'*',requestStage:'Request'}]});
  await connection.send('Page.navigate',{url:'https://www.wenku8.net/login.php'});
  await until(async()=> (await connection.send('Runtime.evaluate',{expression:'document.title',returnByValue:true})).result.value===title);
  let nativeWindow;
  if(process.env.WENKU8_WINDOW_SMOKE_X11==='1') {
   await until(async()=> {
    try { nativeWindow=(await execFile('xdotool',['search','--onlyvisible','--name',title])).stdout.trim().split('\n')[0];return !!nativeWindow; } catch { return false; }
   });
   await execFile('xdotool',['windowminimize',nativeWindow]);
   await until(async()=> (await execFile('xprop',['-id',nativeWindow,'_NET_WM_STATE'])).stdout.includes('_NET_WM_STATE_HIDDEN'));
  }
  await vscode.commands.executeCommand('wenku8.open');
  await client.continueVerification();
  assert.equal(client.auth.status,'loggedIn','session confirmation works with the window minimized');
  assert.match((await client.read('https://www.wenku8.net/book/1.htm')).html,/模拟正文/);
  assert.deepEqual(await client.search('模拟'),[{id:1,title:'模拟作品'}]);
  const catalog = await client.catalog(1);
  assert.equal(catalog.chapters.length,1);
  assert.deepEqual((await client.chapter(catalog.chapters[0].url)).paragraphs,['模拟正文']);
  await client.openVerification();
  assert.equal(browser.connection,connection,'reveal reuses the existing CDP connection');
  await until(()=>vscode.window.tabGroups.all.length===before.size+1);
  if(nativeWindow) {
   await until(async()=> {
    try { nativeWindow=(await execFile('xdotool',['search','--onlyvisible','--name',title])).stdout.trim().split('\n')[0];return !!nativeWindow; } catch { return false; }
   });
   assert.ok(!(await execFile('xprop',['-id',nativeWindow,'_NET_WM_STATE'])).stdout.includes('_NET_WM_STATE_HIDDEN'),'verification is visible again');
   await execFile('wmctrl',['-ic','0x'+Number(nativeWindow).toString(16)]);
  } else await vscode.window.tabGroups.close(browser.verificationTab);
  // Closing the window destroys the browser. A later verification creates a new one.
  await until(()=>!browser.active);
  await until(()=>vscode.window.tabGroups.all.every(g=>g.tabs.every(t=>t.input!==undefined)));
  await client.openVerification();
  assert.equal(browser.active,true,'closed verification window can be reopened');
  assert.notEqual(browser.connection,connection);
  await client.logout();
  assert.equal(browser.active,false,'logout stops the owned browser session');
  await until(()=>vscode.window.tabGroups.all.every(g=>g.tabs.every(t=>t.input!==undefined)));
  console.log('WENKU8_VERIFICATION_WINDOW_SMOKE_PASSED');
 } finally { client.dispose(); }
};
