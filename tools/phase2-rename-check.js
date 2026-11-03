await R.app.route('home');
const id=R.library.all()[0].id;
await R.study.preview(id,document.querySelector('[data-book="'+id+'"]'));
return {id,before:R.library.get(id).title,active:document.activeElement.id};
//---
const t=document.querySelector('#previewTitle');t.focus();const focused=document.activeElement.id;document.getSelection().selectAllChildren(t);document.execCommand('insertText',false,'注意力与阅读 · 修订');t.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));await R.sleep(200);
return {after:R.library.all()[0].title,dom:t.textContent,focused,active:document.activeElement.id,editable:t.isContentEditable,handler:t.onblur.toString()};
//---
await R.study.closePreview();return {afterClose:R.library.all()[0].title};
