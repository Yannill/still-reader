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
    wheelAcc: 0, lastStepAt: 0, wheelReset: 0, wheelLastAt: 0, wheelLastAbs: 0, wheelDir: 0, wheelInertia: false,
    pace: false, paceTimer: 0,
    winBox: null, busy: false, epoch: 0, blocked: false,
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
    initWindowDrag();
    R.bus.on('pages-built', () => { F.pos = null; F.cur = null; F.winBox = null; stopPace(); draw(); });
    R.bus.on('zoom', () => { if (F.pos) { computeTarget(); F.cur = { ...F.target }; scrollToTarget(true); draw(); } });
    R.bus.on('layout', () => { sizeLayer(); if (F.pos) { computeTarget(); F.cur = { ...F.target }; draw(); } });
    R.bus.on('settings', applyStyle);
    R.bus.on('pages-built',()=>{F.scanHinted=false;});
    applyStyle();
  }

  function applyStyle() {
    if (!dim) return;
    const s = R.settings;
    if (!['line', 'window'].includes(s.focusMode)) s.focusMode = 'line';
    dim.style.setProperty('--dim', s.dim);
    dim.classList.toggle('blur', !!s.blur);
    lens.classList.toggle('pace-progress-hidden', s.paceProgress === false);
    document.body.dataset.focusMode=s.focusMode;
    const modeCtrl = R.$('#focusModeControl');
    if (modeCtrl && modeCtrl.value !== s.focusMode) modeCtrl.value = s.focusMode;
    if(F.mode && F.mode!==s.focusMode){
      stopPace(); F.wheelAcc=0; F.blocked=false;
      if(s.focusMode==='window' && !F.winBox){ensureWindowBox(true);}
    }
    F.mode=s.focusMode;
    if (F.pos) { computeTarget(); startLoop(); }
  }

  function ensureWindowBox(force = false) {
    if (F.winBox && !force) return;
    const pageIdx = F.pos ? F.pos.i : R.viewer.currentPage();
    const p = V().pages[pageIdx];
    if (!p || !p.el) return;
    const pageW = p.vp1.width * V().scale;
    const pageLeft = p.el.offsetLeft;
    const margin = Math.max(14, Math.min(28, pageW * 0.04));
    const maxW = Math.max(180, scroller.clientWidth - 28);
    const w = Math.min(maxW, Math.max(220, pageW - margin * 2));
    let cy = scroller.scrollTop + scroller.clientHeight * ANCHOR;
    if (F.pos && p.lines?.[F.pos.k]) {
      const c = R.viewer.toContent(pageIdx, p.lines[F.pos.k]);
      cy = c.y + c.h / 2;
    }
    const h = Math.max(84, Math.round(scroller.clientHeight * 0.16));
    const maxX = Math.max(12, Math.max(scroller.clientWidth, scroller.scrollWidth) - w - 12);
    const x = R.clamp(pageLeft + margin, 12, maxX);
    F.winBox = { x, y: Math.max(p.el.offsetTop + 12, cy - h / 2), w, h };
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
    if (!on) { stopPace(); F.scrollTarget=null; draw(); return; }
    sizeLayer();
    if (!F.pos) {
      if (scroller.scrollTop < 40) await startAtFirstLine();
      else await pickAtAnchor();
    } else { computeTarget(); F.cur = F.cur || { ...F.target }; startLoop(); }
  }

  /** 刚打开文档：从第一页的第一行开始 */
  async function startAtFirstLine() {
    const lines = await R.viewer.ensureLines(0), seq=R.text.sequence(lines,R.settings.readingContent);
    if (seq.length) return setPos(0,seq[0],{scroll:false,instant:true});
    recoverHint();
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
    const epoch=F.epoch;
    await R.viewer.ensureLines(i);
    if(epoch!==F.epoch || !V().pages[i])return;
    const lines = V().pages[i].lines;
    if (!lines || !lines[k]) return;
    F.pos = { i, k };
    if(V().pages[i].scanned&&!F.scanHinted){F.scanHinted=true;R.toast('扫描页目前仅检测图像行带，尚无 OCR 文字；可随时关闭玻璃框正常浏览。','info',5000);}
    F.blocked=false;
    if (R.settings.focusMode === 'window') {
      if (!F.winBox) ensureWindowBox(true);
      else if (lines[k]) {
        const c = R.viewer.toContent(i, lines[k]);
        const maxY = Math.max(10, scroller.scrollHeight - F.winBox.h - 10);
        F.winBox.y = R.clamp(c.y + c.h / 2 - F.winBox.h / 2, 10, maxY);
      }
    }
    computeTarget();
    if (!F.cur || instant) F.cur = { ...F.target };
    if (scroll) scrollToTarget(instant || Math.abs((F.target?.y||0)-scroller.scrollTop)>scroller.clientHeight*2);
    startLoop();
    if(instant)draw();
    if (!silent) R.bus.emit('focus-move', { i, k, total: lines.length });
    if (F.pace) schedulePace();
  }

  function computeTarget() {
    if(!F.pos || !V().pages[F.pos.i]?.lines?.[F.pos.k])return;
    const { i, k } = F.pos;
    const pageObj = V().pages[i];
    const lines = pageObj.lines;
    const first = lines[k];
    let y0 = first.y, y1 = first.y + first.h;
    // 逐行阅读：仅吸收同行公式片段与小尺寸上下标（避免紧排双栏论文中吞并紧邻下一行正文）
    if (R.settings.focusMode === 'line') {
      const firstMid = first.y + first.h / 2;
      for (const l of lines) {
        if (l === first || l.column !== first.column) continue;
        const overlapY = Math.min(y1, l.y + l.h) - Math.max(y0, l.y);
        if (overlapY <= 0) continue;
        const isSmallScript = l.h < first.h * 0.72 && overlapY > l.h * 0.25;
        const isSameBand = overlapY > Math.min(first.h, l.h) * 0.48 && Math.abs((l.y + l.h / 2) - firstMid) < Math.max(first.h, l.h) * 0.55;
        if (isSmallScript || isSameBand) {
          y0 = Math.min(y0, l.y);
          y1 = Math.max(y1, l.y + l.h);
        }
      }
    }
    F.band = { i, y0, y1 };
    // 逐行阅读：玻璃框固定与页面同宽（双栏页则与当前栏同宽），彻底杜绝只框住单个符号
    const pageW = pageObj.vp1.width;
    const twoCol = lines.some(l => l.column === 1);
    const pageMargin = Math.min(14, pageW * 0.024);
    let x0, x1;
    if (R.settings.focusMode === 'line') {
      if (twoCol && (first.column === 0 || first.column === 1)) {
        const colLines = lines.filter(l => l.column === first.column);
        x0 = Math.max(pageMargin, Math.min(...colLines.map(l => l.x)) - 6);
        x1 = Math.min(pageW - pageMargin, Math.max(...colLines.map(l => l.x + l.w)) + 6);
      } else {
        x0 = pageMargin;
        x1 = pageW - pageMargin;
      }
    } else {
      x0 = first.x;
      x1 = first.x + first.w;
    }
    const sz = SIZES[R.settings.lensSize] || SIZES.comfort;
    const c = R.viewer.toContent(i, { x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
    const lineH = first.h * V().scale;
    const py = Math.max(5, lineH * sz.py);
    F.radius = Math.min(sz.r, (c.h + py * 2) / 2);
    const px = R.settings.focusMode === 'line' ? 0 : sz.px;
    F.target = { x: c.x - px, y: c.y - py, w: c.w + px * 2, h: c.h + py * 2 };
    if (R.settings.focusMode === 'window') {
      if (!F.winBox) ensureWindowBox();
      if (F.winBox) {
        // 侧栏展开或窗口缩窄时，确保自由玻璃窗和右侧缩放手柄始终留在可视区内不被裁切
        const maxW = Math.max(120, scroller.clientWidth - 28);
        if (F.winBox.w > maxW) F.winBox.w = maxW;
        const maxX = Math.max(12, scroller.clientWidth - F.winBox.w - 14);
        if (F.winBox.x > maxX) F.winBox.x = maxX;
        F.radius = 12;
        F.target = { ...F.winBox };
      }
    }
  }

  function scrollToTarget(instant) {
    const t = F.target;
    if (!t) return;
    const maxScroll = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
    const want = R.clamp(t.y + t.h / 2 - scroller.clientHeight * ANCHOR, 0, maxScroll);
    if (instant) {
      F.lastProgScroll = performance.now();
      scroller.scrollTop = want;
      F.scrollTarget = null;
      return;
    }
    // 真人阅读舒适死区：当目标框已处于视口 24%~58% 高度内时，保持纸面静止，不随每行微移频繁滚屏
    const centerInView = (t.y + t.h / 2) - scroller.scrollTop;
    const vh = scroller.clientHeight || 1;
    if (centerInView >= vh * 0.24 && centerInView <= vh * 0.58 && t.h < vh * 0.45) {
      return;
    }
    F.scrollTarget = want;
  }

  /* ---------------- 导航 ---------------- */
  async function next(opts) {
    return navigate(1, opts);
  }
  async function prev(opts) {
    return navigate(-1, opts);
  }
  function recoverHint(){F.blocked=true;stopPace();R.toast('暂不能确定下一处正文。可点击文字重新定位，或直接滚动、翻页。','info',4500);}

  /** 收集指定页在当前玻璃窗水平范围内的去重视觉行（按纵坐标升序） */
  async function windowVisualRows(pageIdx) {
    const p = V().pages[pageIdx];
    if (!p || !p.el) return [];
    const lines = await R.viewer.ensureLines(pageIdx);
    if (!lines || !lines.length) return [];
    const wx0 = F.winBox.x, wx1 = F.winBox.x + F.winBox.w;
    let items = lines.map(l => {
      const c = R.viewer.toContent(pageIdx, l);
      return { top: c.y, bot: c.y + c.h, mid: c.y + c.h / 2, h: c.h, x0: c.x, x1: c.x + c.w };
    });
    const horiz = items.filter(r => Math.min(wx1, r.x1) - Math.max(wx0, r.x0) > 4);
    if (horiz.length) items = horiz;
    items.sort((a, b) => a.top - b.top);
    const rows = [];
    for (const r of items) {
      const prev = rows[rows.length - 1];
      if (prev) {
        const overlap = Math.min(prev.bot, r.bot) - Math.max(prev.top, r.top);
        const sameVisualRow = overlap > Math.min(prev.h, r.h) * 0.42 || Math.abs(r.mid - prev.mid) < Math.min(prev.h, r.h) * 0.52;
        if (sameVisualRow) {
          prev.top = Math.min(prev.top, r.top);
          prev.bot = Math.max(prev.bot, r.bot);
          prev.h = prev.bot - prev.top;
          prev.mid = (prev.top + prev.bot) / 2;
          continue;
        }
      }
      rows.push({ top: r.top, bot: r.bot, mid: r.mid, h: r.h });
    }
    return rows;
  }

  function findWinBoxPage() {
    if (!F.winBox || !V().pages.length) return 0;
    const cy = F.winBox.y + F.winBox.h / 2;
    let bestPage = 0, bestDist = Infinity;
    for (const p of V().pages) {
      if (!p.el) continue;
      const top = p.el.offsetTop, bot = top + p.el.offsetHeight;
      const dist = cy < top ? top - cy : cy > bot ? cy - bot : 0;
      if (dist < bestDist) { bestDist = dist; bestPage = p.i; }
    }
    return bestPage;
  }

  /** 自由玻璃窗：按真实正文行距精确步进 1 行并贴合行顶/行底留白，绝不跳行切字 */
  async function stepWindowByLine(dir, large = false) {
    if (!F.winBox) ensureWindowBox(true);
    if (!F.winBox) return;
    const maxContentY = Math.max(10, scroller.scrollHeight - F.winBox.h - 10);
    if (large) {
      const stepY = Math.max(48, F.winBox.h * 0.72) * dir;
      F.winBox.y = R.clamp(F.winBox.y + stepY, 10, maxContentY);
      return;
    }
    const pageIdx = findWinBoxPage();
    const rows = await windowVisualRows(pageIdx);
    const winTop = F.winBox.y;
    const winBot = F.winBox.y + F.winBox.h;
    if (!rows.length) {
      const fallbackPitch = Math.max(18, Math.round(22 * V().scale));
      F.winBox.y = R.clamp(winTop + fallbackPitch * dir, 10, maxContentY);
      return;
    }
    const padOf = r => Math.min(6, Math.max(2, Math.round(r.h * 0.24)));
    // 找到当前玻璃窗内最靠上的完整/主可见行
    let topIdx = rows.findIndex(r => r.mid >= winTop + 2);
    if (dir > 0) {
      if (topIdx < 0 || rows[rows.length - 1].bot <= winBot + 3) {
        // 已读到本页末行：顺滑跨页对齐到下一页第 1 行
        const nextPage = pageIdx + 1;
        if (nextPage < V().pages.length) {
          const nextRows = await windowVisualRows(nextPage);
          if (nextRows.length) {
            F.winBox.y = R.clamp(nextRows[0].top - padOf(nextRows[0]), 10, maxContentY);
            return;
          }
          const np = V().pages[nextPage];
          if (np?.el) {
            F.winBox.y = R.clamp(np.el.offsetTop + 16, 10, maxContentY);
            return;
          }
        }
        return;
      }
      // 若玻璃窗当前悬在本页首行上方空白区，先精准贴合首行
      if (rows[topIdx].top > winTop + F.winBox.h * 0.55) {
        F.winBox.y = R.clamp(rows[topIdx].top - padOf(rows[topIdx]), 10, maxContentY);
        return;
      }
      const nextIdx = topIdx + 1;
      if (nextIdx < rows.length) {
        const targetRow = rows[nextIdx];
        F.winBox.y = R.clamp(targetRow.top - padOf(targetRow), 10, maxContentY);
      } else {
        const nextPage = pageIdx + 1;
        if (nextPage < V().pages.length) {
          const nextRows = await windowVisualRows(nextPage);
          if (nextRows.length) F.winBox.y = R.clamp(nextRows[0].top - padOf(nextRows[0]), 10, maxContentY);
        }
      }
    } else {
      if (topIdx < 0) topIdx = rows.length;
      if (topIdx > 0) {
        const targetRow = rows[topIdx - 1];
        F.winBox.y = R.clamp(targetRow.top - padOf(targetRow), 10, maxContentY);
      } else {
        // 已在本页首行：顺滑跨回上一页末行
        const prevPage = pageIdx - 1;
        if (prevPage >= 0) {
          const prevRows = await windowVisualRows(prevPage);
          if (prevRows.length) {
            const lastRow = prevRows[prevRows.length - 1];
            const wantedTop = lastRow.bot + padOf(lastRow) - F.winBox.h;
            const prevTop = V().pages[prevPage]?.el?.offsetTop || 10;
            F.winBox.y = R.clamp(Math.max(prevTop + 8, wantedTop), 10, maxContentY);
            return;
          }
        }
      }
    }
  }

  async function navigate(dir, { large = false } = {}){
    if(F.busy)return;
    F.busy=true;const epoch=F.epoch;
    try {
      if (R.settings.focusMode === 'window') {
        await stepWindowByLine(dir, large);
        if (epoch !== F.epoch) return;
        syncWinBoxPage();
        computeTarget();
        scrollToTarget(false);
        startLoop();
        if (dir > 0) R.bus.emit('line-read');
        return;
      }
      if(!F.pos)return await pickAtAnchor();
      const origin=F.pos,{i,k}=origin, lines=await R.viewer.ensureLines(i);
      if(epoch!==F.epoch || F.pos!==origin || !V().pages[i])return;
      const seq=R.text.sequence(lines,R.settings.readingContent);
      const bandY0 = F.band?.i === i ? F.band.y0 : lines[k].y;
      const bandY1 = F.band?.i === i ? F.band.y1 : lines[k].y + lines[k].h;
      const target = dir > 0
        ? seq.find(n => n > k && (lines[n].column !== lines[k].column || (lines[n].y + lines[n].h / 2) > bandY1 + 1))
        : seq.slice().reverse().find(n => n < k && (lines[n].column !== lines[k].column || (lines[n].y + lines[n].h / 2) < bandY0 - 1));
      if(target!==undefined){if(dir>0)R.bus.emit('line-read');return await setPos(i,target);}
      const j=i+dir;if(j<0 || j>=V().pages.length){stopPace();if(dir>0)R.bus.emit('doc-done');return;}
      let next=await R.viewer.ensureLines(j);
      if(!next.length)next=await R.viewer.ensureLines(j); // One bounded recovery attempt.
      if(epoch!==F.epoch || F.pos!==origin || !V().pages[j])return;
      const nextSeq=R.text.sequence(next,R.settings.readingContent);
      // Never silently leap over a page whose reading content is unknown.
      if(!nextSeq.length)return recoverHint();
      if(dir>0)R.bus.emit('page-done',i);
      await setPos(j,dir>0?nextSeq[0]:nextSeq.at(-1));
    } catch(e){if(epoch===F.epoch)recoverHint();}
    finally{if(epoch===F.epoch)F.busy=false;}
  }

  function syncWinBoxPage() {
    if (!F.winBox || !V().pages.length) return;
    const cy = F.winBox.y + F.winBox.h / 2;
    let bestPage = 0, bestDist = Infinity;
    for (const p of V().pages) {
      if (!p.el) continue;
      const top = p.el.offsetTop, bot = top + p.el.offsetHeight;
      const dist = cy < top ? top - cy : cy > bot ? cy - bot : 0;
      if (dist < bestDist) { bestDist = dist; bestPage = p.i; }
    }
    const pObj = V().pages[bestPage];
    if (pObj?.lines?.length) {
      const localY = (cy - pObj.el.offsetTop) / V().scale;
      let bestK = 0, bestLineD = Infinity;
      pObj.lines.forEach((l, idx) => {
        const d = Math.abs((l.y + l.h / 2) - localY);
        if (d < bestLineD) { bestLineD = d; bestK = idx; }
      });
      F.pos = { i: bestPage, k: bestK };
    } else {
      F.pos = { i: bestPage, k: 0 };
    }
    R.bus.emit('focus-move', F.pos);
  }

  /** 单击某处：点到哪行读哪行；点当前行 = 下一行 */
  function clickAt(i, x, y) {
    if (!F.on) return false;
    const k = R.viewer.lineAt(i, x, y, true);
    if (k < 0) return false;
    F.blocked=false;
    if(R.settings.focusMode==='window'){
      F.pos={i,k};
      if (!F.winBox) ensureWindowBox();
      else {
        const c = R.viewer.toContent(i, V().pages[i].lines[k]);
        F.winBox.y = Math.max(8, c.y + c.h / 2 - F.winBox.h / 2);
      }
      computeTarget();if(!F.cur)F.cur={...F.target};startLoop();draw();R.bus.emit('focus-move',{i,k});
    } else setPos(i,k,{scroll:false});
    return true;
  }

  /* ---------------- 滚轮（防连发 + 触控板惯性尾帧过滤） ---------------- */
  function onWheel(e) {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      const s = V().scale * (e.deltaY < 0 ? 1.08 : 1 / 1.08);
      R.viewer.setScale(s);
      return;
    }
    if (!F.on || (R.settings.focusMode!=='line' && R.settings.focusMode!=='window') || F.blocked || !F.pos || e.shiftKey || !V().pdf || Math.abs(e.deltaX)>Math.abs(e.deltaY)) return;
    e.preventDefault();
    const dy = e.deltaY * (e.deltaMode === 1 ? 18 : e.deltaMode === 2 ? 400 : 1);
    if (!dy) return;
    const now = performance.now();
    const dt = now - F.wheelLastAt;
    const absDy = Math.abs(dy);
    const dir = Math.sign(dy);

    // 换向或停顿超过 115ms：视为全新一次滚轮/触控板动作，解除惯性屏蔽
    if (dir !== F.wheelDir || dt > 115) {
      F.wheelAcc = 0;
      F.wheelInertia = false;
    } else if (F.wheelInertia) {
      // 惯性尾帧：若后续幅度明显大于前一帧（用户主动再次加力），解除屏蔽；否则吞掉余波防止多跳一行
      if (absDy > F.wheelLastAbs * 1.35 + 6) {
        F.wheelInertia = false;
        F.wheelAcc = 0;
      } else {
        F.wheelLastAt = now;
        F.wheelLastAbs = absDy;
        return;
      }
    }

    F.wheelDir = dir;
    F.wheelLastAt = now;
    F.wheelLastAbs = absDy;
    F.wheelAcc += dy;
    clearTimeout(F.wheelReset);
    F.wheelReset = setTimeout(() => { F.wheelAcc = 0; F.wheelInertia = false; }, 220);

    if (Math.abs(F.wheelAcc) >= 42 && now - F.lastStepAt >= 185 && !F.busy) {
      F.wheelAcc = 0;
      F.lastStepAt = now;
      // 触发步进后进入惯性观察态：若是刻度鼠标单帧事件，下一次 >115ms 会自动解除；若是触控板滑行余波，会被吸收
      F.wheelInertia = true;
      if (F.pace) schedulePace();
      dir > 0 ? next() : prev();
    }
  }

  const resumeAfterManualScroll = R.debounce(() => {
    if (!F.on || !F.cur || R.settings.focusMode!=='line' || F.blocked) return;
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
    const reduced = R.motionReduced();
    if (F.cur && F.target) {
      if (reduced) {
        // 减少动态模式：采用 130ms 轻柔线性收敛，既不晃眼弹跳，又避免 0ms 瞬移的僵硬顿挫
        const alpha = Math.min(1, 0.44 * dt);
        for (const key of ['x', 'y', 'w', 'h']) {
          const diff = F.target[key] - F.cur[key];
          F.vel[key] = 0;
          if (Math.abs(diff) > 0.35) {
            F.cur[key] += diff * alpha;
            moving = true;
          } else {
            F.cur[key] = F.target[key];
          }
        }
      } else {
        // 标准模式：临界阻尼平滑滑行（无果冻回弹与过冲震荡）
        const K = { x: [0.24, 0.56], y: [0.25, 0.55], w: [0.24, 0.56], h: [0.22, 0.58] };
        for (const key of ['x', 'y', 'w', 'h']) {
          const [k, d] = K[key];
          const diff = F.target[key] - F.cur[key];
          F.vel[key] = (F.vel[key] + diff * k * dt) * Math.pow(d, dt);
          F.cur[key] += F.vel[key] * dt;
          if (Math.abs(diff) > 0.3 || Math.abs(F.vel[key]) > 0.3) moving = true;
          else { F.cur[key] = F.target[key]; F.vel[key] = 0; }
        }
      }
    }
    if (F.scrollTarget !== null) {
      const diff = F.scrollTarget - scroller.scrollTop;
      F.lastProgScroll = performance.now();
      const scrollStep = reduced ? 0.34 : 0.18;
      if (Math.abs(diff) < 0.8) { scroller.scrollTop = F.scrollTarget; F.scrollTarget = null; }
      else { scroller.scrollTop += diff * Math.min(1, scrollStep * dt); moving = true; }
    }
    draw();
    F.raf = moving ? requestAnimationFrame(tick) : 0;
  }

  function roundRect(x, y, w, h, r) {
    r = Math.max(0, Math.min(r, w / 2, h / 2));
    return `M${x + r} ${y}H${x + w - r}A${r} ${r} 0 0 1 ${x + w} ${y + r}V${y + h - r}A${r} ${r} 0 0 1 ${x + w - r} ${y + h}` +
      `H${x + r}A${r} ${r} 0 0 1 ${x} ${y + h - r}V${y + r}A${r} ${r} 0 0 1 ${x + r} ${y}Z`;
  }

  function appendExtraCutouts(d) {
    const lr = layer.getBoundingClientRect();
    for (const card of document.querySelectorAll('.tr-card')) {
      const r = card.getBoundingClientRect();
      if (r.bottom < lr.top || r.top > lr.bottom) continue;
      d += ' ' + roundRect(r.left - lr.left - 2, r.top - lr.top - 8, r.width + 4, r.height + 10, 12);
    }
    return d;
  }

  function draw() {
    if (!F.on || !F.cur) {
      lens && (lens.style.opacity = 0);
      if (dim) dim.style.clipPath = 'none';
      return;
    }
    lens.classList.toggle('window-mode', R.settings.focusMode === 'window');
    const c = F.cur;
    // 极微量的光学滑行形变（<= 1.8%），减少动态模式下完全不拉伸
    const speed = R.motionReduced() ? 0 : Math.abs(F.vel.y);
    const sy = 1 + Math.min(0.018, speed / 950);
    const sx = 1 - Math.min(0.006, speed / 2200);
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
    d = appendExtraCutouts(d);
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
    if(R.settings.focusMode!=='line'){
      R.settings.focusMode = 'line';
      R.saveSettings();
    }
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
    const line = p?.lines?.[F.pos.k];
    return line ? { i: F.pos.i, k: F.pos.k, line } : null;
  }

  async function restore(pos) {
    if (!pos || !V().pages[pos.i]) return false;
    const lines = await R.viewer.ensureLines(pos.i);
    if (!lines.length) return false;
    let k=Math.min(pos.k,lines.length-1);
    const old=V().pages[pos.i].legacyLines?.[pos.k];
    const anchor=pos.layout===2 && Number.isFinite(pos.y)?pos:old?{x:old.x+old.w/2,y:old.y+old.h/2}:null;
    if(anchor){let distance=Infinity;lines.forEach((line,j)=>{const d=Math.abs(line.y+line.h/2-anchor.y)*4+Math.max(line.x-anchor.x,0,anchor.x-line.x-line.w);if(d<distance){distance=d;k=j;}});}
    sizeLayer();
    await setPos(pos.i,k,{instant:true,silent:true});
    lens.classList.add('resume');
    setTimeout(() => lens.classList.remove('resume'), 1600);
    return true;
  }

  function reset() {
    F.epoch++;F.busy=false;F.winBox=null;F.blocked=false;
    stopPace(); cancelAnimationFrame(F.raf); F.raf = 0; F.on = false; F.pos = null; F.cur = null; F.target = null; F.scrollTarget = null;
    F.vel = { x:0,y:0,w:0,h:0 }; clearTimeout(F.wheelReset); resumeAfterManualScroll.cancel(); R.hide(layer);
  }

  function activePayload() {
    if (!F.pos) return null;
    const i = F.pos.i;
    const p = V().pages[i];
    if (!p || !p.lines) return null;
    if (R.settings.focusMode === 'window' && F.winBox) {
      const el = p.el;
      const rx = (F.winBox.x - el.offsetLeft) / V().scale;
      const ry = (F.winBox.y - el.offsetTop) / V().scale;
      const rw = F.winBox.w / V().scale;
      const rh = F.winBox.h / V().scale;
      const inside = p.lines.filter(l => l.y + l.h >= ry && l.y <= ry + rh && l.x + l.w >= rx && l.x <= rx + rw);
      const text = inside.map(l => l.text).filter(Boolean).join(' ');
      const rects = inside.length ? inside.map(l => ({ x: l.x, y: l.y, w: l.w, h: l.h })) : [{ x: R.clamp(rx, 0, p.vp1.width), y: R.clamp(ry, 0, p.vp1.height), w: Math.min(rw, p.vp1.width), h: Math.min(rh, p.vp1.height) }];
      return { i, rects, text, scanned: p.scanned };
    }
    const l = p.lines[F.pos.k];
    if (!l) return null;
    if (R.settings.focusMode === 'line' && F.band?.i === i) {
      const bandLines = p.lines.filter(x => x.column === l.column && x.y + x.h >= F.band.y0 - 1 && x.y <= F.band.y1 + 1);
      if (bandLines.length > 1) {
        const text = bandLines.map(x => x.text).filter(Boolean).join(' ');
        const rects = bandLines.map(x => ({ x: x.x, y: x.y, w: x.w, h: x.h }));
        return { i, rects, text: text || l.text || '', scanned: p.scanned };
      }
    }
    return { i, rects: [{ x: l.x, y: l.y, w: l.w, h: l.h }], text: l.text || '', scanned: p.scanned };
  }

  function initWindowDrag(){
    let winDrag = null, autoScrollRaf = 0;
    const MIN_W = 100, MIN_H = 36, PAD = 10;
    const stopWinAutoScroll = () => {
      if (autoScrollRaf) {
        cancelAnimationFrame(autoScrollRaf);
        autoScrollRaf = 0;
      }
    };
    const finishWinDrag = () => {
      if (!winDrag) return;
      const finishedDir = winDrag.dir;
      try { winDrag.captureEl?.releasePointerCapture?.(winDrag.pointerId); } catch {}
      winDrag = null;
      lens?.classList.remove('resizing');
      stopWinAutoScroll();
      if (F.winBox) {
        syncWinBoxPage();
        // 仅在整体移动玻璃窗且停靠在视口极端边缘时，柔和托回舒适阅读高度；缩放大小后保持原位不跳屏
        if (finishedDir === 'move') {
          const centerInView = (F.winBox.y + F.winBox.h / 2) - scroller.scrollTop;
          const vh = scroller.clientHeight || 1;
          if (centerInView > vh * 0.68 || centerInView < vh * 0.18) {
            F.target = { ...F.winBox };
            scrollToTarget(false);
            startLoop();
          }
        }
      }
    };
    const runWinAutoScroll = () => {
      autoScrollRaf = 0;
      if (!winDrag || !F.winBox) return;
      // 仅在整体移动或纵向（上/下边与四角）缩放时触发自动滚屏，横向缩放绝不误滚页面
      const canScrollY = winDrag.dir === 'move' || winDrag.dir.includes('n') || winDrag.dir.includes('s');
      if (!canScrollY) return;
      const sr = scroller.getBoundingClientRect();
      const maxScroll = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
      const lensTopScreen = (F.winBox.y - scroller.scrollTop) + sr.top;
      const lensBotScreen = (F.winBox.y + F.winBox.h - scroller.scrollTop) + sr.top;
      const lowerTrigger = sr.top + sr.height * 0.76;
      const upperTrigger = sr.top + sr.height * 0.20;
      let delta = 0;
      if (winDrag.dir === 'move') {
        if ((winDrag.lastY > lowerTrigger || lensBotScreen > sr.bottom - 52) && winDrag.lastY >= winDrag.startY - 6) {
          const depth = Math.max(winDrag.lastY - lowerTrigger, lensBotScreen - (sr.bottom - 52), 8);
          delta = R.clamp(depth * 0.18, 3.5, 22);
        } else if ((winDrag.lastY < upperTrigger || lensTopScreen < sr.top + 48) && winDrag.lastY <= winDrag.startY + 6) {
          const depth = Math.max(upperTrigger - winDrag.lastY, (sr.top + 48) - lensTopScreen, 8);
          delta = -R.clamp(depth * 0.18, 3.5, 22);
        }
      } else if (winDrag.dir.includes('s') && winDrag.lastY > sr.bottom - 44 && winDrag.lastY > winDrag.startY + 8) {
        delta = R.clamp((winDrag.lastY - (sr.bottom - 44)) * 0.2, 3, 18);
      } else if (winDrag.dir.includes('n') && winDrag.lastY < sr.top + 44 && winDrag.lastY < winDrag.startY - 8) {
        delta = -R.clamp(((sr.top + 44) - winDrag.lastY) * 0.2, 3, 18);
      }
      if (delta !== 0) {
        const prevTop = scroller.scrollTop;
        const nextTop = R.clamp(prevTop + delta, 0, maxScroll);
        const actual = nextTop - prevTop;
        const maxBottom = Math.max(scroller.clientHeight, scroller.scrollHeight) - PAD;
        if (Math.abs(actual) > 0.2) {
          F.lastProgScroll = performance.now();
          scroller.scrollTop = nextTop;
          if (winDrag.dir === 'move') {
            F.winBox.y = R.clamp(F.winBox.y + actual, PAD, Math.max(PAD, maxBottom - F.winBox.h));
          } else if (winDrag.dir.includes('s') && actual > 0) {
            F.winBox.h = R.clamp(F.winBox.h + actual, MIN_H, Math.max(MIN_H, maxBottom - F.winBox.y));
          } else if (winDrag.dir.includes('n') && actual < 0) {
            const bottom = F.winBox.y + F.winBox.h;
            const ny = R.clamp(F.winBox.y + actual, PAD, bottom - MIN_H);
            F.winBox.y = ny;
            F.winBox.h = bottom - ny;
          }
          F.target = { ...F.winBox };
          F.cur = { ...F.winBox };
          syncWinBoxPage();
          draw();
        }
      }
      autoScrollRaf = requestAnimationFrame(runWinAutoScroll);
    };

    // 阻止 mousedown 冒泡到 annotate.js 或触发原生文本选中，避免抢夺玻璃窗缩放/拖动事件
    lens.addEventListener('mousedown', e => {
      if (!F.on || R.settings.focusMode !== 'window' || e.button !== 0) return;
      const isHandle = !!e.target.closest('.lens-resize');
      if (isHandle || !document.body.classList.contains('tool-mode')) {
        e.preventDefault();
        e.stopPropagation();
      }
    }, true);

    document.addEventListener('pointerdown', e => {
      if (!F.on || e.button !== 0) return;
      const resizeHandle = e.target.closest('.lens-resize');
      const resizeDir = resizeHandle?.dataset.resize;
      const inToolMode = document.body.classList.contains('tool-mode');
      const onLensBody = !resizeDir && !inToolMode && R.settings.focusMode === 'window' && !!e.target.closest('#lens');
      if (resizeDir || onLensBody) {
        if (R.settings.focusMode !== 'window') {
          F.winBox = F.cur ? { ...F.cur } : null;
          R.settings.focusMode = 'window';
          R.saveSettings();
        }
        if (!F.winBox) {
          if (F.cur) F.winBox = { ...F.cur };
          else ensureWindowBox(true);
        }
        if (F.winBox) {
          e.preventDefault();
          e.stopImmediatePropagation();
          // 立即终止惯性/弹簧动画，防止旧目标框回拉覆盖用户正在缩放的尺寸
          cancelAnimationFrame(F.raf);
          F.raf = 0;
          F.vel = { x: 0, y: 0, w: 0, h: 0 };
          F.scrollTarget = null;
          const captureEl = resizeHandle || lens;
          try { captureEl.setPointerCapture?.(e.pointerId); } catch {}
          lens.classList.add('resizing');
          winDrag = {
            dir: resizeDir || 'move',
            pointerId: e.pointerId,
            captureEl,
            startX: e.clientX,
            startY: e.clientY,
            lastX: e.clientX,
            lastY: e.clientY,
          };
          stopWinAutoScroll();
          if (winDrag.dir === 'move' || winDrag.dir.includes('n') || winDrag.dir.includes('s')) {
            autoScrollRaf = requestAnimationFrame(runWinAutoScroll);
          }
          return;
        }
      }
    }, true);

    window.addEventListener('pointermove', e => {
      if (!winDrag || !F.winBox) return;
      if (winDrag.pointerId != null && e.pointerId !== winDrag.pointerId) return;
      const dx = e.clientX - winDrag.lastX;
      const dy = e.clientY - winDrag.lastY;
      winDrag.lastX = e.clientX;
      winDrag.lastY = e.clientY;
      const b = { ...F.winBox };
      const maxScroll = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
      const maxRight = Math.max(scroller.clientWidth, scroller.scrollWidth) - PAD;
      const maxBottom = Math.max(scroller.clientHeight, scroller.scrollHeight) - PAD;
      if (winDrag.dir === 'move') {
        b.x = R.clamp(b.x + dx, PAD, Math.max(PAD, maxRight - b.w));
        b.y = R.clamp(b.y + dy, PAD, Math.max(PAD, maxBottom - b.h));
        // 向下拖动进入视口下半区（>58%）时，同步推动页面向下滚动，避免玻璃框沉底被工具栏遮挡并直接翻入下一页
        const botInView = (b.y + b.h) - scroller.scrollTop;
        const topInView = b.y - scroller.scrollTop;
        const vh = scroller.clientHeight || 1;
        if (dy > 0 && botInView > vh * 0.58 && scroller.scrollTop < maxScroll) {
          const push = Math.min(maxScroll - scroller.scrollTop, dy * 1.45);
          F.lastProgScroll = performance.now();
          scroller.scrollTop += push;
          b.y = R.clamp(b.y + push, PAD, Math.max(PAD, maxBottom - b.h));
        } else if (dy < 0 && topInView < vh * 0.24 && scroller.scrollTop > 0) {
          const pull = Math.min(scroller.scrollTop, -dy * 1.45);
          F.lastProgScroll = performance.now();
          scroller.scrollTop -= pull;
          b.y = R.clamp(b.y - pull, PAD, Math.max(PAD, maxBottom - b.h));
        }
      } else {
        if (winDrag.dir.includes('e')) {
          b.w = R.clamp(b.w + dx, MIN_W, Math.max(MIN_W, maxRight - b.x));
        }
        if (winDrag.dir.includes('s')) {
          b.h = R.clamp(b.h + dy, MIN_H, Math.max(MIN_H, maxBottom - b.y));
        }
        if (winDrag.dir.includes('w')) {
          const right = b.x + b.w;
          const nx = R.clamp(b.x + dx, PAD, right - MIN_W);
          b.x = nx;
          b.w = right - nx;
        }
        if (winDrag.dir.includes('n')) {
          const bottom = b.y + b.h;
          const ny = R.clamp(b.y + dy, PAD, bottom - MIN_H);
          b.y = ny;
          b.h = bottom - ny;
        }
      }
      F.winBox = b;
      F.target = { ...b };
      F.cur = { ...b };
      draw();
    });

    window.addEventListener('pointerup', finishWinDrag);
    window.addEventListener('pointercancel', finishWinDrag);
  }
  return { F, init, enable, toggle, next, prev, setPos, clickAt, togglePace, stopPace, current, activePayload, restore, pickAtAnchor, redraw: draw, isOn: () => F.on, reset };
})();
