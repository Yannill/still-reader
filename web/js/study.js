/* study.js — Library presentation, local archive management and secondary pages.
 * PDF sessions remain owned by app/viewer. A preview may prepare one PDF, never render it.
 */
'use strict';
R.study = (() => {
  const state = { railCollapsed: false, categoriesOpen: false, boxFilter: 'all', query: '', scrollTop: 0, sort: 'recent' };
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
    const savedView = await R.db.kvGet('libraryView', {});
    for (const key of Object.keys(state)) {
      if (Object.hasOwn(savedView, key)) state[key] = savedView[key];
    }
    if (state.boxFilter !== 'all' && state.boxFilter !== 'recent' && !boxes.some(b => b.id === state.boxFilter)) state.boxFilter = 'all';
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
      if (label) editBox(label.dataset.boxLabel);
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
    R.$('#homeView').addEventListener('scroll', () => { state.scrollTop = R.$('#homeView').scrollTop; saveView(); }, { passive: true });
    R.$('#homeView').addEventListener('dragstart', e => {
      const folder=e.target.closest('[data-folder-drag]');if(folder){e.dataTransfer.setData('application/x-still-folder',folder.dataset.folderDrag);e.dataTransfer.effectAllowed='move';return;}
      const book = e.target.closest('[data-book]'); if (book) { e.dataTransfer.setData('application/x-still-book', book.dataset.book); e.dataTransfer.effectAllowed = 'move'; }
    });
    R.$('#homeView').addEventListener('dragover', e => { const box = e.target.closest('[data-box]'); if (box) { e.preventDefault(); box.classList.add('drag-target'); } });
    R.$('#homeView').addEventListener('dragleave', e => { if (!e.currentTarget.contains(e.relatedTarget)) R.$$('.drag-target').forEach(b => b.classList.remove('drag-target')); });
    R.$('#homeView').addEventListener('drop', async e => {
      const id = e.dataTransfer.getData('application/x-still-book'), box = e.target.closest('[data-box]');
      R.$$('.drag-target').forEach(b => b.classList.remove('drag-target'));
      const folderId=e.dataTransfer.getData('application/x-still-folder');if(folderId&&box){e.preventDefault();e.stopPropagation();return reorderBox(folderId,box.dataset.box);}
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
      R.$('#boxDialog').close(); await renderLibrary(); R.library.renderSidebar?.(); R.app?.setTitle?.();
    };
    R.$('#boxDelete').onclick = async () => {
      const id = R.$('#boxName').dataset.id; if (!id || id === 'unsorted') return;
      R.$('#boxDialog').close(); if (!await R.confirm('删除这个收纳盒？书籍将移至“未归档”，标注和阅读记录会保留。', '删除收纳盒')) return;
      const moved = R.library.all().filter(d => d.boxId === id);
      const removed={box:structuredClone(boxes.find(b=>b.id===id)),docs:moved.map(d=>d.id)};
      await R.db.batch([{ store: 'boxes', del: true, value: id }, ...moved.map(d => ({ store: 'docs', value: {...d,boxId:'unsorted'} })),{store:'kv',value:{key:'removedBox',value:removed}}]);
      moved.forEach(d=>d.boxId='unsorted');
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
  function visibleDocs(filter = state.boxFilter) {
    return R.library.all().filter(d => filter === 'all' || filter === 'recent' && d.lastOpened || d.boxId === filter).slice().sort((a,b) => state.sort === 'title' ? a.title.localeCompare(b.title,'zh') : state.sort === 'progress' ? (b.progress||0)-(a.progress||0) : (b.lastOpened||b.addedAt)-(a.lastOpened||a.addedAt));
  }
  function bookHTML(d, n) {
    const h = R.clamp(0.92 + ((d.aspect || 0.75)-0.75)*0.15,0.88,1);
    return `<button class="shelf-book face ${d.progress?'in-progress':''} ${pct(d)>=100?'complete':''}" data-book="${d.id}" draggable="true" tabindex="${n===0?0:-1}" style="--book-h:${h*100}%;--tone:${esc(d.tone||'var(--box)')}" aria-label="《${esc(d.title)}》，${d.pageCount} 页，已读 ${pct(d)}%">${cover(d)}<i class="ribbon" style="height:${12+pct(d)*0.16}px"></i></button>`;
  }
  function folderHTML(b,docs,idx=0){
    const mono=['white','gray','black'][idx%3];
    const gradId='fbg-'+b.id+'-'+mono;
    const stops=mono==='black'
      ? '<stop offset="0%" stop-color="#3E3B37" stop-opacity=".86"/><stop offset="55%" stop-color="#282623" stop-opacity=".91"/><stop offset="100%" stop-color="#191816" stop-opacity=".95"/>'
      : mono==='gray'
      ? '<stop offset="0%" stop-color="#A8A49C" stop-opacity=".78"/><stop offset="55%" stop-color="#8B877F" stop-opacity=".84"/><stop offset="100%" stop-color="#6E6A63" stop-opacity=".9"/>'
      : '<stop offset="0%" stop-color="#F5F3ED" stop-opacity=".86"/><stop offset="55%" stop-color="#E6E2D9" stop-opacity=".88"/><stop offset="100%" stop-color="#D6D1C6" stop-opacity=".92"/>';
    const items=docs.slice(0,4);
    const sheets=[];
    for(let j=0;j<Math.max(3,items.length);j++){
      const d=items[j];
      const slot=j-(Math.max(3,items.length)-1)/2;
      if(d){
        sheets.push('<div class="folder-sheet" style="--depth:'+j+';--slot:'+slot+'">'+cover(d)+'<span>'+esc(d.title)+'</span></div>');
      }else{
        sheets.push('<div class="folder-sheet folder-liner" style="--depth:'+j+';--slot:'+slot+'" aria-hidden="true"><div class="liner-lines"></div></div>');
      }
    }
    return '<section class="archive-box folder" data-mono="'+mono+'" style="--folder-i:'+idx+'" data-box="'+b.id+'" role="listitem" aria-label="'+esc(b.name)+'，'+docs.length+' 本"><div class="folder-tilt"><div class="folder-shadow"></div><svg class="folder-back" viewBox="0 0 340 272" aria-hidden="true"><defs><linearGradient id="'+gradId+'" x1="0%" y1="0%" x2="100%" y2="100%">'+stops+'</linearGradient></defs><path fill="url(#'+gradId+')" d="M24 34H142C162 34 163 0 186 0H316Q340 0 340 24V248Q340 272 316 272H24Q0 272 0 248V58Q0 34 24 34Z"/></svg><div class="folder-sheets">'+sheets.join('')+'</div><div class="folder-front"><span class="folder-glare" aria-hidden="true"></span><button class="folder-hit" data-open-box="'+b.id+'" draggable="true" data-folder-drag="'+b.id+'" aria-label="打开文件夹 '+esc(b.name)+'" aria-expanded="false"></button><span class="folder-label"><b>'+esc(b.name)+'</b><small>'+String(docs.length).padStart(2,'0')+' 份文档</small></span><button class="folder-menu" data-edit-box="'+b.id+'" aria-label="管理文件夹 '+esc(b.name)+'">⋯</button></div></div></section>';
  }
  async function renderLibrary(){
    const el=R.$('#homeView'),last=recent(),shown=visibleDocs(),activeBoxes=boxes.filter(b=>state.boxFilter==='all'||state.boxFilter==='recent'&&shown.some(d=>d.boxId===b.id)||b.id===state.boxFilter);
    const trash=await R.db.kvGet('removedBooks',[]),deletedBox=await R.db.kvGet('removedBox',null);
    const today=R.adhd?.todayStats?await R.adhd.todayStats():{lines:0,streak:0};
    const icoAll='<svg class="rail-svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20"/></svg>';
    const icoRecent='<svg class="rail-svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15.5 14"/></svg>';
    const icoCat='<svg class="rail-svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>';
    el.innerHTML='<div class="library-layout '+(state.railCollapsed?'rail-collapsed':'')+'"><aside class="library-index"><div class="library-heading"><h1>我的书库</h1><button data-collapse-rail aria-label="'+(state.railCollapsed?'展开书库导航':'折叠书库导航')+'" aria-expanded="'+!state.railCollapsed+'" title="折叠 / 展开书库导航">'+(state.railCollapsed?'☰':'‹')+'</button></div><div class="box-index"><button data-filter="all" title="全部藏书" aria-label="全部藏书" class="'+(state.boxFilter==='all'?'selected':'')+'">'+icoAll+'<span class="rail-label">'+(state.railCollapsed?'全部':'全部藏书')+'</span><small>'+R.library.all().length+'</small></button><button data-filter="recent" title="最近阅读" aria-label="最近阅读" class="'+(state.boxFilter==='recent'?'selected':'')+'">'+icoRecent+'<span class="rail-label">'+(state.railCollapsed?'最近':'最近阅读')+'</span></button><details '+(state.categoriesOpen?'open':'')+' id="libraryCategories"><summary title="分类文件夹">'+icoCat+'<span class="rail-label">分类</span></summary>'+boxes.map(b=>'<button data-filter="'+b.id+'" title="'+esc(b.name)+'" class="category-link '+(state.boxFilter===b.id?'selected':'')+'"><span class="rail-icon" aria-hidden="true">·</span><span class="rail-label">'+esc(b.name)+'</span><small>'+R.library.all().filter(d=>d.boxId===b.id).length+'</small></button>').join('')+'</details></div><div class="resume-block">'+(last?'<span class="eyebrow">继续阅读</span><button class="resume-card" data-direct="'+last.id+'" title="继续阅读 '+esc(last.title)+'"><span class="resume-cover">'+cover(last)+'</span><span class="resume-copy"><b>'+esc(last.title)+'</b><small>第 '+((last.pos?.i||0)+1)+' / '+last.pageCount+' 页 · '+pct(last)+'%</small><i><u style="width:'+pct(last)+'%"></u></i></span></button>':'<p class="muted rail-label">导入一份 PDF，开始阅读。</p>')+'</div><div class="rail-stats-block"><div class="rail-stats-meta mono">今日 '+today.lines+' 行 · 连续 '+today.streak+' 天</div></div></aside><div class="library-collection"><div class="collection-head"><div class="collection-title"><span class="collection-name">'+(state.boxFilter==='all'?'全部藏书':state.boxFilter==='recent'?'最近阅读':esc(boxName(state.boxFilter)))+'</span><span class="collection-count" aria-live="polite">'+String(shown.length).padStart(2,'0')+' 份</span></div></div>'+
      '<div class="shelving folder-grid '+(activeBoxes.length>9?'dense':'')+'" role="list" aria-label="文件夹书架">'+activeBoxes.map((b,idx)=>folderHTML(b,shown.filter(d=>d.boxId===b.id),idx)).join('')+'<button class="new-box new-folder" data-new-box>＋ 新文件夹</button></div>'+
      (!R.library.all().length?'<div class="library-empty"><p>书架还空着。</p><button class="btn-primary" data-import>放上第一份 PDF</button><span>也可以拖入文件</span></div>':'')+(trash.length?'<div class="restore-row">已移除的书籍仍可恢复 <button data-restore-book="'+trash.at(-1).id+'">恢复《'+esc(trash.at(-1).title)+'》</button></div>':'')+(deletedBox?'<div class="restore-row">已删除文件夹 <button data-restore-box>恢复「'+esc(deletedBox.box.name)+'」</button></div>':'')+'</div></div>';
    R.$('#libraryCategories').ontoggle=e=>{state.categoriesOpen=e.target.open;saveView();};
    el.scrollTop=state.scrollTop;filterSearch();R.whenIdle(upgradeCovers);
    R.$$('.folder').forEach(folder=>{folder.onpointermove=e=>{if(e.pointerType!=='mouse'||R.motionReduced())return;const r=folder.getBoundingClientRect();folder.style.setProperty('--px',((e.clientX-r.left)/r.width-.5)*2);folder.style.setProperty('--py',((e.clientY-r.top)/r.height-.5)*2);};folder.onpointerleave=()=>{folder.style.setProperty('--px',0);folder.style.setProperty('--py',0);};});
    if(openFolderId && R.$('#folderDialog')?.open)drawFolder();
  }
  let openFolderId=null,folderReturn=null;
  function drawFolder(){
    const b=boxes.find(b=>b.id===openFolderId);if(!b)return closeFolder();
    const docs = visibleDocs(state.boxFilter === 'recent' ? 'recent' : b.id).filter(d => d.boxId === b.id && matches(d));
    R.$('#folderDialog').innerHTML='<div class="folder-dialog-head"><button data-close-folder>← 返回书架</button><button data-edit-box="'+b.id+'" aria-label="管理文件夹">管理 ⋯</button></div><div class="folder-focus-art" aria-hidden="true" inert>'+folderHTML(b,docs)+'</div><div class="folder-content-head"><h2 id="folderTitle">'+esc(b.name)+'</h2><span>'+docs.length+' 份文档</span><button data-folder-import>添加 PDF</button></div><div class="folder-contents" data-box="'+b.id+'">'+(docs.length?docs.map((d,i)=>'<div class="folder-book">'+bookHTML(d,i)+'<button data-menu="'+d.id+'" class="folder-book-menu" aria-label="管理 '+esc(d.title)+'">⋯</button><b>'+esc(d.title)+'</b><small>'+d.pageCount+' 页 · '+pct(d)+'%</small></div>').join(''):'<div class="folder-empty">'+(state.query?'没有匹配的书籍。':'文件夹还是空的。添加 PDF，或将书籍拖到这里。')+'</div>')+'</div><div class="folder-move-targets"><span>拖动书籍，移到：</span>'+boxes.filter(target=>target.id!==b.id).map(target=>'<button data-drop-box="'+target.id+'" data-open-box="'+target.id+'" title="拖放书籍至 '+esc(target.name)+'">'+esc(target.name)+'</button>').join('')+'</div>';
  }
  function openFolder(id){
    openFolderId=id;folderReturn=R.$('[data-open-box="'+id+'"]');
    let dialog=R.$('#folderDialog');if(!dialog){dialog=document.createElement('dialog');dialog.id='folderDialog';dialog.className='folder-dialog';dialog.setAttribute('aria-labelledby','folderTitle');document.body.appendChild(dialog);dialog.onclick=onClick;dialog.addEventListener('cancel',e=>{e.preventDefault();closeFolder();});dialog.addEventListener('contextmenu',e=>{const b=e.target.closest('[data-book]');if(b){e.preventDefault();showBookMenu(b.dataset.book);}});dialog.addEventListener('dragstart',e=>{const b=e.target.closest('[data-book]');if(b)e.dataTransfer.setData('application/x-still-book',b.dataset.book);});dialog.addEventListener('keydown',e=>{const book=e.target.closest('[data-book]');if(!book)return;if(e.key==='Enter'&&e.shiftKey){e.preventDefault();direct(book.dataset.book);}if(e.key.startsWith('Arrow')){e.preventDefault();const all=R.$$('[data-book]',dialog),n=all.indexOf(book),step=/Left|Up/.test(e.key)?-1:1,next=all[(n+step+all.length)%all.length];all.forEach(b=>b.tabIndex=-1);next.tabIndex=0;next.focus();}});dialog.addEventListener('dragover',e=>{const target=e.target.closest('[data-drop-box]');if(target){e.preventDefault();target.classList.add('drag-target');}});dialog.addEventListener('dragleave',e=>e.target.closest('[data-drop-box]')?.classList.remove('drag-target'));dialog.addEventListener('drop',e=>{const target=e.target.closest('[data-drop-box]'),id=e.dataTransfer.getData('application/x-still-book');if(target&&id){e.preventDefault();e.stopPropagation();move(id,target.dataset.dropBox);}});}
    drawFolder();R.$('.shelving')?.classList.add('folder-focused');folderReturn?.setAttribute('aria-expanded','true');if(!dialog.open)dialog.showModal();
  }
  async function closeFolder(){
    const dialog=R.$('#folderDialog');if(!dialog?.open)return;
    if(!R.motionReduced())await dialog.animate([{opacity:1,transform:'none'},{opacity:0,transform:'translateY(12px) scale(.98)'}],{duration:180,easing:'ease-out'}).finished.catch(()=>{});
    dialog.close();R.$('.shelving')?.classList.remove('folder-focused');openFolderId=null;folderReturn?.setAttribute('aria-expanded','false');folderReturn?.focus();
  }
  async function reorderBox(id,before){
    const b=boxes.find(b=>b.id===id);if(!b||id===before)return;const next=boxes.filter(b=>b.id!==id),at=next.findIndex(b=>b.id===before);next.splice(at<0?next.length:at,0,b);
    const values=next.map((b,order)=>({...b,order}));await R.db.batch(values.map(value=>({store:'boxes',value})));boxes=values;await renderLibrary();
  }
  function filterSearch() {
    R.$$('.folder-grid [data-box]').forEach(el=>el.classList.toggle('search-dim',!!state.query&&!R.library.all().some(d=>d.boxId===el.dataset.box&&matches(d))&&!boxName(el.dataset.box).toLowerCase().includes(state.query.toLowerCase())));
    R.$$('[data-book]').forEach(el => { const d = R.library.get(el.dataset.book); const match = d && matches(d); el.classList.toggle('search-dim', !match); });
    const count = R.$('.collection-count');
    if (count) count.textContent = String(visibleDocs().filter(matches).length).padStart(2, '0') + ' 份';
  }
  async function saveTitle() {
    const el=R.$('#previewTitle'), id=el.dataset.docId, title=el.textContent.trim();
    if(id && title && R.library.get(id)?.title !== title) { await R.library.rename(id,title);R.app.setTitle(); }
  }
  function onClick(e) {
    const b=e.target.closest('button'); if(!b)return;
    if(b.hasAttribute('data-collapse-rail')){state.railCollapsed=!state.railCollapsed;saveView();renderLibrary();return;}
    if(b.hasAttribute('data-statistics'))return R.app.route('focus');
    if(b.dataset.openBox)return openFolder(b.dataset.openBox);
    if(b.hasAttribute('data-close-folder'))return closeFolder();
    if(b.hasAttribute('data-folder-import')){R.app.pickFiles(openFolderId);return;}
    if(b.dataset.restoreBook)return R.library.restoreRemoved(b.dataset.restoreBook);
    if(b.hasAttribute('data-restore-box'))return restoreBox();
    if(b.hasAttribute('data-import')) return R.app.pickFiles();
    if(b.dataset.book) {
      if(e.detail>0) lastBookClick={id:b.dataset.book,at:performance.now(),x:e.clientX,y:e.clientY};
      preview(b.dataset.book,b);return;
    }
    if(b.dataset.direct) return direct(b.dataset.direct);
    if(b.dataset.menu) return showBookMenu(b.dataset.menu);
    if(b.dataset.editBox) return editBox(b.dataset.editBox);
    if(b.hasAttribute('data-new-box')) return editBox();
    if(b.dataset.filter) { state.boxFilter=b.dataset.filter; state.scrollTop=0; saveView(); renderLibrary(); }
  }
  async function restoreBox(){
    const removed=await R.db.kvGet('removedBox',null);if(!removed||boxes.some(b=>b.id===removed.box.id))return;
    const docs=removed.docs.map(id=>R.library.get(id)).filter(d=>d&&d.boxId==='unsorted');
    await R.db.batch([{store:'boxes',value:removed.box},...docs.map(d=>({store:'docs',value:{...d,boxId:removed.box.id}})),{store:'kv',value:{key:'removedBox',value:null}}]);
    docs.forEach(d=>d.boxId=removed.box.id);boxes.push(removed.box);boxes.sort((a,b)=>a.order-b.order);await renderLibrary();
  }
  function editBox(id) {
    const b=boxes.find(b=>b.id===id), input=R.$('#boxName'); input.value=b?.name||''; input.dataset.id=id||'';
    R.$('#boxDialogTitle').textContent=id?'管理文件夹':'新文件夹';
    input.readOnly=false; input.disabled=false;
    R.$('#boxDelete').hidden=!id||id==='unsorted';
    R.$('#boxDialog').showModal(); input.focus(); input.select();
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
      let file=await R.db.get('files',id);
      if(!file) file = await R.cloud?.downloadPdf?.(id);
      if(!file)throw Error('文件数据丢失，请重新导入');
      if(prepared!==entry)throw new DOMException('预览已取消','AbortError');
      entry.task=R.viewer.loadPdf(file.bytes);
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
    if(transitioning)return; if(R.$('#folderDialog')?.open)await closeFolder(); const d=R.library.get(id);if(!d)return;
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
    if(!id)return;if(R.$('#folderDialog')?.open)await closeFolder();clearTimeout(clickTimer);finishMotion();
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
      pdf=await R.viewer.loadPdf(file.bytes).promise;
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
    el.innerHTML=`<div class="journal notes-journal"><span class="eyebrow">02 / NOTES</span><h1>页边的思绪 <em>Notes</em></h1><div class="journal-tools"><label>文件夹 <select id="notesFilter"><option value="all">全部</option>${boxes.map(b=>`<option value="${b.id}">${esc(b.name)}</option>`).join('')}</select></label><span class="mono">标注、引文与留下的话</span></div><div id="allNotes"></div><section class="parking-section"><h2>杂念停车场 <em>For later</em></h2>${parking.map(p=>`<p class="parking-note ${p.done?'done':''}">${esc(p.text)} <small class="mono">${esc(p.doc||'')} · ${date(p.at)}</small></p>`).join('')||'<p class="muted">还没有杂念。阅读时按 N，先放在这里。</p>'}<button id="notesParking" class="chip ghost">记下一个念头</button></section></div>`;
    const draw=()=>{const filter=R.$('#notesFilter').value;const html=rows.map(rec=>{const d=R.library.get(rec.id);if(!d||!rec.list?.length||(filter!=='all'&&d.boxId!==filter))return '';return `<section class="note-book"><h2><span>${esc(d.title)}</span><small class="note-count">${rec.list.length} 条</small></h2><div class="note-book-list">${rec.list.slice().sort((a,b)=>a.page-b.page).map(a=>`<button class="journal-note" data-note-doc="${d.id}" data-page="${a.page}" data-y="${a.rects[0]?.y||0}"><span class="eyebrow">P.${String(a.page+1).padStart(3,'0')} · ${esc(boxName(d.boxId))}</span><blockquote>${esc(a.text||'扫描页选区')}</blockquote>${a.comment?`<p>${esc(a.comment)}</p>`:''}</button>`).join('')}</div></section>`;}).filter(Boolean).join('');R.$('#allNotes').innerHTML=html||'<p class="journal-empty">读过的文字，留下的想法，都会在这里相遇。</p>';};
    R.$('#notesFilter').onchange=draw;draw();R.$('#notesParking').onclick=()=>R.$('#navParking').click();
    el.onclick = async e => {
      const note = e.target.closest('[data-note-doc]');
      if (!note) return;
      const id = note.dataset.noteDoc, page = Number(note.dataset.page), y = Number(note.dataset.y);
      await R.app.openDoc(id);
      if (R.app.current()?.id !== id) return;
      const lines = await R.viewer.ensureLines(page);
      if (R.app.current()?.id !== id) return;
      if (!lines.length || !R.focus.isOn()) return R.reader.jump(page, { y });
      let nearest = 0;
      lines.forEach((line, i) => {
        if (Math.abs(line.y - y) < Math.abs(lines[nearest].y - y)) nearest = i;
      });
      await R.focus.setPos(page, nearest);
    };
  }
  async function renderFocus() {
    const stats=await R.db.kvGet('stats',{}),today=await R.adhd.todayStats(),days=[];
    for(let i=13;i>=0;i--){const d=new Date();d.setDate(d.getDate()-i);const key=`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;days.push({key,lines:stats[key]?.lines||0});}
    const max=Math.max(1,...days.map(d=>d.lines)),last=recent();
    R.$('#focusView').innerHTML=`<div class="journal focus-journal"><span class="eyebrow">03 / FOCUS</span><h1>一点一点，读下去 <em>Focus</em></h1><p class="focus-intro">不必赶路。今天的每一行，都算数。</p><div class="focus-numbers">${[[today.lines,'今天读过的行','行'],[today.minutes,'专注时长','分钟'],[today.streak,'连续阅读','天']].map(([n,l,u])=>`<div class="focus-stat"><strong>${String(n).padStart(2,'0')}<em>${u}</em></strong><span>${l}</span></div>`).join('')}</div><div class="focus-chart-card"><div class="chart-head eyebrow">最近 14 天 · 每日阅读行数</div><div class="focus-chart" role="img" aria-label="近14天每日阅读行数：${days.map(d=>d.key+' '+d.lines+'行').join('，')}">${days.map(d=>`<div class="${d.lines?'has-data':'is-zero'}" title="${d.key}：${d.lines} 行">${d.lines?`<i class="bar-val">${d.lines}</i>`:''}<span style="height:${d.lines?Math.max(10,Math.round(d.lines/max*100)):3}%"></span><small>${d.key.slice(8)}</small></div>`).join('')}</div></div><div class="focus-resume-bar">${last?`<button class="btn-primary" id="focusResume">从上次停下的地方开始 ↗</button><span class="focus-last-doc mono">${esc(last.title)} · 第 ${(last.pos?.i||0)+1} 页</span>`:'<button class="btn-primary" id="focusLibrary">到书库选一本书 →</button>'}</div></div>`;
    if(last)R.$('#focusResume').onclick=()=>direct(last.id);else R.$('#focusLibrary').onclick=()=>R.app.route('home');
  }
  async function reloadBoxes() {
    boxes = (await R.db.all('boxes')).sort((a, b) => a.order - b.order);
  }
  return { init,reloadBoxes,openFolder,closeFolder,reorderBox,state,renderLibrary,renderNotes,renderFocus,boxName,boxes:()=>boxes,recent,move,preview,closePreview,direct,prepare,takePrepared,saveView:()=>saveView.flush(),finishMotion,readerEntered,returnToShelf };
})();
