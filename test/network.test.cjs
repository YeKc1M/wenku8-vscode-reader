const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DirectHttp, encodeForm } = require('../dist/network');
const { WenkuClient } = require('../dist/client');
const memory = () => { const values = new Map(); return { get: async k => values.get(k), store: async (k,v) => { values.set(k,v); }, delete: async k => { values.delete(k); }, values }; };

test('direct HTTPS persists cookies, decodes GBK, follows safe redirects and blocks foreign targets before sending', async () => {
  const original = globalThis.fetch, requests = [];
  const store = memory();
  const iconv = require('iconv-lite');
  globalThis.fetch = async (url, options) => {
    requests.push({ url, ...options });
    if (url.includes('/book/1.htm')) return new Response(null, { status: 302, headers: { Location: '/index.php', 'Set-Cookie': 'sid=fixture; Path=/; Secure; HttpOnly' } });
    if (url.includes('/book/2.htm')) return new Response(null, { status: 302, headers: { Location: 'https://evil.com/' } });
    return new Response(iconv.encode('<title>测试</title>', 'gbk'), { headers: { 'Content-Type': 'text/html; charset=gbk' } });
  };
  try {
    const direct = new DirectHttp(store);
    const p = await direct.page('https://www.wenku8.net/book/1.htm');
    assert.ok(p.html.includes('测试')); assert.equal(requests[1].headers.Cookie, 'sid=fixture');
    assert.ok(store.values.size);
    const restored = new DirectHttp(store); await restored.page('https://www.wenku8.net/index.php');
    assert.equal(requests.at(-1).headers.Cookie, 'sid=fixture');
    await assert.rejects(direct.page('https://www.wenku8.net/book/2.htm'), /拒绝/);
    assert.ok(!requests.some(r => r.url.includes('evil.com')));
    await direct.clear(); assert.equal(store.values.size, 0);
  } finally { globalThis.fetch = original; }
});
test('login is submitted once, password never enters stored cookie jar, failure is explicit', async () => {
  const store = memory(), requests = [], original = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    requests.push({url,options});
    return new Response('<title>错误</title><input name="password">', {headers:{'Content-Type':'text/html; charset=utf-8'}});
  };
  try {
    const direct = new DirectHttp(store);
    const client = new WenkuClient({page: (...args) => direct.page(...args),clear:()=>direct.clear()});
    await assert.rejects(client.login('fixture','fixture-password'), /登录未成功/);
    assert.equal(requests.length,1); assert.equal(requests[0].options.method,'POST');
    assert.ok(requests[0].url.endsWith('/login.php?do=submit'));
    assert.equal(JSON.stringify([...store.values.values()]).includes('fixture-password'),false);
    assert.ok(encodeForm({q:'败北'}).includes('%b0%dc%b1%b1'));
  } finally { globalThis.fetch=original; }
});
test('logout cannot be undone by an older response arriving after cookie clearance', async () => {
  const original=globalThis.fetch, store=memory(); let finish, received;
  const started=new Promise(resolve=>{received=resolve;});
  globalThis.fetch=async()=>{received();await new Promise(resolve=>{finish=resolve;});return new Response('old',{headers:{'Set-Cookie':'sid=late; Path=/; Secure'}});};
  try {
    const direct=new DirectHttp(store);
    const pending=direct.page('https://www.wenku8.net/index.php');
    await started; await direct.clear(); finish();
    await assert.rejects(pending,/取消/);
    assert.equal(store.values.size,0);
  }finally{globalThis.fetch=original;}
});
