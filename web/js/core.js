/* core.js —— 阅读器核心算法（与 cpp/core 中的 C++ 实现一一对应）
 *
 * 1. 文字版 PDF：把 pdf.js 的文字块按基线聚成“行”，并按版面（单栏/双栏）排阅读顺序
 * 2. 扫描版 PDF：自适应二值化 + 水平投影 → 行带 → 垂直投影 → 行段（与 C++ LineDetector 同算法）
 * 3. 离线标题：从元数据/首页大字号文本/文件名中提炼“开题报告”这类简短中文标题
 *
 * 如果 web/wasm/reader_core.js（由 C++ 用 Emscripten 编译）存在，扫描版检测和标题生成
 * 会优先调用 C++/WASM 版本；否则使用本文件的 JS 版本，结果一致。
 */
'use strict';
R.core = (() => {
  let wasm = null;

  async function init() {
    if (typeof window.createReaderCore === 'function') {
      try {
        wasm = await window.createReaderCore();
        console.info('[core] C++ WebAssembly 核心已加载');
      } catch (e) {
        console.warn('[core] WASM 加载失败，使用 JS 版本', e);
      }
    }
    return !!wasm;
  }

  /* ------------------------------------------------------------------ */
  /*  阅读顺序：识别双栏，先左栏后右栏；通栏行（标题/图注）打断分栏块     */
  /* ------------------------------------------------------------------ */
  function orderLines(lines, pageW) {
    const sorted = lines.slice().sort((a, b) => a.y - b.y || a.x - b.x);
    const out = [];
    let run = [];
    const flush = () => {
      if (!run.length) return;
      const left = run.filter((l) => l.x + l.w / 2 < pageW / 2);
      const right = run.filter((l) => l.x + l.w / 2 >= pageW / 2);
      const twoCol =
        left.length >= 3 && right.length >= 3 &&
        Math.min(...right.map((l) => l.x)) > pageW * 0.38 &&
        Math.max(...left.map((l) => l.x + l.w)) < pageW * 0.62;
      if (twoCol) out.push(...left, ...right);
      else out.push(...run);
      run = [];
    };
    for (const l of sorted) {
      if (l.w < pageW * 0.6) run.push(l);
      else { flush(); out.push(l); }
    }
    flush();
    return out;
  }

  /* ------------------------------------------------------------------ */
  /*  文字版：pdf.js textContent → 行                                      */
  /* ------------------------------------------------------------------ */
  function linesFromText(textContent, vp1) {
    const segs = [];
    for (const it of textContent.items) {
      if (!it.str || !it.str.trim()) continue;
      const tx = pdfjsLib.Util.transform(vp1.transform, it.transform);
      const fh = Math.hypot(tx[2], tx[3]);
      if (fh < 2) continue;
      // 跳过竖排/旋转文字
      if (Math.abs(tx[1]) > Math.abs(tx[0]) * 0.5 + 0.01) continue;
      const x = tx[4];
      const base = tx[5];
      const w = Math.max(it.width * vp1.scale, fh * 0.3);
      segs.push({ x, x2: x + w, base, fh, top: base - fh * 0.86, bottom: base + fh * 0.24, str: it.str });
    }
    if (!segs.length) return [];
    segs.sort((a, b) => a.base - b.base || a.x - b.x);

    // 1) 按基线聚类成“行”
    const rows = [];
    for (const s of segs) {
      const row = rows[rows.length - 1];
      if (row && Math.abs(s.base - row.base) <= Math.max(2, 0.42 * Math.min(row.fh, s.fh))) {
        row.items.push(s);
        row.fh = Math.max(row.fh, s.fh);
      } else {
        rows.push({ base: s.base, fh: s.fh, items: [s] });
      }
    }
    // 2) 合并上下标（小字号且与上一行竖直重叠）
    for (let i = rows.length - 1; i > 0; i--) {
      const a = rows[i - 1], b = rows[i];
      const aTop = Math.min(...a.items.map((s) => s.top)), aBot = Math.max(...a.items.map((s) => s.bottom));
      const bTop = Math.min(...b.items.map((s) => s.top)), bBot = Math.max(...b.items.map((s) => s.bottom));
      const overlap = Math.min(aBot, bBot) - Math.max(aTop, bTop);
      const small = Math.min(a.fh, b.fh) < 0.75 * Math.max(a.fh, b.fh);
      if (small && overlap > 0.3 * Math.min(aBot - aTop, bBot - bTop)) {
        a.items.push(...b.items);
        a.fh = Math.max(a.fh, b.fh);
        if (b.fh > a.fh) a.base = b.base;
        rows.splice(i, 1);
      }
    }
    // 3) 行内按大间距切成段（分栏/表格）
    const lines = [];
    for (const row of rows) {
      const items = row.items.sort((a, b) => a.x - b.x);
      let cur = null;
      const push = () => {
        if (!cur) return;
        const top = Math.min(...cur.items.map((s) => s.top));
        const bottom = Math.max(...cur.items.map((s) => s.bottom));
        const x = cur.items[0].x;
        const x2 = Math.max(...cur.items.map((s) => s.x2));
        let text = '';
        cur.items.forEach((s, k) => {
          if (k > 0) {
            const gap = s.x - cur.items[k - 1].x2;
            const prev = text.slice(-1);
            if (gap > row.fh * 0.22 && !(R.isCJK(prev) && R.isCJK(s.str[0])) && prev !== ' ') text += ' ';
          }
          text += s.str;
        });
        lines.push({
          x, y: top, w: x2 - x, h: bottom - top, fh: row.fh, text: text.replace(/\s+/g, ' ').trim(),
          items: cur.items.map((s) => ({ x: s.x, x2: s.x2, str: s.str })),
        });
      };
      for (const s of items) {
        if (cur && s.x - cur.x2 > Math.max(1.8 * row.fh, 12)) { push(); cur = null; }
        if (!cur) cur = { items: [], x2: -Infinity };
        cur.items.push(s);
        cur.x2 = Math.max(cur.x2, s.x2);
      }
      push();
    }
    return orderLines(lines.filter((l) => l.h > 2 && l.w > 2), vp1.width);
  }

  /* ------------------------------------------------------------------ */
  /*  扫描版：像素 → 行（JS 版，与 C++ LineDetector::detect 一致）         */
  /* ------------------------------------------------------------------ */
  function detectLinesJS(rgba, w, h) {
    const N = w * h;
    const gray = new Uint8Array(N);
    for (let i = 0, j = 0; i < N; i++, j += 4) gray[i] = (rgba[j] * 77 + rgba[j + 1] * 150 + rgba[j + 2] * 29) >> 8;

    // 积分图 → 局部均值（自适应阈值，抗阴影/光照不均）
    const W1 = w + 1;
    const integ = new Float64Array(W1 * (h + 1));
    for (let y = 0; y < h; y++) {
      let row = 0;
      for (let x = 0; x < w; x++) {
        row += gray[y * w + x];
        integ[(y + 1) * W1 + x + 1] = integ[y * W1 + x + 1] + row;
      }
    }
    const rad = Math.max(8, Math.round(Math.min(w, h) / 30));
    const dark = new Uint8Array(N);
    const colSum = new Int32Array(w);
    for (let y = 0; y < h; y++) {
      const y0 = Math.max(0, y - rad), y1 = Math.min(h, y + rad + 1);
      for (let x = 0; x < w; x++) {
        const x0 = Math.max(0, x - rad), x1 = Math.min(w, x + rad + 1);
        const area = (x1 - x0) * (y1 - y0);
        const sum = integ[y1 * W1 + x1] - integ[y0 * W1 + x1] - integ[y1 * W1 + x0] + integ[y0 * W1 + x0];
        const g = gray[y * w + x];
        if (g < sum / area - 20 && g < 215) { dark[y * w + x] = 1; colSum[x]++; }
      }
    }
    // 去掉扫描黑边（整列/整行大面积暗）
    const colMask = new Uint8Array(w);
    for (let x = 0; x < w; x++) colMask[x] = colSum[x] > h * 0.45 ? 1 : 0;
    const rowCount = new Int32Array(h);
    for (let y = 0; y < h; y++) {
      let c = 0;
      for (let x = 0; x < w; x++) if (dark[y * w + x] && !colMask[x]) c++;
      rowCount[y] = c > w * 0.6 ? 0 : c;
    }
    // 水平投影 → 行带
    const thr = Math.max(2, w * 0.003);
    let bands = [];
    let start = -1;
    for (let y = 0; y <= h; y++) {
      const on = y < h && rowCount[y] > thr;
      if (on && start < 0) start = y;
      if (!on && start >= 0) { bands.push({ y0: start, y1: y }); start = -1; }
    }
    // 合并极小间隙
    const merged = [];
    for (const b of bands) {
      const last = merged[merged.length - 1];
      if (last && b.y0 - last.y1 <= 1) last.y1 = b.y1;
      else merged.push({ ...b });
    }
    bands = merged.filter((b) => b.y1 - b.y0 >= 3);
    if (!bands.length) return [];
    const hs = bands.map((b) => b.y1 - b.y0).sort((a, b) => a - b);
    const med = hs[Math.floor(hs.length / 2)];

    // 过高的行带可能是两行粘连 → 在投影最小处切开
    const split = (b, depth) => {
      const bh = b.y1 - b.y0;
      if (depth > 3 || bh < 1.7 * med) return [b];
      let sum = 0;
      for (let y = b.y0; y < b.y1; y++) sum += rowCount[y];
      const avg = sum / bh;
      let best = -1, bestV = Infinity;
      for (let y = b.y0 + Math.round(med * 0.5); y < b.y1 - Math.round(med * 0.5); y++) {
        if (rowCount[y] < bestV) { bestV = rowCount[y]; best = y; }
      }
      if (best < 0 || bestV > avg * 0.35) return [b];
      return [...split({ y0: b.y0, y1: best }, depth + 1), ...split({ y0: best + 1, y1: b.y1 }, depth + 1)];
    };
    bands = bands.flatMap((b) => split(b, 0)).filter((b) => {
      const bh = b.y1 - b.y0;
      return bh <= 3.5 * med && bh >= Math.max(3, 0.3 * med);
    });

    // 垂直投影 → 行段（处理双栏）
    const lines = [];
    const colCount = new Int32Array(w);
    for (const b of bands) {
      colCount.fill(0);
      for (let y = b.y0; y < b.y1; y++) for (let x = 0; x < w; x++) if (dark[y * w + x] && !colMask[x]) colCount[x]++;
      const bh = b.y1 - b.y0;
      const gapThr = Math.max(1.6 * bh, w * 0.02);
      let segStart = -1, lastOn = -1, mass = 0;
      const flush = () => {
        if (segStart < 0) return;
        const sw = lastOn - segStart + 1;
        if (sw >= 0.4 * med && mass >= med * 2) lines.push({ x: segStart, y: b.y0, w: sw, h: bh });
        segStart = -1; mass = 0;
      };
      for (let x = 0; x < w; x++) {
        if (colCount[x] > 0) {
          if (segStart >= 0 && x - lastOn > gapThr) flush();
          if (segStart < 0) segStart = x;
          lastOn = x;
          mass += colCount[x];
        }
      }
      flush();
    }
    return orderLines(lines, w);
  }

  function detectLinesWasm(rgba, w, h) {
    const M = wasm;
    const maxLines = 600;
    const inPtr = M._malloc(rgba.length);
    const outPtr = M._malloc(maxLines * 16);
    try {
      M.HEAPU8.set(rgba, inPtr);
      const n = M._rc_detect_lines(inPtr, w, h, outPtr, maxLines);
      const out = [];
      const base = outPtr >> 2;
      for (let i = 0; i < n; i++) {
        out.push({ x: M.HEAP32[base + i * 4], y: M.HEAP32[base + i * 4 + 1], w: M.HEAP32[base + i * 4 + 2], h: M.HEAP32[base + i * 4 + 3] });
      }
      return out;
    } finally {
      M._free(inPtr);
      M._free(outPtr);
    }
  }

  /** 扫描页行检测：canvas 像素 → 行（坐标已除以 renderScale，回到 scale=1 空间） */
  function linesFromCanvas(canvas, renderScale) {
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const { width: w, height: h } = canvas;
    const data = ctx.getImageData(0, 0, w, h).data;
    let lines;
    try { lines = wasm ? detectLinesWasm(data, w, h) : detectLinesJS(data, w, h); }
    catch (e) { console.warn(e); lines = detectLinesJS(data, w, h); }
    return lines.map((l) => ({
      x: l.x / renderScale, y: l.y / renderScale, w: l.w / renderScale, h: l.h / renderScale,
      fh: l.h / renderScale, text: '', items: [], scanned: true,
    }));
  }

  /* ------------------------------------------------------------------ */
  /*  离线标题提炼（与 C++ TitleSummarizer 一致）                         */
  /* ------------------------------------------------------------------ */
  const DOC_TYPES = ['开题报告', '文献综述', '实验报告', '课程设计', '课程论文', '毕业论文', '毕业设计', '学位论文',
    '读书报告', '调研报告', '研究报告', '中期报告', '结题报告', '任务书', '说明书', '讲义', '课件', '教案', '笔记',
    '习题', '作业', '试卷', '简历', '合同', '白皮书', '综述', '论文', '报告', '手册', '指南', '教程'];
  const EN_STOP = new Set(['a', 'an', 'the', 'of', 'for', 'and', 'or', 'in', 'on', 'to', 'with', 'by', 'from', 'at', 'via', 'using', 'towards', 'toward', 'into']);

  function cleanTitle(s) {
    return String(s || '')
      .replace(/^microsoft\s+(word|powerpoint)\s*-\s*/i, '')
      .replace(/\.(pdf|docx?|pptx?|txt|caj)$/i, '')
      .replace(/[_]+/g, ' ')
      .replace(/^(?=[0-9A-F]*\d)[0-9A-F]{6,}\s+/i, '') // 153B6CB7_Level 2 → Level 2
      .replace(/^[\s\d.\-()（）\[\]【】]+(?=\D)/, '')
      .replace(/\s+/g, ' ')
      .trim();
  }
  function looksValid(t) {
    if (!t || t.length < 2) return false;
    if (/^[\d\s.\-]+$/.test(t)) return false;
    if (/^[0-9a-f\-_\s]{8,}$/i.test(t)) return false; // 哈希式文件名
    if (/^(untitled|unknown|document|文档\d*|新建.*)$/i.test(t)) return false;
    return true;
  }
  function shortenTitle(t) {
    if (R.cjkRatio(t) > 0.3) {
      let s = t.replace(/[\s《》“”"'「」【】\[\]()（）:：,，.。!！?？、\-—_·]/g, '');
      s = s.replace(/^(基于|关于|浅析|浅谈|试论|论)/, '');
      const type = DOC_TYPES.find((k) => s.includes(k));
      const stripSuffix = (x) => x.replace(/(的?研究|的?分析|的?设计与实现|的?设计|探究|探讨|初探|方法)$/, '');
      if (type) {
        let topic = s.slice(0, s.indexOf(type));
        const segs = topic.split('的').filter(Boolean);
        topic = stripSuffix(segs.length ? segs[segs.length - 1] : '');
        if (topic.length > 4) topic = topic.slice(-4);
        return topic.length >= 2 ? topic + type : type;
      }
      if (s.length <= 8) return s;
      const segs = s.split('的').map(stripSuffix).filter((x) => x.length >= 2);
      const pick = segs.length ? segs[segs.length - 1] : s;
      return pick.slice(0, 8);
    }
    const words = t.split(/\s+/).filter(Boolean);
    if (t.length <= 26) return t;
    const sig = words.filter((w) => !EN_STOP.has(w.toLowerCase()));
    return sig.slice(0, 4).join(' ');
  }
  function summarizeTitleJS(candidates, fileName) {
    for (const c of candidates) {
      const t = cleanTitle(c);
      if (looksValid(t)) return shortenTitle(t);
    }
    const f = cleanTitle(fileName);
    return looksValid(f) ? shortenTitle(f) : '未命名文档';
  }
  function summarizeTitle(candidates, fileName) {
    if (wasm) {
      try {
        const input = [...candidates, fileName].join('\n');
        const M = wasm;
        const len = M.lengthBytesUTF8(input) + 1;
        const inPtr = M._malloc(len);
        const outPtr = M._malloc(256);
        M.stringToUTF8(input, inPtr, len);
        const n = M._rc_summarize_title(inPtr, outPtr, 256);
        const res = n > 0 ? M.UTF8ToString(outPtr) : '';
        M._free(inPtr); M._free(outPtr);
        if (res) return res;
      } catch (e) { console.warn(e); }
    }
    return summarizeTitleJS(candidates, fileName);
  }

  return { init, orderLines, linesFromText, linesFromCanvas, detectLinesJS, summarizeTitle, hasWasm: () => !!wasm };
})();
