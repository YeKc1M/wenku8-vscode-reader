import iconv from 'iconv-lite';
import { Transport, encodeForm } from './network';
import { Catalog, Content, ORIGIN, catalogUrl } from './model';
import { checked, parseBooks, parseCatalog, parseContent } from './parser';

export function searchUrl(query: string, type: 'articlename' | 'author' = 'articlename'): string {
  const text = query.trim();
  if (!text || text.length > 50) throw new Error('搜索词应为 1–50 个字符。');
  const bytes = iconv.encode(text, 'gbk');
  if (iconv.decode(bytes, 'gbk') !== text) throw new Error('搜索词包含网站 GBK 编码不支持的字符。');
  const key = [...bytes].map(b => `%${b.toString(16).padStart(2, '0').toUpperCase()}`).join('');
  return `${ORIGIN}/modules/article/search.php?searchtype=${type}&searchkey=${key}`;
}
export class WenkuClient {
  private catalogs = new Map<number, Catalog>();
  private contents = new Map<string, Content>();
  private searchQueue: Promise<unknown> = Promise.resolve();
  private lastSearch = 0;
  constructor(readonly transport: Transport) {}
  clear() { this.catalogs.clear(); this.contents.clear(); }
  async logout() {
    await this.transport.clear();
    this.clear();
  }
  async login(username: string, password: string) {
    if (!username.trim() || !password) throw new Error('请输入账号和密码。');
    const result = checked(await this.transport.page(`${ORIGIN}/login.php?do=submit`, { body: encodeForm({ username: username.trim(), password, usecookie: '2592000', action: 'login', submit: '登录' }) }));
    if (!result('a[href*="logout.php"]').length && !/登录成功/.test(result('body').text())) throw new Error('登录未成功，请检查账号密码；若网站要求验证，请先在 VS Code 内验证。');
    this.clear();
  }
  async catalog(id: number): Promise<Catalog> {
    if (this.catalogs.has(id)) return this.catalogs.get(id)!;
    const catalog = parseCatalog(await this.transport.page(catalogUrl(id)), id);
    if (this.catalogs.size >= 12) this.catalogs.delete(this.catalogs.keys().next().value!);
    this.catalogs.set(id, catalog); return catalog;
  }
  async chapter(url: string): Promise<Content> {
    if (this.contents.has(url)) return this.contents.get(url)!;
    const content = parseContent(await this.transport.page(url));
    if (this.contents.size >= 8) this.contents.delete(this.contents.keys().next().value!);
    this.contents.set(url, content); return content;
  }
  async search(query: string, type: 'articlename' | 'author' = 'articlename') { return this.list(searchUrl(query, type)); }
  async list(url: string) {
    if (!new URL(url).pathname.endsWith('/search.php')) return parseBooks(await this.transport.page(url));
    // 网站实测要求两次搜索间隔至少五秒，翻页也经同一入口。
    const request = this.searchQueue.then(async () => {
      const remaining = 5200 - (Date.now() - this.lastSearch);
      if (remaining > 0) await new Promise(resolve => setTimeout(resolve, remaining));
      try { return parseBooks(await this.transport.page(url)); }
      finally { this.lastSearch = Date.now(); }
    });
    this.searchQueue = request.catch(() => undefined);
    return request;
  }
  async shelf(group = 0) { return this.list(`${ORIGIN}/modules/article/bookcase.php?classid=${group}`); }
}
