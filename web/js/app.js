/* app.js —— 启动入口：路由、打开文档、顶栏/工具栏绑定、全局快捷键 */
'use strict';
R.app = (() => {
  let opening = null;
  let meta = null; // 当前打开的文档

  /* pdf.js 资源路径：本地 vendor 优先，否则 CDN */
  function configPdfjs() {
    const local = !!window.__pdfLocal;
    const base = local ? new URL('vendor/pdfjs/', location.href).href : 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/';
    R.PDFJS = { cmaps: base + 'cmaps/', fonts: base + 'standard_fonts/' };
    if (location.protocol !== 'file:') pdfjsLib.GlobalWorkerOptions.workerSrc = base + 'build/pdf.worker.min.js';
  }

  async function boot() {
    if (!window.pdfjsLib) {
      document.body.innerHTML = '<div style="padding:40px;font-size:15px">pdf.js 加载失败：请检查网络，或确认 web/vendor/pdfjs 目录存在。</div>';
      return;
    }
    configPdfjs();
    await R.core.init();
    R.viewer.init();
    R.focus.init();
    R.annot && R.annot.init();
    R.translate && R.translate.init();
    R.chat && R.chat.init();
    if (R.adhd) await R.adhd.init();
    bindUI();
    await R.library.load();
    await R.study.init();
    R.reader.init();
    window.__appReady = true;

    // 开发/演示：?open=samples/sample.pdf 自动导入并打开
    const q = new URLSearchParams(location.search).get('open');
    if (q) {
      try {
        const resp = await fetch(q);
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        const blob = await resp.blob();
        const file = new File([blob], decodeURIComponent(q.split('/').pop()), { type: 'application/pdf' });
        const id = await R.library.importFiles([file]);
        if (id) return openDoc(id);
      } catch (e) { R.toast('自动打开失败：' + e.message, 'error'); }
    }
    route('home');
    window.__appReady = true;
  }

  /* ---------------- 路由 ---------------- */
  async function checkpoint() {
    await saveProgress.flush();
    await R.annot?.flush();
    await R.chat?.leave();
  }
  async function route(name) {
    if (name !== 'reader') {
      if (opening) await opening;
      await checkpoint();
      window.__docReady = false;
      R.focus.stopPace(); R.focus.reset();
      document.body.classList.remove('focus-on', 'calm-idle', 'tool-mode', 'tool-erase');
      R.viewer.close(); meta = null; R.library.setCurrent(null);
      R.$$('.popover').forEach(R.hide);
    }
    document.body.classList.toggle('reading', name === 'reader');
    ['home','reader','notes','focus'].forEach(key => R.$('#'+key+'View').classList.toggle('hidden', name !== key));
    R.$$('.top-nav [data-route]').forEach(b => { b.classList.toggle('active',b.dataset.route===name); b.setAttribute('aria-current',b.dataset.route===name?'page':'false'); });
    if(name==='home') await R.library.renderHome();
    if(name==='notes') await R.study.renderNotes();
    if(name==='focus') await R.study.renderFocus();
    if(name!=='reader') document.title='静读 · Still Reader';
  }

  /* ---------------- 打开文档 ---------------- */
  function openDoc(id, options = {}) {
    if (opening) return opening;
    opening = doOpenDoc(id, options).finally(() => { opening = null; });
    return opening;
  }
  async function doOpenDoc(id, { fromStart = false } = {}) {
    await checkpoint();
    await R.study.saveView();
    window.__docReady = false;
    const m = R.library.get(id);
    if (!m) return;
    const cached = await R.study.takePrepared(id).catch(() => null);
    const file = cached?.file || await R.db.get('files', id);
    if (!file) { R.toast('文件数据丢失，请重新导入', 'error'); return; }
    await route('reader');
    R.focus.reset();
    R.library.setCurrent(id);
    meta = m;
    setTitle();
    const stage = R.$('#stage');
    const cover = document.createElement('div');
    cover.className = 'loading-cover';
    cover.textContent = '正在打开…';
    stage.appendChild(cover);
    try {
      await R.viewer.open(m, file.bytes, cached?.pdf);
    } catch (e) {
      console.error(e);
      cover.remove();
      R.toast('打开失败：' + (e.message || e), 'error', 5000);
      R.toast('请返回书库后重试', 'error');
      return;
    }
    cover.remove();
    const entering = R.study.readerEntered();
    updateZoomLabel();
    R.annot && (await R.annot.load(m, file.bytes));
    R.chat && (await R.chat.load(m));
    m.lastOpened = Date.now();
    await R.library.update(m);

    // 专注框回到上次读到的位置
    if (fromStart) { m.pos = null; m.progress = 0; m.resumeText = ''; }
    const restored = m.pos ? await R.focus.restore(m.pos) : false;
    if (R.settings.focusOn) await R.focus.enable(true);
    if (restored) {
      const hint = R.$('#resumeHint');
      hint.textContent = `已回到上次读到的地方 · 第 ${m.pos.i + 1} 页`;
      R.show(hint);
      setTimeout(() => R.hide(hint), 2600);
    }
    if (!R.settings.focusOn && !fromStart && m.scrollAnchor) R.viewer.restoreAnchor(m.scrollAnchor);
    updateProgress();
    await R.reader.load();
    await entering;
    R.bus.emit('doc-opened', m);
    window.__docReady = true;
  }

  function setTitle() {
    if (!meta) return;
    R.$('#docTitle').textContent = meta.title;
    document.title = meta.title + ' · 静读';
    R.$('#readerBox').textContent = R.study?.boxName(meta.boxId) || '未归档';
  }

  /* ---------------- 进度 ---------------- */
  function updateProgress() {
    if (!meta || !R.viewer.V.pdf) return;
    const n = R.viewer.V.pages.length;
    const cur = R.focus.current();
    let p;
    if (cur && R.focus.isOn()) {
      const total = R.viewer.V.pages[cur.i].lines.length || 1;
      p = (cur.i + (cur.k + 1) / total) / n;
    } else {
      const sc = R.viewer.V.scroller;
      p = (sc.scrollTop + sc.clientHeight) / sc.scrollHeight;
    }
    p = R.clamp(p || 0, 0, 1);
    R.$('#progressFill').style.width = p * 100 + '%';
    const pageNo = cur && R.focus.isOn() ? cur.i + 1 : R.viewer.currentPage() + 1;
    const left = R.adhd && R.adhd.remainingText ? R.adhd.remainingText() : '';
    R.$('#docMeta').textContent = `第 ${pageNo} / ${n} 页 · 已读 ${Math.round(p * 100)}%${left ? ' · ' + left : ''}`;
    meta.progress = p;
    R.$('#pageInput').value = pageNo;
    R.$('#pageTotal').textContent = '/ ' + String(n).padStart(3,'0');
    if (cur && R.focus.isOn()) { meta.pos = { i: cur.i, k: cur.k }; meta.resumeText = cur.line?.text || ''; }
    else { meta.pos = { i: pageNo-1, k: 0 }; meta.scrollAnchor = R.viewer.captureAnchor(); }
    saveProgress(structuredClone(meta));
  }
  const saveProgress = R.debounce(async (snapshot) => {
    await R.library.update(snapshot);
    R.library.renderSidebar();
  }, 800);

  function updateZoomLabel() {
    R.$('#zoomLabel').textContent = Math.round(R.viewer.V.scale * 100) + '%';
  }

  /* ---------------- UI 绑定 ---------------- */
  function bindUI() {
    const fileInput = R.$('#fileInput');
    const pick = () => fileInput.click();
    R.$('#btnImport').onclick = pick;
    fileInput.onchange = async () => {
      const id = await R.library.importFiles(fileInput.files);
      fileInput.value = '';
      if (id) { await route('home'); R.toast('已放上书架'); }
    };

    // 侧栏
    R.$('#btnCollapse').onclick = () => { R.$('#sidebar').classList.toggle('collapsed'); window.dispatchEvent(new Event('resize')); };
    R.$('#navHome').onclick = () => route('home');
    R.$('#docList').addEventListener('click', (e) => {
      const del = e.target.closest('[data-del]');
      if (del) { e.stopPropagation(); return R.library.remove(del.dataset.del); }
      const it = e.target.closest('[data-id]');
      if (it && it.dataset.id !== R.library.current()) openDoc(it.dataset.id);
    });
    R.$('#docList').addEventListener('dblclick', (e) => {
      const it = e.target.closest('[data-id]');
      if (!it) return;
      const t = prompt('重命名（侧栏显示的简短标题）', R.library.get(it.dataset.id).title);
      if (t) R.library.rename(it.dataset.id, t).then(() => { if (meta && meta.id === it.dataset.id) setTitle(); });
    });

    // 标题双击重命名
    const title = R.$('#docTitle');
    title.ondblclick = () => {
      title.contentEditable = 'true';
      title.focus();
      document.getSelection().selectAllChildren(title);
    };
    title.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); title.blur(); } if (e.key === 'Escape') { title.textContent = meta.title; title.blur(); } };
    title.onblur = async () => {
      if (title.contentEditable !== 'true') return;
      title.contentEditable = 'false';
      if (meta && title.textContent.trim() && title.textContent.trim() !== meta.title) {
        await R.library.rename(meta.id, title.textContent);
        setTitle();
      } else setTitle();
    };

    // 缩放
    R.$('#btnZoomIn').onclick = () => R.viewer.setScale(R.viewer.V.scale * 1.15);
    R.$('#btnZoomOut').onclick = () => R.viewer.setScale(R.viewer.V.scale / 1.15);
    R.$('#btnFit').onclick = () => R.viewer.setScale(R.viewer.fitScale(), { fit: true });
    R.bus.on('zoom', updateZoomLabel);

    // 专注
    R.$('#btnFocus').onclick = () => R.focus.toggle();
    R.$('#btnPace').onclick = () => R.focus.togglePace();
    bindFocusOpts();
    R.bus.on('focus-move', updateProgress);
    R.viewer.V.scroller.addEventListener('scroll', R.debounce(() => { if (!R.focus.isOn()) updateProgress(); }, 200), { passive: true });
    R.bus.on('doc-done', () => R.toast('读完了！给自己一点奖励吧', 'success', 4000));
    R.bus.on('doc-updated', (m) => { if (meta && m.id === meta.id) setTitle(); });

    // 点击页面：专注模式下“点哪行读哪行”（标注/翻译模块加载后由 annotate.js 接管）
    if (!R.annot) {
      R.viewer.V.scroller.addEventListener('click', (e) => {
        if (String(window.getSelection())) return;
        const pt = R.viewer.fromClient(e.clientX, e.clientY, e.target);
        if (pt) R.focus.clickAt(pt.i, pt.x, pt.y);
      });
    }

    // 关闭按钮
    document.addEventListener('click', (e) => {
      const dc = e.target.closest('[data-dialog-close]');
      if (dc) R.$('#' + dc.dataset.dialogClose).close();
      const c = e.target.closest('[data-close]');
      if (c) {
        R.hide(R.$('#' + c.dataset.close));
        const toggle = { outlinePanel:'btnOutline', annotPanel:'btnAnnotPanel', chatPanel:'btnChat' }[c.dataset.close];
        if(toggle) R.$('#'+toggle).classList.remove('on');
        window.dispatchEvent(new Event('resize'));
      }
      const fo = R.$('#focusOpts');
      if (!fo.classList.contains('hidden') && !e.target.closest('#focusOpts') && !e.target.closest('#btnFocusOpts')) R.hide(fo);
    });
    R.$$('.modal').forEach((m) => m.addEventListener('mousedown', (e) => { if (e.target === m) R.hide(m); }));
    R.$('#navHelp').onclick = () => R.show(R.$('#helpModal'));
    R.$('#navSettings').onclick = () => (R.settingsUI ? R.settingsUI.open() : R.toast('设置模块稍后加入'));

    // 拖拽导入
    let dragN = 0;
    window.addEventListener('dragenter', (e) => { if (e.dataTransfer.types.includes('Files')) { dragN++; R.show(R.$('#dropOverlay')); } });
    window.addEventListener('dragleave', () => { if (--dragN <= 0) { dragN = 0; R.hide(R.$('#dropOverlay')); } });
    window.addEventListener('dragover', (e) => e.preventDefault());
    window.addEventListener('drop', async (e) => {
      e.preventDefault();
      dragN = 0;
      R.hide(R.$('#dropOverlay'));
      if (!e.dataTransfer.files.length) return;
      const id = await R.library.importFiles(e.dataTransfer.files);
      if (id) { await route('home'); R.toast('已放上书架'); }
    });

    R.$$('.top-nav [data-route]').forEach(b => b.onclick = () => route(b.dataset.route));
    R.$('#topSettings').onclick = () => R.settingsUI.open();
    R.$('#topImport').onclick = pick;
    document.addEventListener('visibilitychange', () => { if (document.hidden) { saveProgress.flush(); R.annot.flush(); } });
    window.addEventListener('pagehide', () => { saveProgress.flush(); R.annot.flush(); });
    document.addEventListener('keydown', onKey);
  }

  function bindFocusOpts() {
    const pop = R.$('#focusOpts');
    R.$('#btnFocusOpts').onclick = (e) => {
      if (!pop.classList.contains('hidden')) return R.hide(pop);
      const r = e.currentTarget.getBoundingClientRect();
      R.show(pop);
      pop.style.left = Math.min(window.innerWidth - pop.offsetWidth - 10, r.right - pop.offsetWidth) + 'px';
      pop.style.top = r.bottom + 8 + 'px';
    };
    const syncSeg = () => R.$$('.seg[data-key]', pop).forEach((seg) => {
      R.$$('button', seg).forEach((b) => b.classList.toggle('on', String(R.settings[seg.dataset.key]) === b.dataset.v));
    });
    R.$$('.seg[data-key]', pop).forEach((seg) => seg.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      const k = seg.dataset.key;
      R.settings[k] = k === 'focusLines' && b.dataset.v !== 'paragraph' ? +b.dataset.v : b.dataset.v;
      R.saveSettings();
      syncSeg();
    }));
    const dimR = R.$('#dimRange'), blurT = R.$('#blurToggle'), paceR = R.$('#paceRange'), paceL = R.$('#paceLabel');
    dimR.value = R.settings.dim;
    blurT.checked = R.settings.blur;
    paceR.value = R.settings.paceWpm;
    paceL.textContent = R.settings.paceWpm + ' 词/分';
    const paceProgressT = R.$('#paceProgressToggle');
    paceProgressT.checked = R.settings.paceProgress;
    paceProgressT.onchange = () => { R.settings.paceProgress = paceProgressT.checked; R.saveSettings(); };
    dimR.oninput = () => { R.settings.dim = +dimR.value; R.saveSettings(); };
    blurT.onchange = () => { R.settings.blur = blurT.checked; R.saveSettings(); };
    paceR.oninput = () => { R.settings.paceWpm = +paceR.value; paceL.textContent = paceR.value + ' 词/分'; R.saveSettings(); };
    syncSeg();
  }

  /* ---------------- 快捷键 ---------------- */
  function onKey(e) {
    const tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || e.target.isContentEditable) return;
    if (e.key === 'Escape') {
      R.$$('.modal, .popover').forEach(R.hide);
      return;
    }
    if (!meta) return;
    const ctrl = e.ctrlKey || e.metaKey;
    if (ctrl && (e.key === '=' || e.key === '+')) { e.preventDefault(); return R.viewer.setScale(R.viewer.V.scale * 1.15); }
    if (ctrl && e.key === '-') { e.preventDefault(); return R.viewer.setScale(R.viewer.V.scale / 1.15); }
    if (ctrl) return; // 其余 Ctrl 组合交给各模块
    const k = e.key.toLowerCase();
    if (k === '[') { R.$('#sidebar').classList.toggle('collapsed'); window.dispatchEvent(new Event('resize')); return; }
    if (!R.focus.isOn() && (e.key === 'PageDown' || e.key === 'PageUp')) { e.preventDefault(); return R.reader.jump(R.viewer.currentPage() + (e.key === 'PageDown' ? 1 : -1)); }
    if (R.focus.isOn() && (e.key === 'ArrowDown' || e.key === ' ' || e.key === 'PageDown')) { e.preventDefault(); return R.focus.next(); }
    if (R.focus.isOn() && (e.key === 'ArrowUp' || e.key === 'PageUp')) { e.preventDefault(); return R.focus.prev(); }
    if (k === 'f') return R.focus.toggle();
    if (k === 'p') return R.focus.togglePace();
    if (k === 't') return R.translate && R.translate.current();
    if (k === '?') return R.show(R.$('#helpModal'));
  }

  document.addEventListener('DOMContentLoaded', boot);
  return { route, openDoc, current: () => meta, updateProgress, setTitle, checkpoint };
})();
