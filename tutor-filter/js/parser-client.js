/** 解析引擎的 JS 侧客户端：懒加载 worker，按需拉 Pyodide。 */

export class ParserClient {
  constructor() {
    this.worker = null;
    this.seq = 0;
    this.pending = new Map();
    this.onProgress = null;
    this.ready = false;
  }

  ensureWorker() {
    if (this.worker) return this.worker;
    const worker = new Worker(new URL('./parser-worker.js', import.meta.url), { type: 'module' });
    worker.addEventListener('message', event => {
      const message = event.data || {};
      if (message.type === 'progress') {
        if (typeof this.onProgress === 'function') this.onProgress(message);
        return;
      }
      if (message.type === 'boot-error') {
        this.lastError = message.error;
        if (typeof this.onProgress === 'function') this.onProgress({ phase: 'error', message: message.error });
        return;
      }
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.ok) pending.resolve(message.result);
      else pending.reject(new Error(message.error || '解析失败'));
    });
    worker.addEventListener('error', event => {
      const detail = this.lastError || event.message || '';
      const error = new Error(detail || '解析引擎加载失败，请刷新页面重试');
      for (const pending of this.pending.values()) pending.reject(error);
      this.pending.clear();
      this.worker = null;
      this.ready = false;
    });
    this.worker = worker;
    return worker;
  }

  call(type, payload = {}) {
    const worker = this.ensureWorker();
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      worker.postMessage({ id, type, ...payload });
    });
  }

  async init() {
    await this.call('init');
    this.ready = true;
  }

  prefetch() {
    if (this.ready) return Promise.resolve();
    if (!this.preloading) {
      this.preloading = this.init().finally(() => {
        this.preloading = null;
      });
    }
    return this.preloading;
  }

  async parse(text, source) {
    const result = await this.call('parse', { text, source });
    this.ready = true;
    return result;
  }

  async parseOne(text) {
    return this.call('parseOne', { text });
  }

  async extractLocation(text) {
    return this.call('extract', { text });
  }
}
