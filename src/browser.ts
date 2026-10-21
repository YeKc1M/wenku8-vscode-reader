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
  private verificationTab?: vscode.Tab;
  private verificationGroup?: vscode.TabGroup;
  private verificationUri?: vscode.Uri;
  private movingWindow = false;
  private closing?: Promise<void>;
  private epoch = 0;
  private disposables: vscode.Disposable[] = [];
  get active(): boolean { return !!this.connection; }
  async openVerification(url = `${ORIGIN}/login.php`): Promise<void> {
    allowedUrl(url);
    if (!this.connecting) this.connecting = (async () => {
      if (this.connection) {
        await this.connection.send('Page.navigate', { url });
        await this.moveVerificationToWindow();
      } else await this.open(url);
    })().finally(() => { this.connecting = undefined; });
    return this.connecting;
  }
  private async moveVerificationToWindow(): Promise<void> {
    if (!this.verificationUri) throw new Error('无法定位网站验证页，请重试。');
    const original = this.verificationTab;
    const groups = new Set(vscode.window.tabGroups.all);
    this.movingWindow = true;
    try {
      // The URI targets only our browser even when the user is editing another
      // file. Rehosting also restores a minimized verification window: VS Code's
      // focus commands alone do not reliably restore auxiliary windows. The same
      // browser/CDP session survives, and the old empty auxiliary window closes.
      await vscode.commands.executeCommand('workbench.action.moveEditorToNewWindow', this.verificationUri);
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const newGroups = vscode.window.tabGroups.all.filter(group => !groups.has(group));
        const originalStillOpen = original && vscode.window.tabGroups.all.some(group => groups.has(group) && group.tabs.includes(original));
        if (newGroups.length === 1 && newGroups[0].tabs.length === 1 && newGroups[0].activeTab?.input === undefined && !originalStillOpen) {
          this.verificationTab = newGroups[0].activeTab;
          this.verificationGroup = newGroups[0];
          return;
        }
        await delay(50);
      }
    } catch { /* Report the placement failure, rather than claiming it is hidden. */ }
    finally { this.movingWindow = false; }
    throw new Error('无法将网站验证页移到独立窗口，请重试。');
  }
  private async open(url: string): Promise<void> {
    const epoch = this.epoch;
    await this.closing;
    const previousRoot = this.root; this.root = undefined;
    if (previousRoot) await vscode.debug.stopDebugging(previousRoot);
    if (epoch !== this.epoch) throw new SiteError('cancelled', '请求已取消。');
    this.disposeListeners();
    this.verificationTab = undefined; this.verificationGroup = undefined; this.verificationUri = undefined;
    const token = randomUUID();
    let child: vscode.DebugSession | undefined;
    const starts = vscode.debug.onDidStartDebugSession(session => {
      if (session.configuration.__wenku8Session === token && !session.parentSession) this.root = session;
      if (this.root && session.parentSession?.id === this.root.id) child = session;
    });
    const ends = vscode.debug.onDidTerminateDebugSession(session => {
      if (session.id === this.root?.id || session.id === child?.id) { this.connection?.dispose(); this.connection = undefined; }
    });
    this.disposables.push(starts, ends);
    this.disposables.push(vscode.window.tabGroups.onDidChangeTabGroups(event => {
      if (this.movingWindow || !this.verificationGroup || !event.closed.includes(this.verificationGroup)) return;
      // Closing an auxiliary window normally returns its editors to the main
      // window. Stop our browser as well so a website tab is not left there.
      this.connection?.dispose(); this.connection = undefined;
      this.verificationTab = undefined; this.verificationGroup = undefined; this.verificationUri = undefined;
      const root = this.root; this.root = undefined;
      if (root) this.closing = Promise.resolve(vscode.debug.stopDebugging(root)).then(() => undefined, () => {
        void vscode.window.showErrorMessage('未能停止网站验证会话，请手动关闭残留的网站标签。');
      });
    }));
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
      // VS Code adds this ID to CDP target metadata. Like requestCDPProxy, it is
      // an internal integration; fail explicitly if a future version changes it.
      const { targetInfo } = await connection.send('Target.getTargetInfo');
      const viewId: unknown = targetInfo?.vscodeBrowserViewId;
      if (typeof viewId !== 'string' || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(viewId)) throw new Error('VS Code 未返回验证页标识，无法移到独立窗口。');
      this.verificationUri = vscode.Uri.from({ scheme: 'vscode-browser', path: `/${viewId}` });
      await this.moveVerificationToWindow();
      if (epoch !== this.epoch) throw new SiteError('cancelled', '请求已取消。');
    } catch (error) {
      this.connection?.dispose(); this.connection = undefined;
      if (this.root) await vscode.debug.stopDebugging(this.root);
      this.root = undefined; this.verificationTab = undefined; this.verificationGroup = undefined; this.verificationUri = undefined; this.disposeListeners(); throw error;
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
    const tab = this.verificationTab;
    this.verificationTab = undefined; this.verificationGroup = undefined; this.verificationUri = undefined;
    const root = this.root; this.root = undefined;
    this.disposeListeners();
    if (tab || root) this.closing = (async () => {
      try {
        if (tab && vscode.window.tabGroups.all.some(group => group.tabs.includes(tab))) await vscode.window.tabGroups.close(tab, true);
      } finally { if (root) await vscode.debug.stopDebugging(root); }
    })().then(() => undefined, () => {
      void vscode.window.showErrorMessage('未能关闭网站验证会话，请手动关闭残留的网站标签。');
    });
  }
}
