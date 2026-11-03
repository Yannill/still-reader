/* Reader controls layered over the existing PDF, focus and annotation engines. */
'use strict';
R.reader = (() => {
  let outlineObserver, outlineToken = 0;
  function init() {
    R.$('#readerHome').onclick = () => R.study.returnToShelf();
    R.$('#prevPage').onclick = () => jump(R.viewer.currentPage()-1);
    R.$('#nextPage').onclick = () => jump(R.viewer.currentPage()+1);
    R.$('#pageInput').onchange = e => jump(Number(e.target.value)-1);
    R.$('#pageInput').onkeydown = e => { if(e.key==='Enter'){e.preventDefault();jump(Number(e.target.value)-1);e.target.blur();} };
    R.$('#btnFitPage').onclick = () => { const i=R.viewer.currentPage(); R.viewer.setScale(R.viewer.fitPageScale(),{fit:'page'}); jump(i); };
    R.$('#paperSelect').value = R.settings.paper;
    R.$('#paperSelect').onchange = e => { R.settings.paper=e.target.value;R.saveSettings(); };
    R.$('#reduceMotion').checked = R.settings.reducedMotion;
    R.$('#reduceMotion').onchange = e => {R.settings.reducedMotion=e.target.checked;R.saveSettings();};
    R.$('#aaFocus').onclick = () => R.focus.toggle();
    R.$('#aaHelp').onclick = () => R.show(R.$('#helpModal'));
    R.$('#btnOutline').onclick = () => toggleOutline();
    R.$('#btnNextLine').onclick = () => R.focus.next();
    R.$$('.drawer-tabs [data-drawer]').forEach(b=>b.onclick=()=>{if(b.dataset.drawer==='outline')toggleOutline(true);if(b.dataset.drawer==='annot')R.annot.togglePanel(true);if(b.dataset.drawer==='chat')R.chat.toggle(true);});
    R.bus.on('settings',applyPaper); applyPaper();
    const ro = new ResizeObserver(R.debounce(()=>{if(R.viewer.V.pdf){if(R.viewer.V.fitMode)R.viewer.setScale(R.viewer.V.fitMode==='page'?R.viewer.fitPageScale():R.viewer.fitScale(),{fit:R.viewer.V.fitMode});R.bus.emit('layout');}},120));
    ro.observe(R.$('#stage'));
  }
  function applyPaper() { document.body.dataset.paper=R.settings.paper;document.body.classList.toggle('reduce-motion',R.motionReduced()); }
  async function jump(i) {
    const V=R.viewer.V;if(!V.pdf)return;
    i=R.clamp(Math.round(Number(i)||0),0,V.pages.length-1);
    if(R.focus.isOn()){await R.viewer.ensureLines(i);if(V.pages[i].lines.length)await R.focus.setPos(i,0,{instant:true});else V.scroller.scrollTop=V.pages[i].el.offsetTop;}
    else V.scroller.scrollTop=V.pages[i].el.offsetTop-20;
    R.$('#pageInput').value=i+1;R.app.updateProgress();
    R.$$('[data-outline-page]').forEach(b=>b.classList.toggle('active',+b.dataset.outlinePage===i));
  }
  function paragraphLength(i,k) {
    const lines=R.viewer.V.pages[i]?.lines||[],first=lines[k];if(!first)return 1;
    const gaps=lines.slice(1).map((l,j)=>l.y-lines[j].y).filter(g=>g>0&&g<first.h*3).sort((a,b)=>a-b);
    const median=gaps[Math.floor(gaps.length/2)]||first.h*1.2;let count=1,last=first;
    for(let j=k+1;j<lines.length&&count<15;j++){const l=lines[j];const overlap=Math.min(last.x+last.w,l.x+l.w)-Math.max(last.x,l.x);if(l.y<=last.y||l.y-last.y>median*1.35||overlap<=0||Math.abs(l.fh-last.fh)>last.fh*.25)break;count++;last=l;}
    return count;
  }
  function toggleOutline(force) {
    const p=R.$('#outlinePanel'),open=force??p.classList.contains('hidden');
    p.classList.toggle('hidden',!open);R.$('#btnOutline').classList.toggle('on',open);
    if(open){R.hide(R.$('#annotPanel'));R.hide(R.$('#chatPanel'));R.$('#btnChat').classList.remove('on');R.$('#btnAnnotPanel').classList.remove('on');}
    window.dispatchEvent(new Event('resize'));
  }
  async function load() {
    const V=R.viewer.V,pdf=V.pdf,token=++outlineToken;outlineObserver?.disconnect();
    R.$('#pageInput').max=V.pages.length;
    const outline=await pdf.getOutline();if(token!==outlineToken||pdf!==V.pdf)return;
    const el=R.$('#outlineList');
    if(outline?.length){
      const draw=items=>`<ol>${items.map(item=>`<li><button class="outline-entry">${R.esc(item.title)}</button>${item.items?.length?draw(item.items):''}</li>`).join('')}</ol>`;
      el.innerHTML=draw(outline);const flat=[];const walk=items=>items.forEach(item=>{flat.push(item);walk(item.items||[]);});walk(outline);
      R.$$('.outline-entry',el).forEach((b,i)=>b.onclick=async()=>{const dest=typeof flat[i].dest==='string'?await pdf.getDestination(flat[i].dest):flat[i].dest;if(dest){const index=typeof dest[0]==='number'?dest[0]:await pdf.getPageIndex(dest[0]);b.dataset.outlinePage=index;await jump(index);}});
    }else{
      el.innerHTML=`<p class="muted">这本书没有目录，按页浏览。</p><div class="page-thumbs">${V.pages.map(p=>`<button data-outline-page="${p.i}" class="page-thumb"><span class="thumb-placeholder"></span><small>${String(p.i+1).padStart(3,'0')}</small></button>`).join('')}</div>`;
      outlineObserver=new IntersectionObserver(entries=>entries.forEach(async e=>{if(!e.isIntersecting)return;outlineObserver.unobserve(e.target);const i=+e.target.dataset.outlinePage;try{const image=await R.viewer.pageImage(i,null,120);if(token===outlineToken&&pdf===V.pdf)e.target.querySelector('span').innerHTML=`<img src="${image}" alt="第 ${i+1} 页">`;}catch{/* A closed document needs no thumbnail. */}}),{root:el,rootMargin:'100px'});
      R.$$('[data-outline-page]',el).forEach(b=>{b.onclick=()=>jump(+b.dataset.outlinePage);outlineObserver.observe(b);});
    }
  }
  return {init,load,jump,paragraphLength,toggleOutline};
})();
