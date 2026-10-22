import * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';
import { CdpConnection } from './cdp';
import { ORIGIN, Page, siteUrl } from './model';
import { DirectHttp, RequestOptions, SessionStore, Transport, isChallenge } from './network';
import { COVER } from './reader';

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const VERIFICATION = '网站需要安全验证。请执行 Wenku8: 在 VS Code 内验证，在验证页完成后执行 Wenku8: 验证完成。';

/** Uses the browser already bundled with desktop VS Code, only after explicit verification. */
export class NativeSession {
  private cdp?: CdpConnection;
  private root?: vscode.DebugSession;
  private resource?: vscode.Uri;
  private starting?: Promise<void>;
  private listeners: vscode.Disposable[] = [];
  private ready = false;
  private disposed = false;
  private epoch = 0;
  get active() { return !!this.cdp && this.ready; }
  get connected() { return !!this.cdp; }
  async verify() {
    this.ready = false; this.epoch++;
    if (!this.starting) this.starting = this.open().finally(() => { this.starting = undefined; });
    await this.starting;
    await this.cdp!.send('Page.setBypassCSP', { enabled: false });
    await this.cdp!.send('Page.navigate', { url: `${ORIGIN}/login.php` });
    this.ready = false;
    if (this.resource) await vscode.commands.executeCommand('vscode.open', this.resource);
  }
  private async open() {
    if (this.disposed) throw new Error('插件会话已关闭。');
    if (this.cdp) return;
    if (this.root) await vscode.debug.stopDebugging(this.root);
    for (const listener of this.listeners) listener.dispose(); this.listeners = [];
    const token = randomUUID();
    let child: vscode.DebugSession | undefined;
    this.listeners.push(vscode.debug.onDidStartDebugSession(session => {
      if (session.configuration.__workspaceNotes === token && !session.parentSession) this.root = session;
      if (session.parentSession && (session.parentSession.configuration.__workspaceNotes === token || (this.root && session.parentSession.id === this.root.id))) child = session;
    }));
    this.listeners.push(vscode.debug.onDidTerminateDebugSession(session => {
      if (session.id === this.root?.id || session.id === child?.id) { this.cdp?.dispose(); this.cdp = undefined; this.ready = false; }
    }));
    try {
      const launched = await vscode.debug.startDebugging(undefined, {
        type: 'editor-browser', request: 'launch', name: 'Workspace Notes Session', url: 'about:blank',
        __workspaceNotes: token, sourceMaps: false, trace: false, internalConsoleOptions: 'neverOpen', timeout: 20000
      }, { suppressDebugToolbar: true, suppressDebugStatusbar: true, suppressDebugView: true, suppressSaveBeforeStart: true });
      if (!launched) throw new Error('无法启动 VS Code 内置浏览器，请使用桌面版 VS Code 1.142 或更新版本，并启用内置 JavaScript Debugger。');
      const until = Date.now() + 20000;
      while (!child && Date.now() < until && !this.disposed) await pause(50);
      if (!child || this.disposed) throw new Error('VS Code 内置浏览器未就绪。');
      const cdp = new CdpConnection();
      await cdp.connect(await child.customRequest('requestCDPProxy'));
      if (this.disposed) { cdp.dispose(); throw new Error('插件会话已关闭。'); }
      this.cdp = cdp;
      cdp.onClose = () => { if (this.cdp === cdp) { this.cdp = undefined; this.ready = false; } };
      const requests = new Set<string>();
      cdp.onEvent = (method, params) => {
        if (method === 'Network.loadingFinished' || method === 'Network.loadingFailed') { requests.delete(params.requestId); return; }
        if (method !== 'Fetch.requestPaused') return;
        const own = Object.keys(params.request.headers).some(k => k.toLowerCase() === 'x-workspace-notes') || requests.has(params.networkId);
        let allowed = true;
        if (own) {
          if (params.networkId) requests.add(params.networkId);
          try {
            siteUrl(params.request.url, params.request.method === 'POST');
            if ([301,302,303,307,308].includes(params.responseStatusCode)) {
              const location = params.responseHeaders?.find((h: { name: string }) => h.name.toLowerCase() === 'location')?.value;
              if (location) siteUrl(new URL(location, params.request.url).href, [307,308].includes(params.responseStatusCode) && params.request.method === 'POST');
            }
          } catch { allowed = false; }
        }
        void cdp.send(allowed ? 'Fetch.continueRequest' : 'Fetch.failRequest', { requestId: params.requestId, ...(!allowed ? { errorReason: 'BlockedByClient' } : {}) }).catch(() => {});
      };
      await cdp.send('JsDebug.subscribe', { events: ['Fetch.requestPaused', 'Network.loadingFinished', 'Network.loadingFailed'] });
      await cdp.send('Fetch.enable', { patterns: ['Request','Response'].map(requestStage => ({ urlPattern: '*', resourceType: 'Fetch', requestStage })) });
      const { targetInfo } = await cdp.send('Target.getTargetInfo');
      const id = targetInfo?.vscodeBrowserViewId;
      if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/i.test(id)) throw new Error('当前 VS Code 未提供可识别的内置浏览器页签。');
      this.resource = vscode.Uri.from({ scheme: 'vscode-browser', path: `/${id}` });
    } catch (error) {
      this.cdp?.dispose(); this.cdp = undefined;
      if (this.root) await vscode.debug.stopDebugging(this.root);
      this.root = undefined; throw error;
    }
  }
  private async evaluate<T>(expression: string): Promise<T> {
    if (!this.cdp) throw new Error('网站会话已关闭，请重新在 VS Code 内验证。');
    const result = await this.cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails || !result.result || result.result.value === undefined) {
      const reason = result.exceptionDetails?.exception?.description?.split('\n')[0] ?? result.exceptionDetails?.text ?? '';
      throw new Error(`网站会话读取失败，请重新完成验证。${reason ? ` (${reason})` : ''}`);
    }
    return result.result.value as T;
  }
  private snapshot() {
    return this.evaluate<Page>('({url:location.href,status:200,html:document.documentElement.outerHTML})');
  }
  async completeVerification() {
    const page = await this.snapshot();
    if (new URL(page.url).origin !== ORIGIN || isChallenge(page)) throw new Error('安全验证尚未完成，请先在 VS Code 验证页中完成操作。');
    // 导航到同源的无脚本资源，卸载登录页及广告脚本；该页面仅作为网络会话。
    await this.cdp!.send('Page.navigate', { url: `${ORIGIN}/robots.txt` });
    const until = Date.now() + 12000;
    let stable = false;
    while (Date.now() < until) {
      const info = await this.evaluate<{ url: string; loading: string }>('({url:location.href,loading:document.readyState})').catch(() => undefined);
      if (info?.url === `${ORIGIN}/robots.txt` && info.loading === 'complete') { stable = true; break; }
      await pause(100);
    }
    if (!stable || isChallenge(await this.snapshot())) throw new Error('网站会话尚未就绪，请重新完成验证。');
    // robots.txt 可能带响应级 CSP；仅对这个已替换为本地代码的会话页开放调试请求。
    await this.cdp!.send('Page.setBypassCSP', { enabled: true });
    this.ready = true;
    await this.conceal();
  }
  async conceal() {
    if (!this.cdp) return;
    const light = vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.Light || vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.HighContrastLight;
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>session.ts</title><meta http-equiv="Content-Security-Policy" content="default-src 'none'; connect-src ${ORIGIN}; style-src 'unsafe-inline'"><style>body{margin:0;padding:24px 32px;background:${light ? '#ffffff' : '#1f1f1f'};color:${light ? '#3b3b3b' : '#cccccc'};font:14px/1.8 monospace;white-space:pre-wrap}</style></head><body>${COVER.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</body></html>`;
    const { frameTree } = await this.cdp.send('Page.getFrameTree');
    await this.cdp.send('Page.stopLoading');
    await this.cdp.send('Page.setDocumentContent', { frameId: frameTree.frame.id, html });
  }
  async page(input: string, options: RequestOptions = {}): Promise<Page> {
    const url = siteUrl(input, options.body !== undefined).href;
    if (!this.active) throw new Error(VERIFICATION);
    const epoch = this.epoch;
    const result = await this.evaluate<Page>(`(async () => {
      if (location.origin !== ${JSON.stringify(ORIGIN)}) throw new Error('origin');
      const controller = new AbortController(); (globalThis.__notesRequests ??= new Set()).add(controller);
      try {
      const response = await fetch(${JSON.stringify(url)}, {method:${JSON.stringify(options.body === undefined ? 'GET' : 'POST')},${options.body === undefined ? '' : `body:${JSON.stringify(options.body)},`}headers:{'X-Workspace-Notes':'1',${options.body === undefined ? '' : "'Content-Type':'application/x-www-form-urlencoded',"}},credentials:'same-origin',redirect:'follow',signal:AbortSignal.any([controller.signal,AbortSignal.timeout(18000)])});
      const bytes = await response.arrayBuffer(); if (bytes.byteLength > 4000000) throw new Error('size');
      return {url:response.url,status:response.status,html:new TextDecoder(/charset\\s*=\\s*["']?utf-?8/i.test(response.headers.get('content-type') || '') ? 'utf-8' : 'gbk').decode(bytes)};
      } finally { globalThis.__notesRequests.delete(controller); }
    })()`);
    if (epoch !== this.epoch) throw new Error('请求已取消。');
    siteUrl(result.url, result.url.includes('/login.php?do=submit'));
    if (isChallenge(result)) { this.ready = false; throw new Error(VERIFICATION); }
    return result;
  }
  async clear() {
    this.ready = false; this.epoch++;
    if (!this.cdp) {
      // 创建会话是为了清除此站持久 Cookie，不导航网站。
      await this.open();
    }
    await this.evaluate("(() => { globalThis.__notesRequests?.forEach(c => c.abort()); globalThis.__notesRequests?.clear(); return true; })()");
    const { cookies } = await this.cdp!.send('Network.getCookies', { urls: [`${ORIGIN}/`, `${ORIGIN}/login.php`, `${ORIGIN}/modules/article/search.php`] });
    for (const cookie of cookies ?? []) if (/^(?:\.)?(?:www\.)?wenku8\.net$/.test(cookie.domain)) await this.cdp!.send('Network.deleteCookies', { name: cookie.name, domain: cookie.domain, path: cookie.path });
    this.ready = false; await this.conceal();
  }
  dispose() {
    this.disposed = true; this.epoch++; this.ready = false; this.cdp?.dispose(); this.cdp = undefined;
    for (const listener of this.listeners) listener.dispose(); this.listeners = [];
    const root = this.root; this.root = undefined;
    if (root) void vscode.debug.stopDebugging(root);
  }
}

export class SiteTransport implements Transport {
  private readonly direct: DirectHttp;
  constructor(secrets: SessionStore, private readonly native = new NativeSession()) { this.direct = new DirectHttp(secrets); }
  async page(url: string, options?: RequestOptions) {
    if (this.native.active) return this.native.page(url, options);
    const result = await this.direct.page(url, options);
    if (isChallenge(result)) throw new Error(VERIFICATION);
    return result;
  }
  verify() { return this.native.verify(); }
  completeVerification() { return this.native.completeVerification(); }
  conceal() { return this.native.conceal(); }
  async updateTheme() { if (this.native.active) await this.native.conceal(); }
  async clear() { await this.direct.clear(); await this.native.clear(); }
  dispose() { this.direct.dispose(); this.native.dispose(); }
}
