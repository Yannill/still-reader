/* util.js —— 通用工具：DOM、事件总线、设置、提示 */
'use strict';
const R = (window.R = {});

R.$ = (s, el = document) => el.querySelector(s);
R.$$ = (s, el = document) => Array.from(el.querySelectorAll(s));
R.clamp = (v, a, b) => Math.max(a, Math.min(b, v));
R.uid = (p = 'a') => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
R.sleep = (ms) => new Promise((r) => setTimeout(r, ms));

R.esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

R.debounce = (fn, ms) => {
  let t, args;
  const invoke = () => { clearTimeout(t); t = null; const a = args; args = null; return a ? fn(...a) : undefined; };
  const wrapped = (...a) => {
    clearTimeout(t);
    args = a;
    t = setTimeout(invoke, ms);
  };
  wrapped.flush = invoke;
  wrapped.cancel = () => { clearTimeout(t); t = null; args = null; };
  return wrapped;
};

R.hexToRgb = (hex) => {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
R.rgbToHex = (r, g, b) => '#' + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');

R.isCJK = (s) => /[\u3400-\u9fff\uf900-\ufaff]/.test(s);
R.cjkRatio = (s) => {
  const t = s.replace(/\s/g, '');
  if (!t) return 0;
  const m = t.match(/[\u3400-\u9fff\uf900-\ufaff]/g);
  return (m ? m.length : 0) / t.length;
};

R.today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/* ---------- 事件总线 ---------- */
R.bus = (() => {
  const map = {};
  return {
    on(ev, fn) { (map[ev] = map[ev] || []).push(fn); },
    emit(ev, data) { (map[ev] || []).forEach((fn) => { try { fn(data); } catch (e) { console.error(e); } }); },
  };
})();

/* ---------- 提示 ---------- */
R.toast = (msg, type = 'info', ms = 2600) => {
  const el = document.createElement('div');
  el.className = 'toast ' + type;
  el.textContent = msg;
  R.$('#toasts').appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 300);
  }, ms);
};

/* ---------- 设置（localStorage） ---------- */
R.DEFAULT_SETTINGS = {
  // 专注
  focusOn: true,
  focusLines: 1,
  lensSize: 'comfort',
  dim: 0.62,
  blur: false,
  paceWpm: 180, // 每分钟“词”数（中文按 2 字 = 1 词估算）
  paceProgress: true, // 显示玻璃框底部的自动步进进度条
  // 番茄钟
  pomodoro: 25,
  breakMin: 5,
  // 标注
  color: '#E8D38A',
  paper: 'original',
  reducedMotion: false,
  // 翻译
  translateEngine: 'ai', // ai | free
  translateTarget: 'zh', // zh | en
  // AI
  ai: {
    provider: 'openai',
    baseURL: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    apiKey: '',
    proxy: '', // 例如 http://localhost:8080/api/ai/chat （C++ 服务器提供）
    vision: true,
  },
  aiTitle: true, // 导入时用 AI 自动起标题
  calmChrome: true, // 专注时自动淡出工具栏
};

R.settings = (() => {
  let s;
  try { s = JSON.parse(localStorage.getItem('adhd-reader-settings') || '{}'); } catch { s = {}; }
  const merged = Object.assign({}, R.DEFAULT_SETTINGS, s);
  merged.ai = Object.assign({}, R.DEFAULT_SETTINGS.ai, s.ai || {});
  return merged;
})();
R.saveSettings = () => {
  localStorage.setItem('adhd-reader-settings', JSON.stringify(R.settings));
  R.bus.emit('settings');
};

/* ---------- 弹层定位 ---------- */
R.showPopover = (el, x, y, { above = true } = {}) => {
  el.classList.remove('hidden');
  const r = el.getBoundingClientRect();
  let left = x - r.width / 2;
  let top = above ? y - r.height - 10 : y + 10;
  if (top < 8) top = y + 14;
  left = R.clamp(left, 8, window.innerWidth - r.width - 8);
  top = R.clamp(top, 8, window.innerHeight - r.height - 8);
  el.style.left = left + 'px';
  el.style.top = top + 'px';
};
R.hide = (el) => el && el.classList.add('hidden');
R.show = (el) => el && el.classList.remove('hidden');

/* 简易 Markdown（AI 回复用）：标题、粗体、行内代码、代码块、列表 */
R.md = (text) => {
  const inline = (s) => s.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/`([^`]+)`/g, '<code>$1</code>');
  const parts = String(text).split(/```/);
  let out = '';
  parts.forEach((b, i) => {
    if (i % 2 === 1) {
      out += '<pre><code>' + R.esc(b.replace(/^[\w+-]*\n/, '')) + '</code></pre>';
      return;
    }
    let inList = false;
    for (const raw of b.split('\n')) {
      const li = raw.match(/^\s*(?:[-*•]|\d+[.、)])\s+(.*)$/);
      if (li) {
        if (!inList) { out += '<ul>'; inList = true; }
        out += '<li>' + inline(R.esc(li[1])) + '</li>';
        continue;
      }
      if (inList) { out += '</ul>'; inList = false; }
      const hm = raw.match(/^#{1,4}\s+(.*)$/);
      const bq = raw.match(/^\s*>\s?(.*)$/);
      if (hm) out += '<h4>' + inline(R.esc(hm[1])) + '</h4>';
      else if (bq) out += '<blockquote>' + inline(R.esc(bq[1])) + '</blockquote>';
      else if (raw.trim()) out += '<p>' + inline(R.esc(raw)) + '</p>';
    }
    if (inList) out += '</ul>';
  });
  return out;
};

/* 下载文件 */
R.download = (data, name, type = 'application/octet-stream') => {
  const blob = data instanceof Blob ? data : new Blob([data], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
};

R.motionReduced = () => R.settings.reducedMotion || matchMedia('(prefers-reduced-motion: reduce)').matches;
R.whenIdle = (fn) => window.requestIdleCallback ? requestIdleCallback(fn, { timeout: 2000 }) : setTimeout(fn, 300);
R.confirm = (message, label = '确认') => new Promise((resolve) => {
  const dialog = R.$('#confirmDialog');
  R.$('#confirmText').textContent = message;
  R.$('#confirmOk').textContent = label;
  const done = (value) => { dialog.close(); resolve(value); };
  R.$('#confirmOk').onclick = () => done(true);
  R.$('#confirmCancel').onclick = () => done(false);
  dialog.oncancel = (e) => { e.preventDefault(); done(false); };
  dialog.showModal();
});
