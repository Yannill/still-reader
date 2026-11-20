/* app.js —— 启动入口：路由、打开文档、顶栏/工具栏绑定、全局快捷键 */
'use strict';
R.app = (() => {
  let opening = null;
  let meta = null; // 当前打开的文档

  async function boot() {
    const cdn = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.2.67/';
    let base = new URL('vendor/pdfjs/', location.href).href;
    try {
      await window.pdfjsReady;
      if (!window.pdfjsLib) {
        base = cdn;
        await import(cdn + 'build/pdf.min.mjs');
      }
      pdfjsLib.GlobalWorkerOptions.workerSrc = base + (base === cdn ? 'build/pdf.worker.min.mjs' : 'build/pdf.worker.mjs');
      R.PDFJS = { cmaps: base + 'cmaps/', fonts: base + 'standard_fonts/' };
    } catch (error) {
      document.body.textContent = 'PDF 解析器加载失败，请检查本地 vendor/pdfjs 目录。';
      console.error(error);
      return;
    }
    await R.core.init();
    R.viewer.init();
    R.focus.init();
    R.annot && R.annot.init();
    R.translate && R.translate.init();
    R.chat && R.chat.init();
    if (R.adhd) await R.adhd.init();
    await R.library.load();
    await R.study.init();
    R.reader.init();
    bindUI();
    R.cloud && R.cloud.init();
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
    let file = cached?.file || await R.db.get('files', id);
    if (!file) file = await R.cloud?.downloadPdf?.(id);
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
    const sc = R.viewer.V.scroller;
    const visiblePage=R.viewer.currentPage();
    const focusTracks=cur && R.focus.isOn() && (R.settings.focusMode==='line' || cur.i===visiblePage && R.focus.F.target && R.focus.F.target.y+R.focus.F.target.h>=sc.scrollTop && R.focus.F.target.y<=sc.scrollTop+sc.clientHeight);
    let p;
    if (focusTracks) {
      const total = R.viewer.V.pages[cur.i].lines.length || 1;
      p = (cur.i + (cur.k + 1) / total) / n;
    } else {
      const page=R.viewer.V.pages[visiblePage];
      p = (visiblePage+R.clamp((sc.scrollTop+sc.clientHeight*.4-page.el.offsetTop)/page.el.offsetHeight,0,1))/n;
    }
    p = R.clamp(p || 0, 0, 1);
    R.$('#progressFill').style.width = p * 100 + '%';
    const pageNo = focusTracks ? cur.i+1 : visiblePage+1;
    const left = R.adhd && R.adhd.remainingText ? R.adhd.remainingText() : '';
    const dm = R.$('#docMeta');
    if (dm) dm.textContent = left || '';
    meta.progress = p;
    R.$('#pageInput').value = pageNo;
    R.$('#pageTotal').textContent = '/ ' + String(n).padStart(3,'0');
    if (focusTracks) { const l=R.viewer.V.pages[cur.i].lines[cur.k];meta.pos = { i: cur.i, k: cur.k,x:l.x+l.w/2,y:l.y+l.h/2,layout:2 }; meta.resumeText = cur.line?.text || ''; }
    else { const page=R.viewer.V.pages[visiblePage],y=(sc.scrollTop+sc.clientHeight*.4-page.el.offsetTop)/R.viewer.V.scale;let k=0,distance=Infinity;(page.lines||[]).forEach((l,j)=>{if(Math.abs(l.y-y)<distance){distance=Math.abs(l.y-y);k=j;}});const l=page.lines?.[k];meta.pos = { i: visiblePage, k, x:l?l.x+l.w/2:0,y:l?l.y+l.h/2:y,layout:2 };meta.resumeText=l?.text||''; meta.scrollAnchor = R.viewer.captureAnchor(); }
    R.bus.emit('reading-progress',{page:pageNo,percent:p,y:meta.pos.y});
    const { id, progress, pos, resumeText, scrollAnchor } = meta;
    saveProgress(id, { progress, pos, resumeText, scrollAnchor });
  }
  const saveProgress = R.debounce(async (id, fields) => {
    await R.db.patchDoc(id, fields);
    R.library.renderSidebar();
  }, 800);

  function updateZoomLabel() {
    R.$('#zoomLabel').textContent = Math.round(R.viewer.V.scale * 100) + '%';
  }

  /* ---------------- UI 绑定 ---------------- */
  function pickFiles(boxId = R.study.state.boxFilter) {
    const input = R.$('#fileInput');
    input.dataset.box = boxId;
    input.click();
  }

  // Capture FileList synchronously; drop data expires when the event returns.
  let importQueue = Promise.resolve();
  function enqueueImport(fileList, boxId) {
    const files = Array.from(fileList);
    if (!files.length) return;
    importQueue = importQueue.then(async () => {
      await R.study.closeFolder();
      const panel = R.$('#importPanel'), summary = R.$('#importSummary'), list = R.$('#importResults');
      const counts = { added: 0, existing: 0, failed: 0 };
      list.replaceChildren();
      panel.hidden = false;
      const id = await R.library.importFiles(files, boxId, event => {
        if (event.status === 'reading') {
          summary.textContent = `正在导入 ${event.index + 1}/${event.total} · ${event.file.name}`;
          return;
        }
        counts[event.status]++;
        const row = document.createElement('li');
        if (event.doc) {
          const book = document.createElement('button');
          book.type = 'button';
          book.dataset.importBook = event.doc.id;
          book.textContent = event.file.name;
          row.append(book, ' · ' + R.study.boxName(event.doc.boxId) + (event.status === 'existing' ? '（已在书库）' : ''));
        } else row.textContent = event.file.name + ' · ' + event.reason;
        list.append(row);
      });
      if (id) await route('home');
      const labels = { added: '已导入', existing: '已在书库', failed: '失败' };
      summary.textContent = Object.keys(labels).filter(k => counts[k]).map(k => labels[k] + ' ' + counts[k] + ' 份').join(' · ');
    }).catch(error => R.toast('导入流程中断：' + error.message, 'error', 6000));
  }

  function bindUI() {
    const fileInput = R.$('#fileInput');
    const pick = () => pickFiles();
    R.$('#btnImport').onclick = pick;
    fileInput.onchange = () => {
      enqueueImport(fileInput.files, fileInput.dataset.box || R.study.state.boxFilter);
      fileInput.value = '';
    };
    R.$('#importDismiss').onclick = () => { R.$('#importPanel').hidden = true; };
    R.$('#importResults').onclick = e => {
      const book = e.target.closest('[data-import-book]');
      if (book) { R.$('#importPanel').hidden = true; openDoc(book.dataset.importBook); }
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
    const tbTranslate = R.$('#btnToolbarTranslate');
    const tbAsk = R.$('#btnToolbarAsk');
    if (tbTranslate) {
      tbTranslate.addEventListener('mousedown', (e) => e.preventDefault());
      tbTranslate.onclick = () => R.translate && R.translate.current();
    }
    if (tbAsk) {
      tbAsk.addEventListener('mousedown', (e) => e.preventDefault());
      tbAsk.onclick = () => {
        if (!R.chat) return;
        const selText = String(window.getSelection?.() || '').trim();
        const focusText = (!selText && R.focus?.isOn?.()) ? (R.focus.activePayload?.()?.text || '').trim() : '';
        const quote = selText || focusText;
        R.hide(R.$('#selPopover'));
        R.chat.open(quote ? { quote } : {});
      };
    }
    bindFocusOpts();
    R.bus.on('focus-move', updateProgress);
    R.viewer.V.scroller.addEventListener('scroll', R.debounce(updateProgress,200), { passive: true });
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
        if(c.dataset.close==='outlinePanel'){R.reader.toggleOutline(false);return;}
        R.hide(R.$('#' + c.dataset.close));
        const toggle = { outlinePanel:'btnOutline', annotPanel:'btnAnnotPanel', chatPanel:'btnChat' }[c.dataset.close];
        if(toggle) R.$('#'+toggle)?.classList.remove('on');
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
      const target = e.target.closest?.('[data-drop-box], [data-box]');
      const folder = R.$('#folderDialog[open] .folder-contents');
      enqueueImport(e.dataTransfer.files, target?.dataset.dropBox || target?.dataset.box || folder?.dataset.box || R.study.state.boxFilter);
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
      R.settings[k] = b.dataset.v;
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
    if (R.focus.isOn() && (e.key === 'ArrowDown' || e.key === ' ')) { e.preventDefault(); return R.focus.next(); }
    if (R.focus.isOn() && e.key === 'ArrowUp') { e.preventDefault(); return R.focus.prev(); }
    if (R.focus.isOn() && e.key === 'PageDown') { e.preventDefault(); return R.focus.next({ large: true }); }
    if (R.focus.isOn() && e.key === 'PageUp') { e.preventDefault(); return R.focus.prev({ large: true }); }
    if (k === 'f') return R.focus.toggle();
    if (k === 'p') return R.focus.togglePace();
    if (k === 't') return R.translate && R.translate.current();
    if (k === '?') return R.show(R.$('#helpModal'));
  }

  document.addEventListener('DOMContentLoaded', boot);
  return { route, openDoc, pickFiles, current: () => meta, updateProgress, setTitle, checkpoint };
})();
