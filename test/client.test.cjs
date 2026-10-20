const { test } = require('node:test');
const assert = require('node:assert/strict');
const iconv = require('iconv-lite');
const { client } = require('./helpers.cjs');
const originalFetch = global.fetch;
test('direct fetch decodes GBK and caches chapter results', async () => {
  let requests = 0;
  global.fetch = async () => { requests++; return new Response(iconv.encode('<div id="title">测试章节</div><div id="content">你好，世界。<br>下一段。</div>', 'gbk'), { headers: { 'content-type': 'text/html; charset=gbk' } }); };
  try {
    const c = client(); const url = 'https://www.wenku8.net/novel/0/1/2.htm';
    assert.equal((await c.chapter(url)).title, '测试章节'); await c.chapter(url); assert.equal(requests, 1);
    c.clear(); await c.chapter(url); assert.equal(requests, 2);
  } finally { global.fetch = originalFetch; }
});
test('redirect to unrelated host is rejected before issuing its request', async () => {
  let requests = 0;
  global.fetch = async () => { requests++; return new Response('', { status: 302, headers: { location: 'https://evil.test/book/1.htm' } }); };
  try { await assert.rejects(client().read('https://www.wenku8.net/book/1.htm'), /非文库吧/); assert.equal(requests, 1); } finally { global.fetch = originalFetch; }
});
test('HTTP 403 offers verification inside VS Code', async () => {
  global.fetch = async () => new Response('blocked', { status: 403 });
  try { await assert.rejects(client().read('https://www.wenku8.net/book/1.htm'), /HTTP 403.*VS Code/); } finally { global.fetch = originalFetch; }
});
test('search uses GBK percent encoding and handles direct book redirects', async () => {
  let firstUrl;
  global.fetch = async url => { firstUrl ??= url; if (String(url).includes('/so.php')) return new Response('', { status: 302, headers: { location: '/book/1.htm' } }); return new Response('<meta charset="utf-8"><div id="content"><table><tr><td><b>测试作品</b></td></tr></table></div>'); };
  try { assert.equal((await client().search('测试'))[0].id, 1); assert.match(firstUrl, /searchkey=%b2%e2%ca%d4/); } finally { global.fetch = originalFetch; }
});
