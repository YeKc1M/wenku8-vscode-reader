const { test } = require('node:test');
const assert = require('node:assert/strict');
const { bookId, catalogUrl, allowedUrl, imageUrl } = require('../dist/model');
const { parseCatalog, parseContent, parseBook, parseSearch, assertPage } = require('../dist/parser');

test('book inputs and thousand-based catalog path', () => {
  assert.equal(bookId('1'), 1);
  assert.equal(bookId('https://www.wenku8.net/novel/1/1234/567.htm'), 1234);
  assert.equal(bookId('https://www.wenku8.net/book/1234.htm'), 1234);
  assert.equal(catalogUrl(1234), 'https://www.wenku8.net/novel/1/1234/index.htm');
  for (const input of ['0', '-1', 'NaN', '10000000', 'https://evil.test/book/1.htm', 'https://www.wenku8.net.evil.test/book/1.htm', 'https://user:secret@www.wenku8.net/book/1.htm', 'http://www.wenku8.net/book/1.htm']) assert.throws(() => bookId(input));
});
test('request and image URL allowlists reject unrelated hosts and scripts', () => {
  assert.equal(allowedUrl('/novel/0/1/2.htm').hostname, 'www.wenku8.net');
  for (const url of ['https://evil.test/book/1.htm', 'file:///etc/passwd', 'http://www.wenku8.net/book/1.htm', '/admin.php', 'https://www.wenku8.net:444/book/1.htm']) assert.throws(() => allowedUrl(url));
  assert.equal(imageUrl('http://img.wenku8.com/image/a.jpg'), 'https://img.wenku8.com/image/a.jpg');
  for (const url of ['javascript:alert(1)', 'https://evil.test/a.jpg', 'https://img.wenku8.com.evil.test/a.jpg']) assert.equal(imageUrl(url), undefined);
});
test('catalog preserves volume and document order while filtering foreign chapters', () => {
  const html = '<div id="title">测试作品</div><table><tr><td class="vcss">第一卷</td></tr><tr><td class="ccss"><a href="2.htm">序章</a></td><td class="ccss"><a href="3.htm">第一章</a></td></tr><tr><td class="vcss">第二卷</td></tr><tr><td class="ccss"><a href="8.htm">新章</a><a href="https://evil.test/novel/0/1/9.htm">坏地址</a><a href="/novel/0/2/10.htm">其他书</a><a href="8.htm">重复</a></td></tr></table>';
  const c = parseCatalog(html, { id: 1, title: '1' }, catalogUrl(1));
  assert.equal(c.book.title, '测试作品');
  assert.deepEqual(c.chapters.map(c => [c.id, c.volume]), [[2, '第一卷'], [3, '第一卷'], [8, '第二卷']]);
  assert.throws(() => parseCatalog('<p>作品下架</p>', { id: 1, title: 'x' }, catalogUrl(1)));
});
test('body strips scripts and site boilerplate, preserves text and allowed illustrations', () => {
  const html = '<div id="title">第一章</div><div id="content"><ul id="contentdp">来源</ul>&nbsp;&nbsp;第一段 &lt;tag&gt;<br><br>第二段<script>alert(1)</script><p>第三段</p><img src="http://img.wenku8.com/a.jpg"><img src="https://evil.test/pixel"><ul id="contentdp">底部广告</ul></div>';
  const c = parseContent(html);
  assert.deepEqual(c.paragraphs, ['第一段 <tag>', '第二段', '第三段']);
  assert.deepEqual(c.images, ['https://img.wenku8.com/a.jpg']);
  assert.equal(c.title, '第一章');
});
test('image-only chapters and missing content', () => {
  assert.equal(parseContent('<div id="title">插图</div><div id="content"><img src="https://pic.wenku8.com/a.jpg"></div>').images.length, 1);
  assert.throws(() => parseContent('<div id="title">空</div><div id="content"></div>'));
  assert.throws(() => parseContent('<h1>404</h1>'));
});
test('login and challenge pages report actionable errors', () => {
  assert.throws(() => assertPage('<form><input name="password"></form>'), /登录/);
  assert.throws(() => assertPage('<div id="content"><form action="/login.php?do=submit"><input name="password"></form></div>'), /登录/);
  assert.throws(() => assertPage('<script src="/cdn-cgi/challenge-platform/x"></script>'), /安全验证/);
  assert.doesNotThrow(() => assertPage('<div id="content">正文</div><input name="password">'));
});
test('detail and search parsers use the inspected HTML layout', () => {
  assert.deepEqual(parseBook('<div id="content"><table><tr><td><b>测试作品</b></td></tr><tr><td>小说作者：某作者</td></tr></table></div>', 1), { id: 1, title: '测试作品', author: '某作者' });
  const results = parseSearch('<div id="left"><a href="/book/99.htm">推荐</a></div><div id="content"><a href="/book/1.htm"><img></a><a href="/book/1.htm">测试作品</a><a href="https://evil.test/book/2.htm">外站</a></div>');
  assert.deepEqual(results, [{ id: 1, title: '测试作品' }]);
});
