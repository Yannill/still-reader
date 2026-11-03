/* annotate.js —— 标注编辑器：高亮 / 下划线 / 评论 / 擦除 / 撤销 + 批注栏 + 选中文字浮动菜单
 *  - 拖选会自动吸附到“行”，可跨行；扫描版 PDF 同样可用（基于行检测结果）
 *  - 阅读模式：单击某行 = 专注框跳过去；双击单词 = 翻译；拖选文字 = 弹出菜单（翻译/高亮/下划线/评论/问AI/复制）
 */
'use strict';
R.annot = (() => {
  const A = { tool: 'read', list: [], docId: null, undo: [], filter: 'all', drag: null, pending: null, editing: null, clickTimer: 0 };
  const COLORS = ['#E8D38A', '#B8C6A4', '#AEBFCC', '#D8B2A7'];
  const NAMES = { highlight: '高亮', underline: '下划线', comment: '评论' };
  const V = () => R.viewer.V;
  const persist = R.debounce((record) => R.db.put('annots', record).catch(e => R.toast('标注未保存：' + e.message, 'error')), 400);
  const queueSave = () => { if (A.docId) persist(structuredClone({ id: A.docId, list: A.list })); };

  function init() {
    if (!COLORS.includes(R.settings.color)) R.settings.color = COLORS[0];
    const cg = R.$('#colorGroup');
    cg.innerHTML = COLORS.map((c) => `<button class="sw" data-c="${c}" style="background:${c}" title="标注颜色"></button>`).join('');
    cg.onclick = (e) => {
      const b = e.target.closest('.sw');
      if (!b) return;
      R.settings.color = b.dataset.c;
      R.saveSettings();
      syncColors();
      if (A.tool === 'read') setTool('highlight');
    };
    syncColors();
    R.$('#toolGroup').onclick = (e) => { const b = e.target.closest('[data-tool]'); if (b) setTool(b.dataset.tool); };
    R.$('#btnUndo').onclick = undo;
    R.$('#btnSave').onclick = save;
    R.$('#btnAnnotPanel').onclick = () => togglePanel();
    R.$('#btnExportMd').onclick = exportMd;
    R.$('#annotFilter').onclick = (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      A.filter = b.dataset.v;
      R.$$('#annotFilter button').forEach((x) => x.classList.toggle('on', x === b));
      renderPanel();
    };
    R.$('#annotList').onclick = onListClick;

    const sc = V().scroller;
    sc.addEventListener('mousedown', onDown);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    sc.addEventListener('pointerdown', e => { if(e.pointerType !== 'mouse' && A.tool !== 'read') { sc.setPointerCapture(e.pointerId); onDown(e); } });
    window.addEventListener('pointermove', e => { if(e.pointerType !== 'mouse' && A.tool !== 'read') onMove(e); });
    window.addEventListener('pointerup', e => { if(e.pointerType !== 'mouse' && A.tool !== 'read') onUp(e); });
    window.addEventListener('pointercancel', () => { A.drag=null; });
    sc.addEventListener('touchend', () => setTimeout(() => {
      if(A.tool !== 'read') return;
      const info=selectionInfo(); if(info) { A.pending=info; R.showPopover(R.$('#selPopover'),info.box.left+info.box.width/2,info.box.top); }
    }, 80), {passive:true});
    sc.addEventListener('scroll', () => R.hide(R.$('#selPopover')), { passive: true });

    const pop = R.$('#selPopover');
    pop.addEventListener('mousedown', (e) => e.preventDefault()); // 保持文字选中
    pop.onclick = onPopAct;

    R.$('#cpSave').onclick = saveEditor;
    R.$('#cpCancel').onclick = closeEditor;
    R.$('#cpDelete').onclick = () => { if (A.editing) remove(A.editing.id); closeEditor(); };
    R.$('#cpText').addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) saveEditor(); });

    R.bus.on('pages-built', renderAll);
    document.addEventListener('keydown', onKey);
  }

  function syncColors() {
    R.$$('#colorGroup .sw').forEach((b) => b.classList.toggle('on', b.dataset.c === R.settings.color));
  }

  function setTool(t) {
    A.tool = t;
    R.$$('#toolGroup .tool').forEach((b) => b.classList.toggle('on', b.dataset.tool === t));
    document.body.classList.toggle('tool-mode', t !== 'read');
    document.body.classList.toggle('tool-erase', t === 'erase');
    window.getSelection().removeAllRanges();
  }

  /* ---------------- 数据 ---------------- */
  async function load(meta) {
    await persist.flush();
    A.docId = meta.id;
    A.undo = [];
    const rec = await R.db.get('annots', meta.id);
    if (rec) A.list = rec.list || [];
    else {
      try { A.list = await R.pdfsave.importFromPdf(V().pages); } catch (e) { console.warn(e); A.list = []; }
      queueSave();
      if (A.list.length) R.toast(`已读入 PDF 里原有的 ${A.list.length} 条标注，可继续编辑`);
    }
    setTool('read');
    renderAll();
  }

  function snapshot() {
    A.undo.push(JSON.stringify(A.list));
    if (A.undo.length > 60) A.undo.shift();
  }
  function changed(pages) {
    queueSave();
    (pages || [...new Set(A.list.map((a) => a.page))]).forEach(renderPage);
    renderPanel();
  }
  function add({ page, type, color, rects, text, comment }) {
    snapshot();
    const a = { id: R.uid('n'), page, type, color: color || (type === 'underline' ? getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() : R.settings.color), rects, text: text || '', comment: comment || '', created: Date.now() };
    A.list.push(a);
    changed([page]);
    return a;
  }
  function remove(id) {
    const a = A.list.find((x) => x.id === id);
    if (!a) return;
    snapshot();
    A.list = A.list.filter((x) => x.id !== id);
    changed([a.page]);
  }
  function undo() {
    if (!A.undo.length) return R.toast('没有可以撤销的操作');
    const before = new Set(A.list.map((a) => a.page));
    A.list = JSON.parse(A.undo.pop());
    A.list.forEach((a) => before.add(a.page));
    changed([...before]);
  }

  /* ---------------- 绘制 ---------------- */
  function renderAll() {
    V().pages.forEach((p) => renderPage(p.i));
    renderPanel();
  }
  function renderPage(i, preview) {
    const p = V().pages[i];
    if (!p || !p.svg) return;
    let s = '';
    const draw = (a, cls = '') => {
      for (const r of a.rects) {
        if (a.type === 'underline') {
          const t = Math.max(1, r.h * 0.08);
          s += `<rect class="${cls}" data-id="${a.id}" x="${r.x}" y="${r.y + r.h - t * 1.2}" width="${r.w}" height="${t}" rx="${t / 2}" fill="${a.color}"/>`;
        } else {
          s += `<rect class="${cls}" data-id="${a.id}" x="${r.x - 1}" y="${r.y}" width="${r.w + 2}" height="${r.h}" rx="2" fill="${a.color}" fill-opacity="0.42"/>`;
        }
      }
    };
    A.list.filter((a) => a.page === i).forEach((a) => draw(a, a.id === A.flash ? 'flash' : ''));
    if (preview) draw(preview, 'preview');
    p.svg.innerHTML = s;
    // 评论小图标
    R.$$('.note-pin', p.notes).forEach((n) => n.remove());
    A.list.filter((a) => a.page === i && a.comment).forEach((a) => {
      const r = a.rects[a.rects.length - 1];
      const pin = document.createElement('div');
      pin.className = 'note-pin';
      pin.title = a.comment;
      pin.innerHTML = '<span class="pin-comment">' + R.esc(a.comment) + '</span>';
      pin.style.left = `calc(${((r.x + r.w) / p.vp1.width) * 100}% + 4px)`;
      pin.style.top = `calc(${(r.y / p.vp1.height) * 100}% - 12px)`;
      pin.style.borderColor = a.color;
      pin.onmousedown = (e) => e.stopPropagation();
      pin.onclick = (e) => { e.stopPropagation(); openEditor(a, e.clientX, e.clientY); };
      p.notes.appendChild(pin);
    });
    R.$('#annotCount').textContent = A.list.length;
  }

  /* ---------------- 选区 → 行矩形 ---------------- */
  function pagePoint(i, cx, cy) {
    const p = V().pages[i];
    const r = p.el.getBoundingClientRect();
    return { i, x: R.clamp((cx - r.left) / V().scale, 0, p.vp1.width), y: R.clamp((cy - r.top) / V().scale, 0, p.vp1.height) };
  }

  function rangeRects(i, a, b, moved) {
    if (A.tool === 'box') return { rects: [{ x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.max(2, Math.abs(a.x - b.x)), h: Math.max(2, Math.abs(a.y - b.y)) }], text: '' };
    const lines = V().pages[i].lines || [];
    let ka = R.viewer.lineAt(i, a.x, a.y, true);
    let kb = R.viewer.lineAt(i, b.x, b.y, true);
    if (ka < 0 && kb < 0) {
      if (!moved) return { rects: [], text: '' };
      const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
      return { rects: [{ x, y, w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) }], text: '' };
    }
    if (ka < 0) { ka = kb; a = b; }
    if (kb < 0) { kb = ka; b = a; }
    if (ka > kb || (ka === kb && a.x > b.x)) { [ka, kb] = [kb, ka]; [a, b] = [b, a]; }
    const rects = [], texts = [];
    for (let k = ka; k <= kb; k++) {
      const l = lines[k];
      let x0 = l.x, x1 = l.x + l.w;
      if (moved) {
        if (k === ka) x0 = R.clamp(a.x, l.x, l.x + l.w);
        if (k === kb) x1 = R.clamp(b.x, l.x, l.x + l.w);
        // 只拖了一点点 → 视为整行
        if (ka === kb && x1 - x0 < Math.max(6, l.h * 0.6)) { x0 = l.x; x1 = l.x + l.w; }
      }
      if (x1 - x0 < 1) continue;
      rects.push({ x: x0, y: l.y, w: x1 - x0, h: l.h });
      texts.push(R.viewer.textInRange(l, x0, x1));
    }
    return { rects, text: texts.filter(Boolean).join(' ') };
  }

  /** 浏览器原生选区（文字版 PDF）→ 每行一个矩形，并吸附到检测到的行高 */
  function selectionInfo() {
    const sel = window.getSelection();
    if (!sel.rangeCount || sel.isCollapsed) return null;
    const text = String(sel).replace(/\s+/g, ' ').trim();
    if (!text) return null;
    const range = sel.getRangeAt(0);
    const startEl = range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentElement;
    const pageEl = startEl && startEl.closest('.page');
    if (!pageEl) return null;
    const i = +pageEl.dataset.i;
    const p = V().pages[i];
    const pr = pageEl.getBoundingClientRect();
    const s = V().scale;
    const out = [];
    Array.from(range.getClientRects())
      .filter((r) => r.width > 1 && r.height > 1 && r.top < pr.bottom && r.bottom > pr.top)
      .sort((a, b) => a.top - b.top || a.left - b.left)
      .forEach((r) => {
        let x = (r.left - pr.left) / s, y = (r.top - pr.top) / s, w = r.width / s, h = r.height / s;
        const k = R.viewer.lineAt(i, x + w / 2, y + h / 2);
        if (k >= 0) { const l = p.lines[k]; y = l.y; h = l.h; }
        const m = out.find((o) => Math.abs(o.y + o.h / 2 - (y + h / 2)) < Math.min(o.h, h) * 0.5 && x - (o.x + o.w) < h * 2.5 && o.x - (x + w) < h * 2.5);
        if (m) {
          const x1 = Math.max(m.x + m.w, x + w);
          m.x = Math.min(m.x, x);
          m.w = x1 - m.x;
        } else out.push({ x, y, w, h });
      });
    if (!out.length) return null;
    return { i, rects: out, text, box: range.getBoundingClientRect() };
  }

  /* ---------------- 鼠标 ---------------- */
  function hit(i, x, y) {
    const list = A.list.filter((a) => a.page === i);
    for (let k = list.length - 1; k >= 0; k--) {
      if (list[k].rects.some((r) => x >= r.x - 2 && x <= r.x + r.w + 2 && y >= r.y - 2 && y <= r.y + r.h + 2)) return list[k];
    }
    return null;
  }

  function onDown(e) {
    if (e.button !== 0 || e.target.closest('.note-pin, .tr-card')) return;
    const pt = R.viewer.fromClient(e.clientX, e.clientY, e.target);
    if (!pt) return;
    R.hide(R.$('#selPopover'));
    const p = V().pages[pt.i];
    if (A.tool === 'read') {
      if (p.scanned) { e.preventDefault(); A.drag = { mode: 'scan', i: pt.i, start: pt, cur: pt, moved: false, x0: e.clientX, y0: e.clientY }; }
      else A.drag = { mode: 'native', i: pt.i, start: pt, moved: false, x0: e.clientX, y0: e.clientY };
      return;
    }
    e.preventDefault();
    if (A.tool === 'erase') { const a = hit(pt.i, pt.x, pt.y); if (a) remove(a.id); return; }
    if (A.tool === 'comment') { const a = hit(pt.i, pt.x, pt.y); if (a) { openEditor(a, e.clientX, e.clientY); return; } }
    A.drag = { mode: 'tool', i: pt.i, start: pt, cur: pt, moved: false, x0: e.clientX, y0: e.clientY };
  }

  function onMove(e) {
    const d = A.drag;
    if (!d) return;
    if (!d.moved && Math.hypot(e.clientX - d.x0, e.clientY - d.y0) > 4) d.moved = true;
    if (d.mode === 'native' || !d.moved) return;
    d.cur = pagePoint(d.i, e.clientX, e.clientY);
    const r = rangeRects(d.i, d.start, d.cur, true);
    const type = A.tool === 'underline' ? 'underline' : 'highlight';
    renderPage(d.i, { id: '_pv', type: d.mode === 'scan' ? 'highlight' : type, color: d.mode === 'scan' ? 'var(--accent)' : R.settings.color, rects: r.rects });
  }

  function onUp(e) {
    const d = A.drag;
    A.drag = null;
    if (!d) return;
    if (d.mode === 'native') return onUpRead(e, d);
    if (d.mode === 'scan') {
      renderPage(d.i);
      if (!d.moved) return clickLine(d, e);
      const r = rangeRects(d.i, d.start, d.cur, true);
      if (!r.rects.length) return;
      A.pending = { i: d.i, rects: r.rects, text: '', scanned: true };
      return R.showPopover(R.$('#selPopover'), e.clientX, e.clientY - 6);
    }
    // 标注工具
    const r = rangeRects(d.i, d.start, d.moved ? d.cur : d.start, d.moved);
    renderPage(d.i);
    if (!r.rects.length) return;
    const a = add({ page: d.i, type: A.tool === 'underline' ? 'underline' : 'highlight', rects: r.rects, text: r.text });
    if (A.tool === 'comment') openEditor(a, e.clientX, e.clientY, true);
  }

  function clickLine(d) {
    if (!R.focus.isOn()) return;
    const cur = R.focus.current();
    const k = R.viewer.lineAt(d.i, d.start.x, d.start.y, true);
    const isCurrent = cur && cur.i === d.i && cur.k === k;
    clearTimeout(A.clickTimer);
    // 点当前行 = 下一行；延迟一点点，以免和“双击取词”冲突
    if (isCurrent) A.clickTimer = setTimeout(() => R.focus.clickAt(d.i, d.start.x, d.start.y), 230);
    else R.focus.clickAt(d.i, d.start.x, d.start.y);
  }

  function onUpRead(e, d) {
    if (e.detail >= 2) {
      clearTimeout(A.clickTimer);
      setTimeout(() => {
        const info = selectionInfo();
        if (info && info.text.length <= 40 && R.translate) {
          R.translate.show(info);
          window.getSelection().removeAllRanges();
        }
      }, 10);
      return;
    }
    setTimeout(() => {
      const info = selectionInfo();
      if (info && d.moved) {
        A.pending = info;
        R.showPopover(R.$('#selPopover'), info.box.left + info.box.width / 2, info.box.top);
      } else if (!d.moved) clickLine(d, e);
    }, 0);
  }

  /* ---------------- 浮动菜单 ---------------- */
  async function onPopAct(e) {
    const b = e.target.closest('[data-act]');
    const s = A.pending;
    if (!b || !s) return;
    R.hide(R.$('#selPopover'));
    const act = b.dataset.act;
    if (act === 'translate') R.translate && R.translate.show(s);
    else if (act === 'highlight' || act === 'underline') add({ page: s.i, type: act, rects: s.rects, text: s.text });
    else if (act === 'comment') {
      const a = add({ page: s.i, type: 'highlight', rects: s.rects, text: s.text });
      const box = s.box || { left: e.clientX, top: e.clientY, width: 0, height: 0 };
      openEditor(a, box.left + box.width / 2, box.top + box.height, true);
    } else if (act === 'ask') {
      let image = null;
      if (s.scanned && R.ai.supportsVision()) image = await R.viewer.pageImage(s.i, bbox(s.rects));
      R.chat && R.chat.open({ quote: s.text || '（扫描页上框选的区域）', image });
    } else if (act === 'copy') {
      if (s.text) { navigator.clipboard.writeText(s.text).then(() => R.toast('已复制')); }
      else R.toast('扫描版没有文字层，无法复制，可以“问 AI”识别');
    }
    window.getSelection().removeAllRanges();
    A.pending = null;
  }
  const bbox = (rects) => {
    const x = Math.min(...rects.map((r) => r.x)), y = Math.min(...rects.map((r) => r.y));
    return { x, y, w: Math.max(...rects.map((r) => r.x + r.w)) - x, h: Math.max(...rects.map((r) => r.y + r.h)) - y };
  };

  /* ---------------- 评论编辑 ---------------- */
  function openEditor(a, x, y, isNew = false) {
    A.editing = a;
    A.editingNew = isNew;
    R.$('#cpQuote').textContent = a.text || '（扫描版区域）';
    R.$('#cpQuote').style.borderColor = a.color;
    R.$('#cpText').value = a.comment || '';
    R.$('#cpDelete').classList.toggle('hidden', isNew);
    R.showPopover(R.$('#commentPop'), x, y, { above: false });
    setTimeout(() => R.$('#cpText').focus(), 0);
  }
  function saveEditor() {
    const a = A.editing;
    if (!a) return;
    const txt = R.$('#cpText').value.trim();
    if (txt !== a.comment) {
      snapshot();
      a.comment = txt;
      changed([a.page]);
    }
    closeEditor();
  }
  function closeEditor() {
    A.editing = null;
    R.hide(R.$('#commentPop'));
  }

  /* ---------------- 批注栏 ---------------- */
  function togglePanel(force) {
    const p = R.$('#annotPanel');
    const open = force === undefined ? p.classList.contains('hidden') : force;
    if (open) { R.hide(R.$('#chatPanel')); R.hide(R.$('#outlinePanel')); R.$('#btnOutline').classList.remove('on'); }
    p.classList.toggle('hidden', !open);
    R.$('#btnAnnotPanel').classList.toggle('on', open);
    R.$('#btnChat').classList.remove('on');
    renderPanel();
    window.dispatchEvent(new Event('resize'));
  }

  function renderPanel() {
    R.$('#annotCount').textContent = A.list.length;
    const el = R.$('#annotList');
    if (R.$('#annotPanel').classList.contains('hidden')) return;
    const items = A.list
      .filter((a) => A.filter === 'all' || (A.filter === 'comment' ? !!a.comment : a.type === A.filter))
      .sort((a, b) => a.page - b.page || a.rects[0].y - b.rects[0].y);
    if (!items.length) {
      el.innerHTML = `<div class="al-empty">${A.list.length ? '这个分类下还没有标注' : '还没有标注<br>选一个工具，在文字上横着拖动即可<br><span style="font-size:12px">（快捷键：H 高亮当前行 · C 评论当前行）</span>'}</div>`;
      return;
    }
    let html = '', page = -1;
    for (const a of items) {
      if (a.page !== page) { page = a.page; html += `<div class="al-page">第 ${page + 1} 页</div>`; }
      html += `<div class="al-item" data-id="${a.id}">
        <div class="al-top"><span class="al-sw" style="background:${a.color}"></span>${a.comment ? '评论' : NAMES[a.type]}
          <span class="al-act"><button data-edit="${a.id}">${a.comment ? '编辑' : '写评论'}</button><button data-del="${a.id}">删除</button></span></div>
        ${a.text ? `<div class="al-q" style="border-color:${a.color}">${R.esc(a.text)}</div>` : '<div class="al-q" style="border-color:var(--rule-2);color:var(--ink-2)">（扫描版区域）</div>'}
        ${a.comment ? `<div class="al-c">${R.esc(a.comment)}</div>` : ''}
      </div>`;
    }
    el.innerHTML = html;
  }

  function onListClick(e) {
    const del = e.target.closest('[data-del]');
    if (del) return remove(del.dataset.del);
    const ed = e.target.closest('[data-edit]');
    const it = e.target.closest('.al-item');
    if (!it) return;
    const a = A.list.find((x) => x.id === it.dataset.id);
    if (!a) return;
    jumpTo(a);
    if (ed) {
      const r = e.target.getBoundingClientRect();
      setTimeout(() => openEditor(a, r.left - 170, r.bottom), 350);
    }
  }

  function jumpTo(a) {
    const r = a.rects[0];
    const c = R.viewer.toContent(a.page, r);
    const sc = V().scroller;
    if (R.focus.isOn()) {
      const k = R.viewer.lineAt(a.page, r.x + 1, r.y + r.h / 2, true);
      if (k >= 0) R.focus.setPos(a.page, k);
      else sc.scrollTo({ top: c.y - sc.clientHeight * 0.38, behavior: 'smooth' });
    } else sc.scrollTo({ top: c.y - sc.clientHeight * 0.38, behavior: 'smooth' });
    A.flash = a.id;
    renderPage(a.page);
    setTimeout(() => { A.flash = null; renderPage(a.page); }, 1800);
  }

  /* ---------------- 键盘 ---------------- */
  function onKey(e) {
    const tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || e.target.isContentEditable || !A.docId || R.$('#readerView').classList.contains('hidden')) return;
    const ctrl = e.ctrlKey || e.metaKey;
    if (ctrl && e.key.toLowerCase() === 'z') { e.preventDefault(); return undo(); }
    if (ctrl && e.key.toLowerCase() === 's') { e.preventDefault(); return save(); }
    if (ctrl || e.altKey) return;
    const k = e.key.toLowerCase();
    const tools = { 1: 'read', 2: 'highlight', 3: 'underline', 4: 'comment', 5: 'erase' };
    if (tools[e.key]) return setTool(tools[e.key]);
    if (k === 'b') return togglePanel();
    if (k === 'h' || k === 'u' || k === 'c') {
      const cur = R.focus.current();
      if (!cur) return R.toast('先打开专注模式（F），再用 H / U / C 标注当前行');
      const l = cur.line;
      const a = add({ page: cur.i, type: k === 'u' ? 'underline' : 'highlight', rects: [{ x: l.x, y: l.y, w: l.w, h: l.h }], text: l.text });
      if (k === 'c') {
        const c = R.viewer.toContent(cur.i, l);
        const sr = V().scroller.getBoundingClientRect();
        openEditor(a, sr.left + c.x - V().scroller.scrollLeft + c.w / 2, sr.top + c.y - V().scroller.scrollTop + c.h + 8, true);
      }
    }
  }

  /* ---------------- 保存 / 导出 ---------------- */
  async function save() {
    const meta = R.app.current();
    if (!meta) return;
    const btn = R.$('#btnSave');
    btn.disabled = true;
    btn.textContent = '保存中…';
    try {
      const out = await R.pdfsave.exportPdf(V().bytes, A.list, V().pages);
      const base = meta.name.replace(/\.pdf$/i, '');
      R.download(out, (/-标注$/.test(base) ? base : base + '-标注') + '.pdf', 'application/pdf');
      R.toast(`已把 ${A.list.length} 条标注写入 PDF，用其他阅读器打开也能看到`, 'success', 3500);
    } catch (e) {
      console.error(e);
      R.toast('保存失败：' + (e.message || e), 'error', 5000);
    } finally {
      btn.disabled = false;
      btn.textContent = '保存 PDF';
    }
  }

  function exportMd() {
    const meta = R.app.current();
    if (!meta) return;
    let md = `# ${meta.title} · 阅读笔记\n\n> 来源：${meta.name}　导出时间：${new Date().toLocaleString()}\n`;
    let page = -1;
    A.list.slice().sort((a, b) => a.page - b.page || a.rects[0].y - b.rects[0].y).forEach((a) => {
      if (a.page !== page) { page = a.page; md += `\n## 第 ${page + 1} 页\n`; }
      md += `\n- ${a.text ? '“' + a.text + '”' : '（扫描版区域）'}${a.type === 'underline' ? '（下划线）' : ''}\n`;
      if (a.comment) md += `  - 评论：${a.comment.replace(/\n/g, '\n    ')}\n`;
    });
    R.download(md, meta.title + '-笔记.md', 'text/markdown');
  }

  return { init, load, add, remove, undo, setTool, togglePanel, renderAll, list: () => A.list, flush: () => persist.flush() };
})();
