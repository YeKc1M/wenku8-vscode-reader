import * as cheerio from 'cheerio';
import { Book, Catalog, Content, ORIGIN, allowedUrl, imageUrl } from './model';
export function assertPage(html: string): void {
  if (/cf-chl-|challenge-platform|Just a moment|正在进行安全验证/.test(html)) throw new Error('网站要求安全验证。请点击「连接 Chrome」，在浏览器中完成验证后重试。');
  const $ = cheerio.load(html);
  if ($('form[action*="do=submit"] input[name="password"]').length || ($('input[name="password"]').length && !$('#content').length)) throw new Error('此页面需要登录。请连接 Chrome，在浏览器中登录文库吧后重试。');
}
export function parseBook(html: string, id: number): Book {
  assertPage(html);
  const $ = cheerio.load(html);
  const title = $('#content table b').first().text().trim();
  if (!title) throw new Error('未找到书籍信息，请检查 ID、作品是否下架，或网站结构是否改变。');
  const author = $('#content td').toArray().map(e => $(e).text().trim()).find(t => /^小说作者：/.test(t))?.replace(/^小说作者：/, '').trim();
  return { id, title, author };
}
export function parseCatalog(html: string, book: Book, url: string): Catalog {
  assertPage(html);
  const $ = cheerio.load(html);
  const chapters: Catalog['chapters'] = [];
  let volume = '';
  $('.vcss, .ccss').each((_, cell) => {
    const el = $(cell);
    if (el.hasClass('vcss')) { volume = el.text().trim(); return; }
    el.find('a[href]').each((_, a) => {
      const target = new URL($(a).attr('href')!, url);
      const match = target.pathname.match(/^\/novel\/\d+\/(\d+)\/(\d+)\.htm$/);
      if (!match || Number(match[1]) !== book.id) return;
      try { allowedUrl(target.href); } catch { return; }
      if (!chapters.some(c => c.id === Number(match[2]))) chapters.push({ id: Number(match[2]), title: $(a).text().trim(), volume, url: target.href });
    });
  });
  if (!chapters.length) throw new Error('未找到章节目录：作品可能已下架，或网站结构已改变。');
  return { book: { ...book, title: $('#title').text().trim() || book.title }, chapters };
}
export function parseContent(html: string): Content {
  assertPage(html);
  const $ = cheerio.load(html);
  const content = $('#content');
  if (!content.length || !$('#title').length) throw new Error('未找到章节正文：可能需要登录、作品已下架，或网站结构已改变。');
  content.find('script, style, #contentdp, iframe, noscript').remove();
  const images = [...new Set(content.find('img').toArray().map(e => imageUrl($(e).attr('src') ?? '')).filter((x): x is string => !!x))];
  content.find('br').replaceWith('\n');
  content.find('p, div').prepend('\n').append('\n');
  const paragraphs = content.text().split(/\n+/).map(p => p.replace(/\u00a0/g, ' ').trim()).filter(Boolean);
  if (!paragraphs.length && !images.length) throw new Error('章节正文为空。');
  return { title: $('#title').text().trim(), paragraphs, images };
}
export function parseSearch(html: string): Book[] {
  assertPage(html);
  const $ = cheerio.load(html);
  const books = new Map<number, Book>();
  // Restrict results to the main content to avoid sidebar recommendations.
  $('#content a[href], .grid a[href]').each((_, a) => {
    const href = $(a).attr('href') ?? '';
    const u = new URL(href, ORIGIN);
    const m = u.pathname.match(/^\/book\/(\d+)\.htm$/);
    const title = $(a).text().trim();
    if (m && u.origin === ORIGIN && title) books.set(Number(m[1]), { id: Number(m[1]), title });
  });
  return [...books.values()];
}
