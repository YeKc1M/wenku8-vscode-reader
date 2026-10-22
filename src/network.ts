import iconv from 'iconv-lite';
import { CookieJar } from 'tough-cookie';
import { Page, siteUrl } from './model';

export interface RequestOptions { body?: string }
export interface SessionStore { get(key: string): Thenable<string | undefined>; store(key: string, value: string): Thenable<void>; delete(key: string): Thenable<void> }
export interface Transport {
  page(url: string, options?: RequestOptions): Promise<Page>;
  verify(): Promise<void>;
  completeVerification(): Promise<void>;
  conceal(): Promise<void>;
  clear(): Promise<void>;
  dispose(): void;
}
export function encodeForm(fields: Record<string, string>) {
  const encode = (s: string) => [...iconv.encode(s, 'gbk')].map(b => `%${b.toString(16).padStart(2, '0')}`).join('');
  return Object.entries(fields).map(([key, value]) => `${encode(key)}=${encode(value)}`).join('&');
}
export function isChallenge(page: Page) { return page.status === 403 || /<title[^>]*>\s*(?:Just a moment|Attention Required|请稍候|请稍等)/i.test(page.html) || /id=["']challenge-form["']/.test(page.html); }
export class DirectHttp {
  private jar = new CookieJar();
  private writes = Promise.resolve();
  private restored: Promise<void>;
  private pending = new Set<AbortController>();
  private epoch = 0;
  constructor(private readonly secrets: SessionStore) {
    this.restored = Promise.resolve(secrets.get('wenku8.httpSession.v1')).then(value => {
      if (value) { try { this.jar = CookieJar.deserializeSync(value); } catch { /* expired or invalid local session */ } }
    });
  }
  async page(input: string, options: RequestOptions = {}): Promise<Page> {
    await this.restored;
    const epoch = this.epoch, jar = this.jar;
    let url = siteUrl(input, !!options.body).href, body = options.body;
    const controller = new AbortController(); this.pending.add(controller);
    try {
      for (let redirects = 0; redirects < 6; redirects++) {
        const cookie = await jar.getCookieString(url);
        const response = await fetch(url, {
          method: body === undefined ? 'GET' : 'POST', body, redirect: 'manual', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(18000)]),
          headers: { Accept: 'text/html', 'User-Agent': 'WorkspaceNotes/0.5', ...(cookie ? { Cookie: cookie } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/x-www-form-urlencoded', Origin: new URL(url).origin, Referer: new URL('/login.php', url).href }) }
        });
        if (epoch !== this.epoch) { await response.body?.cancel(); throw new Error('请求已取消。'); }
        for (const cookie of response.headers.getSetCookie()) await jar.setCookie(cookie, url, { ignoreError: true });
        if ([301,302,303,307,308].includes(response.status) && response.headers.has('location')) {
          await response.body?.cancel();
          url = siteUrl(new URL(response.headers.get('location')!, url).href).href;
          if ([301,302,303].includes(response.status)) body = undefined;
          continue;
        }
        const chunks: Uint8Array[] = []; let size = 0;
        const reader = response.body?.getReader();
        try {
          if (reader) for (;;) {
            const { done, value } = await reader.read(); if (done) break;
            size += value.length; if (size > 4_000_000) throw new Error('网站页面过大。'); chunks.push(value);
          }
        } finally { await reader?.cancel().catch(() => {}); }
        const bytes = Buffer.concat(chunks);
        const utf8 = /charset\s*=\s*["']?utf-?8/i.test((response.headers.get('content-type') ?? '') + bytes.subarray(0, 1024).toString());
        if (epoch !== this.epoch) throw new Error('请求已取消。');
        const session = JSON.stringify(jar.toJSON());
        this.writes = this.writes.catch(() => undefined).then(() => Promise.resolve(this.secrets.store('wenku8.httpSession.v1', session)));
        await this.writes;
        return { html: iconv.decode(bytes, utf8 ? 'utf8' : 'gbk'), status: response.status, url };
      }
      throw new Error('网站重定向次数过多。');
    } finally { this.pending.delete(controller); }
  }
  async clear() {
    this.dispose(); await this.restored; await this.writes.catch(() => undefined);
    this.jar = new CookieJar(); await this.secrets.delete('wenku8.httpSession.v1');
  }
  dispose() { this.epoch++; for (const controller of this.pending) controller.abort(); this.pending.clear(); }
}
