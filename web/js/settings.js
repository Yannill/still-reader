/* settings.js —— 设置面板：AI 模型（可换国内模型）、翻译、阅读习惯 */
'use strict';
R.settingsUI = (() => {
  function open() {
    render();
    R.show(R.$('#settingsModal'));
  }

  function render() {
    const s = R.settings, ai = s.ai, P = R.ai.PROVIDERS;
    const pre = P[ai.provider] || P.custom;
    R.$('#settingsBody').innerHTML = `
      <div class="set-group">
        <h4>AI 模型</h4>
        <div class="set-row"><label>服务商</label>
          <select id="sProvider">${Object.entries(P).map(([k, p]) => `<option value="${k}" ${k === ai.provider ? 'selected' : ''}>${p.name}</option>`).join('')}</select></div>
        <div class="set-row"><label>接口地址</label><input type="text" id="sBase" value="${R.esc(ai.baseURL)}" placeholder="https://…/v1（OpenAI 兼容）" /></div>
        <div class="set-row"><label>模型名</label><input type="text" id="sModel" list="sModels" value="${R.esc(ai.model)}" />
          <datalist id="sModels">${(pre.models || []).map((m) => `<option value="${R.esc(m)}">`).join('')}</datalist></div>
        <div class="set-row"><label>API Key</label><input type="password" id="sKey" value="${R.esc(ai.apiKey)}" placeholder="只保存在本机浏览器里" /></div>
        <div class="set-row"><label>代理地址</label><input type="text" id="sProxy" value="${R.esc(ai.proxy)}" placeholder="可选，如 http://localhost:8080/api/ai/chat" /></div>
        <div class="set-note">浏览器直连可能受跨域限制。当前本地服务只提供静态网页；代理需要另行部署，再填写地址。Key 仅保存在此浏览器的本地设置中。</div>
        <div class="set-row"><label>支持图片</label><label class="switch"><input type="checkbox" id="sVision" ${ai.vision ? 'checked' : ''}/><i></i></label>
          <span style="color:var(--muted);font-size:12px">扫描版 PDF 的翻译 / 提问需要</span></div>
        <div class="set-row"><label></label><button class="chip ghost" id="sTest">测试连接</button><span id="sTestRes" style="font-size:12px;color:var(--muted)"></span></div>
      </div>
      <div class="set-group">
        <h4>翻译</h4>
        <div class="set-row"><label>翻译引擎</label>
          <div class="seg" id="sEngine"><button data-v="ai">AI 模型（更准）</button><button data-v="free">免费接口（无需 Key）</button></div></div>
        <div class="set-note">未配置 AI 时会自动使用免费接口。中文内容会自动翻成英文。</div>
      </div>
      <div class="set-group">
        <h4>阅读习惯</h4>
        <div class="set-row"><label>番茄钟</label><input type="number" id="sPomo" min="5" max="90" value="${s.pomodoro}" style="max-width:90px"/> 分钟专注
          <input type="number" id="sBreak" min="1" max="30" value="${s.breakMin}" style="max-width:80px"/> 分钟休息</div>
        <div class="set-row"><label>安静模式</label><label class="switch"><input type="checkbox" id="sCalm" ${s.calmChrome ? 'checked' : ''}/><i></i></label>
          <span style="color:var(--muted);font-size:12px">专注时 3 秒不动鼠标，工具栏自动淡出</span></div>
        <div class="set-row"><label>AI 起标题</label><label class="switch"><input type="checkbox" id="sAiTitle" ${s.aiTitle ? 'checked' : ''}/><i></i></label>
          <span style="color:var(--muted);font-size:12px">导入时发送前文片段或首页图像至所选服务，生成简短标题；关闭后使用离线算法</span></div>
      </div>
      <div class="set-group">
        <h4>关于</h4>
        <div class="set-note" style="margin:0">行检测 / 标题算法：${R.core.hasWasm() ? '<b style="color:var(--done)">WebAssembly 核心</b>' : '本地 JavaScript 核心（当前交付未包含可选 WASM）'}</div>
      </div>`;

    const $ = (id) => R.$('#' + id);
    const save = () => R.saveSettings();
    if (ai.provider === 'mock') {
      ['sBase', 'sModel', 'sKey', 'sProxy'].forEach((id) => $(id).closest('.set-row').classList.add('hidden'));
      R.$('#settingsBody .set-note').textContent = '离线演示不联网，用来课堂展示界面流程。换成真实模型：在上面选择 OpenAI / DeepSeek / 通义千问 等。';
    }
    $('sProvider').onchange = (e) => {
      const k = e.target.value, p = P[k];
      ai.provider = k;
      ai.baseURL = p.baseURL;
      ai.model = (p.models && p.models[0] && !p.models[0].startsWith('（')) ? p.models[0] : '';
      ai.vision = p.vision;
      save();
      render();
    };
    $('sBase').onchange = (e) => { ai.baseURL = e.target.value.trim(); save(); };
    $('sModel').onchange = (e) => { ai.model = e.target.value.trim(); save(); };
    $('sKey').onchange = (e) => { ai.apiKey = e.target.value.trim(); save(); };
    $('sProxy').onchange = (e) => { ai.proxy = e.target.value.trim(); save(); };
    $('sVision').onchange = (e) => { ai.vision = e.target.checked; save(); };
    $('sPomo').onchange = (e) => { s.pomodoro = R.clamp(+e.target.value || 25, 5, 90); save(); };
    $('sBreak').onchange = (e) => { s.breakMin = R.clamp(+e.target.value || 5, 1, 30); save(); };
    $('sCalm').onchange = (e) => { s.calmChrome = e.target.checked; save(); };
    $('sAiTitle').onchange = (e) => { s.aiTitle = e.target.checked; save(); };
    const eng = $('sEngine');
    const syncEng = () => R.$$('button', eng).forEach((b) => b.classList.toggle('on', b.dataset.v === s.translateEngine));
    eng.onclick = (e) => { const b = e.target.closest('button'); if (b) { s.translateEngine = b.dataset.v; save(); syncEng(); } };
    syncEng();
    $('sTest').onclick = async () => {
      const res = $('sTestRes');
      res.style.color = 'var(--muted)';
      res.textContent = '连接中…';
      try {
        const t = await R.ai.ask('只回复四个字：连接成功', { temperature: 0 });
        res.style.color = 'var(--done)';
        res.textContent = '成功：' + t.slice(0, 30);
      } catch (e) {
        res.style.color = 'var(--danger)';
        res.textContent = e.message.slice(0, 120);
      }
    };
  }

  return { open };
})();
