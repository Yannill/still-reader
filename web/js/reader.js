/* Shared left navigation and committed progress seeking. */
'use strict';
R.reader = (() => {
  let outlineObserver, token=0, entries=[], previewToken=0, thumbCache=new Map(), seekTimer;
  const isDrawerViewport = () => window.matchMedia('(max-width: 1199px), (hover: none) and (pointer: coarse)').matches;
  function syncOutlineBackdrop() {
    const panel = R.$('#outlinePanel');
    const backdrop = R.$('#outlineBackdrop');
    if (!panel || !backdrop) return;
    const showBackdrop = !panel.classList.contains('hidden') && isDrawerViewport();
    backdrop.classList.toggle('hidden', !showBackdrop);
  }
  function init(){
    R.$('#readerHome').onclick=()=>R.study.returnToShelf();
    R.$('#prevPage').onclick=()=>jump(R.viewer.currentPage()-1);
    R.$('#nextPage').onclick=()=>jump(R.viewer.currentPage()+1);
    R.$('#pageInput').onchange=e=>jump(Number(e.target.value)-1);
    R.$('#pageInput').onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();jump(Number(e.target.value)-1);e.target.blur();}};
    R.$('#btnFitPage').onclick=()=>{const i=R.viewer.currentPage();R.viewer.setScale(R.viewer.fitPageScale(),{fit:'page'});jump(i);};
    for(const [id,key,checkbox] of [['paperSelect','paper'],['reduceMotion','reducedMotion',true],['focusModeControl','focusMode'],['readingContent','readingContent']]){
      const el=R.$('#'+id);if(!el)continue;if(checkbox)el.checked=R.settings[key];else el.value=R.settings[key];
      el.onchange=()=>{R.settings[key]=checkbox?el.checked:el.value;R.saveSettings();};
    }
    R.$('#btnOutline').onclick=()=>toggleOutline();
    const outlineBackdrop = R.$('#outlineBackdrop');
    if (outlineBackdrop) outlineBackdrop.onclick = () => toggleOutline(false, !isDrawerViewport());
    window.addEventListener('resize', syncOutlineBackdrop);
    R.$$('.drawer-tabs [data-drawer]').forEach(b=>b.onclick=()=>{if(b.dataset.drawer==='outline')toggleOutline(true);if(b.dataset.drawer==='annot')R.annot.togglePanel(true);if(b.dataset.drawer==='chat')R.chat.toggle(true);});
    R.$('#readerView').insertAdjacentHTML('beforeend','<footer class="reader-progress"><input id="progressSeek" type="range" min="1" max="1" value="1" step="1" aria-label="拖动预览，释放跳转到目标页"><span id="bottomPercent"></span><div id="seekPreview" class="seek-preview hidden" aria-live="polite"><span id="seekLabel"></span><img id="seekImage" alt="目标页缩略预览"></div></footer>');
    const seek=R.$('#progressSeek');
    seek.oninput=()=>{R.show(R.$('#seekPreview'));R.$('#seekLabel').textContent='第 '+seek.value+' 页 · 释放跳转';R.$('#seekImage').removeAttribute('src');clearTimeout(seekTimer);const seq=++previewToken,pdf=R.viewer.V.pdf,i=Number(seek.value)-1;seekTimer=setTimeout(async()=>{try{let url=thumbCache.get(i);if(!url){url=await R.viewer.pageImage(i,null,150);if(pdf===R.viewer.V.pdf){thumbCache.set(i,url);if(thumbCache.size>6)thumbCache.delete(thumbCache.keys().next().value);}}if(seq===previewToken&&pdf===R.viewer.V.pdf)R.$('#seekImage').src=url;}catch{}},120);};
    seek.onchange=()=>{jump(Number(seek.value)-1);R.hide(R.$('#seekPreview'));};
    seek.onblur=()=>R.hide(R.$('#seekPreview'));
    R.bus.on('settings',applyPaper);applyPaper();
    R.bus.on('reading-progress',syncProgress);
    R.bus.on('doc-opened',()=>{toggleOutline(isDrawerViewport() ? false : R.settings.readerSidebarOpen, false);});
    const ro=new ResizeObserver(R.debounce(()=>{if(R.viewer.V.pdf){if(R.viewer.V.fitMode)R.viewer.setScale(R.viewer.V.fitMode==='page'?R.viewer.fitPageScale():R.viewer.fitScale(),{fit:R.viewer.V.fitMode});R.bus.emit('layout');}},120));ro.observe(R.$('#stage'));
  }
  function applyPaper(){document.body.dataset.paper=R.settings.paper;document.body.classList.toggle('reduce-motion',R.motionReduced());R.$('#focusModeControl').value=R.settings.focusMode;}
  async function jump(i,{y=0,smooth=false}={}){
    const V=R.viewer.V,pdf=V.pdf;if(!pdf)return;i=R.clamp(Math.round(Number(i)||0),0,V.pages.length-1);
    const p=V.pages[i];await R.viewer.ensureLines(i);if(pdf!==V.pdf)return;
    if(R.focus.isOn()&&p.lines?.length){const seq=R.text.sequence(p.lines,R.settings.readingContent);const k=seq.find(k=>p.lines[k].y>=y-4)??seq.at(-1);if(k!==undefined)await R.focus.setPos(i,k,{instant:!smooth});}
    else {const top=p.el.offsetTop+y*V.scale-20;V.scroller.scrollTo({top,behavior:smooth&&!R.motionReduced()&&Math.abs(top-V.scroller.scrollTop)<V.scroller.clientHeight*2?'smooth':'instant'});}
    R.app.updateProgress();
  }
  function toggleOutline(force,persist=true){const p=R.$('#outlinePanel'),open=force??p.classList.contains('hidden');p.classList.toggle('hidden',!open);R.$('#btnOutline')?.classList.toggle('on',open);R.$('#btnOutline')?.setAttribute('aria-expanded',String(open));syncOutlineBackdrop();if(persist && !isDrawerViewport()){R.settings.readerSidebarOpen=open;R.saveSettings();}window.dispatchEvent(new Event('resize'));}
  function syncProgress({page,percent,y:positionY}){
    const n=R.viewer.V.pages.length;const bp=R.$('#bottomPercent');if(bp)bp.textContent=Math.round(percent*100)+'%';
    const seek=R.$('#progressSeek');seek.max=n;if(document.activeElement!==seek)seek.value=page;
    const p=R.viewer.V.pages[page-1],y=positionY??(R.viewer.V.scroller.scrollTop-(p?.el.offsetTop||0))/R.viewer.V.scale;
    const active=entries.filter(e=>e.page<page-1||e.page===page-1&&e.y<=y+20).at(-1);
    R.$$('.outline-entry').forEach(b=>b.classList.toggle('active',+b.dataset.outlineId===active?.id));
    R.$$('[data-outline-page]').forEach(b=>b.classList.toggle('active',+b.dataset.outlinePage===page-1));
  }
  async function load(){
    const V=R.viewer.V,pdf=V.pdf,run=++token;outlineObserver?.disconnect();entries=[];thumbCache.clear();previewToken++;clearTimeout(seekTimer);R.hide(R.$('#seekPreview'));R.$('#pageInput').max=V.pages.length;
    const outline=await pdf.getOutline();if(run!==token||pdf!==V.pdf)return;const el=R.$('#outlineList');
    if(outline?.length){
      let id=0;const flat=[];const draw=items=>'<ol>'+items.map(item=>{const n=id++;flat.push({item,id:n});return '<li><button class="outline-entry" data-outline-id="'+n+'">'+R.esc(item.title)+'</button>'+(item.items?.length?draw(item.items):'')+'</li>';}).join('')+'</ol>';el.innerHTML=draw(outline);
      await Promise.all(flat.map(async({item,id})=>{try{const dest=typeof item.dest==='string'?await pdf.getDestination(item.dest):item.dest;if(!dest)return;const page=typeof dest[0]==='number'?dest[0]:await pdf.getPageIndex(dest[0]);const p=V.pages[page];if(!p)return;let y=0;if(dest[1]?.name==='XYZ'&&Number.isFinite(dest[3]))y=p.vp1.convertToViewportPoint(0,dest[3])[1];if(dest[1]?.name==='FitH'&&Number.isFinite(dest[2]))y=p.vp1.convertToViewportPoint(0,dest[2])[1];if(run!==token||pdf!==V.pdf)return;entries.push({id,page,y});const b=el.querySelector('[data-outline-id="'+id+'"]');b.onclick=()=>jump(page,{y,smooth:true});}catch{}}));entries.sort((a,b)=>a.page-b.page||a.y-b.y);
    }else{
      el.innerHTML='<p class="muted">没有内置目录，可按页浏览。</p><div class="page-thumbs">'+V.pages.map(p=>'<button data-outline-page="'+p.i+'" class="page-thumb"><span class="thumb-placeholder"></span><small>'+String(p.i+1).padStart(3,'0')+'</small></button>').join('')+'</div>';
      outlineObserver=new IntersectionObserver(list=>list.forEach(async e=>{if(!e.isIntersecting)return;outlineObserver.unobserve(e.target);const i=+e.target.dataset.outlinePage;try{const image=await R.viewer.pageImage(i,null,120);if(run===token&&pdf===V.pdf)e.target.querySelector('span').innerHTML='<img src="'+image+'" alt="第 '+(i+1)+' 页">';}catch{}}),{root:el,rootMargin:'100px'});
      R.$$('[data-outline-page]',el).forEach(b=>{b.onclick=()=>jump(+b.dataset.outlinePage);outlineObserver.observe(b);});
    }
    R.app.updateProgress();
  }
  return {init,load,jump,toggleOutline};
})();
