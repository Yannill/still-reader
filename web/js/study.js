/* study.js — Library presentation, local archive management and secondary pages.
 * PDF sessions remain owned by app/viewer. A preview may prepare one PDF, never render it.
 */
'use strict';
R.study = (() => {
  const state = { view: 'shelf', boxFilter: 'all', query: '', scrollTop: 0, sort: 'recent' };
  let boxes = [], urls = new Map(), prepared = null, previewId = null, returnFocus = null;
  let transitioning = false, simplified = false, measured = false, clickTimer, menuId, upgradeRunning = false, flight = null, lastBookClick = null;
  const esc = R.esc;
  const pct = d => Math.round((d.progress || 0) * 100);
  const recent = () => R.library.all().filter(d => d.lastOpened).sort((a,b) => b.lastOpened-a.lastOpened)[0];
  const boxName = id => boxes.find(b => b.id === id)?.name || '未归档';
  const date = at => at ? new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(at) : '尚未翻开';
  const saveView = R.debounce(() => R.db.kvSet('libraryView', { ...state }), 150);
  const matches = d => (d.title + ' ' + d.name + ' ' + boxName(d.boxId)).toLowerCase().includes(state.query.toLowerCase());

  async function init() {
    boxes = (await R.db.all('boxes')).sort((a,b) => a.order-b.order);
    R.library.all().forEach(d => { if(!boxes.some(b=>b.id===d.boxId)) d.boxId='unsorted'; });
    Object.assign(state, await R.db.kvGet('libraryView', {}));
    if (state.boxFilter !== 'all' && !boxes.some(b => b.id === state.boxFilter)) state.boxFilter = 'all';
    R.$('#librarySearch').value = state.query;
    R.$('#librarySearch').oninput = e => { state.query = e.target.value; saveView(); filterSearch(); };
    R.$('#librarySearch').onkeydown = e => { if (e.key === 'Enter') { const d = visibleDocs().find(matches); if (d) direct(d.id); } };
    R.$('#homeView').addEventListener('click', onClick);
    document.addEventListener('pointerdown', e => {
      if(lastBookClick && previewId === lastBookClick.id && performance.now()-lastBookClick.at<500 && Math.hypot(e.clientX-lastBookClick.x,e.clientY-lastBookClick.y)<8) {
        e.preventDefault();e.stopPropagation();direct(previewId);lastBookClick=null;
      }
    }, true);
    R.$('#homeView').addEventListener('dblclick', e => {
      const book = e.target.closest('[data-book]');
      if (book) { clearTimeout(clickTimer); direct(book.dataset.book); }
      const label = e.target.closest('[data-box-label]');
      if (label && label.dataset.boxLabel !== 'unsorted') editBox(label.dataset.boxLabel);
    });
    R.$('#homeView').addEventListener('keydown', e => {
      const book = e.target.closest('[data-book]');
      if (!book) return;
      if (e.key === 'Enter' && e.shiftKey) { e.preventDefault(); clearTimeout(clickTimer); direct(book.dataset.book); }
      if (e.key.startsWith('Arrow')) {
        e.preventDefault(); const all = R.$$('[data-book]'); const n = all.indexOf(book), step = /Left|Up/.test(e.key) ? -1 : 1;
        const next = all[(n + step + all.length) % all.length]; all.forEach(b => b.tabIndex = -1); next.tabIndex = 0; next.focus();
      }
    });
    ['mouseover', 'focusin'].forEach(event => R.$('#homeView').addEventListener(event, e => {
      const book = e.target.closest('[data-book]'); if (book) describe(R.library.get(book.dataset.book));
    }));
    R.$('#homeView').addEventListener('scroll', () => { state.scrollTop = R.$('#homeView').scrollTop; saveView(); }, { passive: true });
    R.$('#homeView').addEventListener('dragstart', e => {
      const book = e.target.closest('[data-book]'); if (book) { e.dataTransfer.setData('application/x-still-book', book.dataset.book); e.dataTransfer.effectAllowed = 'move'; }
    });
    R.$('#homeView').addEventListener('dragover', e => { const box = e.target.closest('[data-box]'); if (box) { e.preventDefault(); box.classList.add('drag-target'); } });
    R.$('#homeView').addEventListener('dragleave', e => { if (!e.currentTarget.contains(e.relatedTarget)) R.$$('.drag-target').forEach(b => b.classList.remove('drag-target')); });
    R.$('#homeView').addEventListener('drop', async e => {
      const id = e.dataTransfer.getData('application/x-still-book'), box = e.target.closest('[data-box]');
      R.$$('.drag-target').forEach(b => b.classList.remove('drag-target'));
      if (id && box) { e.preventDefault(); e.stopPropagation(); await move(id, box.dataset.box); }
    });
    R.$('#previewBack').onclick = closePreview;
    R.$('#previewContinue').onclick = () => direct(previewId);
    R.$('#previewStart').onclick = () => direct(previewId, true);
    R.$('#previewMenu').onclick = () => showBookMenu(previewId);
    R.$('#previewDialog').addEventListener('cancel', e => { e.preventDefault(); finishMotion(); closePreview(); });
    R.$('#previewTitle').onkeydown = e => {
      if (e.key === 'Enter') { e.preventDefault(); saveTitle(); e.target.blur(); }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); e.target.textContent = R.library.get(previewId)?.title || ''; e.target.blur(); }
    };
    R.$('#previewTitle').onblur = saveTitle;
    R.$('#bookMove').onchange = async e => { if (menuId) { await move(menuId, e.target.value); if (previewId === menuId) R.$('#previewBox').textContent = boxName(e.target.value); } };
    R.$('#bookRename').onclick = () => { const id = menuId; R.$('#bookMenu').close(); preview(id).then(() => { R.$('#previewTitle').focus(); document.getSelection().selectAllChildren(R.$('#previewTitle')); }); };
    R.$('#bookRemove').onclick = async () => { const id = menuId; R.$('#bookMenu').close(); await closePreview(); await R.library.remove(id); };
    R.$('#boxForm').onsubmit = async e => {
      e.preventDefault(); const input = R.$('#boxName'), name = input.value.trim(); if (!name) return;
      const editing = input.dataset.id;
      if (editing) { const box = boxes.find(b => b.id === editing); if (box) { box.name = name; await R.db.put('boxes', box); } }
      else { const box = { id: R.uid('box'), name, order: boxes.length, createdAt: Date.now() }; await R.db.put('boxes', box); boxes.push(box); }
      R.$('#boxDialog').close(); await renderLibrary();
    };
    R.$('#boxDelete').onclick = async () => {
      const id = R.$('#boxName').dataset.id; if (!id || id === 'unsorted') return;
      R.$('#boxDialog').close(); if (!await R.confirm('删除这个收纳盒？书籍将移至“未归档”，标注和阅读记录会保留。', '删除收纳盒')) return;
      const moved = R.library.all().filter(d => d.boxId === id); moved.forEach(d => d.boxId = 'unsorted');
      await R.db.batch([{ store: 'boxes', del: true, value: id }, ...moved.map(d => ({ store: 'docs', value: d }))]);
      boxes = boxes.filter(b => b.id !== id); if (state.boxFilter === id) state.boxFilter = 'all'; saveView(); await renderLibrary();
    };
    R.$('#homeView').addEventListener('contextmenu', e => { const b = e.target.closest('[data-book]'); if (b) { e.preventDefault(); showBookMenu(b.dataset.book); } });
    R.bus.on('doc-updated', () => { if (!R.$('#homeView').classList.contains('hidden')) renderLibrary(); });
    R.whenIdle(upgradeCovers);
  }

  function imageURL(d) {
    const data = d.thumb2x || d.thumb; if (!data) return '';
    const old = urls.get(d.id); if (old?.data === data) return old.url;
    if (old) URL.revokeObjectURL(old.url);
    if (!data.startsWith('data:')) return '';
    const [head, encoded] = data.split(',');
    const bytes = Uint8Array.from(atob(encoded), c => c.charCodeAt(0));
    const url = URL.createObjectURL(new Blob([bytes], { type: head.match(/data:([^;]+)/)?.[1] || 'image/jpeg' }));
    urls.set(d.id, { data, url }); return url;
  }
  function cover(d, lazy = true) {
    const url = imageURL(d);
    return url ? `<img src="${esc(url)}" alt="${esc(d.title)}的首页" decoding="async" ${lazy ? 'loading="lazy"' : ''}>` : `<span class="fallback-cover"><span>${esc(d.title)}</span><small>PDF · ${d.pageCount} P.</small></span>`;
  }
  function visibleDocs() {
    return R.library.all().filter(d => state.boxFilter === 'all' || d.boxId === state.boxFilter).slice().sort((a,b) => state.sort === 'title' ? a.title.localeCompare(b.title,'zh') : state.sort === 'progress' ? (b.progress||0)-(a.progress||0) : (b.lastOpened||b.addedAt)-(a.lastOpened||a.addedAt));
  }
  function bookHTML(d, face, n) {
    const width = R.clamp(6 + 4*Math.log2(Math.max(1,d.pageCount)),10,34);
    const h = R.clamp(0.92 + ((d.aspect || 0.75)-0.75)*0.15,0.88,1);
    return `<button class="shelf-book ${face?'face':'spine'} ${d.progress?'in-progress':''} ${pct(d)>=100?'complete':''}" data-book="${d.id}" draggable="true" tabindex="${n===0?0:-1}" style="--spine-w:${width}px;--book-h:${h*100}%;--tone:${esc(d.tone||'var(--box)')}" aria-label="《${esc(d.title)}》，${d.pageCount} 页，已读 ${pct(d)}%">${face?cover(d):`<span class="spine-title">${esc(d.title)}</span><small>PDF</small>`}<i class="ribbon" style="height:${12+pct(d)*0.16}px"></i></button>`;
  }
  async function renderLibrary() {
    const el = R.$('#homeView'), last = recent(), stats = await R.adhd.todayStats();
    const shown = visibleDocs(), activeBoxes = boxes.filter(b => state.boxFilter === 'all' || b.id === state.boxFilter);
    let n = 0;
    const boxHTML = b => {
      const books = shown.filter(d => d.boxId === b.id);
      return `<section class="archive-box ${!books.length?'empty-box':''}" data-box="${b.id}" role="group" aria-label="${esc(b.name)}，${books.length} 本"><div class="box-books">${books.map((d,i)=>bookHTML(d,i===0,n++)).join('')}${!R.library.all().length?'<span class="empty-book-space"></span>':''}</div><div class="box-front"><span class="finger-hole" aria-hidden="true"></span><button class="box-label" data-box-label="${b.id}" data-edit-box="${b.id}" title="管理收纳盒">${esc(b.name)}<small>${String(books.length).padStart(2,'0')}</small></button></div></section>`;
    };
    const nonempty = activeBoxes.filter(b => shown.some(d => d.boxId === b.id));
    const empty = activeBoxes.filter(b => !shown.some(d => d.boxId === b.id));
    const groups = nonempty.length ? nonempty : activeBoxes.filter(b => b.id === 'unsorted').slice(0,1);
    const rows = [];
    for (let i=0;i<groups.length;i+=2) rows.push(`<div class="shelf-row" role="listitem">${groups.slice(i,i+2).map(boxHTML).join('')}</div>`);
    el.innerHTML = `<div class="library-layout"><aside class="library-index"><span class="eyebrow">01 / LIBRARY</span><h1>我的书库</h1><p class="english-title">My Library</p><p class="library-motto">A quiet place for<br>everything you read.</p>
      <div class="resume-block">${last?`<span class="eyebrow">拾起上次的思绪</span><button class="resume-link" data-direct="${last.id}"><span>${esc(last.title)}</span><span aria-hidden="true">↗</span></button><p class="mono">P.${String((last.pos?.i||0)+1).padStart(3,'0')} / ${last.pageCount} · ${date(last.lastOpened)}</p><p class="resume-quote">${esc(last.resumeText || '从上次停下的那一行，继续。')}</p>`:`<span class="eyebrow">每次，只读一点</span><p class="resume-quote">为想读的东西留一个位置。<br>不必一次读完。</p>`}</div>
      <div class="box-index"><span class="eyebrow">收纳盒 / INDEX</span><button data-filter="all" class="${state.boxFilter==='all'?'selected':''}"><span>全部书籍</span><i></i><small>${R.library.all().length}</small></button>${boxes.map(b=>`<button data-filter="${b.id}" class="${state.boxFilter===b.id?'selected':''}"><span>${esc(b.name)}</span><i></i><small>${R.library.all().filter(d=>d.boxId===b.id).length}</small></button>`).join('')}</div><p class="daily-line mono">今日 ${stats.lines} 行 · ${stats.minutes} 分钟<br>连续 ${stats.streak} 天</p></aside>
      <div class="library-collection"><div class="collection-head"><span class="eyebrow">${state.boxFilter==='all'?'全部书籍':esc(boxName(state.boxFilter))} <span class="collection-count">/ ${String(shown.length).padStart(2,'0')}</span></span><div class="view-switch"><button data-view="shelf" aria-pressed="${state.view==='shelf'}">书架</button><span>/</span><button data-view="list" aria-pressed="${state.view==='list'}">列表</button><select id="librarySort" aria-label="排序"><option value="recent">最近阅读</option><option value="title">书名</option><option value="progress">进度</option></select></div></div>
      ${state.view==='shelf'?`<div class="shelving ${boxes.length>40?'many-boxes':''}" role="list" aria-label="书架">${rows.join('')}<div class="empty-boxes">${empty.filter(b=>!groups.includes(b)).map(b=>`<button data-edit-box="${b.id}" class="empty-box-label">${esc(b.name)} <span>00</span></button>`).join('')}<button class="new-box" data-new-box>＋ 新收纳盒</button></div></div>`:`<div class="library-table"><div class="list-head mono"><span>NO.</span><span>书名 / TITLE</span><span>收纳盒</span><span>页数</span><span>进度</span><span>上次阅读</span><span></span></div>${shown.map((d,i)=>`<div class="book-row" data-row="${d.id}"><span class="mono">${String(i+1).padStart(2,'0')}</span><button data-book="${d.id}" class="list-book">${esc(d.title)}</button><span>${esc(boxName(d.boxId))}</span><span class="mono">${d.pageCount}</span><span class="list-progress"><i style="width:${pct(d)}%"></i><small>${pct(d)}%</small></span><span class="mono">${date(d.lastOpened)}</span><button data-menu="${d.id}" aria-label="管理 ${esc(d.title)}">⋯</button></div>`).join('')}<button class="new-box" data-new-box>＋ 新收纳盒</button></div>`}
      ${!R.library.all().length?'<div class="library-empty"><p>书架还空着。</p><button class="btn-primary" data-import>放上第一份 PDF</button><span>或将文件轻轻拖到这里</span></div>':''}<div class="exhibit-caption" id="exhibitCaption" aria-live="polite">${shown.length?'悬停或聚焦一本书，看看它的故事。':'纸页有序，思绪自在。'}</div><div class="collection-foot mono"><span>STILL READER — YOUR PERSONAL ARCHIVE</span><span>本地珍藏 · ${R.library.all().length} 份文档</span></div></div></div>`;
    R.$('#librarySort').value = state.sort;
    R.$('#librarySort').onchange = e => { state.sort=e.target.value; saveView(); renderLibrary(); };
    el.scrollTop = state.scrollTop; filterSearch();
    R.whenIdle(upgradeCovers);
  }
  function filterSearch() {
    R.$$('[data-book]').forEach(el => { const d = R.library.get(el.dataset.book); const match = d && matches(d); el.classList.toggle('search-dim', !match); if (el.closest('.book-row')) el.closest('.book-row').hidden = !match; });
    const caption = R.$('#exhibitCaption'); if (caption && state.query) caption.textContent = `找到 ${visibleDocs().filter(matches).length} 本与「${state.query}」有关的书`;
  }
  function describe(d) { const el=R.$('#exhibitCaption'); if (d&&el) el.textContent=`《${d.title}》 · ${d.pageCount} 页 · 已读 ${pct(d)}% · ${boxName(d.boxId)}`; }
  async function saveTitle() {
    const el=R.$('#previewTitle'), id=el.dataset.docId, title=el.textContent.trim();
    if(id && title && R.library.get(id)?.title !== title) { await R.library.rename(id,title);R.app.setTitle(); }
  }
  function onClick(e) {
    const b=e.target.closest('button'); if(!b)return;
    if(b.hasAttribute('data-import')) return R.$('#fileInput').click();
    if(b.dataset.book) {
      if(e.detail>0) lastBookClick={id:b.dataset.book,at:performance.now(),x:e.clientX,y:e.clientY};
      preview(b.dataset.book,b);return;
    }
    if(b.dataset.direct) return direct(b.dataset.direct);
    if(b.dataset.menu) return showBookMenu(b.dataset.menu);
    if(b.dataset.editBox) return editBox(b.dataset.editBox);
    if(b.hasAttribute('data-new-box')) return editBox();
    if(b.dataset.filter) { state.boxFilter=b.dataset.filter; state.scrollTop=0; saveView(); renderLibrary(); }
    if(b.dataset.view) { state.view=b.dataset.view; saveView(); renderLibrary(); }
  }
  function editBox(id) {
    const b=boxes.find(b=>b.id===id), input=R.$('#boxName'); input.value=b?.name||''; input.dataset.id=id||'';
    R.$('#boxDialogTitle').textContent=id?'管理收纳盒':'新收纳盒';
    input.readOnly=id==='unsorted'; R.$('#boxDelete').hidden=!id||id==='unsorted'; R.$('#boxDialog').showModal(); input.focus(); input.select();
  }
  async function move(id, boxId) { const d=R.library.get(id); if(!d||!boxes.some(b=>b.id===boxId))return; d.boxId=boxId; await R.library.update(d); await renderLibrary(); R.library.renderSidebar(); R.toast('已移至「'+boxName(boxId)+'」'); }
  function showBookMenu(id) {
    menuId=id; const d=R.library.get(id); if(!d)return;
    R.$('#bookMenuTitle').textContent=d.title;
    R.$('#bookMove').innerHTML=boxes.map(b=>`<option value="${b.id}">${esc(b.name)}</option>`).join(''); R.$('#bookMove').value=d.boxId;
    R.$('#bookMenu').showModal();
  }

  function discardPrepared() { if(prepared) { const p=prepared; prepared=null; p.task?.destroy(); } }
  function prepare(id) {
    if(prepared?.id===id)return prepared.promise;
    discardPrepared(); const entry={id,task:null}; prepared=entry;
    entry.promise=(async()=>{
      const file=await R.db.get('files',id); if(!file)throw Error('文件数据丢失，请重新导入');
      if(prepared!==entry)throw new DOMException('预览已取消','AbortError');
      entry.task=pdfjsLib.getDocument({data:file.bytes.slice(),cMapUrl:R.PDFJS.cmaps,cMapPacked:true,standardFontDataUrl:R.PDFJS.fonts});
      const pdf=await entry.task.promise; return {file,pdf};
    })();
    entry.promise.catch(()=>{}); return entry.promise;
  }
  async function takePrepared(id) { if(prepared?.id!==id)return null; const p=prepared; const result=await p.promise; if(prepared===p)prepared=null; return result; }
  function finishMotion() { document.getAnimations().forEach(a=>{try{a.finish();}catch{}}); transitioning=false; }
  async function animateBook(source, target, reverse=false) {
    const simple=R.motionReduced()||simplified, a=source?.getBoundingClientRect(), b=target.getBoundingClientRect();
    target.style.willChange='transform, opacity';
    if(!measured) { measured=true; let last=performance.now(),samples=[]; const frame=t=>{samples.push(t-last);last=t;if(samples.length<15)requestAnimationFrame(frame);else simplified=samples.reduce((a,b)=>a+b,0)/samples.length>24;};requestAnimationFrame(frame); }
    try {
      if(!simple&&a&&document.startViewTransition&&!reverse) {
        // The preview cover is already laid out; animate the snapshot's transform only.
        const name='book-'+previewId; target.style.viewTransitionName=name;
        const transition=document.startViewTransition(()=>{}); await transition.ready;
        const anim=document.documentElement.animate([{transform:`translate(${a.left-b.left}px,${a.top-b.top}px) scale(${a.width/b.width},${a.height/b.height}) rotate(-4deg)`,opacity:.4},{transform:'none',opacity:1}],{duration:380,easing:'cubic-bezier(.2,.7,.1,1)',pseudoElement:`::view-transition-new(${name})`});
        await anim.finished.catch(()=>{}); await transition.finished; target.style.viewTransitionName='none';
      } else {
        const frames=simple||!a?[{opacity:0},{opacity:1}]:[{transform:`translate(${a.left-b.left}px,${a.top-b.top}px) scale(${a.width/b.width},${a.height/b.height}) rotate(-4deg)`,opacity:.3},{transform:'none',opacity:1}];
        await target.animate(reverse?frames.reverse():frames,{duration:simple?120:reverse?300:380,easing:'cubic-bezier(.2,.7,.1,1)'}).finished.catch(()=>{});
      }
    } finally { target.style.willChange=''; }
  }
  async function preview(id, source) {
    if(transitioning)return; const d=R.library.get(id);if(!d)return;
    transitioning=true; previewId=id;returnFocus=source||document.activeElement;
    const loading=prepare(id); R.$('#previewCover').innerHTML=cover(d,false); R.$('#previewTitle').textContent=d.title;R.$('#previewTitle').dataset.docId=id;
    R.$('#previewMeta').textContent=`${d.pageCount} P. · 已读 ${pct(d)}% · 上次 P.${String((d.pos?.i||0)+1).padStart(3,'0')} · ${date(d.lastOpened)}`;
    R.$('#previewBox').textContent=boxName(d.boxId);R.$('#previewQuote').textContent=d.resumeText||'在这里，开启一段新的阅读。';
    R.$('#previewLoading').classList.add('loading');R.$('#previewDialog').showModal();
    loading.then(()=>R.$('#previewLoading').classList.remove('loading')).catch(e=>{if(previewId===id&&e.name!=='AbortError'){R.$('#previewLoading').classList.remove('loading');R.toast(e.message,'error');}});
    try{ if(source&&!R.motionReduced())await source.animate([{transform:'none'},{transform:'translateY(-14px) rotate(-4deg)'}],{duration:140}).finished.catch(()=>{});await animateBook(source,R.$('#previewCover')); }
    finally{transitioning=false;R.$('#previewContinue').focus();}
  }
  async function closePreview() {
    if(!R.$('#previewDialog').open)return;
    await saveTitle();
    finishMotion();const target=R.$(`[data-book="${previewId}"]`); if(target)await animateBook(target,R.$('#previewCover'),true);
    R.$('#previewDialog').close();previewId=null;discardPrepared();returnFocus?.focus?.();
  }
  async function direct(id, fromStart=false) {
    if(!id)return;clearTimeout(clickTimer);finishMotion();
    if(R.$('#previewDialog').open)await saveTitle();
    const source=R.$('#previewDialog').open?R.$('#previewCover'):R.$(`[data-book="${id}"]`);
    if(source&&!flight) {
      const rect=source.getBoundingClientRect(),d=R.library.get(id),ghost=document.createElement('div');
      ghost.className='book-flight';ghost.innerHTML=cover(d,false);
      Object.assign(ghost.style,{left:rect.left+'px',top:rect.top+'px',width:rect.width+'px',height:rect.height+'px'});
      document.body.appendChild(ghost);flight={ghost,rect,fromStart,id};
    }
    R.$('#previewDialog').close();previewId=null;
    try { await R.app.openDoc(id,{fromStart}); } finally { flight?.ghost.remove();flight=null; }
  }
  async function readerEntered() {
    if(!flight)return;
    const {ghost,rect,fromStart,id}=flight,d=R.library.get(id),simple=R.motionReduced()||simplified;
    const target=R.viewer.V.pages[0]?.el.getBoundingClientRect();
    ghost.style.willChange='transform,opacity';
    const frames=!simple&&target&&(fromStart||!d.pos?.i)?[{transform:'none',opacity:1},{transform:`translate(${target.left-rect.left}px,${target.top-rect.top}px) scale(${target.width/rect.width},${target.height/rect.height})`,opacity:0}]:[{opacity:1},{opacity:0}];
    await ghost.animate(frames,{duration:simple?120:300,easing:'cubic-bezier(.2,.7,.1,1)'}).finished.catch(()=>{});
    ghost.remove();flight=null;
    R.$('#readerTop').animate([{opacity:.2},{opacity:1}],{duration:simple?120:200});
  }
  async function returnToShelf() {
    const d=R.app.current(),p=R.viewer.V.pages[R.viewer.currentPage()];
    const rect=p?.el.getBoundingClientRect();
    await R.app.route('home');
    const target=d&&R.$(`[data-book="${d.id}"]`);
    if(!target||!rect)return;
    if(R.motionReduced()||d.pos?.i) {R.$('#homeView').animate([{opacity:.4},{opacity:1}],{duration:R.motionReduced()?120:300});return;}
    const ghost=document.createElement('div');ghost.className='book-flight';ghost.innerHTML=cover(d,false);
    Object.assign(ghost.style,{left:rect.left+'px',top:rect.top+'px',width:rect.width+'px',height:rect.height+'px',willChange:'transform,opacity'});document.body.appendChild(ghost);
    const t=target.getBoundingClientRect();await ghost.animate([{transform:'none',opacity:1},{transform:`translate(${t.left-rect.left}px,${t.top-rect.top}px) scale(${t.width/rect.width},${t.height/rect.height})`,opacity:0}],{duration:300,easing:'cubic-bezier(.2,.7,.1,1)'}).finished.catch(()=>{});ghost.remove();target.focus();
  }
  async function upgradeCovers() {
    if(upgradeRunning||!R.$('#readerView').classList.contains('hidden')||previewId)return;
    const d=R.library.all().find(d=>!d.thumb2x||!d.tone);if(!d)return; upgradeRunning=true;
    let pdf;
    try {
      const file=await R.db.get('files',d.id);if(!file)return;
      pdf=await pdfjsLib.getDocument({data:file.bytes.slice(),cMapUrl:R.PDFJS.cmaps,cMapPacked:true,standardFontDataUrl:R.PDFJS.fonts}).promise;
      const p=await pdf.getPage(1),vp=p.getViewport({scale:360/p.getViewport({scale:1}).width}),c=document.createElement('canvas');c.width=Math.ceil(vp.width);c.height=Math.ceil(vp.height);
      await p.render({canvasContext:c.getContext('2d'),viewport:vp}).promise;
      if(!R.library.get(d.id))return;d.thumb2x=c.toDataURL('image/jpeg',.8);d.aspect=vp.width/vp.height;
      if(d.pos && !d.resumeText) {
        const resumePage=await pdf.getPage(R.clamp(d.pos.i+1,1,pdf.numPages));
        const lines=R.core.linesFromText(await resumePage.getTextContent(),resumePage.getViewport({scale:1}));
        d.resumeText=lines[d.pos.k]?.text || '';
      }
      const sw=document.createElement('canvas');sw.width=sw.height=1;sw.getContext('2d').drawImage(c,0,0,1,1);d.tone=R.rgbToHex(...Array.from(sw.getContext('2d').getImageData(0,0,1,1).data).slice(0,3).map(n=>120+n*.38));await R.library.update(d);
    } catch(e){ console.warn('封面使用原有缩略图：',e.message);d.thumb2x=d.thumb||'unavailable';d.tone='var(--box)'; }
    finally{if(pdf)await pdf.destroy();upgradeRunning=false;}
    R.whenIdle(upgradeCovers);
  }

  async function renderNotes() {
    const rows=await R.db.all('annots'),parking=await R.db.kvGet('parking',[]),el=R.$('#notesView');
    el.innerHTML=`<div class="journal"><span class="eyebrow">02 / NOTES</span><h1>页边的思绪 <em>Notes</em></h1><div class="journal-tools"><label>收纳盒 <select id="notesFilter"><option value="all">全部</option>${boxes.map(b=>`<option value="${b.id}">${esc(b.name)}</option>`).join('')}</select></label><span class="mono">标注、引文与留下的话</span></div><div id="allNotes"></div><section class="parking-section"><h2>杂念停车场 <em>For later</em></h2>${parking.map(p=>`<p class="parking-note ${p.done?'done':''}">${esc(p.text)} <small class="mono">${esc(p.doc||'')} · ${date(p.at)}</small></p>`).join('')||'<p class="muted">还没有杂念。阅读时按 N，先放在这里。</p>'}<button id="notesParking" class="chip ghost">记下一个念头</button></section></div>`;
    const draw=()=>{const filter=R.$('#notesFilter').value;R.$('#allNotes').innerHTML=rows.map(rec=>{const d=R.library.get(rec.id);if(!d||filter!=='all'&&d.boxId!==filter)return '';return `<section class="note-book"><h2>${esc(d.title)}</h2>${rec.list.slice().sort((a,b)=>a.page-b.page).map(a=>`<button class="journal-note" data-note-doc="${d.id}" data-page="${a.page}" data-y="${a.rects[0]?.y||0}"><span class="eyebrow">P.${String(a.page+1).padStart(3,'0')} / ${esc(boxName(d.boxId))}</span><blockquote>${esc(a.text||'扫描页选区')}</blockquote>${a.comment?`<p>${esc(a.comment)}</p>`:''}</button>`).join('')}</section>`;}).join('')||'<p class="journal-empty">读过的文字，留下的想法，都会在这里相遇。</p>';};
    R.$('#notesFilter').onchange=draw;draw();R.$('#notesParking').onclick=()=>R.$('#navParking').click();
    el.onclick=async e=>{const b=e.target.closest('[data-note-doc]');if(!b)return;await R.app.openDoc(b.dataset.noteDoc);await R.viewer.ensureLines(+b.dataset.page);const p=R.viewer.V.pages[+b.dataset.page];let k=0,dist=Infinity;p.lines.forEach((l,i)=>{if(Math.abs(l.y- +b.dataset.y)<dist){k=i;dist=Math.abs(l.y- +b.dataset.y);}});if(p.lines.length)await R.focus.setPos(p.i,k);else R.reader.jump(p.i);};
  }
  async function renderFocus() {
    const stats=await R.db.kvGet('stats',{}),today=await R.adhd.todayStats(),days=[];
    for(let i=13;i>=0;i--){const d=new Date();d.setDate(d.getDate()-i);const key=`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;days.push({key,lines:stats[key]?.lines||0});}
    const max=Math.max(1,...days.map(d=>d.lines)),last=recent();
    R.$('#focusView').innerHTML=`<div class="journal focus-journal"><span class="eyebrow">03 / FOCUS</span><h1>一点一点，读下去 <em>Focus</em></h1><p class="focus-intro">不必赶路。今天的每一行，都算数。</p><div class="focus-numbers">${[[today.lines,'今天读过的行'],[today.minutes,'专注分钟'],[today.streak,'连续阅读天数']].map(([n,l])=>`<div><strong>${String(n).padStart(2,'0')}</strong><span>${l}</span></div>`).join('')}</div><div class="chart-head eyebrow">最近 14 天 / LINES READ</div><div class="focus-chart" role="img" aria-label="近14天每日阅读行数：${days.map(d=>d.key+' '+d.lines+'行').join('，')}">${days.map(d=>`<div title="${d.key}：${d.lines}行"><span style="height:${Math.max(1,d.lines/max*100)}%"></span><small>${d.key.slice(8)}</small></div>`).join('')}</div>${last?`<button class="btn-primary" id="focusResume">从上次停下的地方开始 ↗</button><p class="mono">${esc(last.title)} · P.${(last.pos?.i||0)+1}</p>`:'<button class="btn-primary" id="focusLibrary">到书库选一本书 →</button>'}</div>`;
    if(last)R.$('#focusResume').onclick=()=>direct(last.id);else R.$('#focusLibrary').onclick=()=>R.app.route('home');
  }
  return { init,state,renderLibrary,renderNotes,renderFocus,boxName,boxes:()=>boxes,recent,move,preview,closePreview,direct,prepare,takePrepared,saveView:()=>saveView.flush(),finishMotion,readerEntered,returnToShelf };
})();
