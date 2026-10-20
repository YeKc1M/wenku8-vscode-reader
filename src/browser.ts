import * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';
import { CdpConnection } from './cdp';
import { ORIGIN, allowedUrl } from './model';
import { BrowserTransport, Page, RequestOptions, SiteError } from './network';

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
export class BrowserSession implements BrowserTransport {
  private connection?: CdpConnection;
  private root?: vscode.DebugSession;
  private connecting?: Promise<void>;
  private epoch = 0;
  private disposables: vscode.Disposable[] = [];
  get active(): boolean { return !!this.connection; }
  async openVerification(url = `${ORIGIN}/login.php`): Promise<void> {
    allowedUrl(url);
    if (this.connection) { await this.connection.send('Page.navigate', { url }); return; }
    if (!this.connecting) this.connecting = this.open(url).finally(() => { this.connecting = undefined; });
    return this.connecting;
  }
  private async open(url: string): Promise<void> {
    this.disposeListeners();
    const epoch = this.epoch, token = randomUUID();
    let child: vscode.DebugSession | undefined;
    const starts = vscode.debug.onDidStartDebugSession(session => {
      if (session.configuration.__wenku8Session === token && !session.parentSession) this.root = session;
      if (this.root && session.parentSession?.id === this.root.id) child = session;
    });
    const ends = vscode.debug.onDidTerminateDebugSession(session => {
      if (session.id === this.root?.id || session.id === child?.id) { this.connection?.dispose(); this.connection = undefined; }
    });
    this.disposables.push(starts, ends);
    try {
      const ok = await vscode.debug.startDebugging(undefined, {
        type: 'editor-browser', request: 'launch', name: 'Wenku8 · 网站验证', url,
        __wenku8Session: token, sourceMaps: false, trace: false, timeout: 20000, internalConsoleOptions: 'neverOpen'
      }, { suppressDebugStatusbar: true, suppressDebugToolbar: true, suppressDebugView: true, suppressSaveBeforeStart: true });
      if (!ok) throw new Error('无法打开 VS Code 内置浏览器。请使用桌面版 VS Code 1.142 或更新版本，并启用内置 JavaScript Debugger。');
      const deadline = Date.now() + 20000;
      while (!child && Date.now() < deadline && epoch === this.epoch) await delay(100);
      if (epoch !== this.epoch) throw new SiteError('cancelled', '请求已取消。');
      if (!child) throw new Error('内置浏览器启动超时，请重试。');
      const connection = new CdpConnection();
      await connection.connect(await child.customRequest('requestCDPProxy'));
      if (epoch !== this.epoch) { connection.dispose(); throw new SiteError('cancelled', '请求已取消。'); }
      this.connection = connection;
      connection.onClose = () => { if (this.connection === connection) this.connection = undefined; };
      // Stop extension requests and their redirects before sending data to a foreign address.
      const requests = new Set<string>();
      connection.onEvent = (method, params) => {
        if (method === 'Network.loadingFinished' || method === 'Network.loadingFailed') { requests.delete(params.requestId); return; }
        if (method !== 'Fetch.requestPaused') return;
        const own = Object.keys(params.request.headers).some(k => k.toLowerCase() === 'x-wenku8-reader') || requests.has(params.networkId);
        let permitted = true;
        if (own) { if (params.networkId) requests.add(params.networkId); try { allowedUrl(params.request.url); } catch { permitted = false; } }
        void connection.send(permitted ? 'Fetch.continueRequest' : 'Fetch.failRequest', { requestId: params.requestId, ...(!permitted ? { errorReason: 'BlockedByClient' } : {}) }).catch(() => {});
      };
      await connection.send('JsDebug.subscribe', { events: ['Fetch.requestPaused', 'Network.loadingFinished', 'Network.loadingFailed'] });
      await connection.send('Fetch.enable', { patterns: [{ urlPattern: '*', resourceType: 'Fetch', requestStage: 'Request' }] });
    } catch (error) {
      this.connection?.dispose(); this.connection = undefined;
      if (this.root) await vscode.debug.stopDebugging(this.root);
      this.root = undefined; this.disposeListeners(); throw error;
    } finally { starts.dispose(); }
  }
  async request(url: string, options: RequestOptions = {}): Promise<Page> {
    allowedUrl(url);
    const connection = this.connection;
    if (!connection) throw new SiteError('verification', '请在 VS Code 内打开网站验证页，完成后点击「验证完成，继续」。');
    const epoch = this.epoch;
    // Use the local CDP channel instead of putting credentials in the debug console.
    const expression = `(async()=>{
      if(location.origin!==${JSON.stringify(ORIGIN)})throw new Error('origin');
      const controller=new AbortController();(globalThis.__wenku8Requests??=new Set()).add(controller);
      try{
        const r=await fetch(${JSON.stringify(url)},{method:${JSON.stringify(options.method ?? 'GET')},${options.body === undefined ? '' : `body:${JSON.stringify(options.body)},`}credentials:'include',cache:'no-store',redirect:'follow',signal:AbortSignal.any([controller.signal,AbortSignal.timeout(15000)]),headers:{'X-Wenku8-Reader':'1',${options.body === undefined ? '' : "'Content-Type':'application/x-www-form-urlencoded',"}'Accept':'text/html'}});
        const reader=r.body?.getReader();const chunks=[];let size=0;
        try{if(reader)for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>8388608)throw new Error('size');chunks.push(value);}}finally{await reader?.cancel().catch(()=>{});}
        const bytes=new Uint8Array(size);let offset=0;for(const c of chunks){bytes.set(c,offset);offset+=c.length;}
        const utf=/charset\\s*=\\s*["']?utf-?8/i.test(r.headers.get('content-type')+' '+new TextDecoder().decode(bytes.slice(0,2048)));
        return {html:new TextDecoder(utf?'utf-8':'gbk').decode(bytes),url:r.url,status:r.status};
      }finally{globalThis.__wenku8Requests.delete(controller);}
    })()`;
    const result = await connection.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (epoch !== this.epoch) throw new SiteError('cancelled', '请求已取消。');
    if (result.exceptionDetails) throw new Error('内置浏览器读取失败：请确认验证已完成、页面未跳转到其他网站，然后重试。');
    const value = result.result?.value as Page | undefined;
    if (!value || typeof value.html !== 'string' || typeof value.url !== 'string') throw new Error('内置浏览器未返回页面。');
    allowedUrl(value.url); return value;
  }
  async cancel(): Promise<void> {
    this.epoch++;
    await this.connection?.send('Runtime.evaluate', { expression: 'globalThis.__wenku8Requests?.forEach(c=>c.abort());globalThis.__wenku8Requests?.clear();', returnByValue: true }).catch(() => {});
  }
  async clearCookies(): Promise<void> {
    // Reopen a closed tab to clear this site's persistent cookies too.
    if (!this.connection) await this.openVerification();
    await this.cancel();
    const result = await this.connection!.send('Network.getCookies', { urls: [`${ORIGIN}/`, `${ORIGIN}/login.php`, `${ORIGIN}/modules/article/search.php`] });
    for (const cookie of result.cookies ?? []) {
      if (!['wenku8.net', '.wenku8.net', 'www.wenku8.net', '.www.wenku8.net'].includes(cookie.domain)) continue;
      await this.connection!.send('Network.deleteCookies', { name: cookie.name, domain: cookie.domain, path: cookie.path });
    }
    await this.connection!.send('Page.navigate', { url: `${ORIGIN}/login.php` });
  }
  private disposeListeners(): void { for (const disposable of this.disposables) disposable.dispose(); this.disposables = []; }
  dispose(): void {
    this.epoch++; this.connection?.dispose(); this.connection = undefined;
    const root = this.root; this.root = undefined;
    if (root) void vscode.debug.stopDebugging(root);
    this.disposeListeners();
  }
}
