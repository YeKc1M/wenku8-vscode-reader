type Pending = { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };
/** Only connects to the per-session proxy created by VS Code's built-in debugger. */
export class CdpConnection {
  private nextId = 0;
  private pending = new Map<number, Pending>();
  private socket?: WebSocket;
  onEvent?: (method: string, params: any) => void;
  onClose?: () => void;
  async connect(address: { host: string; port: number; path: string }): Promise<void> {
    if (!['127.0.0.1', '::1', 'localhost'].includes(address.host) || !Number.isInteger(address.port) || address.port < 1 || address.port > 65535 || !/^\/[a-f0-9]+$/.test(address.path)) throw new Error('VS Code 内置浏览器接口地址无效。');
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}${address.path}`); this.socket = socket;
    socket.addEventListener('message', event => {
      try {
        if (typeof event.data !== 'string' || event.data.length > 24 * 1024 * 1024) throw new Error();
        const message = JSON.parse(event.data);
        if (message.method) { this.onEvent?.(message.method, message.params); return; }
        const pending = this.pending.get(message.id); if (!pending) return;
        clearTimeout(pending.timer); this.pending.delete(message.id);
        if (message.error) pending.reject(new Error('内置浏览器操作失败，请重新打开验证页。')); else pending.resolve(message.result);
      } catch { this.dispose(); }
    });
    const closed = () => { if (this.socket !== socket) return; this.socket = undefined; this.rejectPending(); this.onClose?.(); };
    socket.addEventListener('close', closed); socket.addEventListener('error', closed);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { socket.close(); reject(new Error('连接 VS Code 内置浏览器超时。')); }, 10000);
      socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('无法连接 VS Code 内置浏览器。')); }, { once: true });
    });
  }
  send(method: string, params: object = {}): Promise<any> {
    if (this.socket?.readyState !== WebSocket.OPEN) return Promise.reject(new Error('验证页已关闭，请重新打开。'));
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('内置浏览器操作超时，请重试。')); }, 25000);
      this.pending.set(id, { resolve, reject, timer });
      try { this.socket!.send(JSON.stringify({ id, method, params })); } catch { clearTimeout(timer); this.pending.delete(id); reject(new Error('验证页已关闭。')); }
    });
  }
  private rejectPending(): void { for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('验证页已关闭，请重新打开。')); } this.pending.clear(); }
  dispose(): void { const socket = this.socket; this.socket = undefined; socket?.close(); this.rejectPending(); this.onClose?.(); }
}
