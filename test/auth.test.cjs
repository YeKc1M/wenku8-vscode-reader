const {test}=require('node:test');
const assert=require('node:assert/strict');
const iconv=require('iconv-lite');
const {WenkuClient,SESSION_KEY}=require('../dist/client');
const {parseLoginForm,loggedIn}=require('../dist/auth');
const {DirectTransport,SiteError,encodeForm}=require('../dist/network');
const {secrets,browser}=require('./helpers.cjs');
const originalFetch=global.fetch;
const origin='https://www.wenku8.net';
const form='<form action="/login.php?do=submit" method="post"><input name="username"><input type="password" name="password"><input type="hidden" name="action" value="login"><input name="submit" type="submit" value="登录"><select name="usecookie"><option value="0"></option></select></form>';
const authenticated='<a href="/logout.php">退出登录</a><div id="content">账号首页</div>';
function response(html,options={}){return new Response(iconv.encode(html,'gbk'),{...options,headers:{'content-type':'text/html; charset=gbk',...options.headers}});}

test('login parser preserves hidden fields and GBK encoding without trusting the form action',()=>{
 const p=parseLoginForm(form);assert.equal(p.url,origin+'/login.php?do=submit');assert.equal(p.fields.action,'login');assert.equal(p.fields.usecookie,'2592000');
 assert.match(encodeForm({username:'测试',password:' a+&中 '}),/%b2%e2%ca%d4/);assert.match(encodeForm({password:' a+&中 '}),/%20%61%2b%26%d6%d0%20/);
 assert.throws(()=>parseLoginForm(form.replace('/login.php?do=submit','https://evil.test/login.php')),/非文库吧/);
 assert.throws(()=>parseLoginForm(form.replace('<select','<input name="checkcode"><select')),error=>error.code==='verification');
 assert.equal(loggedIn('<a href="https://evil.test/logout.php">退出</a>'),false);
});
test('login posts credentials once, follows 302 as GET, and verifies a protected page',async()=>{
 const store=secrets(),c=new WenkuClient(store,browser());let posted=0;const calls=[];
 global.fetch=async(url,options)=>{
  calls.push({url,options});
  if(url.includes('do=submit')){posted++;assert.equal(options.method,'POST');assert.equal(options.headers.Cookie,'pre=first');assert.match(options.body,/%70%61%73%73%77%6f%72%64=%20%61%2b%26%d6%d0%20/);return response('',{status:302,headers:{location:'/index.php','set-cookie':'sid=logged; Path=/; HttpOnly; Secure; Max-Age=2592000'}});}
  if(url.endsWith('/index.php')){assert.equal(options.method,'GET');assert.equal(options.body,undefined);assert.match(options.headers.Cookie,/sid=logged/);return response(authenticated);}
  return response(form,{headers:{'set-cookie':'pre=first; Path=/; HttpOnly'}});
 };
 try{await c.login('测试',' a+&中 ');assert.equal(posted,1);assert.equal(c.auth.status,'loggedIn');const saved=store.entries.get(SESSION_KEY);assert.ok(saved);assert.doesNotMatch(saved,/ a\+&中 |password|%70%61%73%73%77%6f%72%64/);assert.ok(calls.length>=4);}finally{global.fetch=originalFetch;}
});
test('a 200 submission is not enough to claim successful authentication',async()=>{
 const c=new WenkuClient(secrets(),browser());global.fetch=async url=>response(url.endsWith('/login.php')?form:'<div id="content">密码错误</div>');
 try{await assert.rejects(c.login('reader','wrong'),/尚未登录|登录失败/);assert.equal(c.auth.status,'loggedOut');}finally{global.fetch=originalFetch;}
});
test('challenge pages are distinct from invalid credentials and keep passwords out of storage',async()=>{
 const store=secrets(),c=new WenkuClient(store,browser());global.fetch=async()=>response('<title>Attention Required! | Cloudflare</title>',{status:403});
 try{await assert.rejects(c.login('reader','secret'),error=>error instanceof SiteError&&error.code==='verification');assert.equal(c.auth.status,'verification');assert.equal(store.entries.size,0);}finally{global.fetch=originalFetch;}
});
test('cookies are applied on redirect hops, scoped by domain/path and expired by Max-Age',async()=>{
 const transport=new DirectTransport();let calls=0;
 global.fetch=async(url,options)=>{
  calls++;if(calls===1)return response('',{status:302,headers:{location:'/index.php','set-cookie':'sid=ok; Path=/; Secure; HttpOnly'}});
  assert.equal(options.headers.Cookie,'sid=ok');return response('ok');
 };
 try{await transport.request(origin+'/login.php');assert.equal(calls,2);await transport.jar.setCookie('sid=gone; Path=/; Max-Age=0',origin);assert.equal(await transport.jar.getCookieString(origin),'');await transport.jar.setCookie('scoped=yes; Path=/modules/',origin);assert.equal(await transport.jar.getCookieString(origin+'/book/1.htm'),'');await transport.jar.setCookie('bad=yes; Domain=evil.test',origin,{ignoreError:true});assert.doesNotMatch(await transport.jar.getCookieString(origin),/bad=/);}finally{global.fetch=originalFetch;}
});
test('307 redirects cannot leak a POST body to another host',async()=>{
 const transport=new DirectTransport();let calls=0;global.fetch=async()=>{calls++;return response('',{status:307,headers:{location:'https://evil.test/login.php'}});};
 try{await assert.rejects(transport.request(origin+'/login.php',{method:'POST',body:'password=secret'}),/非文库吧/);assert.equal(calls,1);}finally{global.fetch=originalFetch;}
});
test('restoring validates the session and detects expired authentication',async()=>{
 const store=secrets();const c=new WenkuClient(store,browser());
 global.fetch=async url=>response(url.endsWith('/login.php')?form:authenticated,{headers:{'set-cookie':'sid=ok; Path=/; HttpOnly'}});
 try{await c.login('reader','secret');const restored=new WenkuClient(store,browser());await restored.restore();assert.equal(restored.auth.status,'loggedIn');global.fetch=async()=>response(form);const expired=new WenkuClient(store,browser());await expired.restore();assert.equal(expired.auth.status,'expired');}finally{global.fetch=originalFetch;}
});
test('logout cannot be undone by an in-flight login response or queued storage write',async()=>{
 const store=secrets(),b=browser(),c=new WenkuClient(store,b);let release,submitted;
 const submittedPromise=new Promise(r=>submitted=r);
 global.fetch=async url=>{if(url.endsWith('/login.php'))return response(form);if(url.includes('do=submit')){submitted();return new Promise(r=>release=()=>r(response(authenticated,{headers:{'set-cookie':'sid=late; Path=/'}})));}return response(authenticated);};
 try{const login=c.login('reader','secret');const rejected=assert.rejects(login,error=>error.code==='cancelled');await submittedPromise;await c.logout();release();await rejected;assert.equal(c.auth.status,'loggedOut');assert.equal(store.entries.size,0);assert.equal(await c.direct.jar.getCookieString(origin),'');}finally{global.fetch=originalFetch;}
});
test('verification switches subsequent requests to the same browser session',async()=>{
 const store=secrets(),b=browser(),c=new WenkuClient(store,b);let calls=0;
 b.request=async url=>{calls++;return{html:url.endsWith('/login.php')?form:authenticated,url,status:200};};
 await c.openVerification();await c.continueVerification();assert.equal(c.auth.status,'loggedIn');await c.read(origin+'/book/1.htm');assert.equal(calls,3);assert.equal(JSON.parse(store.entries.get(SESSION_KEY)).browser,true);await c.logout();assert.equal(b.active,false);assert.equal(store.entries.size,0);
});
test('failed browser logout blocks reuse and retries cleanup after restart',async()=>{
 const store=secrets(),b=browser(),c=new WenkuClient(store,b);
 await c.openVerification();b.clearCookies=async()=>{throw new Error('tab closed');};
 await assert.rejects(c.logout(),/未能清除/);assert.equal(JSON.parse(store.entries.get(SESSION_KEY)).pendingLogout,true);
 await assert.rejects(c.login('reader','secret'),/先完成退出/);
 const nextBrowser=browser();let cleaned=false;nextBrowser.clearCookies=async()=>{cleaned=true;};
 const next=new WenkuClient(store,nextBrowser);await next.restore();assert.equal(cleaned,true);assert.equal(store.entries.size,0);assert.equal(next.auth.status,'loggedOut');
});
test('malformed persisted state is discarded and unsupported password characters are rejected',async()=>{
 const store=secrets();store.entries.set(SESSION_KEY,'not JSON');const c=new WenkuClient(store,browser());await c.restore();assert.equal(store.entries.size,0);
 await assert.rejects(c.login('reader','😀'),/GBK/);assert.equal(c.auth.status,'loggedOut');
});
test('concurrent logout calls wait for the same browser cleanup',async()=>{
 const b=browser(),c=new WenkuClient(secrets(),b);await c.openVerification();let release,entered;let calls=0;
 const started=new Promise(r=>entered=r);b.clearCookies=async()=>{calls++;entered();await new Promise(r=>release=r);};
 const first=c.logout();await started;const second=c.logout();assert.equal(first,second);assert.equal(calls,1);release();await Promise.all([first,second]);
});
