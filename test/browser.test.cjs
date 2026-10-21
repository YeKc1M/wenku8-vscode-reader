const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const Module=require('node:module');
const {EventEmitter}=require('node:events');
const iconv=require('iconv-lite');
const {CdpConnection}=require('../dist/cdp');
const originalWebSocket=global.WebSocket;
const starts=new EventEmitter(),ends=new EventEmitter();
const groupChanges=new EventEmitter();
let socket,context,pages,issued,paused,nextId;
let groups,launches,commands,cdpCommands,roots,moveFailure,metadataMissing;
const codeTab={label:'app.ts',input:{uri:'file:///app.ts'}};
const readerTab={label:'workspace.ts',input:{viewType:'wenku8.reader'}};
const origin='https://www.wenku8.net';
function activate(group){for(const g of groups)g.isActive=g===group;}
const fakeVscode={Uri:{from:parts=>parts},window:{tabGroups:{
 get all(){return groups;},get activeTabGroup(){return groups.find(g=>g.isActive);},
 async close(tab){
  for(const group of groups){group.tabs=group.tabs.filter(t=>t!==tab);group.activeTab=group.tabs[0];}
  const closed=groups.filter((g,i)=>i>0&&!g.tabs.length);groups=groups.filter((g,i)=>i===0||g.tabs.length);activate(groups[0]);groupChanges.emit('change',{closed});return true;
 },
 onDidChangeTabGroups(fn){groupChanges.on('change',fn);return{dispose:()=>groupChanges.off('change',fn)};}
}},commands:{
 async executeCommand(command,index){
  commands.push(command);
  const group=groups.find(g=>g.isActive);
  if(command==='workbench.action.focusFirstEditorGroup')activate(groups[0]);
  if(command==='workbench.action.focusNextGroup')activate(groups[(groups.indexOf(group)+1)%groups.length]);
  if(command==='workbench.action.openEditorAtIndex')group.activeTab=group.tabs[index];
  if(command==='workbench.action.moveEditorToNewWindow'){
   if(moveFailure==='throw')throw new Error('window unavailable');
   if(moveFailure==='noop')return;
   const source=groups.find(g=>g.tabs.some(t=>t.resourcePath===index.path));assert.ok(source,'move targets the owned browser URI');
   const tab=source.tabs.find(t=>t.resourcePath===index.path);source.tabs=source.tabs.filter(t=>t!==tab);source.activeTab=source.tabs[0];
   if(!source.tabs.length&&groups.indexOf(source)>0){groups=groups.filter(g=>g!==source);groupChanges.emit('change',{closed:[source]});}
   const moved={...tab};const next={tabs:[moved],activeTab:moved,isActive:false};groups.push(next);activate(next);
  }
 }
},debug:{
 onDidStartDebugSession(fn){starts.on('start',fn);return{dispose:()=>starts.off('start',fn)};},
 onDidTerminateDebugSession(fn){ends.on('end',fn);return{dispose:()=>ends.off('end',fn)};},
 async startDebugging(_folder,config){
  launches++;const root={id:'root'+launches,configuration:config,viewId:'00000000-0000-0000-0000-'+String(launches).padStart(12,'0')};roots.push(root);
  const tab={label:'文库吧',resourcePath:'/'+root.viewId};const group=groups[0];group.tabs.push(tab);group.activeTab=tab;activate(group);root.tab=tab;
  starts.emit('start',root);starts.emit('start',{id:'child'+launches,parentSession:root,configuration:config,customRequest:async()=>({host:'127.0.0.1',port:12345,path:'/abcdef'})});return true;
 },
 async stopDebugging(session){
  for(const group of groups){group.tabs=group.tabs.filter(t=>t.resourcePath!=='/'+session.viewId);group.activeTab=group.tabs[0];}
  groups=groups.filter((g,i)=>i===0||g.tabs.length);activate(groups[0]);ends.emit('end',session);
 }
}};
const load=Module._load;Module._load=function(name,...args){return name==='vscode'?fakeVscode:load.call(this,name,...args);};
const {BrowserSession}=require('../dist/browser');Module._load=load;
class FakeSocket extends EventTarget{
 static OPEN=1;readyState=0;
 constructor(){super();socket=this;queueMicrotask(()=>{this.readyState=1;this.dispatchEvent(new Event('open'));});}
 event(method,params){this.dispatchEvent(new MessageEvent('message',{data:JSON.stringify({method,params})}));}
 send(raw){const request=JSON.parse(raw);cdpCommands.push(request);Promise.resolve().then(async()=>{
  let result={};
  if(request.method==='Fetch.continueRequest'||request.method==='Fetch.failRequest'){paused.get(request.params.requestId)?.(request.method==='Fetch.continueRequest');paused.delete(request.params.requestId);}
  if(request.method==='Runtime.evaluate'){
   try{result={result:{value:await vm.runInContext(request.params.expression,context)}};}catch{result={exceptionDetails:{text:'failed'}};}
  }
  if(request.method==='Network.getCookies')result={cookies:[]};
  if(request.method==='Target.getTargetInfo')result={targetInfo:{vscodeBrowserViewId:metadataMissing?undefined:roots.at(-1).viewId}};
  this.dispatchEvent(new MessageEvent('message',{data:JSON.stringify({id:request.id,result})}));
 });}
 close(){this.readyState=3;this.dispatchEvent(new Event('close'));}
}
function setup(){
 const existingBrowser={label:'Unrelated browser'};
 groups=[{tabs:[codeTab,readerTab,existingBrowser],activeTab:readerTab,isActive:true}];launches=0;commands=[];cdpCommands=[];roots=[];moveFailure=undefined;metadataMissing=false;
 global.WebSocket=FakeSocket;pages=new Map();issued=[];paused=new Map();nextId=0;
 const allow=async(url,headers,id)=>new Promise(resolve=>{const requestId='pause'+(++nextId);paused.set(requestId,resolve);socket.event('Fetch.requestPaused',{requestId,networkId:id,request:{url,headers}});});
 context=vm.createContext({location:{origin},TextDecoder,Uint8Array,AbortSignal,AbortController,Set,
 fetch:async(url,options)=>{
  const id='network'+(++nextId);if(!await allow(url,options.headers,id))throw new Error('blocked');issued.push({url,options});
  let page=pages.get(url)||{html:'<meta charset="gbk"><div id="content">中文正文</div>'};
  if(page.redirect){url=page.redirect;if(!await allow(url,{},id))throw new Error('blocked redirect');issued.push({url,options});page=pages.get(url)||{};}
  if(page.pending)await new Promise((resolve,reject)=>options.signal.addEventListener('abort',()=>reject(new Error('aborted')),{once:true}));
  socket.event('Network.loadingFinished',{requestId:id});
  const response=new Response(iconv.encode(page.html||'ok',page.utf8?'utf8':'gbk'),{headers:{'content-type':page.utf8?'text/html; charset=utf-8':'text/html; charset=gbk'}});Object.defineProperty(response,'url',{value:url});return response;
 }});
}
test('verification moves only its own tab and reuses its browser session without interrupting requests',async()=>{
 setup();const browser=new BrowserSession();const originalTabs=[...groups[0].tabs];
 try{
  await Promise.all([browser.openVerification(),browser.openVerification()]);
  assert.equal(launches,1);assert.equal(groups.length,2);assert.deepEqual(groups[0].tabs,originalTabs);
  const connection=browser.connection;assert.equal(groups[1].tabs.length,1);
  // Switching back to code (or minimizing the verification window) keeps CDP alive.
  activate(groups[0]);groups[0].activeTab=codeTab;
  assert.match((await browser.request(origin+'/book/1.htm')).html,/中文正文/);
  await browser.openVerification(origin+'/modules/article/search.php');
  assert.equal(groups.length,2);assert.equal(launches,1);assert.equal(groups[1].isActive,true);assert.equal(browser.connection,connection);
  assert.equal(commands.filter(c=>c==='workbench.action.moveEditorToNewWindow').length,2);
  assert.ok(cdpCommands.some(c=>c.method==='Page.navigate'&&c.params.url.endsWith('search.php')));
  assert.deepEqual(groups[0].tabs,originalTabs);
 }finally{browser.dispose();global.WebSocket=originalWebSocket;}
});
test('disposing closes only the owned verification tab and debug session',async()=>{
 setup();const browser=new BrowserSession();const originalTabs=[...groups[0].tabs];
 try{
  await browser.openVerification();browser.dispose();await browser.closing;
  assert.equal(browser.active,false);assert.equal(groups.length,1);assert.deepEqual(groups[0].tabs,originalTabs);
  assert.equal(groupChanges.listenerCount('change'),0);assert.equal(ends.listenerCount('end'),0);
 }finally{browser.dispose();global.WebSocket=originalWebSocket;}
});
test('closing the verification window permits a fresh launch and ignores unrelated sessions',async()=>{
 setup();const browser=new BrowserSession();
 try{
  await browser.openVerification();ends.emit('end',{id:'unrelated'});assert.equal(browser.active,true);
  const root=roots[0];groups.pop();activate(groups[0]);ends.emit('end',root);
  assert.equal(browser.active,false);
  await browser.openVerification();assert.equal(launches,2);assert.equal(groups.length,2);
  assert.match((await browser.request(origin+'/book/1.htm')).html,/中文正文/);
 }finally{browser.dispose();global.WebSocket=originalWebSocket;}
});
test('closing the native window cleans up the browser tab that VS Code returns to the main window',async()=>{
 setup();const browser=new BrowserSession();const originalTabs=[...groups[0].tabs];
 try{
  await browser.openVerification();const window=groups.pop();groups[0].tabs.push(...window.tabs);activate(groups[0]);
  groupChanges.emit('change',{closed:[window]});
  assert.equal(browser.active,false);assert.deepEqual(groups[0].tabs,originalTabs);
  await browser.openVerification();assert.equal(browser.active,true);assert.equal(launches,2);assert.equal(groups.length,2);
 }finally{browser.dispose();global.WebSocket=originalWebSocket;}
});
test('a placement error rejects verification, stops its debug session, and allows retry',async()=>{
 setup();const browser=new BrowserSession();
 try{
  moveFailure='throw';await assert.rejects(browser.openVerification(),/移到独立窗口/);
  assert.equal(browser.active,false);assert.equal(ends.listenerCount('end'),0);
  moveFailure=undefined;await browser.openVerification();assert.equal(browser.active,true);assert.equal(launches,2);
 }finally{browser.dispose();global.WebSocket=originalWebSocket;}
});
test('missing browser metadata never falls back to moving the active code editor',async()=>{
 setup();const browser=new BrowserSession();const originalTabs=[...groups[0].tabs];
 try{
  metadataMissing=true;await assert.rejects(browser.openVerification(),/未返回验证页标识/);
  assert.equal(browser.active,false);assert.deepEqual(commands,[]);assert.deepEqual(groups[0].tabs,originalTabs);
 }finally{browser.dispose();global.WebSocket=originalWebSocket;}
});
test('a move command that silently does nothing is reported as a placement error',async()=>{
 setup();const browser=new BrowserSession();
 try{
  moveFailure='noop';await assert.rejects(browser.openVerification(),/移到独立窗口/);assert.equal(browser.active,false);
 }finally{browser.dispose();global.WebSocket=originalWebSocket;}
});
test('integrated browser decodes pages and blocks foreign redirect bodies before issuing them',async()=>{
 setup();const browser=new BrowserSession();
 try{
  await browser.openVerification();assert.equal(browser.active,true);
  pages.set(origin+'/novel/0/1/3.htm',{html:'<meta charset="utf-8">中文 UTF-8',utf8:true});
  assert.match((await browser.request(origin+'/novel/0/1/2.htm')).html,/中文正文/);
  assert.match((await browser.request(origin+'/novel/0/1/3.htm')).html,/中文 UTF-8/);
  pages.set(origin+'/login.php',{redirect:'https://evil.test/login.php'});
  await assert.rejects(browser.request(origin+'/login.php',{method:'POST',body:'password=secret'}),/读取失败/);
  assert.equal(issued.some(r=>r.url.startsWith('https://evil.test')),false);
 }finally{browser.dispose();global.WebSocket=originalWebSocket;}
});
test('cancelling an integrated request prevents a stale result after logout',async()=>{
 setup();const browser=new BrowserSession();
 try{
  await browser.openVerification();pages.set(origin+'/book/1.htm',{pending:true});
  const pending=browser.request(origin+'/book/1.htm');const rejected=assert.rejects(pending,error=>error.code==='cancelled');
  while(!issued.length)await new Promise(r=>setImmediate(r));await browser.cancel();await rejected;
  browser.dispose();await assert.rejects(browser.request(origin+'/book/1.htm'),error=>error.code==='verification');
 }finally{browser.dispose();global.WebSocket=originalWebSocket;}
});
test('CDP proxy validates loopback endpoints and rejects pending operations on close',async()=>{
 setup();const connection=new CdpConnection();
 try{
  await assert.rejects(connection.connect({host:'evil.test',port:12345,path:'/abcdef'}),/地址无效/);
  await connection.connect({host:'127.0.0.1',port:12345,path:'/abcdef'});
  const original=socket.send;socket.send=()=>{};const pending=connection.send('Runtime.evaluate');const rejected=assert.rejects(pending,/验证页已关闭/);connection.dispose();await rejected;socket.send=original;
 }finally{connection.dispose();global.WebSocket=originalWebSocket;}
});
