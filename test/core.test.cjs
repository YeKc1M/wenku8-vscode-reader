const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseCatalog, parseContent, parseBooks } = require('../dist/parser');
const { readingLink, siteUrl, imageUrl } = require('../dist/model');
const { searchUrl } = require('../dist/client');
const { renderCode } = require('../dist/reader');
const ts = require('typescript');
const page = html => ({ html, status: 200, url: 'https://www.wenku8.net/novel/3/3057/index.htm' });
test('links accept chapter entry and reject unrelated and mutation URLs', () => {
  assert.deepEqual(readingLink('https://www.wenku8.net/novel/3/3057/125416.htm'), { id: 3057, chapterId: 125416 });
  assert.equal(readingLink('3057').id, 3057);
  for (const s of ['0', 'https://evil.com/book/1.htm', 'https://www.wenku8.net@evil.com/book/1.htm', 'https://wenku8.net:99/book/1.htm']) assert.throws(() => readingLink(s));
  assert.throws(() => siteUrl('/modules/article/bookcase.php?delid=123'));
  assert.throws(() => siteUrl('/login.php?do=submit'));
  assert.equal(imageUrl('https://pic.777743.xyz/3/3057/1/a.jpg'), 'https://pic.777743.xyz/3/3057/1/a.jpg');
  assert.equal(imageUrl('https://evil.com/a.jpg'), undefined);
});
test('search encodes GBK bytes, rejects lossy emoji', () => {
  assert.ok(searchUrl('败北').endsWith('searchkey=%B0%DC%B1%B1'));
  assert.throws(() => searchUrl('😀'));
  assert.throws(() => searchUrl(' '));
});
test('catalog follows DOM volume order, validates book, deduplicates chapters', () => {
  const result = parseCatalog(page('<div id="title">测试书</div><div id="info">作者：测试作者</div><table><tr><td class="vcss">第一卷</td></tr><tr><td class="ccss"><a href="10.htm">序</a></td><td class="ccss"><a href="10.htm">重复</a></td><td class="ccss"><a href="https://evil.com/1.htm">外链</a></td></tr><tr><td class="vcss">第二卷</td></tr><tr><td class="ccss"><a href="11.htm">终</a></td><td class="ccss"><a href="/novel/0/1/12.htm">其他书</a></td></tr></table>'), 3057);
  assert.equal(result.book.author, '测试作者');
  assert.deepEqual(result.chapters.map(c => [c.id, c.volume]), [[10, '第一卷'], [11, '第二卷']]);
});
test('content strips ads and scripts, decodes entities, supports image-only chapters', () => {
  const result = parseContent(page('<div id="title">第一卷</div><div id="content"><ul id="contentdp">广告</ul>&nbsp;测试&lt;内容&gt;<br><p>第二段</p><script>bad()</script><img src="https://pic.777743.xyz/1.jpg"><img src="https://evil.com/track"></div>'));
  assert.deepEqual(result.paragraphs, ['测试<内容>', '第二段']);
  assert.equal(result.images.length, 1);
  assert.equal(parseContent(page('<div id="title">插图</div><div id="content"><img src="https://pic.777743.xyz/1.jpg"></div>')).paragraphs.length, 0);
  assert.throws(() => parseContent(page('<title>Just a moment...</title>')), /验证/);
  assert.throws(() => parseBooks(page('<title>出现错误</title><div>错误原因：对不起，两次搜索的间隔时间不得少于 5 秒请 返 回 并修正</div>')), /不得少于 5 秒/);
});
test('search handles singleton redirects, result duplicates, shelf and pagination', () => {
  assert.equal(parseBooks({ ...page('<div id="content"><b>测试书</b></div>'), url: 'https://www.wenku8.net/book/3057.htm' }).books[0].id, 3057);
  const result = parseBooks(page('<div id="content"><a href="/book/1.htm"><img></a><b><a href="/book/1.htm">测试书</a></b><a href="/book/1.htm">我要阅读</a><a href="/modules/article/readbookcase.php?aid=2&bid=8">书架书</a><a href="/modules/article/readbookcase.php?aid=2&bid=8&cid=3">最新章节</a></div><div id="pagelink"><a class="next" href="/modules/article/search.php?searchkey=%C9%D9%C5%AE&page=2">下一页</a></div>'));
  assert.deepEqual(result.books.map(b => b.title), ['测试书', '书架书']);
  assert.ok(result.next.endsWith('page=2'));
  assert.throws(() => parseBooks(page('<div id="content"><input name="password"></div>')), /登录/);
});
test('rendered text remains valid inert TypeScript with quotes, newlines and astral Unicode', () => {
  const malicious = ['"; process.exit(); //', '中文😀'.repeat(30), 'line\nnext\u2028end'];
  const output = renderCode({ title: '不出现在标签', paragraphs: malicious, images: [] }, 20);
  const source = ts.createSourceFile('workspace.ts', output, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  assert.equal(source.parseDiagnostics.length, 0);
  assert.equal(source.statements.length, 1);
  assert.ok(!output.includes('\ud83d\n'));
  assert.ok(!output.includes('不出现在标签'));
});
