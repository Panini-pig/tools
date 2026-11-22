/**
 * 解析引擎 Web Worker：在浏览器里跑 Pyodide（CPython/WASM），
 * 直接加载 ../parsers/*.py —— 和桌面版是同一份规则，永不跑偏。
 *
 * 站点布局：
 *   /tutor-filter/js/parser-worker.js
 *   /tutor-filter/parsers/*.py
 *   /tutor-filter/service.py
 *   /pyodide/*               全站共用的运行时
 */

const APP_ROOT = new URL('../', import.meta.url);
const SITE_ROOT = new URL('../../', import.meta.url);
const PYODIDE_ROOT = new URL('pyodide/', SITE_ROOT);

const PARSER_FILES = ['__init__', 'text', 'split', 'labels', 'fields', 'rates', 'schedule', 'order'];

let pyodide = null;
let booting = null;

function tell(phase, message) {
  self.postMessage({ type: 'progress', phase, message });
}

function describe(error) {
  if (!error) return '未知错误';
  const message = String(error.message || error);
  const stack = String(error.stack || '').split('\n').slice(0, 4).join(' | ');
  return stack ? `${message}（${stack}）` : message;
}

async function fetchText(url, label) {
  const response = await fetch(url, { cache: 'force-cache' });
  if (!response.ok) throw new Error(`读取 ${label} 失败（HTTP ${response.status}）`);
  return response.text();
}

async function boot() {
  if (pyodide) return pyodide;
  if (booting) return booting;
  booting = (async () => {
    tell('runtime', '正在加载解析引擎（首次约 5 MB）…');
    const { loadPyodide } = await import(new URL('pyodide.mjs', PYODIDE_ROOT).href);
    pyodide = await loadPyodide({
      indexURL: PYODIDE_ROOT.href,
      stdout: () => {},
      stderr: () => {},
    });

    tell('rules', '正在装载解析规则…');
    pyodide.FS.mkdirTree('/parsers');
    const sources = await Promise.all(
      PARSER_FILES.map(name => fetchText(new URL(`parsers/${name}.py`, APP_ROOT), `parsers/${name}.py`)
        .then(code => [name, code]))
    );
    for (const [name, code] of sources) pyodide.FS.writeFile(`/parsers/${name}.py`, code);
    pyodide.FS.writeFile('/service.py', await fetchText(new URL('service.py', APP_ROOT), 'service.py'));

    pyodide.runPython([
      "import sys",
      "if '/' not in sys.path: sys.path.insert(0, '/')",
      "import service",
      "from service import prepare_items, parse_one, extract_location",
    ].join('\n'));
    tell('ready', '解析引擎已就绪');
    return pyodide;
  })().catch(error => {
    booting = null;
    pyodide = null;
    self.postMessage({ type: 'boot-error', error: describe(error) });
    throw error;
  });
  return booting;
}

function callFunction(name, ...args) {
  const fn = pyodide.globals.get(name);
  if (!fn) throw new Error(`解析服务缺少 ${name}`);
  return fn(...args);
}

self.addEventListener('message', async event => {
  const { id, type, text, source } = event.data || {};
  if (!type) return;
  try {
    await boot();
    let result;
    if (type === 'init') {
      result = { ready: true };
    } else if (type === 'parse') {
      result = JSON.parse(callFunction('prepare_items', String(text ?? ''), String(source || '网页粘贴')));
    } else if (type === 'parseOne') {
      result = JSON.parse(callFunction('parse_one', String(text ?? '')));
    } else if (type === 'extract') {
      result = callFunction('extract_location', String(text ?? ''));
    } else {
      throw new Error(`未知操作：${type}`);
    }
    self.postMessage({ id, ok: true, result });
  } catch (error) {
    self.postMessage({ id, ok: false, error: describe(error) });
  }
});

self.addEventListener('unhandledrejection', event => {
  self.postMessage({ type: 'boot-error', error: describe(event.reason) });
});
