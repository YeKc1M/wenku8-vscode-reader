import WebSocket from 'ws';
import { spawn } from 'node:child_process';
import { access, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { ORIGIN } from './model';

async function localJson(port: number, path: string, method = 'GET'): Promise<any> {
  const r = await fetch(`http://127.0.0.1:${port}${path}`, { method, signal: AbortSignal.timeout(2500) });
  if (!r.ok) throw new Error('Chrome 调试接口不可用。');
  return r.json();
}
export class BrowserSession {
  private socket?: WebSocket;
  private port?: number;
  private nextId = 0;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private connecting?: Promise<void>;
  private send(method: string, params: object = {}): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('浏览器请求超时，请在 Chrome 中完成验证后重试。')); }, 25000);
      this.pending.set(id, { resolve, reject, timer });
      this.socket!.send(JSON.stringify({ id, method, params }), err => { if (err) { clearTimeout(timer); this.pending.delete(id); reject(err); } });
    });
  }
  private async attach(port: number): Promise<void> {
    if (this.socket?.readyState === WebSocket.OPEN && this.port === port) return;
    this.dispose();
    const pages = await localJson(port, '/json/list');
    let page = pages.find((p: any) => p.type === 'page' && typeof p.url === 'string' && p.url.startsWith(ORIGIN + '/'));
    if (!page) page = await localJson(port, `/json/new?${encodeURIComponent(ORIGIN + '/book/1.htm')}`, 'PUT');
    const endpoint = new URL(page.webSocketDebuggerUrl);
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname) || endpoint.protocol !== 'ws:') throw new Error('Chrome 调试接口必须位于本机。');
    endpoint.hostname = '127.0.0.1';
    const socket = new WebSocket(endpoint.href, { handshakeTimeout: 5000, maxPayload: 16 * 1024 * 1024 });
    this.socket = socket;
    this.port = port;
    socket.on('message', raw => {
      const response = JSON.parse(raw.toString());
      const p = this.pending.get(response.id);
      if (!p) return;
      clearTimeout(p.timer); this.pending.delete(response.id);
      if (response.error) p.reject(new Error(response.error.message)); else p.resolve(response.result);
    });
    const disconnected = () => {
      if (this.socket !== socket) return;
      for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('Chrome 连接已断开，请重新连接。')); }
      this.pending.clear();
    };
    socket.on('close', disconnected);
    socket.on('error', disconnected);
    await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
    for (let i = 0; i < 30; i++) {
      const r = await this.send('Runtime.evaluate', { expression: 'location.origin', returnByValue: true });
      if (r.result?.value === ORIGIN) return;
      await new Promise(r => setTimeout(r, 200));
    }
    throw new Error('请等待 Chrome 打开文库吧页面后重试。');
  }
  async connect(port: number): Promise<void> {
    if (!this.connecting) this.connecting = this.attach(port).finally(() => { this.connecting = undefined; });
    return this.connecting;
  }
  async read(url: string, port: number): Promise<{ html: string; url: string }> {
    await this.connect(port);
    const expression = String.raw`(async()=>{if(location.origin!==${JSON.stringify(ORIGIN)})throw new Error('请在 Chrome 中打开文库吧页面');const r=await fetch(${JSON.stringify(url)},{credentials:'include',signal:AbortSignal.timeout(20000)});const b=await r.arrayBuffer();if(b.byteLength>8388608)throw new Error('页面过大');const bytes=new Uint8Array(b);const head=new TextDecoder().decode(bytes.slice(0,2048));const utf=/charset\s*=\s*["']?utf-?8/i.test(r.headers.get('content-type')+' '+head);return {html:new TextDecoder(utf?'utf-8':'gbk').decode(bytes),url:r.url,status:r.status};})()`;
    const result = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description?.split('\n')[0] ?? '浏览器读取失败，请完成登录或验证后重试。');
    const value = result.result?.value;
    if (!value || typeof value.html !== 'string') throw new Error('浏览器未返回页面。');
    if (value.status >= 400) throw new Error(`网站返回 HTTP ${value.status}，请在 Chrome 中完成验证后重试。`);
    return value;
  }
  dispose(): void {
    this.socket?.close(); this.socket = undefined;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('浏览器连接已关闭。')); }
    this.pending.clear();
  }
}
export async function launchBrowser(port: number, storage: string): Promise<void> {
  try { await localJson(port, '/json/version'); return; } catch { /* start a dedicated browser profile */ }
  const candidates = process.platform === 'darwin'
    ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge']
    : process.platform === 'win32'
      ? [join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Google/Chrome/Application/chrome.exe'), join(process.env.LOCALAPPDATA || '', 'Google/Chrome/Application/chrome.exe'), join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Microsoft/Edge/Application/msedge.exe')]
      : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/opt/google/chrome/chrome'];
  let executable: string | undefined;
  for (const candidate of candidates) { try { await access(candidate); executable = candidate; break; } catch { /* next */ } }
  if (!executable) throw new Error('未找到 Chrome。请安装 Chrome，或手动以 --remote-debugging-port 启动后重新连接。');
  await mkdir(storage, { recursive: true });
  const child = spawn(executable, [`--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1', `--user-data-dir=${join(storage, 'chrome-profile')}`, '--no-first-run', '--no-default-browser-check', `${ORIGIN}/book/1.htm`], { detached: true, stdio: 'ignore' });
  let spawnError: Error | undefined;
  child.on('error', err => { spawnError = err; });
  child.unref();
  for (let i = 0; i < 40; i++) {
    if (spawnError) throw spawnError;
    try { await localJson(port, '/json/version'); return; } catch { await new Promise(r => setTimeout(r, 250)); }
  }
  throw new Error('Chrome 启动超时，请检查调试端口是否被占用。');
}
