/** 本机偏好（不走 IndexedDB，避免「关掉保存」时连设置一起丢）。 */

const KEY = 'tutor-web-prefs-v1';

const DEFAULTS = { save: true, amapKey: '', city: '南京' };

function read() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || '{}');
    return { ...DEFAULTS, ...(raw && typeof raw === 'object' ? raw : {}) };
  } catch {
    return { ...DEFAULTS };
  }
}

export const prefs = {
  get(name) {
    return read()[name];
  },
  set(name, value) {
    const next = { ...read(), [name]: value };
    try {
      localStorage.setItem(KEY, JSON.stringify(next));
    } catch {
      /* 隐私模式下写不进去，按会话内生效处理 */
    }
    return next;
  },
  all() {
    return read();
  },
};
