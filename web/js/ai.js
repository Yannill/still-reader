/* ai.js —— 可插拔的大模型接入层
 *
 * 设计：所有模型都通过统一接口 R.ai.chat(messages, {onToken}) 调用。
 *   - 绝大多数国内模型（DeepSeek、通义千问、Kimi、智谱、豆包…）都提供 “OpenAI 兼容” 接口，
 *     只需在“设置”里改 baseURL / model / apiKey 即可切换，不用改代码。
 *   - 如果某个平台（例如 WorkBuddy）协议不同，在 ADAPTERS 里新增一个适配器即可。
 *   - 浏览器直连有跨域(CORS)限制的平台，可填写“代理地址”，走 C++ 服务器的 /api/ai/chat 转发。
 */
'use strict';
R.ai = (() => {
  /* 预设：baseURL 都是各平台官方的 OpenAI 兼容地址；models 只是候选，可在设置中手填 */
  const PROVIDERS = {
    openai:   { name: 'OpenAI · GPT', baseURL: 'https://api.openai.com/v1', models: ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1-mini', 'gpt-4.1'], vision: true, adapter: 'openai' },
    deepseek: { name: 'DeepSeek 深度求索', baseURL: 'https://api.deepseek.com/v1', models: ['deepseek-chat', 'deepseek-reasoner'], vision: false, adapter: 'openai' },
    qwen:     { name: '通义千问（阿里云百炼）', baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1', models: ['qwen-plus', 'qwen-turbo', 'qwen-max', 'qwen-vl-plus'], vision: true, adapter: 'openai' },
    moonshot: { name: 'Kimi（月之暗面）', baseURL: 'https://api.moonshot.cn/v1', models: ['moonshot-v1-8k', 'moonshot-v1-32k'], vision: false, adapter: 'openai' },
    zhipu:    { name: '智谱 GLM', baseURL: 'https://open.bigmodel.cn/api/paas/v4', models: ['glm-4-flash', 'glm-4-plus', 'glm-4v-flash'], vision: true, adapter: 'openai' },
    doubao:   { name: '豆包（火山方舟）', baseURL: 'https://ark.cn-beijing.volces.com/api/v3', models: ['（填写你的推理接入点 ID）'], vision: false, adapter: 'openai' },
    workbuddy:{ name: 'WorkBuddy / 其他 Agent（自定义）', baseURL: '', models: [], vision: false, adapter: 'openai' },
    custom:   { name: '自定义 OpenAI 兼容接口', baseURL: '', models: [], vision: false, adapter: 'openai' },
    mock:     { name: '离线演示（无需 Key）', baseURL: '', models: ['demo'], vision: true, adapter: 'mock' },
  };

  const cfg = () => R.settings.ai;
  const preset = () => PROVIDERS[cfg().provider] || PROVIDERS.custom;
  const isReady = () => cfg().provider === 'mock' || !!(cfg().apiKey && cfg().baseURL && cfg().model);
  const supportsVision = () => cfg().provider === 'mock' || !!cfg().vision;

  /* ---------------- SSE 流解析（OpenAI 兼容格式） ---------------- */
  async function readSSE(resp, onToken) {
    const reader = resp.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    let full = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') return full;
        try {
          const j = JSON.parse(data);
          const delta = j.choices && j.choices[0] && (j.choices[0].delta || j.choices[0].message);
          const t = delta && delta.content;
          if (t) { full += t; onToken && onToken(t, full); }
        } catch { /* 忽略心跳/非 JSON 行 */ }
      }
    }
    return full;
  }

  /* ---------------- 适配器 ---------------- */
  const ADAPTERS = {
    async openai(messages, opts) {
      const c = cfg();
      const url = c.baseURL.replace(/\/+$/, '') + '/chat/completions';
      const body = { model: opts.model || c.model, messages, stream: true, temperature: opts.temperature ?? 0.5 };
      let resp;
      if (c.proxy) {
        // 走 C++ 本地服务器转发（解决跨域、隐藏 Key 于本机）
        resp = await fetch(c.proxy, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url, apiKey: c.apiKey, body }),
          signal: opts.signal,
        });
      } else {
        resp = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + c.apiKey },
          body: JSON.stringify(body),
          signal: opts.signal,
        });
      }
      if (!resp.ok) {
        let msg = await resp.text().catch(() => '');
        try { msg = JSON.parse(msg).error.message || msg; } catch { /* ignore */ }
        throw new Error(`HTTP ${resp.status}：${msg.slice(0, 300)}`);
      }
      const ct = resp.headers.get('content-type') || '';
      if (ct.includes('application/json')) {
        // 某些接口忽略 stream 参数，直接返回 JSON
        const j = await resp.json();
        const t = (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '';
        opts.onToken && opts.onToken(t, t);
        return t;
      }
      return readSSE(resp, opts.onToken);
    },

    /* 离线演示：不联网，方便课堂展示 UI 流程 */
    async mock(messages, opts) {
      const last = messages[messages.length - 1];
      const q = typeof last.content === 'string' ? last.content : (last.content.find((p) => p.type === 'text') || {}).text || '';
      let reply;
      if (/翻译|translate/i.test(q)) {
        reply = '（演示模式）这里会显示译文。在“设置 → AI 模型”中填入 Key 后即可得到真实翻译。';
      } else if (/标题/.test(q)) {
        reply = '演示文档';
      } else {
        reply = '（离线演示模式）我收到了你的问题：\n\n> ' + q.split('\n').pop().slice(0, 80) +
          '\n\n- 在“设置”里选择 OpenAI / DeepSeek / 通义千问 等并填入 API Key\n- 就能基于**本页内容**真正回答你\n- 每份 PDF 的对话会单独保存，下次打开还在';
      }
      let full = '';
      for (const ch of reply) {
        if (opts.signal && opts.signal.aborted) break;
        full += ch;
        opts.onToken && opts.onToken(ch, full);
        await R.sleep(12);
      }
      return full;
    },
  };

  async function chat(messages, opts = {}) {
    if (!isReady()) throw new Error('还没有配置 AI 模型：请在“设置 → AI 模型”中填写 API Key');
    const adapter = ADAPTERS[preset().adapter] || ADAPTERS.openai;
    return adapter(messages, opts);
  }

  /** 单轮提问的便捷函数 */
  async function ask(prompt, { system, image, onToken, temperature } = {}) {
    const msgs = [];
    if (system) msgs.push({ role: 'system', content: system });
    if (image) {
      msgs.push({ role: 'user', content: [{ type: 'text', text: prompt }, { type: 'image_url', image_url: { url: image } }] });
    } else {
      msgs.push({ role: 'user', content: prompt });
    }
    return chat(msgs, { onToken, temperature });
  }

  /** 用 AI 给文档起简短标题（像 ChatGPT 自动总结会话标题一样） */
  async function summarizeTitle({ text, image, fallback }) {
    const prompt =
      '下面是一份 PDF 文档开头的内容。请用不超过 8 个汉字（英文文档可用不超过 4 个英文单词）概括它，' +
      '作为侧边栏里的简短标题，例如：“开题报告”、“机器学习导论”、“租房合同”、“Level 2 阅读”。只输出标题本身，不要标点和引号。\n\n' +
      (text ? '---\n' + text.slice(0, 1800) : '（文档是扫描图片，见附图）');
    const out = await ask(prompt, { image: !text && image && supportsVision() ? image : null, temperature: 0.2 });
    const t = out.replace(/["“”'《》。.\n]/g, '').trim().slice(0, 16);
    return t || fallback;
  }

  return { PROVIDERS, isReady, supportsVision, chat, ask, summarizeTitle, preset };
})();
