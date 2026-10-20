import iconv from 'iconv-lite';
import { CookieJar } from 'tough-cookie';
import { allowedUrl } from './model';

export interface Page { html: string; url: string; status: number; }
export interface RequestOptions { method?: 'GET' | 'POST'; body?: string; }
export interface BrowserTransport {
  readonly active: boolean;
  openVerification(url?: string): Promise<void>;
  request(url: string, options?: RequestOptions): Promise<Page>;
  clearCookies(): Promise<void>;
  cancel(): Promise<void>;
  dispose(): void;
}
export class SiteError extends Error {
  constructor(readonly code: 'verification' | 'login' | 'credentials' | 'cancelled', message: string) { super(message); }
}
export function decodeHtml(bytes: Buffer, contentType: string): string {
  const utf = /charset\s*=\s*["']?utf-?8/i.test(contentType + bytes.subarray(0, 2048).toString());
  return iconv.decode(bytes, utf ? 'utf8' : 'gbk');
}
export function encodeForm(fields: Record<string, string>): string {
  const encode = (s: string) => [...iconv.encode(s, 'gbk')].map(b => `%${b.toString(16).padStart(2, '0')}`).join('');
  return Object.entries(fields).map(([key, value]) => `${encode(key)}=${encode(value)}`).join('&');
}
export class DirectTransport {
  jar = new CookieJar();
  private epoch = 0;
  private pending = new Set<AbortController>();
  cancel(): void { this.epoch++; for (const controller of this.pending) controller.abort(); this.pending.clear(); }
  async request(input: string, options: RequestOptions = {}): Promise<Page> {
    const epoch = this.epoch;
    const controller = new AbortController(); this.pending.add(controller);
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]);
    let target = allowedUrl(input).href, method = options.method ?? 'GET', body = options.body;
    try {
      for (let n = 0; n < 6; n++) {
        allowedUrl(target);
        const jar = this.jar;
        const cookie = await jar.getCookieString(target);
        if (epoch !== this.epoch) throw new SiteError('cancelled', '请求已取消。');
        const response = await fetch(target, { method, body, signal, cache: 'no-store', redirect: 'manual', headers: {
          'User-Agent': 'Wenku8-Code-Reader/0.2', Accept: 'text/html', ...(cookie ? { Cookie: cookie } : {}),
          ...(body !== undefined ? { 'Content-Type': 'application/x-www-form-urlencoded', Origin: new URL(target).origin, Referer: new URL('/login.php', target).href } : {})
        } });
        if (epoch !== this.epoch) { await response.body?.cancel(); throw new SiteError('cancelled', '请求已取消。'); }
        for (const cookie of response.headers.getSetCookie()) await jar.setCookie(cookie, target, { ignoreError: true });
        if (epoch !== this.epoch) throw new SiteError('cancelled', '请求已取消。');
        if (response.status >= 300 && response.status < 400 && response.headers.has('location')) {
          const next = new URL(response.headers.get('location')!, target); next.protocol = next.protocol === 'http:' ? 'https:' : next.protocol;
          await response.body?.cancel(); allowedUrl(next.href); target = next.href;
          if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === 'POST')) { method = 'GET'; body = undefined; }
          continue;
        }
        const reader = response.body?.getReader();
        const chunks: Uint8Array[] = []; let size = 0;
        try {
          if (reader) for (;;) {
            const { done, value } = await reader.read(); if (done) break;
            size += value.length; if (size > 8 * 1024 * 1024) throw new Error('页面过大。'); chunks.push(value);
          }
        } finally { await reader?.cancel().catch(() => {}); }
        if (epoch !== this.epoch) throw new SiteError('cancelled', '请求已取消。');
        return { html: decodeHtml(Buffer.concat(chunks), response.headers.get('content-type') ?? ''), url: target, status: response.status };
      }
      throw new Error('重定向次数过多。');
    } finally { this.pending.delete(controller); }
  }
}
