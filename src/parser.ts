import { load } from 'cheerio';
import { Book, Catalog, Content, Page, catalogUrl, imageUrl, readingLink, siteUrl } from './model';

export function checked(page: Page) {
  const $ = load(page.html);
  const title = $('title').text();
  if (page.status === 403 || /Just a moment|Attention Required|请稍候|请完成安全验证/i.test(title) || $('#challenge-form, script[src*="/cdn-cgi/challenge-platform/"]').length) throw new Error('网站需要安全验证，请执行 Wenku8: 在 VS Code 内验证，完成后重试。');
  if (page.status !== 200) throw new Error(`网站返回 HTTP ${page.status}，请稍后重试。`);
  if (/出现错误|错误提示/.test(title)) {
    $('script, style').remove();
    const reason = $('body').text().replace(/\s+/g, ' ').match(/错误原因[：:]\s*(.*?)(?:请\s*返|\[关闭|$)/)?.[1];
    throw new Error(reason?.trim().slice(0, 240) || '网站返回错误，请稍后重试。');
  }
  return $;
}
export function requireLogin(page: Page) {
  const $ = checked(page);
  if ($('input[name="password"]').length || /请先.{0,8}登录|必须.{0,8}登录/.test($('#content').text())) throw new Error('登录已失效，请执行 Wenku8: 登录 / 完成验证。');
  return $;
}
export function parseCatalog(page: Page, id: number): Catalog {
  const $ = checked(page);
  const title = $('#title').text().trim();
  const chapters: Catalog['chapters'] = [];
  const seen = new Set<number>();
  let volume = '';
  $('td.vcss, td.ccss').each((_, el) => {
    const cell = $(el);
    if (cell.hasClass('vcss')) { volume = cell.text().trim(); return; }
    const a = cell.find('a').first();
    if (!a.length) return;
    try {
      const url = siteUrl(new URL(a.attr('href')!, catalogUrl(id)).href).href;
      const link = readingLink(url);
      if (link.id !== id || !link.chapterId || seen.has(link.chapterId)) return;
      seen.add(link.chapterId);
      chapters.push({ id: link.chapterId, title: a.text().trim(), volume, url });
    } catch { /* unrelated link */ }
  });
  if (!title || !chapters.length) throw new Error('未找到目录，书籍可能已下架或页面结构已变化。');
  return { book: { id, title, author: $('#info').text().replace(/^作者[：:]\s*/, '').trim() }, chapters };
}
export function parseContent(page: Page): Content {
  const $ = checked(page);
  const title = $('#title').text().trim();
  const body = $('#content').clone();
  if (!title || !body.length) throw new Error('未找到章节正文，书籍可能已下架或需要验证。');
  body.find('script, style, iframe, #contentdp, .ads, .advertisement').remove();
  const images = [...new Set(body.find('img').toArray().map(el => imageUrl($(el).attr('src') ?? '')).filter((x): x is string => !!x))];
  body.find('br').replaceWith('\n');
  body.find('p, div').append('\n');
  const paragraphs = body.text().split(/\n+/).map(s => s.replace(/\u00a0/g, ' ').trim()).filter(Boolean);
  if (!paragraphs.length && !images.length) throw new Error('本章没有可读正文。');
  return { title, paragraphs, images };
}
export function parseBooks(page: Page): { books: Book[]; next?: string } {
  const $ = requireLogin(page);
  const direct = page.url.match(/\/book\/(\d+)\.htm(?:$|\?)/);
  if (direct) {
    const title = $('#content b').first().text().trim();
    if (!title) throw new Error('未找到书籍信息。');
    return { books: [{ id: Number(direct[1]), title }] };
  }
  const books = new Map<number, Book>();
  $('#content a[href]').each((_, el) => {
    const a = $(el), href = a.attr('href')!;
    if (!/\/book\/\d+\.htm|readbookcase\.php\?/.test(href)) return;
    try {
      const { id } = readingLink(new URL(href, page.url).href);
      const title = a.attr('title')?.trim() || a.text().trim();
      if (!title || /^(我要阅读|阅读|插图)$/.test(title) || books.has(id)) return;
      // 网站书架一行包含名称、最新章节及书签，只取该行首个书籍链接。
      if (href.includes('readbookcase.php') && new URL(href, page.url).searchParams.has('cid')) return;
      books.set(id, { id, title });
    } catch { /* unrelated link */ }
  });
  const href = $('#pagelink a.next').attr('href');
  let next: string | undefined;
  if (href) { try { next = siteUrl(new URL(href, page.url).href).href; } catch { /* invalid pagination */ } }
  return { books: [...books.values()], next };
}
