/**
 * 高德地图直连（Web 服务 Key）。
 * 实测 restapi.amap.com 返回 Access-Control-Allow-Origin: *，浏览器可直连，
 * 所以网页版不需要任何中转服务器 —— Key 只存在你自己的浏览器里。
 */

import { prefs } from './prefs.js';

const BASE = 'https://restapi.amap.com';
const MIN_INTERVAL = 450;
const RATE_ERRORS = new Set([
  'ACCESS_TOO_FREQUENT', 'QPS_HAS_EXCEEDED_THE_LIMIT', 'CQPS_HAS_EXCEEDED_THE_LIMIT',
  'CKQPS_HAS_EXCEEDED_THE_LIMIT', 'CUQPS_HAS_EXCEEDED_THE_LIMIT', 'GATEWAY_TIMEOUT',
]);

const FRIENDLY = {
  INVALID_USER_KEY: 'Key 无效，请确认复制完整（32 位）',
  USERKEY_PLAT_NOMATCH: 'Key 类型不对：创建时要选「Web 服务」，不是「Web 端(JS API)」',
  INVALID_USER_SCODE: 'Key 缺少安全密钥或已失效',
  DAILY_QUERY_OVER_LIMIT: '今天的免费额度已用完，明天恢复',
  USER_KEY_RECYCLED: 'Key 已被回收，请重新申请',
  SERVICE_NOT_AVAILABLE: '该 Key 没有开通地理编码服务',
};

let lastCall = 0;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export function apiKey() {
  return String(prefs.get('amapKey') || '').trim();
}

export function mapCity() {
  return String(prefs.get('city') || '南京').replace(/市$/, '');
}

export function maskKey(value) {
  const key = String(value || '').trim();
  if (!key) return '';
  if (key.length <= 8) return '*'.repeat(key.length);
  return `${key.slice(0, 4)}…${key.slice(-4)}`;
}

async function throttle() {
  const wait = Math.max(0, MIN_INTERVAL - (Date.now() - lastCall));
  if (wait) await sleep(wait);
  lastCall = Date.now();
}

function friendly(info) {
  return FRIENDLY[info] || `高德返回：${info}`;
}

async function hit(path, params) {
  const url = new URL(BASE + path);
  url.search = new URLSearchParams({ ...params, key: apiKey(), output: 'json' }).toString();
  let response;
  try {
    response = await fetch(url.toString(), { credentials: 'omit', mode: 'cors' });
  } catch {
    throw new Error('连不上高德（可能是网络或浏览器拦截），请稍后重试');
  }
  if (!response.ok) throw new Error(`高德返回 HTTP ${response.status}`);
  const data = await response.json();
  if (String(data.status) === '1') return data;
  const info = String(data.info || '未知错误');
  const error = new Error(friendly(info));
  error.code = info;
  throw error;
}

async function call(path, params) {
  if (!apiKey()) throw new Error('未配置高德 Web 服务 Key');
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await throttle();
    try {
      return await hit(path, params);
    } catch (error) {
      if (!RATE_ERRORS.has(error.code) || attempt === 3) throw error;
      await sleep(800 * 2 ** attempt);
    }
  }
  throw new Error('高德请求过于频繁，请稍后再试');
}

function placeFromPoi(poi) {
  const location = String(poi.location || '');
  if (!location.includes(',')) return null;
  const [lng, lat] = location.split(',');
  const lon = Number(lng);
  const la = Number(lat);
  if (!Number.isFinite(lon) || !Number.isFinite(la)) return null;
  return {
    name: poi.name || '',
    address: poi.address || '',
    district: poi.adname || '',
    lng: lon,
    lat: la,
    poi_id: poi.id || '',
  };
}

export async function searchPlaces(query, cache) {
  const city = mapCity();
  const cacheKey = `搜索|${city}|${query}`;
  const cached = cache?.get(cacheKey);
  if (cached) return cached;
  const data = await call('/v5/place/text', {
    keywords: query, region: city, city_limit: 'true', page_size: 10,
  });
  const places = (data.pois || []).map(placeFromPoi).filter(Boolean);
  await cache?.set(cacheKey, places);
  return places;
}

export async function geocodeAddress(address, cache) {
  const city = mapCity();
  const cacheKey = `地理编码|${city}|${address}`;
  const cached = cache?.get(cacheKey);
  if (cached !== undefined) return cached;
  const data = await call('/v3/geocode/geo', { address, city });
  const first = (data.geocodes || [])[0];
  const place = first ? placeFromPoi({
    name: first.formatted_address || address,
    address: first.formatted_address || '',
    adname: first.district || '',
    location: first.location,
    id: '',
  }) : null;
  await cache?.set(cacheKey, place);
  return place;
}

export async function geocodeJob(row, cache) {
  const raw = row.location_text || row.address || '';
  if (!raw) return null;
  const city = mapCity();
  const direct = await geocodeAddress(city + (row.district || '') + raw, cache);
  if (direct) return direct;
  const candidates = await searchPlaces(city + (row.district || '') + raw, cache);
  if (candidates.length) return candidates[0];
  if (raw !== row.district) {
    const fallback = await searchPlaces(raw, cache);
    if (fallback.length) return fallback[0];
  }
  return null;
}

/** 用候选 Key 打一次地理编码，确认它真的能用（不写缓存）。 */
export async function probe(candidateKey) {
  const key = String(candidateKey || '').trim();
  if (!key) return { verified: false, message: '还没有填 Key' };
  const url = new URL(BASE + '/v3/geocode/geo');
  url.search = new URLSearchParams({ key, output: 'json', address: '南京市新街口', city: '南京' }).toString();
  let data;
  try {
    const response = await fetch(url.toString(), { credentials: 'omit', mode: 'cors' });
    data = await response.json();
  } catch {
    return { verified: false, message: '连不上高德：请检查网络后重试' };
  }
  if (String(data.status) === '1' && (data.geocodes || []).length) {
    return { verified: true, message: 'Key 可用，测试查询成功' };
  }
  const info = String(data.info || '未知错误');
  return { verified: false, message: friendly(info) };
}
