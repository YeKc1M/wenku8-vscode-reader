import iconv from 'iconv-lite';
import { CookieJar } from 'tough-cookie';
import { Book, Catalog, Content, ORIGIN, allowedUrl, catalogUrl } from './model';
import { assertPage, parseBook, parseCatalog, parseContent, parseSearch } from './parser';
import { AuthState, loggedIn, loginFailure, parseLoginForm } from './auth';
import { BrowserTransport, DirectTransport, Page, RequestOptions, SiteError, encodeForm } from './network';

export interface SessionSecrets { get(key: string): PromiseLike<string | undefined>; store(key: string, value: string): PromiseLike<void>; delete(key: string): PromiseLike<void>; }
export const SESSION_KEY = 'wenku8.session.v1';
export class WenkuClient {
  readonly direct = new DirectTransport();
  private catalogs = new Map<number, Catalog>();
  private contents = new Map<string, Content>();
  private useBrowser = false;
  private epoch = 0;
  private writes: Promise<void> = Promise.resolve();
  private loginPending = false;
  private hadSession = false;
  private loggingOut = false;
  private logoutTask?: Promise<void>;
  private pendingLogout = false;
  private challengeUrl = `${ORIGIN}/login.php`;
  auth: AuthState = { status: 'loggedOut' };
  onAuthChanged?: (state: AuthState) => void;
  constructor(private readonly secrets: SessionSecrets, readonly browser: BrowserTransport) {}
  private setAuth(state: AuthState): void { this.auth = state; this.onAuthChanged?.({ ...state }); }
  private checkEpoch(epoch: number): void { if (epoch !== this.epoch) throw new SiteError('cancelled', '请求已取消。'); }
  private save(epoch: number): Promise<void> {
    const snapshot = JSON.stringify({ version: 1, browser: this.useBrowser, username: this.auth.username, authenticated: this.hadSession, pendingLogout: this.pendingLogout, jar: this.direct.jar.serializeSync() });
    const work = this.writes.catch(() => {}).then(async () => { if (epoch === this.epoch) await this.secrets.store(SESSION_KEY, snapshot); });
    this.writes = work; return work;
  }
  async restore(): Promise<void> {
    const epoch = this.epoch;
    let stored: string | undefined;
    try { stored = await this.secrets.get(SESSION_KEY); } catch { return; }
    this.checkEpoch(epoch); if (!stored) return;
    try {
      const value = JSON.parse(stored);
      if (value.version !== 1 || typeof value.browser !== 'boolean' || !value.jar) throw new Error();
      this.direct.jar = CookieJar.deserializeSync(value.jar);
      this.useBrowser = value.browser; this.hadSession = !!value.authenticated;
      if (value.pendingLogout) {
        this.pendingLogout = true;
        await this.logout();
        return;
      }
      if (!this.hadSession) return;
      this.setAuth({ status: 'restoring', username: typeof value.username === 'string' ? value.username : undefined });
    } catch (error) {
      if (this.pendingLogout) throw error;
      await this.secrets.delete(SESSION_KEY); this.direct.jar = new CookieJar(); return;
    }
    // Revalidate before reporting a saved account as logged in.
    try {
      if (this.useBrowser) await this.browser.openVerification();
      this.checkEpoch(epoch);
      await this.confirmSession(epoch, this.auth.username);
    } catch (error) {
      if (epoch !== this.epoch) return;
      if (error instanceof SiteError && error.code === 'verification') this.setAuth({ status: 'verification' });
      else if (error instanceof SiteError && error.code === 'login') this.setAuth({ status: 'expired' });
      else this.setAuth({ status: 'expired' });
    }
  }
  private async request(url: string, options?: RequestOptions, validate = true): Promise<Page> {
    if (this.loggingOut || this.pendingLogout) throw new SiteError('cancelled', '请先完成退出登录，再重试。');
    const epoch = this.epoch;
    allowedUrl(url);
    try {
      const page = await (this.useBrowser ? this.browser.request(url, options) : this.direct.request(url, options));
      this.checkEpoch(epoch); allowedUrl(page.url);
      // Challenge pages may use 200, 403 or 503. Detect them before generic HTTP errors.
      try { assertPage(page.html); } catch (error) {
        if (error instanceof SiteError && error.code === 'verification') throw error;
        if (validate) throw error;
      }
      if (page.status === 403) throw new SiteError('verification', '网站拒绝了直接访问（HTTP 403）。请在 VS Code 内完成验证后重试。');
      if (page.status >= 400) throw new Error(`网站返回 HTTP ${page.status}。`);
      await this.save(epoch); this.checkEpoch(epoch); return page;
    } catch (error) {
      this.checkEpoch(epoch);
      if (error instanceof SiteError) {
        if (error.code === 'verification') { this.challengeUrl = options?.method === 'POST' ? `${ORIGIN}/login.php` : url; this.setAuth({ status: 'verification' }); }
        if (error.code === 'login') this.setAuth({ status: this.hadSession ? 'expired' : 'loggedOut' });
      }
      throw error;
    }
  }
  async read(url: string): Promise<Page> { return this.request(url); }
  async login(username: string, password: string): Promise<void> {
    username = username.trim();
    if (!username || !password || username.length > 30 || password.length > 30) throw new Error('请输入 1–30 个字符的账号和密码。');
    if ([username, password].some(value => iconv.decode(iconv.encode(value, 'gbk'), 'gbk') !== value)) throw new Error('账号或密码包含网站 GBK 编码不支持的字符。');
    if (this.loggingOut || this.pendingLogout) throw new Error('请先完成退出登录，再重新登录。');
    if (this.loginPending) throw new Error('正在登录，请稍候。');
    const epoch = this.epoch; this.loginPending = true;
    this.setAuth({ status: 'loggingIn' });
    try {
      const formPage = await this.request(`${ORIGIN}/login.php`, undefined, false);
      if (loggedIn(formPage.html)) { await this.confirmSession(epoch); return; }
      const form = parseLoginForm(formPage.html);
      const body = encodeForm({ ...form.fields, username, password });
      password = '';
      const result = await this.request(form.url, { method: 'POST', body }, false);
      this.checkEpoch(epoch);
      // A successful-looking submission alone is insufficient; validate a protected page.
      if (!loggedIn(result.html) && /input[^>]+name=["']password["']/.test(result.html)) throw new SiteError('credentials', loginFailure(result.html));
      await this.confirmSession(epoch, username);
    } catch (error) {
      if (epoch === this.epoch) {
        if (error instanceof SiteError && error.code === 'verification') this.setAuth({ status: 'verification' });
        else this.setAuth({ status: 'loggedOut' });
      }
      if (error instanceof SiteError && error.code === 'login') throw new SiteError('credentials', '登录失败，请检查账号或密码后重试。');
      throw error;
    } finally { password = ''; this.loginPending = false; }
  }
  private async confirmSession(epoch: number, username?: string): Promise<void> {
    const page = await this.request(`${ORIGIN}/index.php`, undefined, false);
    this.checkEpoch(epoch);
    if (!loggedIn(page.html)) {
      this.setAuth({ status: this.hadSession ? 'expired' : 'loggedOut' });
      throw new SiteError('login', '尚未登录或登录会话已过期，请输入账号密码登录。');
    }
    this.hadSession = true;
    this.setAuth({ status: 'loggedIn', username: username || '文库吧账号' });
    this.clear(); await this.save(epoch); this.checkEpoch(epoch);
  }
  async openVerification(): Promise<void> {
    if (this.loggingOut || this.pendingLogout) throw new Error('请先完成退出登录。');
    this.setAuth({ status: 'verification' });
    const epoch = this.epoch;
    await this.browser.openVerification(this.challengeUrl); this.checkEpoch(epoch);
    this.useBrowser = true; await this.save(epoch);
  }
  async continueVerification(): Promise<void> {
    const epoch = this.epoch;
    if (!this.useBrowser || !this.browser.active) throw new SiteError('verification', '请先打开 VS Code 网站验证页，完成验证后再继续。');
    // Reading the login page first gives a useful challenge error without guessing completion.
    await this.request(`${ORIGIN}/login.php`, undefined, false); this.checkEpoch(epoch);
    try { await this.confirmSession(epoch, this.auth.username); }
    catch (error) {
      if (!(error instanceof SiteError) || error.code !== 'login') throw error;
      this.setAuth({ status: 'loggedOut' });
    }
    this.clear();
  }
  logout(): Promise<void> {
    if (!this.logoutTask) this.logoutTask = this.clearSession().finally(() => { this.logoutTask = undefined; });
    return this.logoutTask;
  }
  private async clearSession(): Promise<void> {
    this.loggingOut = true;
    const needsBrowser = this.useBrowser || this.pendingLogout;
    this.epoch++; this.direct.cancel();
    try {
      await this.browser.cancel();
      this.direct.jar = new CookieJar(); this.clear(); this.hadSession = false;
      this.setAuth({ status: 'loggedOut' });
      await this.writes.catch(() => {}); await this.secrets.delete(SESSION_KEY);
      if (needsBrowser) await this.browser.clearCookies();
      this.pendingLogout = false; this.useBrowser = false;
    } catch {
      this.pendingLogout = needsBrowser;
      await this.save(this.epoch);
      throw new Error('本地登录已清除，但未能清除 VS Code 网站会话。请执行「Wenku8: 退出登录」重试。');
    } finally {
      this.browser.dispose(); this.loggingOut = false;
    }
  }
  async catalog(id: number): Promise<Catalog> {
    const cached = this.catalogs.get(id); if (cached) return cached;
    const epoch = this.epoch, page = await this.read(catalogUrl(id)); this.checkEpoch(epoch);
    const catalog = parseCatalog(page.html, { id, title: String(id) }, page.url);
    if (this.catalogs.size >= 30) this.catalogs.delete(this.catalogs.keys().next().value!);
    this.catalogs.set(id, catalog); return catalog;
  }
  async chapter(url: string): Promise<Content> {
    const cached = this.contents.get(url); if (cached) return cached;
    const epoch = this.epoch, page = await this.read(url); this.checkEpoch(epoch);
    const result = parseContent(page.html);
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
  dispose(): void { this.epoch++; this.direct.cancel(); this.browser.dispose(); }
}
