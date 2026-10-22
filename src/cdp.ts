type Pending = { resolve(value: any): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> };
/** A private, short-lived channel provided by VS Code's bundled JavaScript debugger. */
export class CdpConnection {
  private socket?: WebSocket;
  private sequence = 0;
  private pending = new Map<number, Pending>();
  onClose?: () => void;
  onEvent?: (method: string, params: any) => void;
  async connect(address: { host: string; port: number; path: string }) {
    if (!['127.0.0.1', 'localhost', '::1'].includes(address.host) || !Number.isInteger(address.port) || address.port < 1 || address.port > 65535 || !/^\/[a-f0-9]+$/i.test(address.path)) throw new Error('VS Code 会话地址无效。');
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}${address.path}`);
    this.socket = socket;
    socket.addEventListener('message', event => {
      try {
        if (typeof event.data !== 'string' || event.data.length > 20_000_000) throw new Error('响应过大。');
        const message = JSON.parse(event.data);
        if (message.method) { this.onEvent?.(message.method, message.params); return; }
        const pending = this.pending.get(message.id);
        if (!pending) return;
        clearTimeout(pending.timer); this.pending.delete(message.id);
        if (message.error) pending.reject(new Error('VS Code 网站会话操作失败。'));
        else pending.resolve(message.result);
      } catch { this.dispose(); }
    });
    socket.addEventListener('close', () => { if (this.socket === socket) this.dispose(); });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { socket.close(); reject(new Error('VS Code 网站会话连接超时。')); }, 10000);
      socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('VS Code 网站会话连接失败。')); }, { once: true });
    });
  }
  send(method: string, params: object = {}): Promise<any> {
    if (this.socket?.readyState !== WebSocket.OPEN) return Promise.reject(new Error('网站会话已关闭，请重试。'));
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('网站会话响应超时。')); }, 30000);
      this.pending.set(id, { resolve, reject, timer });
      try { this.socket!.send(JSON.stringify({ id, method, params })); }
      catch { clearTimeout(timer); this.pending.delete(id); reject(new Error('网站会话已关闭。')); }
    });
  }
  dispose() {
    const socket = this.socket; this.socket = undefined; socket?.close();
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error('网站会话已关闭。')); }
    this.pending.clear(); this.onClose?.();
  }
}
