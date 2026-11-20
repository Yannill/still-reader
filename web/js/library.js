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
  async function findDuplicate(file, bytes, digest) {
    for (const doc of docs) {
      if (doc.name !== file.name || (doc.size != null && doc.size !== bytes.length)) continue;
      if (digest && doc.digest) {
        if (digest === doc.digest) return doc;
        continue;
      }
      // Older records and ordinary HTTP origins can lack a SHA-256 digest.
      const stored = await R.db.get('files', doc.id);
      if (!stored?.bytes) continue;
      const original = new Uint8Array(stored.bytes);
      if (original.length === bytes.length && bytes.every((v, i) => v === original[i])) return doc;
    }
  }

  async function importOne(file, target) {
    if (!/\.pdf$/i.test(file.name) && file.type !== 'application/pdf') throw Error('请选择 PDF 格式的文件');
    if (!file.size) throw Error('文件为空');
    const bytes = new Uint8Array(await file.arrayBuffer());
    const hash = globalThis.crypto?.subtle && await crypto.subtle.digest('SHA-256', bytes);
    const digest = hash && Array.from(new Uint8Array(hash), n => n.toString(16).padStart(2, '0')).join('');
    const existing = await findDuplicate(file, bytes, digest);
    if (existing) return { status: 'existing', doc: existing };
    const info = await analyze(bytes, file.name);
    const id = R.uid('d');
    const boxId = R.study.boxes().some(box => box.id === target) ? target : 'unsorted';
    const meta = {
      id, name: file.name, size: file.size, title: info.title, titleSource: 'local',
      pageCount: info.pageCount, thumb: info.thumb, thumb2x: info.thumb, tone: info.tone,
      aspect: info.aspect, scanned: info.scanned, digest, boxId, order: Date.now(),
      addedAt: Date.now(), lastOpened: 0, progress: 0, pos: null,
    };
    await R.db.batch([{ store: 'files', value: { id, bytes } }, { store: 'docs', value: meta }]);
    docs.unshift(meta);
    return { status: 'added', doc: meta };
  }

  function importError(error) {
    if (error.name === 'QuotaExceededError') return '浏览器本地存储空间不足';
    if (error.name === 'PasswordException') return 'PDF 需要密码，请导入已解锁的副本';
    if (error.name === 'InvalidPDFException') return 'PDF 已损坏或格式无效';
    if (/worker/i.test(error.message)) return 'PDF 解析器未能启动：' + error.message;
    if (error instanceof RangeError) return '文件处理超出当前浏览器容量：' + error.message;
    return error.message || String(error);
  }

  async function importFiles(fileList, boxId = R.study.state.boxFilter, notify) {
    const files = Array.from(fileList);
    let lastId = null;
    for (const [index, file] of files.entries()) {
      notify?.({ status: 'reading', file, index, total: files.length });
      let outcome;
      try { outcome = await importOne(file, boxId); }
      catch (error) { outcome = { status: 'failed', reason: importError(error) }; }
      if (outcome.doc) lastId = outcome.doc.id;
      if (notify) notify({ ...outcome, file });
      else if (outcome.reason) R.toast(file.name + '：' + outcome.reason, 'error', 6000);
    }
    if (lastId) renderSidebar();
    return lastId;
  }

  /** 解析：页数、缩略图、首页文字、离线标题 */
  async function analyze(bytes, fileName) {
    const pdf = await R.viewer.loadPdf(bytes).promise;
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
        pageCount: pdf.numPages, thumb, tone, aspect: vp1.width / vp1.height, scanned: text.trim().length < 15,
        title: R.core.summarizeTitle(candidates, fileName),
      };
    } finally {
      await pdf.destroy();
    }
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
    if (!m || !await R.confirm(`移除「${m.title}」？可在书库底部恢复，PDF、标注和对话会保留在此设备。`, '移除这本书')) return;
    if (currentId === id) await R.app.route('home');
    const removed=await R.db.kvGet('removedBooks',[]);
    await R.db.batch([{store:'docs',del:true,value:id},{store:'kv',value:{key:'removedBooks',value:[...removed,structuredClone(m)]}}]);
    docs = docs.filter((d) => d.id !== id);
    renderSidebar();
    if (!R.$('#homeView').classList.contains('hidden')) renderHome();
  }
  async function restoreRemoved(id){
    const removed=await R.db.kvGet('removedBooks',[]),doc=removed.find(d=>d.id===id);if(!doc||get(id))return;
    if(!R.study.boxes().some(b=>b.id===doc.boxId))doc.boxId='unsorted';
    await R.db.batch([{store:'docs',value:doc},{store:'kv',value:{key:'removedBooks',value:removed.filter(d=>d.id!==id)}}]);
    docs.unshift(doc);renderSidebar();await renderHome();R.toast('书籍和阅读记录已恢复');
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

  return { load, get, all: () => docs, importFiles, update, rename, remove, restoreRemoved, renderSidebar, renderHome, setCurrent, abbr, current: () => currentId };
})();
