/**
 * 本地版接口层：把原来打到 FastAPI 的请求，全部改成在浏览器里执行。
 * 刻意保持和 app.py 相同的路径与返回结构，前端 UI 一行都不用改。
 */

import { JobStore } from './store.js';
import { ParserClient } from './parser-client.js';
import { prefs } from './prefs.js';
import * as Amap from './amap.js';

const store = new JobStore();
const parser = new ParserClient();

let progressHandler = null;

function reply(data, status = 200) {
  return { ok: status < 400, status, json: async () => data };
}

function fail(status, detail) {
  return { ok: false, status, json: async () => ({ detail }) };
}

function readJson(options) {
  if (!options || typeof options.body !== 'string') return {};
  try {
    return JSON.parse(options.body) || {};
  } catch {
    return {};
  }
}

function hasKey() {
  return Boolean(Amap.apiKey());
}

function download(name, text, type) {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

function stamp() {
  const now = new Date();
  const pad = value => String(value).padStart(2, '0');
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
}

export class LocalAPI {
  static async init() {
    await store.open();
    parser.onProgress = message => {
      if (typeof progressHandler === 'function') progressHandler(message);
    };
    return { saved: store.saved, records: store.size };
  }

  static onProgress(handler) {
    progressHandler = handler;
  }

  static prefetch() {
    return parser.prefetch();
  }

  static get saved() {
    return store.saved;
  }

  static get size() {
    return store.size;
  }

  static async setPersist(on) {
    await store.setPersist(on);
    return { saved: store.saved };
  }

  static exportCsv() {
    download(`家教信息-${stamp()}.csv`, store.csv(), 'text/csv;charset=utf-8');
    return store.size;
  }

  static exportBackup() {
    const payload = store.backup();
    download(`家教信息备份-${stamp()}.json`, JSON.stringify(payload, null, 1), 'application/json');
    return payload.jobs.length;
  }

  static async importBackup(file) {
    const text = await file.text();
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new Error('备份文件不是合法的 JSON');
    }
    return store.restore(payload);
  }

  static async clearAll() {
    return store.clear();
  }

  static handle(url, options = {}) {
    return this.route(url, options);
  }

  static async route(url, options) {
    try {
      const { pathname, searchParams } = new URL(url, location.href);
      const method = String(options.method || 'GET').toUpperCase();

      if (pathname === '/api/config' && method === 'GET') {
        const key = Amap.apiKey();
        return reply({
          ai_enabled: false,
          parse_mode: '浏览器本地规则（不含任何模型调用）',
          model: '',
          map_enabled: Boolean(key),
          map_source: key ? 'browser' : '',
          amap_key_masked: Amap.maskKey(key),
          stale_hours: 72,
          packaged: false,
          saved: store.saved,
          records: store.size,
          city: Amap.mapCity(),
        });
      }

      if (pathname === '/api/ping') return reply({ ok: true });

      if (pathname === '/api/settings/amap' && method === 'GET') {
        const key = Amap.apiKey();
        return reply({ configured: Boolean(key), source: key ? 'browser' : '', masked: Amap.maskKey(key) });
      }

      if (pathname === '/api/settings/amap' && method === 'POST') {
        const key = String(readJson(options).key || '').trim().replace(/^["']|["']$/g, '');
        if (!/^[A-Za-z0-9]{8,64}$/.test(key)) {
          return fail(400, 'Key 格式不对：应该是 32 位字母数字，别带空格或引号');
        }
        const result = await Amap.probe(key);
        if (result.verified) prefs.set('amapKey', key);
        return reply({
          ok: true,
          verified: result.verified,
          message: result.message,
          masked: Amap.maskKey(key),
          source: 'browser',
          map_enabled: hasKey(),
        });
      }

      if (pathname === '/api/settings/amap/test' && method === 'POST') {
        const key = Amap.apiKey();
        if (!key) return fail(400, '还没有配置 Key');
        const result = await Amap.probe(key);
        return reply({ verified: result.verified, message: result.message, masked: Amap.maskKey(key), source: 'browser' });
      }

      if (pathname === '/api/settings/amap' && method === 'DELETE') {
        prefs.set('amapKey', '');
        return reply({ ok: true, configured: hasKey(), source: '' });
      }

      if (pathname === '/api/map/search' && method === 'GET') {
        const q = String(searchParams.get('q') || '').trim();
        if (q.length < 2) return fail(400, '地点至少输入2个字');
        return reply({ items: await Amap.searchPlaces(q, store) });
      }

      if (pathname === '/api/map/geocode-jobs' && method === 'POST') {
        const body = readJson(options);
        const wanted = Array.isArray(body.ids) ? body.ids.filter(id => Number.isFinite(id) && id > 0).slice(0, 100) : [];
        const rows = wanted.length
          ? wanted.map(id => store.rows.find(row => row.id === id)).filter(Boolean)
          : [...store.rows].filter(row => row.longitude == null).sort((a, b) => b.id - a.id).slice(0, 50);
        let resolved = 0;
        let failed = 0;
        let rateLimited = 0;
        for (const row of rows) {
          try {
            const place = await Amap.geocodeJob(row, store);
            if (place) {
              await store.saveLocation(row.id, place);
              resolved += 1;
            } else {
              await store.markLocationStatus(row.id, '待确认');
              failed += 1;
            }
          } catch (error) {
            failed += 1;
            if (/频繁|QPS|TOO_FREQUENT|EXCEEDED/i.test(String(error?.message || error?.code || ''))) rateLimited += 1;
            await store.markLocationStatus(row.id, '稍后重试');
          }
        }
        return reply({ processed: rows.length, resolved, failed, rate_limited: rateLimited });
      }

      if (pathname === '/api/import/text' && method === 'POST') {
        const body = readJson(options);
        const text = String(body.text || '');
        if (!text.trim()) return fail(400, '请输入消息内容');
        const parsed = await parser.parse(text, String(body.source || '网页粘贴'));
        const summary = await store.addItems(parsed.items);
        return reply({ ...summary, found: parsed.found, ai_used: 0, rule_used: parsed.found });
      }

      if (pathname === '/api/import/file') {
        return fail(400, '网页版只支持直接粘贴文字，请把文件内容复制进来');
      }

      if (pathname === '/api/tenant-doc/parse' || pathname === '/api/tencent-doc/parse') {
        return fail(400, '网页版不支持抓取腾讯文档链接，请导出后粘贴文字');
      }

      if (pathname === '/api/jobs' && method === 'GET') {
        const params = Object.fromEntries(searchParams.entries());
        return reply(store.query(params));
      }

      if (pathname === '/api/jobs/reparse' && method === 'POST') {
        return reply(await store.reparse(parser));
      }

      const statusMatch = pathname.match(/^\/api\/jobs\/(\d+)\/status$/);
      if (statusMatch && (method === 'PATCH' || method === 'POST')) {
        const body = readJson(options);
        return reply(await store.updateStatus(Number(statusMatch[1]), String(body.status || '')));
      }

      const deleteMatch = pathname.match(/^\/api\/jobs\/(\d+)$/);
      if (deleteMatch && method === 'DELETE') {
        return reply(await store.remove(Number(deleteMatch[1])));
      }

      if (pathname === '/api/jobs/batch-delete' && method === 'POST') {
        const body = readJson(options);
        return reply(await store.removeMany(Array.isArray(body.ids) ? body.ids : []));
      }

      if (pathname === '/api/export.csv' && method === 'GET') {
        return {
          ok: true,
          status: 200,
          json: async () => ({ ok: true }),
          text: async () => store.csv(),
        };
      }

      return fail(404, `网页版没有这个接口：${pathname}`);
    } catch (error) {
      return fail(500, String((error && error.message) || error));
    }
  }
}
