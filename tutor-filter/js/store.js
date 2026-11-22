/**
 * 记录仓库：内存里算，IndexedDB 里存（可选）。
 *
 * 数据模型刻意和桌面版 SQLite 的 jobs 表一致（53 列），
 * 筛选语义也照搬 app.py 的 SQL，这样两边看到的结果一样。
 */

import { prefs } from './prefs.js';

export const COLUMNS = [
  'fingerprint', 'status', 'city', 'district', 'address', 'grade', 'grade_code', 'stage',
  'subjects', 'weak_subjects', 'teacher_can_teach', 'teaching_mode', 'student_gender',
  'teacher_gender_required', 'english_required', 'schedule', 'weekdays', 'time_slot',
  'time_text', 'excluded_weekdays', 'frequency_per_week', 'duration_hours',
  'rate_min', 'rate_max', 'rate_unit', 'hourly_min', 'hourly_max', 'hourly_estimated',
  'price_min', 'price_max', 'price_unit', 'price_note', 'requirements', 'tags', 'contact',
  'source', 'source_text', 'confidence', 'missing_fields', 'field_flags', 'evidence',
  'order_no', 'poster', 'published_at', 'created_at',
  'location_text', 'location_name', 'longitude', 'latitude', 'amap_poi_id',
  'location_status', 'location_confidence',
];

const JSON_FIELDS = [
  'subjects', 'weak_subjects', 'teacher_can_teach', 'schedule', 'weekdays',
  'excluded_weekdays', 'requirements', 'tags', 'missing_fields', 'field_flags', 'evidence',
];
const DICT_FIELDS = new Set(['field_flags', 'evidence']);
const KEEP_ON_MERGE = new Set(['fingerprint', 'status', 'created_at']);
const NUMERIC_COLUMNS = new Set([
  'frequency_per_week', 'duration_hours', 'rate_min', 'rate_max', 'hourly_min', 'hourly_max',
  'price_min', 'price_max', 'longitude', 'latitude', 'location_confidence', 'confidence',
]);
const FLAG_COLUMNS = new Set(['english_required', 'hourly_estimated']);
const LOCATION_COLUMNS = new Set([
  'location_text', 'location_name', 'longitude', 'latitude', 'amap_poi_id',
  'location_status', 'location_confidence',
]);

export const STATUSES = ['新单', '收藏', '已联系', '已过期', '忽略'];

const STAGE_TERMS = {
  幼儿园: ['幼儿园', '小班', '中班', '大班', '学前', '幼小', '岁'],
  小学: ['小学', '小一', '小二', '小三', '小四', '小五', '小六', '一年级', '二年级', '三年级', '四年级', '五年级', '六年级'],
  初中: ['初一', '初二', '初三', '七年级', '八年级', '九年级'],
  高中: ['高一', '高二', '高三'],
};

const GRADE_ALIASES = {
  初一: ['初一', '七年级'], 初二: ['初二', '八年级'], 初三: ['初三', '九年级'],
  学前: ['学前', '幼小'],
};

const SUBJECT_ALIASES = {
  作业辅导: ['作业辅导', '辅导作业', '作辅'],
  作业监督: ['作业监督', '监督作业', '陪写作业'],
  陪学: ['陪学', '陪伴学习'],
};

const KNOWN_SUBJECTS = [
  '语文', '数学', '英语', '物理', '化学', '生物', '政治', '历史', '地理', '道法', '科学', '奥数',
  '编程', 'Scratch', 'Python', 'C++', '音乐', '声乐', '钢琴', '古筝', '吉他', '舞蹈', '美术',
  '绘画', '书法', '体育', '篮球', '足球', '游泳', '全科', '主科', '作业辅导', '辅导作业', '作辅',
  '作业监督', '陪读', '陪学', '陪伴', '接送', '理科',
];

const DB_NAME = 'tutor-web';
const DB_VERSION = 1;

/* ------------------------------------------------------------------ IndexedDB 小工具 */

function promisify(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('jobs')) {
        const store = db.createObjectStore('jobs', { keyPath: 'id' });
        store.createIndex('fingerprint', 'fingerprint', { unique: false });
        store.createIndex('order_no', 'order_no', { unique: false });
      }
      if (!db.objectStoreNames.contains('map_cache')) {
        db.createObjectStore('map_cache', { keyPath: 'query' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('数据库被其他标签页占用，请关掉其他页面后重试'));
  });
}

async function readAll(db, storeName) {
  return promisify(db.transaction(storeName, 'readonly').objectStore(storeName).getAll());
}

async function writeRows(db, storeName, rows) {
  if (!rows.length) return;
  const tx = db.transaction(storeName, 'readwrite');
  const store = tx.objectStore(storeName);
  for (const row of rows) store.put(row);
  await txDone(tx);
}

async function clearStore(db, storeName) {
  const tx = db.transaction(storeName, 'readwrite');
  tx.objectStore(storeName).clear();
  await txDone(tx);
}

/* ------------------------------------------------------------------ 行 ↔ 视图对象 */

function jsonOf(value) {
  if (Array.isArray(value)) return JSON.stringify(value);
  return String(value ?? '');
}

function toRow(item) {
  const row = {};
  for (const column of COLUMNS) {
    const value = item[column];
    if (JSON_FIELDS.includes(column)) {
      row[column] = value ?? (DICT_FIELDS.has(column) ? {} : []);
    } else if (NUMERIC_COLUMNS.has(column)) {
      row[column] = value == null || value === '' ? null : Number(value);
    } else if (FLAG_COLUMNS.has(column)) {
      row[column] = value ? 1 : 0;
    } else {
      row[column] = value == null ? '' : value;
    }
  }
  row.status = row.status || '新单';
  return row;
}

function toItem(row) {
  const item = { ...row };
  for (const field of JSON_FIELDS) {
    const value = item[field];
    if (DICT_FIELDS.has(field)) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) item[field] = {};
    } else if (!Array.isArray(value)) {
      item[field] = [];
    }
  }
  item.english_required = Boolean(item.english_required);
  item.hourly_estimated = Boolean(item.hourly_estimated);
  return item;
}

function num(value) {
  if (value === '' || value == null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function haversineKm(lat1, lng1, lat2, lng2) {
  const toRad = value => (value * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 6371.0088 * 2 * Math.asin(Math.sqrt(a));
}

/* ------------------------------------------------------------------ 仓库 */

export class JobStore {
  constructor() {
    this.rows = [];
    this.nextId = 1;
    this.db = null;
    this.dbAvailable = typeof indexedDB !== 'undefined';
    this.persist = this.dbAvailable && prefs.get('save') !== false;
    this.cache = new Map();
  }

  async open() {
    if (!this.dbAvailable) return;
    try {
      this.db = await openDb();
    } catch {
      this.db = null;
      this.persist = false;
      return;
    }
    if (!this.persist) return;
    try {
      this.rows = await readAll(this.db, 'jobs');
      this.nextId = this.rows.reduce((max, row) => Math.max(max, row.id || 0), 0) + 1;
      for (const entry of await readAll(this.db, 'map_cache')) this.cache.set(entry.query, entry.value);
    } catch {
      this.rows = [];
    }
  }

  get saved() {
    return this.persist;
  }

  get size() {
    return this.rows.length;
  }

  async setPersist(on) {
    const desired = Boolean(on) && this.dbAvailable;
    this.persist = desired;
    prefs.set('save', desired);
    if (!this.db) {
      if (!desired) return;
      try {
        this.db = await openDb();
      } catch {
        this.persist = false;
        prefs.set('save', false);
        return;
      }
    }
    if (desired) {
      await writeRows(this.db, 'jobs', this.rows);
    } else {
      await clearStore(this.db, 'jobs');
    }
  }

  async addItems(items) {
    const byOrder = new Map();
    const byFingerprint = new Map();
    for (const row of this.rows) {
      if (row.order_no) byOrder.set(row.order_no, row);
      if (row.fingerprint) byFingerprint.set(row.fingerprint, row);
    }
    const touched = [];
    const summary = { found: items.length, added: 0, merged: 0, duplicates: 0 };
    for (const item of items) {
      const row = toRow(item);
      if (row.order_no && byOrder.has(row.order_no)) {
        const existing = byOrder.get(row.order_no);
        const addressChanged = String(existing.address || '') !== String(row.address || '');
        for (const column of COLUMNS) {
          if (KEEP_ON_MERGE.has(column)) continue;
          if (!addressChanged && LOCATION_COLUMNS.has(column)) continue;
          existing[column] = row[column];
        }
        touched.push(existing);
        summary.merged += 1;
        continue;
      }
      if (row.fingerprint && byFingerprint.has(row.fingerprint)) {
        summary.duplicates += 1;
        continue;
      }
      row.id = this.nextId++;
      this.rows.push(row);
      if (row.order_no) byOrder.set(row.order_no, row);
      if (row.fingerprint) byFingerprint.set(row.fingerprint, row);
      touched.push(row);
      summary.added += 1;
    }
    if (this.persist && this.db) await writeRows(this.db, 'jobs', touched);
    return summary;
  }

  query(params = {}) {
    const q = String(params.q || '').trim().toLowerCase();
    const stage = params.stage || '';
    const grade = params.grade || '';
    const subject = params.subject || '';
    const mode = params.mode || '';
    const status = params.status || '';
    const priceMin = num(params.price_min);
    const priceMax = num(params.price_max);
    const sort = params.sort || 'new';
    const onlyFresh = params.only_fresh === true || params.only_fresh === 'true';
    const staleHours = num(params.stale_hours) ?? 72;
    const limit = Math.max(1, Math.min(num(params.limit) ?? 500, 2000));
    const originLat = num(params.origin_lat);
    const originLng = num(params.origin_lng);
    const radius = num(params.radius_km);

    let rows = this.rows.filter(row => {
      if (q) {
        const haystack = [
          row.source_text, row.district, row.address,
          jsonOf(row.subjects), jsonOf(row.requirements), row.order_no,
        ].map(value => String(value ?? '').toLowerCase());
        if (!haystack.some(value => value.includes(q))) return false;
      }
      if (stage && STAGE_TERMS[stage]) {
        const gradeText = String(row.grade || '').toLowerCase();
        if (!STAGE_TERMS[stage].some(term => gradeText.includes(term.toLowerCase()))) return false;
      }
      if (grade) {
        const terms = GRADE_ALIASES[grade] || [grade];
        const gradeText = String(row.grade || '').toLowerCase();
        if (!terms.some(term => gradeText.includes(term.toLowerCase()))) return false;
      }
      if (mode && !String(row.teaching_mode || '').includes(mode)) return false;
      if (status && !String(row.status || '').includes(status)) return false;
      if (subject) {
        const subjectsText = jsonOf(row.subjects).toLowerCase();
        if (subject === '其他') {
          if (KNOWN_SUBJECTS.some(term => subjectsText.includes(term.toLowerCase()))) return false;
        } else {
          const terms = SUBJECT_ALIASES[subject] || [subject];
          if (!terms.some(term => subjectsText.includes(String(term).toLowerCase()))) return false;
        }
      }
      if (priceMin != null) {
        const high = row.hourly_max ?? row.hourly_min ?? row.price_max ?? row.price_min;
        if (!(high >= priceMin)) return false;
      }
      if (priceMax != null) {
        const low = row.hourly_min ?? row.hourly_max ?? row.price_min ?? row.price_max;
        if (!(low <= priceMax)) return false;
      }
      return true;
    });

    const now = Date.now();
    let items = rows.map(row => {
      const item = toItem(row);
      const published = item.published_at || '';
      let ageHours = null;
      if (published) {
        const stamp = Date.parse(published);
        if (!Number.isNaN(stamp)) ageHours = Math.round(((now - stamp) / 3600000) * 10) / 10;
      }
      item.age_hours = ageHours;
      item.stale = Boolean(ageHours != null && ageHours > staleHours && item.status === '新单');
      return item;
    });

    if (onlyFresh) items = items.filter(item => !item.stale);

    if (originLat != null && originLng != null) {
      for (const item of items) {
        if (item.latitude != null && item.longitude != null) {
          item.distance_km = Math.round(haversineKm(originLat, originLng, item.latitude, item.longitude) * 100) / 100;
          item.bike_minutes = Math.round((item.distance_km / 15) * 60);
        } else {
          item.distance_km = null;
          item.bike_minutes = null;
        }
      }
      if (radius != null) {
        items = items.filter(item => item.distance_km != null && item.distance_km <= radius);
      }
    }

    items.sort(comparator(sort));
    items = items.slice(0, limit);
    return { items, total: items.length };
  }

  listAll() {
    return this.rows.map(toItem);
  }

  get(id) {
    const row = this.rows.find(entry => entry.id === id);
    return row ? toItem(row) : null;
  }

  async updateStatus(id, status) {
    if (!STATUSES.includes(status)) throw new Error('状态不合法');
    const row = this.rows.find(entry => entry.id === id);
    if (!row) throw new Error('记录不存在');
    row.status = status;
    if (this.persist && this.db) await writeRows(this.db, 'jobs', [row]);
    return { ok: true };
  }

  async saveLocation(id, place) {
    const row = this.rows.find(entry => entry.id === id);
    if (!row) return;
    row.location_text = row.location_text || row.address || '';
    row.location_name = place.name || '';
    row.longitude = place.lng;
    row.latitude = place.lat;
    row.amap_poi_id = place.poi_id || '';
    row.location_status = '已识别';
    row.location_confidence = 0.85;
    if (this.persist && this.db) await writeRows(this.db, 'jobs', [row]);
  }

  async markLocationStatus(id, status) {
    const row = this.rows.find(entry => entry.id === id);
    if (!row) return;
    row.location_status = status;
    if (this.persist && this.db) await writeRows(this.db, 'jobs', [row]);
  }

  async remove(id) {
    const index = this.rows.findIndex(entry => entry.id === id);
    if (index < 0) throw new Error('记录不存在');
    this.rows.splice(index, 1);
    if (this.persist && this.db) {
      const tx = this.db.transaction('jobs', 'readwrite');
      tx.objectStore('jobs').delete(id);
      await txDone(tx);
    }
    return { ok: true };
  }

  async removeMany(ids) {
    const wanted = new Set(ids.filter(id => Number.isFinite(id) && id > 0));
    if (!wanted.size) throw new Error('请至少选择一条记录');
    if (wanted.size > 1000) throw new Error('单次最多删除1000条记录');
    this.rows = this.rows.filter(row => !wanted.has(row.id));
    if (this.persist && this.db) {
      const tx = this.db.transaction('jobs', 'readwrite');
      const store = tx.objectStore('jobs');
      for (const id of wanted) store.delete(id);
      await txDone(tx);
    }
    return { ok: true, deleted: wanted.size };
  }

  async clear() {
    const removed = this.rows.length;
    this.rows = [];
    this.nextId = 1;
    this.cache.clear();
    if (this.db) {
      await clearStore(this.db, 'jobs');
      await clearStore(this.db, 'map_cache');
    }
    return { ok: true, removed };
  }

  async reparse(parser) {
    const rows = [...this.rows];
    let updated = 0;
    let failed = 0;
    const touched = [];
    for (const row of rows) {
      try {
        const parsed = await parser.parseOne(row.source_text || '');
        if (!parsed.grade && !(parsed.subjects || []).length) {
          failed += 1;
          continue;
        }
        const next = toRow(parsed);
        for (const column of COLUMNS) {
          if (['fingerprint', 'status', 'created_at', 'source', 'source_text'].includes(column)) continue;
          if (LOCATION_COLUMNS.has(column)) continue;
          row[column] = next[column];
        }
        touched.push(row);
        updated += 1;
      } catch {
        failed += 1;
      }
    }
    if (this.persist && this.db) await writeRows(this.db, 'jobs', touched);
    return { total: rows.length, updated, failed };
  }

  csv() {
    const fields = [
      'id', 'order_no', 'status', 'grade', 'subjects', 'district', 'address', 'teaching_mode',
      'weekdays', 'time_text', 'frequency_per_week', 'duration_hours',
      'hourly_min', 'hourly_max', 'rate_min', 'rate_max', 'rate_unit', 'price_note',
      'teacher_gender_required', 'requirements', 'tags', 'published_at', 'poster',
      'contact', 'source', 'source_text',
    ];
    const escape = value => {
      const text = value == null ? '' : String(value);
      return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
    };
    const lines = [fields.join(',')];
    for (const row of [...this.rows].sort((a, b) => b.id - a.id)) {
      lines.push(fields.map(field => {
        const value = row[field];
        if (['subjects', 'weekdays', 'requirements', 'tags'].includes(field)) {
          return escape((Array.isArray(value) ? value : []).join('、'));
        }
        return escape(value);
      }).join(','));
    }
    return '\ufeff' + lines.join('\r\n');
  }

  backup() {
    return {
      app: 'tutor-filter-web',
      version: 1,
      exported_at: new Date().toISOString(),
      jobs: this.rows.map(row => ({ ...row })),
    };
  }

  async restore(payload) {
    const jobs = Array.isArray(payload?.jobs) ? payload.jobs : [];
    if (!jobs.length) throw new Error('备份文件里没有记录');
    const clean = jobs.filter(row => row && typeof row === 'object' && row.source_text);
    return this.addItems(clean);
  }

  cacheGet(key) {
    return this.cache.get(key);
  }

  async cacheSet(key, value) {
    this.cache.set(key, value);
    if (this.persist && this.db) {
      const tx = this.db.transaction('map_cache', 'readwrite');
      tx.objectStore('map_cache').put({ query: key, value });
      await txDone(tx);
    }
  }
}

function comparator(sort) {
  if (sort === 'hourly') {
    return (a, b) => {
      const av = a.hourly_max ?? a.hourly_min;
      const bv = b.hourly_max ?? b.hourly_min;
      if ((av == null) !== (bv == null)) return av == null ? 1 : -1;
      if (av != null && av !== bv) return bv - av;
      return b.id - a.id;
    };
  }
  if (sort === 'distance') {
    return (a, b) => {
      const ad = a.distance_km;
      const bd = b.distance_km;
      if ((ad == null) !== (bd == null)) return ad == null ? 1 : -1;
      if (ad != null && ad !== bd) return ad - bd;
      return b.id - a.id;
    };
  }
  return (a, b) => {
    const ap = a.published_at || '';
    const bp = b.published_at || '';
    if ((!ap) !== (!bp)) return ap ? -1 : 1;
    if (ap !== bp) return ap < bp ? 1 : -1;
    return b.id - a.id;
  };
}
