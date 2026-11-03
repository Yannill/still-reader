// Stage 1: paper, typography and old controls using the existing CDP harness.
await R.app.route('home');
if (getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() !== '#8C7058') throw Error('Theme missing');
return { stage: 1, theme: 'paper / ink / metal', viewport: [innerWidth, innerHeight] };
//---
// Stage 2: real imported PDFs, with three books in one box to inspect spine widths.
const file = await R.db.get('files', R.library.all()[0].id);
await R.library.importFiles([new File([file.bytes], 'reading-notes.pdf', {type:'application/pdf'}), new File([file.bytes], 'learning-guide.pdf', {type:'application/pdf'})]);
const docs = R.library.all();
await R.library.rename(docs[0].id, '阅读与学习');
await R.library.rename(docs[1].id, '专注练习');
await R.study.renderLibrary();
return { stage: 2, books: R.library.all().length, boxes: R.study.boxes().length };
//--- wait 3000
// Stage 3: list, filter and local view persistence.
R.study.state.view = 'list';
await R.study.renderLibrary();
return { stage: 3, rows: document.querySelectorAll('.book-row').length };
//---
// Stage 4: preparation starts in parallel with the extraction animation.
R.study.state.view = 'shelf';
await R.study.renderLibrary();
const id = R.library.all()[0].id;
await R.study.preview(id, document.querySelector('[data-book="' + id + '"]'));
return { stage: 4, preview: document.querySelector('#previewDialog').open };
//---
await R.study.direct(R.library.all()[0].id);
document.querySelector('#btnOutline').click();
return { stage: 5, pages: R.viewer.V.pages.length, focus: R.focus.isOn() };
//---
const l = R.focus.current().line;
R.annot.add({page:0,type:'highlight',rects:[{x:l.x,y:l.y,w:l.w,h:l.h}],text:l.text,comment:'每次只读一点，慢慢建立自己的阅读节奏。'});
await R.app.route('notes');
return { stage: 6, notes: document.querySelectorAll('.journal-note').length };
//---
await R.app.route('focus');
return { stage: 7, bars: document.querySelectorAll('.focus-chart>div').length };
