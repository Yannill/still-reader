/* viewer.js —— PDF 渲染、懒加载、缩放、坐标换算、行数据
 * 坐标约定：标注/行 都存“scale=1 视口坐标”（左上角为原点，单位=PDF 点），显示时乘以 V.scale。
 */
'use strict';
R.viewer = (() => {
  const V = {
    pdf: null, meta: null, bytes: null, pages: [], scale: 1, maxPageW: 900,
    scroller: null, pagesEl: null,
  };
  let observer = null;
  const DPR = () => Math.min(window.devicePixelRatio || 1, 2);

  function init() {
    V.scroller = R.$('#scroller');
    V.pagesEl = R.$('#pages');
    window.addEventListener('resize', R.debounce(() => {
      if (V.pdf && V.fitMode) setScale(V.fitMode === 'page' ? fitPageScale() : fitScale(), { fit: V.fitMode });
      R.bus.emit('layout');
    }, 200));
  }

  async function open(meta, bytes, preparedPdf) {
    close();
    V.meta = meta;
    V.bytes = bytes;
    const task = preparedPdf ? null : pdfjsLib.getDocument({
      data: bytes.slice(0), // pdf.js 会转移 buffer，传副本，原件留给 pdf-lib
      cMapUrl: R.PDFJS.cmaps, cMapPacked: true, standardFontDataUrl: R.PDFJS.fonts,
    });
    V.pdf = preparedPdf || await task.promise;
    V.pages = [];
    for (let i = 1; i <= V.pdf.numPages; i++) {
      const page = await V.pdf.getPage(i);
      V.pages.push({
        i: i - 1, page, vp1: page.getViewport({ scale: 1 }),
        el: null, canvas: null, textLayer: null, svg: null, notes: null,
        rendered: false, rendering: false, renderTask: null,
        textPromise: null, lines: null, linesPromise: null, scanned: null,
      });
    }
    V.fitMode = true;
    V.scale = fitScale();
    buildDom();
    return V;
  }

  function close() {
    if (observer) observer.disconnect();
    V.pages.forEach((p) => { try { p.renderTask && p.renderTask.cancel(); } catch { /* */ } });
    if (V.pdf) { try { V.pdf.destroy(); } catch { /* */ } }
    V.pdf = null;
    V.bytes = null;
    V.pages = [];
    if (V.pagesEl) V.pagesEl.innerHTML = '';
  }

  /* 适应宽度：整页完整显示在阅读区，但限制最大行宽，避免一行过长难以追踪 */
  function fitScale() {
    const avail = Math.max(100, V.scroller.clientWidth - (innerWidth < 900 ? 24 : 72));
    const pw = Math.max(...V.pages.map((p) => p.vp1.width));
    return R.clamp(Math.min(avail, V.maxPageW) / pw, 0.4, 3);
  }

  function fitPageScale() {
    const p = V.pages[currentPage()];
    return p ? R.clamp(Math.min((V.scroller.clientWidth - 32) / p.vp1.width, (V.scroller.clientHeight - 100) / p.vp1.height), .15, 3) : 1;
  }

  function buildDom() {
    V.pagesEl.innerHTML = '';
    V.pagesEl.style.setProperty('--s', V.scale);
    if (observer) observer.disconnect();
    observer = new IntersectionObserver(
      (entries) => entries.forEach((e) => { if (e.isIntersecting) renderPage(V.pages[+e.target.dataset.i]); }),
      { root: V.scroller, rootMargin: '1400px 0px' }
    );
    for (const p of V.pages) {
      const el = document.createElement('div');
      el.className = 'page';
      el.dataset.i = p.i;
      el.innerHTML =
        `<canvas></canvas><div class="paper-tint" aria-hidden="true"></div>` +
        `<svg class="ann-layer" viewBox="0 0 ${p.vp1.width} ${p.vp1.height}" preserveAspectRatio="none"></svg>` +
        `<div class="textLayer"></div><div class="note-layer"></div><div class="page-no">${p.i + 1}</div>`;
      p.el = el;
      p.canvas = el.querySelector('canvas');
      p.svg = el.querySelector('svg');
      p.textLayer = el.querySelector('.textLayer');
      p.notes = el.querySelector('.note-layer');
      sizePage(p);
      V.pagesEl.appendChild(el);
      observer.observe(el);
    }
    R.bus.emit('pages-built');
  }

  function sizePage(p) {
    p.el.style.width = p.vp1.width * V.scale + 'px';
    p.el.style.height = p.vp1.height * V.scale + 'px';
    p.el.style.setProperty('--scale-factor', V.scale);
  }

  async function getText(p) {
    if (!p.textPromise) p.textPromise = p.page.getTextContent();
    return p.textPromise;
  }

  async function renderPage(p) {
    if (!p || p.rendered || p.rendering) return;
    p.rendering = true;
    const scale = V.scale;
    const vp = p.page.getViewport({ scale });
    const dpr = DPR();
    const off = document.createElement('canvas'); // 先画到离屏，画完再替换，缩放时不闪白
    off.width = Math.floor(vp.width * dpr);
    off.height = Math.floor(vp.height * dpr);
    try {
      p.renderTask = p.page.render({
        canvasContext: off.getContext('2d'),
        viewport: vp,
        transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null,
        annotationMode: pdfjsLib.AnnotationMode.DISABLE, // 标注由我们自己的图层绘制（可编辑）
      });
      await p.renderTask.promise;
    } catch (e) {
      p.rendering = false;
      if (e && e.name === 'RenderingCancelledException') return;
      console.error(e);
      return;
    }
    if (scale !== V.scale || !p.el) { p.rendering = false; return; }
    off.className = '';
    p.el.replaceChild(off, p.canvas);
    p.canvas = off;

    try {
      const tc = await getText(p);
      p.textLayer.innerHTML = '';
      await pdfjsLib.renderTextLayer({ textContentSource: tc, container: p.textLayer, viewport: vp, textDivs: [] }).promise;
    } catch (e) { console.warn('text layer', e); }

    p.rendered = true;
    p.rendering = false;
    R.bus.emit('page-rendered', p.i);
    ensureLines(p.i);
  }

  /* 行数据：文字版用 textContent，扫描版用像素投影 */
  function ensureLines(i) {
    const p = V.pages[i];
    if (!p) return Promise.resolve([]);
    if (p.lines) return Promise.resolve(p.lines);
    if (p.linesPromise) return p.linesPromise;
    const pdfRef = V.pdf;
    p.linesPromise = (async () => {
      let lines = [];
      try {
        const tc = await getText(p);
        const chars = tc.items.reduce((n, it) => n + (it.str ? it.str.trim().length : 0), 0);
        if (chars >= 15) { lines = R.core.linesFromText(tc, p.vp1); p.scanned = false; }
        if (!lines.length) { p.scanned = true; lines = await detectScanned(p); }
      } catch (e) { console.warn('lines', e); }
      if (pdfRef !== V.pdf) return [];
      p.lines = lines;
      R.bus.emit('lines-ready', i);
      return lines;
    })();
    return p.linesPromise;
  }

  async function detectScanned(p) {
    const s = R.clamp(1400 / p.vp1.width, 1, 2.5);
    const canvas = await renderOffscreen(p, s);
    return R.core.linesFromCanvas(canvas, s);
  }

  async function renderOffscreen(p, scale) {
    const vp = p.page.getViewport({ scale });
    const c = document.createElement('canvas');
    c.width = Math.floor(vp.width);
    c.height = Math.floor(vp.height);
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, c.width, c.height);
    await p.page.render({ canvasContext: ctx, viewport: vp, annotationMode: pdfjsLib.AnnotationMode.DISABLE }).promise;
    return c;
  }

  /** 页面截图（可裁剪区域，scale=1 坐标），给支持图像的大模型用 */
  async function pageImage(i, rect, maxW = 1280) {
    const p = V.pages[i];
    const s = R.clamp(maxW / (rect ? rect.w : p.vp1.width), 0.5, 3);
    const c = await renderOffscreen(p, s);
    if (!rect) return c.toDataURL('image/jpeg', 0.85);
    const pad = 4;
    const cx = Math.max(0, (rect.x - pad) * s), cy = Math.max(0, (rect.y - pad) * s);
    const cw = Math.min(c.width - cx, (rect.w + pad * 2) * s), ch = Math.min(c.height - cy, (rect.h + pad * 2) * s);
    const out = document.createElement('canvas');
    out.width = Math.max(1, Math.round(cw));
    out.height = Math.max(1, Math.round(ch));
    out.getContext('2d').drawImage(c, cx, cy, cw, ch, 0, 0, out.width, out.height);
    return out.toDataURL('image/jpeg', 0.9);
  }

  /* ---------------- 缩放 ---------------- */
  function setScale(s, { fit = false } = {}) {
    s = R.clamp(s, 0.15, 4);
    V.fitMode = fit;
    if (!V.pdf || Math.abs(s - V.scale) < 0.001) { R.bus.emit('zoom', V.scale); return; }
    const anchor = captureAnchor();
    V.scale = s;
    V.pagesEl.style.setProperty('--s', s);
    for (const p of V.pages) {
      try { p.renderTask && p.renderTask.cancel(); } catch { /* */ }
      p.rendered = false;
      p.rendering = false;
      p.textLayer.innerHTML = '';
      sizePage(p);
    }
    restoreAnchor(anchor);
    // 触发可见页重绘
    V.pages.forEach((p) => { observer.unobserve(p.el); observer.observe(p.el); });
    R.bus.emit('zoom', s);
  }

  function captureAnchor() {
    const sc = V.scroller;
    const cy = sc.scrollTop + sc.clientHeight * 0.4;
    for (const p of V.pages) {
      if (p.el.offsetTop + p.el.offsetHeight >= cy) return { i: p.i, r: (cy - p.el.offsetTop) / p.el.offsetHeight };
    }
    return null;
  }
  function restoreAnchor(a) {
    if (!a) return;
    const p = V.pages[a.i];
    V.scroller.scrollTop = p.el.offsetTop + a.r * p.el.offsetHeight - V.scroller.clientHeight * 0.4;
  }

  /* ---------------- 坐标换算 ---------------- */
  /** scale=1 页面坐标矩形 → 滚动内容坐标 */
  function toContent(i, r) {
    const el = V.pages[i].el;
    return { x: el.offsetLeft + r.x * V.scale, y: el.offsetTop + r.y * V.scale, w: r.w * V.scale, h: r.h * V.scale };
  }
  /** 屏幕坐标 → {i, x, y}（scale=1 页面坐标） */
  function fromClient(cx, cy, hintEl) {
    let el = hintEl && hintEl.closest ? hintEl.closest('.page') : null;
    const test = (p) => {
      const r = p.el.getBoundingClientRect();
      return cx >= r.left && cx <= r.right && cy >= r.top - 8 && cy <= r.bottom + 8 ? r : null;
    };
    let p = el ? V.pages[+el.dataset.i] : null;
    let rect = p && test(p);
    if (!rect) {
      p = null;
      for (const q of V.pages) { const r = test(q); if (r) { p = q; rect = r; break; } }
    }
    if (!p) return null;
    return { i: p.i, x: (cx - rect.left) / V.scale, y: (cy - rect.top) / V.scale };
  }

  /** 找到点所在的行（返回行索引或 -1） */
  function lineAt(i, x, y, loose = false) {
    const lines = V.pages[i] && V.pages[i].lines;
    if (!lines || !lines.length) return -1;
    let best = -1, bestD = Infinity;
    lines.forEach((l, k) => {
      const padY = l.h * (loose ? 0.9 : 0.35);
      const padX = Math.max(l.fh || l.h, 8) * (loose ? 4 : 1.5);
      if (y < l.y - padY || y > l.y + l.h + padY) return;
      if (x < l.x - padX || x > l.x + l.w + padX) return;
      const d = Math.abs(y - (l.y + l.h / 2)) + (x < l.x || x > l.x + l.w ? 3 : 0);
      if (d < bestD) { bestD = d; best = k; }
    });
    return best;
  }

  function currentPage() {
    const sc = V.scroller;
    const mid = sc.scrollTop + sc.clientHeight * 0.4;
    for (const p of V.pages) if (p.el.offsetTop + p.el.offsetHeight >= mid) return p.i;
    return Math.max(0, V.pages.length - 1);
  }

  async function pageText(i) {
    const lines = await ensureLines(i);
    return lines.map((l) => l.text).filter(Boolean).join('\n');
  }

  /** 行内某个 x 区间对应的文字（文字版） */
  function textInRange(line, x0, x1) {
    if (!line.items || !line.items.length) return '';
    let t = '';
    for (const it of line.items) {
      if (it.x2 < x0 || it.x > x1) continue;
      if (it.x >= x0 && it.x2 <= x1) { t += it.str; continue; }
      // 部分覆盖：按字符比例截取
      const n = it.str.length;
      const span = Math.max(1e-3, it.x2 - it.x);
      const a = Math.floor(R.clamp((x0 - it.x) / span, 0, 1) * n);
      const b = Math.ceil(R.clamp((x1 - it.x) / span, 0, 1) * n);
      t += it.str.slice(a, b);
    }
    return t.replace(/\s+/g, ' ').trim();
  }

  return {
    V, init, open, close, setScale, fitScale, fitPageScale, captureAnchor, restoreAnchor, ensureLines, renderPage, toContent, fromClient, lineAt,
    currentPage, pageText, pageImage, textInRange,
  };
})();
