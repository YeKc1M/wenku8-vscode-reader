const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const vm = require('node:vm');
const { once } = require('node:events');
const { WebSocketServer } = require('ws');
const iconv = require('iconv-lite');
const { BrowserSession } = require('../dist/browser');
test('CDP session reads UTF-8 and GBK in the browser context and reuses its connection', async () => {
 let port; let connections = 0;
 const server = http.createServer((req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify([{ type: 'page', url: 'https://www.wenku8.net/book/1.htm', webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/1` }])); });
 const ws = new WebSocketServer({ server });
 ws.on('connection', socket => { connections++;
  socket.on('message', async raw => {
   const request = JSON.parse(raw.toString());
   if (request.params.expression === 'location.origin') { socket.send(JSON.stringify({ id: request.id, result: { result: { value: 'https://www.wenku8.net' } } })); return; }
   try {
    const value = await vm.runInNewContext(request.params.expression, {
      location: { origin: 'https://www.wenku8.net' }, TextDecoder, Uint8Array, AbortSignal,
      fetch: async url => {
        const utf8 = url.includes('/3.htm');
        const response = new Response(iconv.encode('<meta charset="'+(utf8?'utf-8':'gbk')+'"><div id="content">中文正文</div>', utf8?'utf8':'gbk'), { headers: { 'content-type': 'text/html; charset='+(utf8?'utf-8':'gbk') } });
        Object.defineProperty(response, 'url', { value: url }); return response;
      }
    });
    socket.send(JSON.stringify({ id: request.id, result: { result: { value } } }));
   } catch (err) { socket.send(JSON.stringify({ id: request.id, error: { message: err.message } })); }
  });
 });
 server.listen(0, '127.0.0.1'); await once(server, 'listening'); port = server.address().port;
 const browser = new BrowserSession();
 try {
   const [a, b] = await Promise.all([browser.read('https://www.wenku8.net/novel/0/1/2.htm', port), browser.read('https://www.wenku8.net/novel/0/1/3.htm', port)]);
   assert.match(a.html, /中文正文/); assert.match(b.html, /中文正文/); assert.equal(connections, 1);
 } finally { browser.dispose(); for (const s of ws.clients) s.terminate(); ws.close(); await new Promise(resolve => server.close(resolve)); }
});
