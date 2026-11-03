/* chat.js —— 内置 AI 助手面板
 *  - 每份 PDF 的对话单独保存（IndexedDB），下次打开同一文件自动恢复
 *  - 自动附带上下文：本页文字 / 当前专注行 / 选中引用；扫描页可附带页面截图（需支持图片的模型）
 *  - 回答风格针对 ADHD：先结论、短句、分点
 */
'use strict';
R.chat = (() => {
  const C = { docId: null, messages: [], busy: false, quote: null, image: null, abort: null };
  let generation = 0, lastQuestion = null;
  const SYSTEM =
    '你是一个陪伴 ADHD 读者的阅读助手。回答规则：1) 第一句直接给结论；2) 用短句和分点，每点不超过两行；' +
    '3) 关键词用 **加粗**；4) 默认用简体中文；5) 如果用户读不进去，先给一个 30 秒能读完的版本，再问要不要展开。';
  const QUICK = {
    summary: '用 3 个要点总结本页内容，每点一句话。最后用一句话告诉我：读这页时该重点盯住什么。',
    explain: '用最简单的话解释“当前句”的意思；如果有专业词，顺便解释一下。',
    quiz: '根据本页内容出 3 道单选题帮我检查理解（每题 3 个选项），答案统一放在最后。',
    why: '这一段在全文里起什么作用？为什么值得读？两三句话说清楚。',
  };

  function init() {
    R.$('#btnChat').onclick = () => toggle();
    R.$('#btnChatSend').onclick = () => send(R.$('#chatInput').value);
    const ta = R.$('#chatInput');
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(ta.value); }
    });
    ta.addEventListener('input', () => { ta.style.height = 'auto'; ta.style.height = Math.min(140, ta.scrollHeight) + 'px'; });
    R.$('#chatQuick').onclick = (e) => { const b = e.target.closest('[data-q]'); if (b) send(QUICK[b.dataset.q], { label: b.textContent }); };
    R.$('#btnChatClear').onclick = clear;
    R.$('#chatModel').onchange = (e) => { R.settings.ai.model = e.target.value; R.saveSettings(); };
    R.$('#chatMsgs').addEventListener('click', (e) => {
      if (e.target.closest('[data-open-settings]')) R.settingsUI.open();
      const retry=e.target.closest('[data-retry]');
      if(retry && !C.busy) {
        const text=retry.dataset.retry, index=C.messages.findIndex(m=>m.role==='error'&&m.retryText===text);
        if(index>=0) { C.messages.splice(index,1);if(C.messages[index-1]?.role==='user'&&C.messages[index-1].content===text)C.messages.splice(index-1,1); }
        send(text);
      }
    });
    const contextLabel = () => { R.$('#chatDisclosure').textContent = '将发送：' + [R.$('#ctxPage').checked ? '本页文字（扫描页为本页图像）' : '', R.$('#ctxLine').checked ? '当前句' : '', C.quote ? '选中引用' : ''].filter(Boolean).join(' + ') + '；不发送整份 PDF'; };
    R.$('#chatCtx').onchange = contextLabel; contextLabel();
    R.bus.on('settings', fillModels);
    document.addEventListener('keydown', (e) => {
      const tag = (e.target.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || e.target.isContentEditable || e.ctrlKey || e.metaKey) return;
      if (e.key.toLowerCase() === 'a' && R.app.current()) { e.preventDefault(); toggle(); }
    });
    fillModels();
  }

  function fillModels() {
    const sel = R.$('#chatModel');
    const pre = R.ai.preset();
    const cur = R.settings.ai.model;
    const models = R.settings.ai.provider === 'mock' ? ['离线演示']
      : [...new Set([cur, ...(pre.models || [])].filter((m) => m && !m.startsWith('（')))];
    sel.innerHTML = models.map((m) => `<option ${m === cur ? 'selected' : ''}>${R.esc(m)}</option>`).join('') || '<option>未配置</option>';
    sel.title = pre.name;
  }

  async function load(meta) {
    generation++;
    C.docId = meta.id;
    const rec = await R.db.get('chats', meta.id);
    C.messages = rec ? rec.messages : [];
    setQuote(null);
    render();
  }
  const save = () => C.docId && R.db.put('chats', { id: C.docId, messages: C.messages.slice(-80) });

  function toggle(force) {
    const p = R.$('#chatPanel');
    const open = force === undefined ? p.classList.contains('hidden') : force;
    if (open) { R.hide(R.$('#outlinePanel')); R.$('#btnOutline').classList.remove('on'); R.hide(R.$('#annotPanel')); R.$('#btnAnnotPanel').classList.remove('on'); }
    p.classList.toggle('hidden', !open);
    R.$('#btnChat').classList.toggle('on', open);
    window.dispatchEvent(new Event('resize'));
    if (open) { render(); setTimeout(() => R.$('#chatInput').focus(), 50); }
  }

  /** 从其他地方打开（选中文字“问 AI”、翻译卡片“问 AI”） */
  function open({ quote, image, prefill } = {}) {
    toggle(true);
    if (quote) setQuote(quote, image);
    if (prefill) R.$('#chatInput').value = prefill;
  }

  function setQuote(q, image = null) {
    C.quote = q;
    C.image = image;
    const el = R.$('#chatQuote');
    if (!q) return R.hide(el);
    el.innerHTML = `引用：${R.esc(q.slice(0, 120))}<span class="x" title="移除">×</span>`;
    R.show(el);
    R.$('.x', el).onclick = () => setQuote(null);
  }

  async function clear() {
    if (C.busy && C.abort) C.abort.abort();
    if (C.messages.length && !await R.confirm('清空这份文档的 AI 对话？', '清空对话')) return;
    generation++;
    C.messages = [];
    await save();
    render();
  }

  /* ---------------- 渲染 ---------------- */
  function render() {
    const box = R.$('#chatMsgs');
    if (!C.messages.length) {
      const ready = R.ai.isReady();
      box.innerHTML = `<div class="chat-welcome">
        <b>读不进去？问我就好。</b><br>
        我能看到你<b>正在读的这一页</b>和<b>专注框里的句子</b>。可以试试下面的快捷问题，或者直接问。<br>
        这份文档的对话会自动保存，下次打开还在。
        ${ready ? `<br><span style="font-size:12px">当前模型：${R.esc(R.ai.preset().name)} · ${R.esc(R.settings.ai.model)}</span>`
          : `<br><br>还没有配置模型。<a href="javascript:void 0" data-open-settings style="color:var(--accent)">去设置 →</a>（也可以选“离线演示”先体验）`}
      </div>`;
      return;
    }
    box.innerHTML = C.messages.map((m) => {
      if (m.role === 'user') return `<div class="msg user">${m.quote ? `<span class="q">${R.esc(m.quote.slice(0, 80))}</span>` : ''}${R.esc(m.label || m.content)}</div>`;
      if (m.role === 'error') return `<div class="msg error">${R.esc(m.content)} <a href="javascript:void 0" data-open-settings style="color:inherit;text-decoration:underline">检查设置</a> ${m.retryText ? `<button data-retry="${R.esc(m.retryText)}">重试</button>` : ''}</div>`;
      return `<div class="msg assistant"><small class="message-time">${m.at ? new Date(m.at).toLocaleTimeString([], {hour:"2-digit",minute:"2-digit"}) : "AI / READING COMPANION"}</small>${R.md(m.content)}</div>`;
    }).join('');
    box.scrollTop = box.scrollHeight;
  }

  /* ---------------- 发送 ---------------- */
  async function buildContext() {
    const parts = [];
    const meta = R.app.current();
    if (meta) parts.push(`【文档】${meta.title}（${meta.name}）`);
    const cur = R.focus.current();
    const pageI = cur ? cur.i : R.viewer.currentPage();
    let image = C.image;
    if (R.$('#ctxPage').checked) {
      const t = await R.viewer.pageText(pageI);
      if (t) parts.push(`【第 ${pageI + 1} 页内容】\n${t.slice(0, 3500)}`);
      else if (!image && R.ai.supportsVision()) image = await R.viewer.pageImage(pageI, null, 1100);
    }
    if (R.$('#ctxLine').checked && cur && cur.line.text) parts.push(`【当前句（专注框里）】${cur.line.text}`);
    if (C.quote) parts.push(`【用户选中的内容】${C.quote}`);
    return { text: parts.join('\n\n'), image };
  }

  async function leave() {
    generation++; C.abort?.abort(); C.busy = false; C.abort = null;
    R.$('#chatSendState').textContent = '';
    await save();
  }
  async function send(text, { label } = {}) {
    text = (text || '').trim(); if (!text || C.busy || !R.app.current()) return;
    C.busy = true; lastQuestion = text;
    const token = generation, id = C.docId, messages = C.messages;
    const controller = new AbortController(); C.abort = controller;
    const reply = { role:'assistant', content:'', at:Date.now() };
    R.$('#chatInput').value = '';
    R.$('#chatSendState').textContent = '正在思考…';
    try {
      const ctx = await buildContext(); if (token !== generation) return;
      const quote = C.quote; setQuote(null);
      const history = messages.slice(-12).filter(m=>m.role==='user'||m.role==='assistant').map(m=>({role:m.role,content:m.content}));
      messages.push({role:'user',content:text,label,quote,at:Date.now()},reply); render();
      const userText = (ctx.text ? ctx.text+'\n\n' : '')+'【问题】'+text;
      const user = {role:'user',content:ctx.image?[{type:'text',text:userText},{type:'image_url',image_url:{url:ctx.image}}]:userText};
      await R.ai.chat([{role:'system',content:SYSTEM},...history,user],{signal:controller.signal,onToken:(_,full)=>{if(token!==generation)return;reply.content=full;render();}});
      if (!reply.content) reply.content = '（没有返回内容）';
    } catch(e) {
      if(token === generation && e.name !== 'AbortError') { const i=messages.indexOf(reply);if(i>=0)messages.splice(i,1);messages.push({role:'error',content:'出错了：'+e.message,retryText:text}); }
    } finally {
      if(token === generation) await R.db.put('chats',{id,messages:structuredClone(messages.slice(-80))});
      if(token === generation) { C.busy=false; C.abort=null;R.$('#chatSendState').textContent='';render(); }
    }
  }

  return { init, load, open, toggle, send, leave };
})();
