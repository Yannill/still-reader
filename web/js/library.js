/* library.js —— 文档库：导入、自动标题、侧栏（简短中文）、主页 */
'use strict';
R.library = (() => {
  let docs = [];
  let currentId = null;

  async function load() {
    docs = (await R.db.all('docs')).map(d => Object.assign({ boxId: 'unsorted', order: 0 }, d)).sort((a, b) => (b.lastOpened || b.addedAt) - (a.lastOpened || a.addedAt));
    renderSidebar();
    return docs;
  }
  const get = (id) => docs.find((d) => d.id === id);

  /* 侧栏收起时显示的两字简称：开题报告→开题，Machine Learning→ML，Level 2→L2 */
  function abbr(title) {
    const t = (title || '').trim();
    if (!t) return '文档';
    if (R.isCJK(t[0])) return t.replace(/[^\u3400-\u9fffA-Za-z0-9]/g, '').slice(0, 4);
    const words = t.split(/\s+/).filter(Boolean);
    if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
    return t.slice(0, 2);
  }

  /* ---------------- 导入 ---------------- */
  async function importFiles(fileList, boxId = R.study?.state.boxFilter || 'unsorted') {
    const files = Array.from(fileList).filter((f) => /\.pdf$/i.test(f.name) || f.type === 'application/pdf');
    if (!files.length) { R.toast('请选择 PDF 文件', 'error'); return null; }
    let lastId = null;
    for (const f of files) {
      const id = R.uid('d');
      let info, bytes, digest;
      try {
        bytes = new Uint8Array(await f.arrayBuffer());
        digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))).map(n => n.toString(16).padStart(2, '0')).join('');
        const dup = docs.find(d => d.digest === digest && d.name === f.name);
        if (dup) { lastId = dup.id; continue; }
        info = await analyze(bytes, f.name);
      }
      catch (e) {
        console.error(e);
        R.toast(`无法打开「${f.name}」：${e.message || e}`, 'error', 4000);
        continue;
      }
      const meta = {
        id, name: f.name, size: f.size, title: info.title, titleSource: 'local',
        pageCount: info.pageCount, thumb: info.thumb, thumb2x: info.thumb, tone: info.tone, aspect: info.aspect, digest, boxId: boxId === 'all' ? 'unsorted' : boxId, order: Date.now(), scanned: info.scanned,
        addedAt: Date.now(), lastOpened: 0, progress: 0, pos: null,
      };
      try { await R.db.batch([{ store: 'files', value: { id, bytes } }, { store: 'docs', value: meta }]); }
      catch (e) { R.toast('导入未保存，可能空间不足：' + e.message, 'error', 5000); continue; }
      docs.unshift(meta);
      lastId = id;
      renderSidebar();
      aiTitle(meta, info); // 后台用 AI 重新总结标题（如已配置）
    }
    return lastId;
  }

  /** 解析：页数、缩略图、首页文字、离线标题 */
  async function analyze(bytes, fileName) {
    const pdf = await pdfjsLib.getDocument({
      data: bytes.slice(0), cMapUrl: R.PDFJS.cmaps, cMapPacked: true, standardFontDataUrl: R.PDFJS.fonts,
    }).promise;
    try {
      const page = await pdf.getPage(1);
      const vp1 = page.getViewport({ scale: 1 });
      // 缩略图
      const s = 360 / vp1.width;
      const vp = page.getViewport({ scale: s });
      const c = document.createElement('canvas');
      c.width = Math.round(vp.width);
      c.height = Math.round(vp.height);
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, c.width, c.height);
      await page.render({ canvasContext: ctx, viewport: vp }).promise;
      const thumb = c.toDataURL('image/jpeg', 0.75);
      const swatch = document.createElement('canvas'); swatch.width = swatch.height = 1;
      swatch.getContext('2d').drawImage(c, 0, 0, 1, 1);
      const pixel = swatch.getContext('2d').getImageData(0, 0, 1, 1).data;
      const tone = R.rgbToHex(...Array.from(pixel).slice(0, 3).map(n => 120 + n * 0.38));
      // 标题候选：元数据标题 + 首页上半部分字号最大的几行
      let metaTitle = '';
      try { const m = await pdf.getMetadata(); metaTitle = (m.info && m.info.Title) || ''; } catch { /* */ }
      const tc = await page.getTextContent();
      const lines = R.core.linesFromText(tc, vp1);
      const big = lines.filter((l) => l.y < vp1.height * 0.6 && l.text.length >= 2)
        .sort((a, b) => b.fh - a.fh).slice(0, 3).map((l) => l.text);
      const candidates = [metaTitle, ...big];
      let text = lines.map((l) => l.text).join('\n');
      if (pdf.numPages > 1 && text.length < 800) {
        try {
          const p2 = await pdf.getPage(2);
          const t2 = await p2.getTextContent();
          text += '\n' + t2.items.map((i) => i.str).join(' ');
        } catch { /* */ }
      }
      return {
        pageCount: pdf.numPages, thumb, tone, aspect: vp1.width / vp1.height, text: text.trim(), scanned: text.trim().length < 15,
        title: R.core.summarizeTitle(candidates, fileName),
      };
    } finally {
      pdf.destroy();
    }
  }

  async function aiTitle(meta, info) {
    if (!R.settings.aiTitle || !R.ai.isReady()) return;
    if (!info.text && !R.ai.supportsVision()) return;
    try {
      const t = await R.ai.summarizeTitle({ text: info.text, image: info.text ? null : info.thumb, fallback: meta.title });
      const current = get(meta.id);
      if (current && t && t !== current.title && current.titleSource !== 'user') {
        current.title = t;
        current.titleSource = 'ai';
        await update(current);
        renderSidebar();
        R.bus.emit('doc-updated', current);
      }
    } catch (e) { console.warn('AI 标题失败：', e.message); }
  }

  async function update(meta) {
    const current = get(meta.id);
    if (!current) return;
    Object.assign(current, meta);
    await R.db.put('docs', structuredClone(current));
  }

  async function rename(id, title) {
    const m = get(id);
    if (!m || !title.trim()) return;
    m.title = title.trim().slice(0, 40);
    m.titleSource = 'user';
    await update(m);
    renderSidebar();
  }

  async function remove(id) {
    const m = get(id);
    if (!m || !await R.confirm(`移除「${m.title}」？标注和对话记录也会删除，原文件不受影响。`, '移除这本书')) return;
    if (currentId === id) await R.app.route('home');
    await R.db.batch(['docs', 'files', 'annots', 'chats'].map(store => ({ store, del: true, value: id })));
    docs = docs.filter((d) => d.id !== id);
    renderSidebar();
    if (!R.$('#homeView').classList.contains('hidden')) renderHome();
  }

  /* ---------------- 侧栏 ---------------- */
  function renderSidebar() {
    const list = R.$('#docList');
    list.innerHTML = docs.slice().sort((a,b)=>(b.lastOpened||b.addedAt)-(a.lastOpened||a.addedAt)).map(d => `<button class="spine-link ${d.id===currentId?'active':''}" data-id="${d.id}" style="--tone:${R.esc(d.tone||'var(--box)')}" aria-label="打开 ${R.esc(d.title)}"><span>${R.esc(abbr(d.title))}</span><span class="spine-full">${R.esc(d.title)}</span></button>`).join('');
  }

  function setCurrent(id) {
    currentId = id;
    R.$('#navHome').classList.toggle('active', !id);
    renderSidebar();
  }

  /* ---------------- 主页 ---------------- */
  async function renderHome() { return R.study.renderLibrary(); }

  return { load, get, all: () => docs, importFiles, update, rename, remove, renderSidebar, renderHome, setCurrent, abbr, current: () => currentId };
})();
