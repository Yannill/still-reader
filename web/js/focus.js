/* focus.js —— 专注玻璃框
 *  - 玻璃框内文字清晰，框外整体淡化（可选轻微模糊）
 *  - 鼠标滚轮 / 方向键 / 单击 切换行；切换时带弹簧动画：框会被“拉伸—回弹”，有大小上的动态感
 *  - 当前行固定停在屏幕约 38% 高度处（视线不用上下乱跑）
 *  - 手动拖动滚动条后，框会自动“接住”屏幕中间的那一行
 *  - 自动步进：按阅读速度自动走到下一行，框底部有细进度条提示节奏
 */
'use strict';
R.focus = (() => {
  const F = {
    on: false, pos: null, cur: null, target: null, vel: { x: 0, y: 0, w: 0, h: 0 }, radius: 12,
    raf: 0, lastT: 0, scrollTarget: null, lastProgScroll: 0,
    wheelAcc: 0, lastStepAt: 0, wheelReset: 0,
    pace: false, paceTimer: 0,
  };
  const ANCHOR = 0.38;
  const SIZES = {
    compact: { px: 8, py: 0.2, r: 9 },
    comfort: { px: 18, py: 0.42, r: 14 },
    airy: { px: 28, py: 0.7, r: 18 },
  };
  let layer, lens, dim, scroller;
  const V = () => R.viewer.V;

  function init() {
    layer = R.$('#focusLayer');
    lens = R.$('#lens');
    dim = R.$('#dim');
    scroller = R.$('#scroller');
    scroller.addEventListener('wheel', onWheel, { passive: false });
    scroller.addEventListener('scroll', onScroll, { passive: true });
    R.bus.on('pages-built', () => { F.pos = null; F.cur = null; stopPace(); draw(); });
    R.bus.on('zoom', () => { if (F.pos) { computeTarget(); F.cur = { ...F.target }; scrollToTarget(true); draw(); } });
    R.bus.on('layout', () => { sizeLayer(); if (F.pos) { computeTarget(); F.cur = { ...F.target }; draw(); } });
    R.bus.on('settings', applyStyle);
    applyStyle();
  }

  function applyStyle() {
    if (!dim) return;
    const s = R.settings;
    dim.style.setProperty('--dim', s.dim);
    dim.classList.toggle('blur', !!s.blur);
    lens.classList.toggle('pace-progress-hidden', s.paceProgress === false);
    if (F.pos) { computeTarget(); startLoop(); }
  }

  function sizeLayer() {
    // 覆盖滚动区，但不盖住滚动条
    layer.style.width = scroller.clientWidth + 'px';
    layer.style.height = scroller.clientHeight + 'px';
  }

  /* ---------------- 开关 ---------------- */
  async function enable(on) {
    F.on = on;
    R.settings.focusOn = on;
    R.saveSettings();
    R.$('#btnFocus').classList.toggle('on', on);
    document.body.classList.toggle('focus-on', on);
    layer.classList.toggle('hidden', !on);
    if (!on) { stopPace(); return; }
    sizeLayer();
    if (!F.pos) {
      if (scroller.scrollTop < 40) await startAtFirstLine();
      else await pickAtAnchor();
    } else { computeTarget(); F.cur = F.cur || { ...F.target }; startLoop(); }
  }

  /** 刚打开文档：从第一页的第一行开始 */
  async function startAtFirstLine() {
    for (let i = 0; i < Math.min(V().pages.length, 4); i++) {
      const lines = await R.viewer.ensureLines(i);
      if (lines.length) return setPos(i, 0, { scroll: false, instant: true });
    }
  }
  const toggle = () => enable(!F.on);

  /** 选中屏幕“视线高度”附近的那一行 */
  async function pickAtAnchor() {
    if (!V().pdf) return;
    const start = R.viewer.currentPage();
    const anchorY = scroller.scrollTop + scroller.clientHeight * ANCHOR;
    for (let i = start; i < Math.min(V().pages.length, start + 4); i++) {
      const lines = await R.viewer.ensureLines(i);
      if (!lines.length) continue;
      let best = 0, bestD = Infinity;
      lines.forEach((l, k) => {
        const c = R.viewer.toContent(i, l);
        const d = Math.abs(c.y + c.h / 2 - anchorY);
        if (d < bestD) { bestD = d; best = k; }
      });
      return setPos(i, best, { scroll: i !== start });
    }
  }

  /* ---------------- 位置 / 目标框 ---------------- */
  async function setPos(i, k, { scroll = true, instant = false, silent = false } = {}) {
    await R.viewer.ensureLines(i);
    const lines = V().pages[i].lines;
    if (!lines || !lines[k]) return;
    F.pos = { i, k };
    computeTarget();
    if (!F.cur || instant) F.cur = { ...F.target };
    lens.classList.remove('bump');
    void lens.offsetWidth;
    lens.classList.add('bump');
    if (scroll) scrollToTarget(instant);
    startLoop();
    if (!silent) R.bus.emit('focus-move', { i, k, total: lines.length });
    if (F.pace) schedulePace();
  }

  function computeTarget() {
    const { i, k } = F.pos;
    const lines = V().pages[i].lines;
    const n = R.settings.focusLines === 'paragraph' ? (R.reader?.paragraphLength(i, k) || 1) : R.settings.focusLines || 1;
    const first = lines[k];
    let y0 = first.y, y1 = first.y + first.h;
    let last = first;
    for (let j = k + 1; j < Math.min(lines.length, k + n); j++) {
      const l = lines[j];
      if (l.y < last.y || l.y - (last.y + last.h) > last.h * 1.6) break; // 换栏就停
      y1 = l.y + l.h;
      last = l;
    }
    // 宽度取“所在栏”的宽度，使框宽稳定、不随行长短跳动
    let x0 = first.x, x1 = first.x + first.w;
    for (let j = Math.max(0, k - 10); j < Math.min(lines.length, k + 11); j++) {
      const l = lines[j];
      const overlap = Math.min(x1, l.x + l.w) - Math.max(x0, l.x);
      if (overlap > 0 && Math.abs(l.y - first.y) < first.h * 25 && l.w > first.w * 0.25) {
        x0 = Math.min(x0, l.x);
        x1 = Math.max(x1, l.x + l.w);
      }
    }
    const sz = SIZES[R.settings.lensSize] || SIZES.comfort;
    const c = R.viewer.toContent(i, { x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
    const lineH = first.h * V().scale;
    const py = Math.max(4, lineH * sz.py);
    F.radius = Math.min(sz.r, (c.h + py * 2) / 2);
    F.target = { x: c.x - sz.px, y: c.y - py, w: c.w + sz.px * 2, h: c.h + py * 2 };
  }

  function scrollToTarget(instant) {
    const t = F.target;
    const want = R.clamp(t.y + t.h / 2 - scroller.clientHeight * ANCHOR, 0, scroller.scrollHeight - scroller.clientHeight);
    if (instant) { F.lastProgScroll = performance.now(); scroller.scrollTop = want; F.scrollTarget = null; }
    else F.scrollTarget = want;
  }

  /* ---------------- 导航 ---------------- */
  async function next() {
    if (!F.pos) return pickAtAnchor();
    const { i, k } = F.pos;
    const lines = await R.viewer.ensureLines(i);
    if (!V().pages[i] || F.pos?.i !== i || F.pos?.k !== k) return;
    const step = R.settings.focusLines === 'paragraph' ? R.reader.paragraphLength(i,k) : 1;
    if (k + step < lines.length) { for(let n=0;n<step;n++) R.bus.emit('line-read'); return setPos(i, k + step); }
    for (let j = i + 1; j < Math.min(V().pages.length, i + 8); j++) {
      const l = await R.viewer.ensureLines(j);
      if (l.length) { R.bus.emit('line-read'); R.bus.emit('page-done', i); return setPos(j, 0); }
    }
    if (i >= V().pages.length - 1) {
      stopPace();
      R.bus.emit('doc-done');
    }
  }
  async function prev() {
    if (!F.pos) return pickAtAnchor();
    const { i, k } = F.pos;
    if (k > 0) {
      if(R.settings.focusLines === 'paragraph') {
        let start=0,previous=0; while(start<k){previous=start;start+=R.reader.paragraphLength(i,start);} return setPos(i,previous);
      }
      return setPos(i, k - 1);
    }
    for (let j = i - 1; j >= Math.max(0, i - 8); j--) {
      const l = await R.viewer.ensureLines(j);
      if (l.length) return setPos(j, l.length - 1);
    }
  }

  /** 单击某处：点到哪行读哪行；点当前行 = 下一行 */
  function clickAt(i, x, y) {
    if (!F.on) return false;
    const k = R.viewer.lineAt(i, x, y, true);
    if (k < 0) return false;
    if (F.pos && F.pos.i === i && F.pos.k === k) next();
    else setPos(i, k);
    return true;
  }

  /* ---------------- 滚轮 ---------------- */
  function onWheel(e) {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      const s = V().scale * (e.deltaY < 0 ? 1.08 : 1 / 1.08);
      R.viewer.setScale(s);
      return;
    }
    if (!F.on || e.shiftKey || !V().pdf) return;
    e.preventDefault();
    const dy = e.deltaY * (e.deltaMode === 1 ? 18 : e.deltaMode === 2 ? 400 : 1);
    F.wheelAcc += dy;
    clearTimeout(F.wheelReset);
    F.wheelReset = setTimeout(() => (F.wheelAcc = 0), 220);
    const now = performance.now();
    if (Math.abs(F.wheelAcc) >= 40 && now - F.lastStepAt > 70) {
      const dir = Math.sign(F.wheelAcc);
      F.wheelAcc = 0;
      F.lastStepAt = now;
      if (F.pace) schedulePace(); // 手动操作时重置自动步进计时
      dir > 0 ? next() : prev();
    }
  }

  const resumeAfterManualScroll = R.debounce(() => {
    if (!F.on || !F.cur) return;
    const vy = F.cur.y - scroller.scrollTop;
    if (vy + F.cur.h < 0 || vy > scroller.clientHeight) pickAtAnchor();
  }, 280);

  function onScroll() {
    draw();
    if (performance.now() - F.lastProgScroll > 120 && F.scrollTarget === null) resumeAfterManualScroll();
  }

  /* ---------------- 弹簧动画 ---------------- */
  function startLoop() {
    if (!F.raf) { F.lastT = performance.now(); F.raf = requestAnimationFrame(tick); }
  }
  function tick(t) {
    const dt = Math.min(3, (t - F.lastT) / 16.67);
    F.lastT = t;
    let moving = false;
    if (F.cur && F.target) {
      // y 走得快、h 跟得慢 → 移动时框被“拉长”，到位后回弹，形成大小上的动态感
      const K = { x: [0.16, 0.7], y: [0.17, 0.68], w: [0.14, 0.7], h: [0.09, 0.72] };
      for (const key of ['x', 'y', 'w', 'h']) {
        const [k, d] = K[key];
        const diff = F.target[key] - F.cur[key];
        F.vel[key] = (F.vel[key] + diff * k * dt) * Math.pow(d, dt);
        F.cur[key] += F.vel[key] * dt;
        if (Math.abs(diff) > 0.3 || Math.abs(F.vel[key]) > 0.3) moving = true;
        else { F.cur[key] = F.target[key]; F.vel[key] = 0; }
      }
    }
    if (F.scrollTarget !== null) {
      const diff = F.scrollTarget - scroller.scrollTop;
      F.lastProgScroll = performance.now();
      if (Math.abs(diff) < 0.8) { scroller.scrollTop = F.scrollTarget; F.scrollTarget = null; }
      else { scroller.scrollTop += diff * Math.min(1, 0.16 * dt); moving = true; }
    }
    draw();
    F.raf = moving ? requestAnimationFrame(tick) : 0;
  }

  function roundRect(x, y, w, h, r) {
    r = Math.max(0, Math.min(r, w / 2, h / 2));
    return `M${x + r} ${y}H${x + w - r}A${r} ${r} 0 0 1 ${x + w} ${y + r}V${y + h - r}A${r} ${r} 0 0 1 ${x + w - r} ${y + h}` +
      `H${x + r}A${r} ${r} 0 0 1 ${x} ${y + h - r}V${y + r}A${r} ${r} 0 0 1 ${x + r} ${y}Z`;
  }

  function draw() {
    if (!F.on || !F.cur) { lens && (lens.style.opacity = 0); if (dim) dim.style.clipPath = 'none'; return; }
    const c = F.cur;
    // 速度 → 拉伸：竖向拉长、横向略收
    const speed = Math.abs(F.vel.y);
    const sy = 1 + Math.min(0.22, speed / 260);
    const sx = 1 - Math.min(0.025, speed / 1500);
    const w = c.w * sx, h = c.h * sy;
    const x = c.x - scroller.scrollLeft + (c.w - w) / 2;
    const y = c.y - scroller.scrollTop + (c.h - h) / 2;
    lens.style.opacity = 1;
    lens.style.width = w + 'px';
    lens.style.height = h + 'px';
    lens.style.transform = `translate3d(${x}px, ${y}px, 0)`;
    lens.style.borderRadius = F.radius + 'px';
    const W = layer.clientWidth, H = layer.clientHeight;
    let d = `M0 0H${W}V${H}H0Z ` + roundRect(x, y, w, h, F.radius);
    // 翻译卡片也保持清晰：在淡化层上为它们额外挖洞
    const lr = layer.getBoundingClientRect();
    for (const card of document.querySelectorAll('.tr-card')) {
      const r = card.getBoundingClientRect();
      if (r.bottom < lr.top || r.top > lr.bottom) continue;
      d += ' ' + roundRect(r.left - lr.left - 2, r.top - lr.top - 8, r.width + 4, r.height + 10, 12);
    }
    dim.style.clipPath = `path(evenodd, "${d}")`;
    dim.style.webkitClipPath = `path(evenodd, "${d}")`;
  }

  /* ---------------- 自动步进 ---------------- */
  function lineDuration() {
    if (!F.pos) return 2000;
    const l = V().pages[F.pos.i].lines[F.pos.k];
    let words;
    if (l.text) {
      const cjk = (l.text.match(/[\u3400-\u9fff]/g) || []).length;
      const latin = (l.text.replace(/[\u3400-\u9fff]/g, ' ').match(/[A-Za-z0-9]+/g) || []).length;
      words = latin + cjk / 2;
    } else {
      words = l.w / (l.h * 2.4); // 扫描版按行宽估算
    }
    words *= R.settings.focusLines === 'paragraph' ? (R.reader?.paragraphLength(F.pos.i,F.pos.k) || 1) : R.settings.focusLines || 1;
    return Math.max(900, (words / R.settings.paceWpm) * 60000) + 250;
  }
  function schedulePace() {
    clearTimeout(F.paceTimer);
    if (!F.pace) return;
    const ms = lineDuration();
    lens.style.setProperty('--pace-ms', ms + 'ms');
    lens.classList.remove('pacing');
    void lens.offsetWidth;
    lens.classList.add('pacing');
    F.paceTimer = setTimeout(() => { if (F.pace && !document.hidden) next(); else schedulePace(); }, ms);
  }
  async function togglePace(force) {
    F.pace = force === undefined ? !F.pace : force;
    R.$('#btnPace').classList.toggle('on', F.pace);
    if (F.pace) {
      if (!F.on) await enable(true);
      R.toast(`自动步进已开启：约 ${R.settings.paceWpm} 词/分钟，滚轮可随时接管`);
      schedulePace();
    } else stopPace();
  }
  function stopPace() {
    F.pace = false;
    clearTimeout(F.paceTimer);
    lens && lens.classList.remove('pacing');
    const b = R.$('#btnPace');
    b && b.classList.remove('on');
  }

  /* ---------------- 其他 ---------------- */
  function current() {
    if (!F.pos) return null;
    const p = V().pages[F.pos.i];
    return p && p.lines ? { i: F.pos.i, k: F.pos.k, line: p.lines[F.pos.k] } : null;
  }

  async function restore(pos) {
    if (!pos || !V().pages[pos.i]) return false;
    const lines = await R.viewer.ensureLines(pos.i);
    if (!lines.length) return false;
    sizeLayer();
    await setPos(pos.i, Math.min(pos.k, lines.length - 1), { instant: true, silent: true });
    lens.classList.add('resume');
    setTimeout(() => lens.classList.remove('resume'), 1600);
    return true;
  }

  function reset() {
    stopPace(); cancelAnimationFrame(F.raf); F.raf = 0; F.on = false; F.pos = null; F.cur = null; F.target = null; F.scrollTarget = null;
    F.vel = { x:0,y:0,w:0,h:0 }; clearTimeout(F.wheelReset); resumeAfterManualScroll.cancel(); R.hide(layer);
  }
  return { F, init, enable, toggle, next, prev, setPos, clickAt, togglePace, stopPace, current, restore, pickAtAnchor, redraw: draw, isOn: () => F.on, reset };
})();
