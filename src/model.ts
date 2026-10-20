export interface Book { id: number; title: string; author?: string; }
export interface Chapter { id: number; title: string; volume: string; url: string; }
export interface Catalog { book: Book; chapters: Chapter[]; }
export interface Content { title: string; paragraphs: string[]; images: string[]; }
export interface SavedBook extends Book { chapterId?: number; progress?: number; updatedAt: number; }
export const ORIGIN = 'https://www.wenku8.net';
export function bookId(input: string): number {
  const value = input.trim();
  let id: string | undefined;
  if (/^\d+$/.test(value)) id = value;
  else {
    const url = new URL(value);
    if (url.protocol !== 'https:' || !['www.wenku8.net', 'wenku8.net', 'www.wenku8.com', 'wenku8.com'].includes(url.hostname) || url.port || url.username || url.password) throw new Error('请输入文库吧 HTTPS 书籍链接或数字 ID。');
    id = url.pathname.match(/^\/book\/(\d+)\.htm$/)?.[1] ?? url.pathname.match(/^\/novel\/\d+\/(\d+)\/(?:index|\d+)\.htm$/)?.[1];
  }
  const result = Number(id);
  if (!Number.isSafeInteger(result) || result < 1 || result > 9999999) throw new Error('书籍 ID 无效，例如 1 或 https://www.wenku8.net/book/1.htm');
  return result;
}
export function catalogUrl(id: number): string { return `${ORIGIN}/novel/${Math.floor(id / 1000)}/${id}/index.htm`; }
export function allowedUrl(input: string): URL {
  const url = new URL(input, ORIGIN);
  if (url.origin !== ORIGIN || url.username || url.password || !/^\/(?:book\/\d+\.htm|novel\/\d+\/\d+\/(?:index|\d+)\.htm|so\.php|modules\/article\/search\.php|login\.php)$/.test(url.pathname)) throw new Error('已拒绝非文库吧阅读地址。');
  return url;
}
export function imageUrl(input: string): string | undefined {
  try { const u = new URL(input, ORIGIN); if (['http:', 'https:'].includes(u.protocol) && /^(?:img|pic)\.wenku8\.(?:com|net)$/.test(u.hostname) && !u.port && !u.username && !u.password) { u.protocol = 'https:'; return u.href; } } catch { /* invalid source */ }
}
