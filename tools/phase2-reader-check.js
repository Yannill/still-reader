// Real reader regression using local sample data; real external APIs are not called.
const rect=document.querySelector('#stage').getBoundingClientRect();
document.querySelector('#btnFocusOpts').click();
const old=R.viewer.V.scale;document.querySelector('#btnZoomIn').click();
if(R.viewer.V.scale<=old)throw Error('Zoom failed');
document.querySelector('#btnFit').click();
if(!document.querySelector('#focusOpts').contains(document.querySelector('#btnFitPage')))throw Error('Fit controls not in Aa');
return {name:'Aa and zoom',width:rect.width,scale:R.viewer.V.scale};
//---
R.hide(document.querySelector('#focusOpts'));
const before=R.focus.F.pos.k;
R.viewer.V.scroller.dispatchEvent(new WheelEvent('wheel',{deltaY:100,bubbles:true,cancelable:true}));await R.sleep(250);
if(R.focus.F.pos.k!==before+1)throw Error('Wheel line navigation failed');
document.dispatchEvent(new KeyboardEvent('keydown',{key:'h',bubbles:true}));
document.dispatchEvent(new KeyboardEvent('keydown',{key:'u',bubbles:true}));
document.dispatchEvent(new KeyboardEvent('keydown',{key:'c',bubbles:true}));
document.querySelector('#cpText').value='中文评论验收';document.querySelector('#cpSave').click();
R.annot.setTool('box');
const p=R.viewer.V.pages[0].el.getBoundingClientRect(),x=p.left+40,y=p.top+90;
R.viewer.V.scroller.dispatchEvent(new MouseEvent('mousedown',{button:0,clientX:x,clientY:y,bubbles:true,cancelable:true}));
window.dispatchEvent(new MouseEvent('mousemove',{clientX:x+100,clientY:y+30,bubbles:true}));
window.dispatchEvent(new MouseEvent('mouseup',{clientX:x+100,clientY:y+30,bubbles:true}));
const count=R.annot.list().length;if(count!==4)throw Error('Annotation tools: '+count);
R.annot.undo();if(R.annot.list().length!==3)throw Error('Undo failed');R.annot.setTool('read');
const bytes=await R.pdfsave.exportPdf(R.viewer.V.bytes,R.annot.list(),R.viewer.V.pages),pdf=await pdfjsLib.getDocument({data:bytes}).promise;
const list=await(await pdf.getPage(1)).getAnnotations();await pdf.destroy();if(list.length!==3)throw Error('Export annotation count');
R.annot.togglePanel(true);return {name:'annotations and PDF export',count:list.length};
//---
R.settings.ai.provider='mock';R.saveSettings();R.translate.current();await R.sleep(1600);
const card=document.querySelector('.tr-card');if(!card)throw Error('Translation missing');card.querySelector('[data-a=note]').click();
R.chat.toggle(true);const original=R.ai.chat;R.ai.chat=async()=>{throw Error('controlled retry test');};
await R.chat.send('解释当前句');R.ai.chat=original;
const retry=document.querySelector('[data-retry]');if(!retry)throw Error('Retry missing');retry.click();
await R.sleep(3200);if(document.querySelector('.msg.error'))throw Error('Retry did not complete');
return {name:'translation and AI retry',saved:R.annot.list().length,messages:document.querySelectorAll('.msg').length};
//---
await R.app.route('home');document.querySelector('[data-book]').focus();
document.querySelector('[data-book]').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',shiftKey:true,bubbles:true,cancelable:true}));
for(let i=0;i<50&&!window.__docReady;i++)await R.sleep(100);
if(!document.body.classList.contains('reading'))throw Error('Keyboard direct read');
await R.study.returnToShelf();if(document.querySelector('#homeView').classList.contains('hidden'))throw Error('Return to library');
return {name:'keyboard and return',pass:true};
