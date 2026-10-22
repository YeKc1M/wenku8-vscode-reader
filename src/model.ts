export const ORIGIN = 'https://www.wenku8.net';
export interface Book { id: number; title: string; author?: string }
export interface Chapter { id: number; title: string; volume: string; url: string }
export interface Catalog { book: Book; chapters: Chapter[] }
export interface Content { title: string; paragraphs: string[]; images: string[] }
export interface SavedBook extends Book { chapterId?: number; progress?: number; line?: number; updatedAt: number }
export interface Page { url: string; html: string; status: number }

export function readingLink(input: string): { id: number; chapterId?: number } {
  if (/^\d+$/.test(input.trim())) return { id: validId(Number(input.trim())) };
  let u: URL;
  try { u = new URL(input.trim()); } catch { throw new Error('请输入书籍 ID 或文库吧 HTTPS 链接。'); }
  if (u.protocol !== 'https:' || !/^(www\.)?wenku8\.(net|com)$/.test(u.hostname) || u.port || u.username || u.password) throw new Error('请输入文库吧 HTTPS 链接。');
  const b = u.pathname.match(/^\/book\/(\d+)\.htm$/);
  const c = u.pathname.match(/^\/novel\/\d+\/(\d+)\/(index|\d+)\.htm$/);
  const aid = u.pathname === '/modules/article/readbookcase.php' ? u.searchParams.get('aid') : null;
  if (!b && !c && !aid) throw new Error('链接必须指向书籍、目录或章节。');
  return { id: validId(Number(b?.[1] ?? c?.[1] ?? aid)), chapterId: c && c[2] !== 'index' ? validId(Number(c[2])) : undefined };
}
export function validId(id: number): number {
  if (!Number.isSafeInteger(id) || id < 1 || id > 9999999) throw new Error('书籍或章节 ID 无效。');
  return id;
}
export function catalogUrl(id: number): string { return `${ORIGIN}/novel/${Math.floor(validId(id) / 1000)}/${id}/index.htm`; }
export function siteUrl(input: string, post = false): URL {
  const u = new URL(input, ORIGIN);
  if (u.origin !== ORIGIN || u.username || u.password || !/^\/(?:index\.php|login\.php|logout\.php|book\/\d+\.htm|novel\/\d+\/\d+\/(?:index|\d+)\.htm|modules\/article\/(?:search|bookcase|toplist)\.php)$/.test(u.pathname)) throw new Error('已拒绝非阅读地址。');
  // bookcase.php 的 delid 参数会删除远端书架，因此仅允许只读参数。
  if (post && !(u.pathname === '/login.php' && u.search === '?do=submit')) throw new Error('不允许向该地址提交表单。');
  const keys = post ? ['do'] : u.pathname.endsWith('/search.php') ? ['searchtype', 'searchkey', 'page'] : u.pathname.endsWith('/bookcase.php') ? ['classid', 'page'] : u.pathname.endsWith('/toplist.php') ? ['sort', 'page'] : [];
  for (const k of u.searchParams.keys()) if (!keys.includes(k)) throw new Error('地址包含不允许的参数。');
  return u;
}
export function imageUrl(value: string): string | undefined {
  try {
    const u = new URL(value, ORIGIN);
    if (/^https?:$/.test(u.protocol) && /^(?:(?:img|pic)\.wenku8\.(?:net|com)|pic\.777743\.xyz)$/.test(u.hostname) && !u.port && !u.username && !u.password) { u.protocol = 'https:'; return u.href; }
  } catch { /* ignore malformed image sources */ }
}
