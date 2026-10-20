import iconv from 'iconv-lite';
import { BrowserSession } from './browser';
import { Book, Catalog, Content, ORIGIN, allowedUrl, catalogUrl } from './model';
import { assertPage, parseBook, parseCatalog, parseContent, parseSearch } from './parser';
export interface NetworkOptions { transport: string; browserPort: number; browserConnected: boolean; }
export class WenkuClient {
  readonly browser = new BrowserSession();
  private catalogs = new Map<number, Catalog>();
  private contents = new Map<string, Content>();
  constructor(private readonly options: () => NetworkOptions) {}
  async read(url: string): Promise<{ html: string; url: string }> {
    allowedUrl(url);
    const opts = this.options();
    if (opts.transport === 'browser' || (opts.transport === 'auto' && opts.browserConnected)) {
      const page = await this.browser.read(url, opts.browserPort);
      allowedUrl(page.url); assertPage(page.html); return page;
    }
    try {
      let target = url;
      for (let n = 0; n < 6; n++) {
        allowedUrl(target);
        const r = await fetch(target, { redirect: 'manual', signal: AbortSignal.timeout(15000), headers: { 'User-Agent': 'Wenku8-Code-Reader/0.1', Accept: 'text/html' } });
        if (r.status >= 300 && r.status < 400 && r.headers.has('location')) { target = new URL(r.headers.get('location')!, target).href.replace(/^http:\/\//, 'https://'); await r.body?.cancel(); continue; }
        if (!r.ok) { await r.body?.cancel(); throw new Error(`HTTP ${r.status}`); }
        const reader = r.body?.getReader();
        if (!reader) throw new Error('正文为空');
        const chunks: Uint8Array[] = []; let size = 0;
        for (;;) { const { value, done } = await reader.read(); if (done) break; size += value.length; if (size > 8 * 1024 * 1024) { await reader.cancel(); throw new Error('页面过大'); } chunks.push(value); }
        const bytes = Buffer.concat(chunks);
        const charset = /charset\s*=\s*["']?utf-?8/i.test((r.headers.get('content-type') || '') + bytes.subarray(0, 2048).toString()) ? 'utf8' : 'gbk';
        const html = iconv.decode(bytes, charset); assertPage(html);
        return { html, url: target };
      }
      throw new Error('重定向次数过多');
    } catch (error) { throw new Error(`直接读取失败：${error instanceof Error ? error.message : String(error)}。可点击「连接 Chrome」，完成登录或安全验证后重试。`); }
  }
  async catalog(id: number): Promise<Catalog> {
    const cached = this.catalogs.get(id); if (cached) return cached;
    // Catalog contains the canonical book title; details are optional metadata.
    const page = await this.read(catalogUrl(id));
    const catalog = parseCatalog(page.html, { id, title: String(id) }, page.url);
    if (this.catalogs.size >= 30) this.catalogs.delete(this.catalogs.keys().next().value!);
    this.catalogs.set(id, catalog); return catalog;
  }
  async chapter(url: string): Promise<Content> {
    const cached = this.contents.get(url); if (cached) return cached;
    const page = await this.read(url); const result = parseContent(page.html);
    if (this.contents.size >= 20) this.contents.delete(this.contents.keys().next().value!);
    this.contents.set(url, result); return result;
  }
  async search(query: string): Promise<Book[]> {
    const q = query.trim(); if (!q || q.length > 50) throw new Error('请输入 1–50 个字符的书名。');
    const encoded = [...iconv.encode(q, 'gbk')].map(b => `%${b.toString(16).padStart(2, '0')}`).join('');
    const page = await this.read(`${ORIGIN}/so.php?searchtype=articlename&searchkey=${encoded}&charset=gbk`);
    const direct = new URL(page.url).pathname.match(/^\/book\/(\d+)\.htm$/);
    return direct ? [parseBook(page.html, Number(direct[1]))] : parseSearch(page.html);
  }
  clear(): void { this.catalogs.clear(); this.contents.clear(); }
}
