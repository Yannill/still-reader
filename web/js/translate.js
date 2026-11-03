/* translate.js —— 就地翻译：释义卡片直接出现在该行文字的下方
 *  引擎：
 *   - AI（已配置模型时，默认）：单词给出音标/词性/语境义；句子给出通顺译文；扫描版用支持图片的模型识别后翻译
 *   - 免费接口（无需 Key）：英文单词 → dictionaryapi.dev + MyMemory；句子 → MyMemory
 */
'use strict';
R.translate = (() => {
  const MAX_CARDS = 3;

  function init() {}

  const isWord = (t) => /^[A-Za-z][A-Za-z'’\-]{0,30}$/.test(t.trim());

  async function show({ i, rects, text, scanned }) {
    const docId = R.app.current()?.id;
    const p = R.viewer.V.pages[i];
    if (!p || !rects || !rects.length) return;
    text = (text || '').trim();
    const first = rects[0];
    const last = rects.reduce((a, r) => (r.y + r.h > a.y + a.h ? r : a), rects[0]);
    const line = (() => {
      const k = R.viewer.lineAt(i, first.x + 1, first.y + first.h / 2);
      return k >= 0 ? p.lines[k] : null;
    })();

    // 同一位置的旧卡片先关掉，最多同时保留 3 张
    R.$$('.tr-card', p.notes).forEach((c) => { if (Math.abs(+c.dataset.y - last.y) < 2) c.remove(); });
    const all = R.$$('.tr-card');
    if (all.length >= MAX_CARDS) all.slice(0, all.length - MAX_CARDS + 1).forEach((c) => c.remove());

    const el = document.createElement('div');
    el.className = 'tr-card';
    el.dataset.y = last.y;
    const word = isWord(text);
    el.innerHTML = `
      <button class="tr-x" title="关闭">×</button>
      <div class="tr-language eyebrow">EN ↔ 中</div><div class="tr-src">${word ? `<b>${R.esc(text)}</b> <span class="tr-ph"></span>` : R.esc(text ? text.slice(0, 90) + (text.length > 90 ? '…' : '') : '扫描页选区')}</div>
      <div class="tr-body loading">翻译中…</div>
      <div class="tr-foot"><button data-a="note">存为评论</button><button data-a="ask">问 AI</button><button data-a="copy">复制译文</button></div>`;
    p.notes.appendChild(el);

    // 位置：该行正下方；水平方向不超出页面
    const S = R.viewer.V.scale;
    const pageW = p.vp1.width * S;
    const wantX = first.x * S;
    const x = R.clamp(wantX - 10, 6, Math.max(6, pageW - el.offsetWidth - 6));
    el.style.left = (x / pageW) * 100 + '%';
    el.style.top = `calc(${((last.y + last.h) / p.vp1.height) * 100}% + 8px)`;
    el.style.setProperty('--arrow', R.clamp(wantX - x + 8, 12, el.offsetWidth - 24) + 'px');
    redraw();

    const body = R.$('.tr-body', el);
    let result = '';
    el.addEventListener('mousedown', (e) => e.stopPropagation());
    el.onclick = async (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      if (b.classList.contains('tr-x')) { el.remove(); return redraw(); }
      const a = b.dataset.a;
      if (R.app.current()?.id !== docId) return;
      if (a === 'note' && result) {
        R.annot.add({ page: i, type: 'highlight', rects, text, comment: '释义：' + result });
        R.toast('已存为评论，保存 PDF 时会一起写入');
      } else if (a === 'ask') {
        R.chat && R.chat.open({ quote: text, prefill: word ? `“${text}”在这句话里是什么意思？还有哪些常见用法？` : '帮我拆解一下这句话的结构和意思' });
      } else if (a === 'copy' && result) navigator.clipboard.writeText(result).then(() => R.toast('已复制'));
    };

    try {
      const onToken = (_, full) => { body.classList.remove('loading'); body.textContent = full; redraw(); };
      if (scanned || (!text && p.scanned)) {
        if (!R.ai.isReady() || !R.ai.supportsVision()) throw new Error('扫描版需要“支持图片”的 AI 模型才能识别翻译（设置 → AI 模型）');
        const img = await R.viewer.pageImage(i, bbox(rects), 1400);
        result = await R.ai.ask('识别图片中的文字，并翻译成中文。格式：\n原文：…\n译文：…', { image: img, onToken, temperature: 0.2 });
      } else if (R.settings.translateEngine === 'ai' && R.ai.isReady()) {
        result = await aiTranslate(text, word, line ? line.text : '', onToken);
      } else {
        result = await freeTranslate(text, word, el);
        body.classList.remove('loading');
        body.textContent = result;
      }
      if (!result) throw new Error('没有得到结果');
    } catch (e) {
      body.classList.remove('loading');
      body.innerHTML = `<span style="color:var(--danger)">${R.esc(e.message || e)}</span>`;
    }
    redraw();
  }

  const bbox = (rects) => {
    const x = Math.min(...rects.map((r) => r.x)), y = Math.min(...rects.map((r) => r.y));
    return { x, y, w: Math.max(...rects.map((r) => r.x + r.w)) - x, h: Math.max(...rects.map((r) => r.y + r.h)) - y };
  };
  const redraw = () => R.focus && R.focus.redraw && R.focus.redraw();

  function targetLang(text) {
    return R.cjkRatio(text) > 0.3 ? 'en' : R.settings.translateTarget || 'zh';
  }

  function aiTranslate(text, word, context, onToken) {
    const tl = targetLang(text) === 'en' ? '英文' : '简体中文';
    const prompt = word
      ? `解释英文单词 “${text}”。严格按两行输出，不要多余内容：\n第1行：/音标/ 词性. 最贴切的中文释义（可给 2~3 个）\n第2行：在这句话中的意思：……（一句话）\n句子：${context || text}`
      : `把下面的文字翻译成${tl}。只输出译文，准确、通顺、口语化一点：\n\n${text}`;
    return R.ai.ask(prompt, { onToken, temperature: 0.2 });
  }

  async function freeTranslate(text, word, el) {
    const tl = targetLang(text);
    const pair = tl === 'en' ? 'zh-CN|en' : 'en|zh-CN';
    const mm = fetch(`https://api.mymemory.translated.net/get?q=${encodeURIComponent(text.slice(0, 480))}&langpair=${pair}`)
      .then((r) => r.json())
      .then((j) => (j && j.responseData && j.responseData.translatedText) || '')
      .catch(() => '');
    if (!word) {
      const t = await mm;
      if (!t) throw new Error('免费翻译接口暂时不可用，可在设置中配置 AI 模型');
      return t;
    }
    const dict = fetch(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(text.toLowerCase())}`)
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null);
    const [zh, d] = await Promise.all([mm, dict]);
    let out = zh ? zh : '';
    if (d && d[0]) {
      const e = d[0];
      const ph = e.phonetic || (e.phonetics || []).map((x) => x.text).find(Boolean) || '';
      if (ph) R.$('.tr-ph', el).textContent = ph;
      const defs = (e.meanings || []).slice(0, 2).map((m) => `${m.partOfSpeech}. ${m.definitions[0].definition}`);
      if (defs.length) out += (out ? '\n' : '') + defs.join('\n');
    }
    if (!out) throw new Error('没查到这个词');
    return out;
  }

  /** 翻译专注框所在的当前行（快捷键 T） */
  function current() {
    const cur = R.focus.current();
    if (!cur) return R.toast('先打开专注模式（F），再按 T 翻译当前行');
    const l = cur.line;
    show({ i: cur.i, rects: [{ x: l.x, y: l.y, w: l.w, h: l.h }], text: l.text, scanned: !l.text });
  }

  return { init, show, current };
})();
