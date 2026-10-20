const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const Module=require('node:module');
const {EventEmitter}=require('node:events');
const iconv=require('iconv-lite');
const {CdpConnection}=require('../dist/cdp');
const originalWebSocket=global.WebSocket;
const starts=new EventEmitter(),ends=new EventEmitter();
let socket,context,pages,issued,paused,nextId;
const origin='https://www.wenku8.net';
const fakeVscode={debug:{
 onDidStartDebugSession(fn){starts.on('start',fn);return{dispose:()=>starts.off('start',fn)};},
 onDidTerminateDebugSession(fn){ends.on('end',fn);return{dispose:()=>ends.off('end',fn)};},
 async startDebugging(_folder,config){const root={id:'root',configuration:config};starts.emit('start',root);starts.emit('start',{id:'child',parentSession:root,configuration:config,customRequest:async()=>({host:'127.0.0.1',port:12345,path:'/abcdef'})});return true;},
 async stopDebugging(session){ends.emit('end',session);}
}};
const load=Module._load;Module._load=function(name,...args){return name==='vscode'?fakeVscode:load.call(this,name,...args);};
const {BrowserSession}=require('../dist/browser');Module._load=load;
class FakeSocket extends EventTarget{
 static OPEN=1;readyState=0;
 constructor(){super();socket=this;queueMicrotask(()=>{this.readyState=1;this.dispatchEvent(new Event('open'));});}
 event(method,params){this.dispatchEvent(new MessageEvent('message',{data:JSON.stringify({method,params})}));}
 send(raw){const request=JSON.parse(raw);Promise.resolve().then(async()=>{
  let result={};
  if(request.method==='Fetch.continueRequest'||request.method==='Fetch.failRequest'){paused.get(request.params.requestId)?.(request.method==='Fetch.continueRequest');paused.delete(request.params.requestId);}
  if(request.method==='Runtime.evaluate'){
   try{result={result:{value:await vm.runInContext(request.params.expression,context)}};}catch{result={exceptionDetails:{text:'failed'}};}
  }
  if(request.method==='Network.getCookies')result={cookies:[]};
  this.dispatchEvent(new MessageEvent('message',{data:JSON.stringify({id:request.id,result})}));
 });}
 close(){this.readyState=3;this.dispatchEvent(new Event('close'));}
}
function setup(){
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
