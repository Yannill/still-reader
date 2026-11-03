/* adhd.js —— 让 ADHD 读者“读得下去、愿意再来”的体验层
 *  - 番茄钟：顶栏小圆环，到点温和提醒休息，回来时专注框原地等你
 *  - 杂念停车场（N）：脑子里冒出别的事，先记下，不打断阅读
 *  - 预计剩余时间：根据你“真实的”换行速度估算，而不是按字数瞎猜
 *  - 今日统计 / 连续天数：主页可见，小小的正反馈
 *  - 安静模式：专注阅读 3 秒不动鼠标，工具栏自动淡出
 */
'use strict';
R.adhd = (() => {
  const T = { mode: 'focus', running: false, left: 0, total: 0, timer: 0 };
  let stats = {};
  const stamps = []; // 最近的换行时间戳
  let lastActive = Date.now();
  let idleTimer = 0;

  async function init() {
    stats = await R.db.kvGet('stats', {});
    resetTimer('focus');
    R.$('#btnTimer').onclick = toggleTimer;
    R.$('#breakOk').onclick = () => { R.hide(R.$('#breakModal')); resetTimer('break'); startTimer(); };
    R.$('#breakSkip').onclick = () => { R.hide(R.$('#breakModal')); T.mode = 'focus'; T.total = T.left = 5 * 60; startTimer(); };

    // 杂念停车场
    R.$('#navParking').onclick = () => openParking();
    const inp = R.$('#parkingInput');
    inp.addEventListener('keydown', async (e) => {
      if (e.key === 'Escape') return R.hide(R.$('#parkingPop'));
      if (e.key !== 'Enter' || e.isComposing || !inp.value.trim()) return;
      const list = await R.db.kvGet('parking', []);
      const meta = R.app.current();
      list.unshift({ id: R.uid('p'), text: inp.value.trim(), at: Date.now(), doc: meta ? meta.title : '', done: false });
      await R.db.kvSet('parking', list.slice(0, 200));
      inp.value = '';
      renderParking();
      R.toast('已停好，继续读吧');
      setTimeout(() => R.hide(R.$('#parkingPop')), 400);
    });
    R.$('#parkingList').addEventListener('click', async (e) => {
      const it = e.target.closest('[data-pid]');
      if (!it) return;
      const list = await R.db.kvGet('parking', []);
      const p = list.find((x) => x.id === it.dataset.pid);
      if (!p) return;
      if (e.target.closest('.pk-del')) list.splice(list.indexOf(p), 1);
      else p.done = !p.done;
      await R.db.kvSet('parking', list);
      renderParking();
    });
    document.addEventListener('mousedown', (e) => {
      const pp = R.$('#parkingPop');
      if (!pp.classList.contains('hidden') && !e.target.closest('#parkingPop') && !e.target.closest('#navParking')) R.hide(pp);
    });

    // 统计
    R.bus.on('line-read', onLineRead);
    setInterval(tickActive, 10000);
    ['mousemove', 'keydown', 'wheel', 'mousedown'].forEach((ev) => document.addEventListener(ev, () => (lastActive = Date.now()), { passive: true }));

    // 安静模式
    document.addEventListener('mousemove', wake, { passive: true });
    document.addEventListener('keydown', (e) => {
      const tag = (e.target.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || e.ctrlKey || e.metaKey) return;
      if (e.key.toLowerCase() === 'n' && !e.target.isContentEditable) { e.preventDefault(); openParking(); }
    });
    R.bus.on('focus-move', scheduleCalm);
  }

  /* ---------------- 番茄钟 ---------------- */
  function resetTimer(mode) {
    T.mode = mode;
    T.total = T.left = (mode === 'focus' ? R.settings.pomodoro : R.settings.breakMin) * 60;
    T.running = false;
    clearInterval(T.timer);
    drawTimer();
  }
  function startTimer() {
    T.running = true;
    clearInterval(T.timer);
    T.timer = setInterval(() => {
      T.left--;
      if (T.left <= 0) return finish();
      drawTimer();
    }, 1000);
    drawTimer();
  }
  function toggleTimer() {
    if (T.running) { T.running = false; clearInterval(T.timer); drawTimer(); R.toast('番茄钟已暂停'); }
    else { startTimer(); if (T.mode === 'focus') R.toast(`开始专注 ${Math.round(T.left / 60)} 分钟，只读这一份就好`); }
  }
  function finish() {
    clearInterval(T.timer);
    T.running = false;
    if (T.mode === 'focus') {
      R.focus.stopPace();
      const lines = (stats[R.today()] || {}).lines || 0;
      R.$('#breakTitle').textContent = `专注了 ${R.settings.pomodoro} 分钟，休息一下`;
      R.$('#breakText').textContent = `今天已经读了 ${lines} 行。站起来伸个懒腰、喝口水，${R.settings.breakMin} 分钟后回来，专注框会停在你读到的地方。`;
      R.show(R.$('#breakModal'));
      resetTimer('focus');
    } else {
      R.toast('休息结束，回来接着读吧', 'success', 4000);
      resetTimer('focus');
      if (R.focus.isOn() && R.focus.current()) { const c = R.focus.current(); R.focus.setPos(c.i, c.k); }
    }
  }
  function drawTimer() {
    const m = Math.floor(T.left / 60), s = T.left % 60;
    R.$('#timerLabel').textContent = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    const ring = R.$('#timerRing');
    const frac = T.total ? 1 - T.left / T.total : 0;
    ring.style.strokeDashoffset = 94.25 * (1 - frac);
    const btn = R.$('#btnTimer');
    btn.classList.toggle('running', T.running);
    btn.classList.toggle('break', T.mode === 'break');
    btn.title = T.mode === 'break' ? '休息中' : T.running ? '专注中（点击暂停）' : '番茄钟（点击开始）';
  }

  /* ---------------- 统计 ---------------- */
  const day = () => (stats[R.today()] = stats[R.today()] || { lines: 0, seconds: 0 });
  const saveStats = R.debounce(() => R.db.kvSet('stats', stats), 2000);

  function onLineRead() {
    const d = day();
    d.lines++;
    stamps.push(Date.now());
    if (stamps.length > 40) stamps.shift();
    saveStats();
    if (d.lines % 100 === 0) R.toast(`今天已经读了 ${d.lines} 行，节奏很好`, 'success');
  }
  function tickActive() {
    const reading = R.app.current() && !document.hidden && Date.now() - lastActive < 60000;
    if (!reading) return;
    day().seconds += 10;
    saveStats();
  }
  async function todayStats() {
    // Keep pending in-memory increments; rereading before the debounce completes loses them.
    const d = stats[R.today()] || { lines: 0, seconds: 0 };
    let streak = 0;
    const dt = new Date();
    for (let k = 0; k < 400; k++) {
      const key = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
      const s = stats[key];
      if (s && (s.lines > 0 || s.seconds >= 60)) streak++;
      else if (k > 0) break;
      dt.setDate(dt.getDate() - 1);
    }
    return { lines: d.lines, minutes: Math.round(d.seconds / 60), streak };
  }

  /** 按你真实的换行速度估算剩余时间 */
  function remainingText() {
    if (stamps.length < 6) return '';
    const gaps = [];
    for (let i = 1; i < stamps.length; i++) { const g = stamps[i] - stamps[i - 1]; if (g < 20000) gaps.push(g); }
    if (gaps.length < 5) return '';
    gaps.sort((a, b) => a - b);
    const per = gaps[Math.floor(gaps.length / 2)];
    const V = R.viewer.V;
    const cur = R.focus.current();
    if (!cur) return '';
    const known = V.pages.filter((p) => p.lines && p.lines.length);
    const avg = known.reduce((n, p) => n + p.lines.length, 0) / Math.max(1, known.length);
    const leftLines = (V.pages[cur.i].lines.length - cur.k - 1) + avg * (V.pages.length - cur.i - 1);
    const pageLeft = V.pages[cur.i].lines.length - cur.k - 1;
    const min = Math.round((leftLines * per) / 60000);
    const pageMin = Math.max(1, Math.round((pageLeft * per) / 60000));
    return `本页约 ${pageMin} 分钟 · 全文约剩 ${min < 60 ? min + ' 分钟' : (min / 60).toFixed(1) + ' 小时'}`;
  }

  /* ---------------- 杂念停车场 ---------------- */
  async function openParking() {
    const pop = R.$('#parkingPop');
    R.show(pop);
    await renderParking();
    setTimeout(() => R.$('#parkingInput').focus(), 0);
  }
  async function renderParking() {
    const list = await R.db.kvGet('parking', []);
    R.$('#parkingList').innerHTML = list.length
      ? list.map((p) => `<div class="pk-item ${p.done ? 'done' : ''}" data-pid="${p.id}">
          <input type="checkbox" ${p.done ? 'checked' : ''}/><span>${R.esc(p.text)}</span>
          <small>${new Date(p.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}${p.doc ? ' · ' + R.esc(p.doc) : ''}</small>
          <button class="icon-btn pk-del" style="width:20px;height:20px;font-size:13px" title="删除">×</button></div>`).join('')
      : '<div class="empty-hint" style="padding:10px 2px">这里还空着。读的时候想到“待会要做的事”，就按 N 丢进来。</div>';
  }

  /* ---------------- 安静模式 ---------------- */
  function scheduleCalm() {
    clearTimeout(idleTimer);
    if (!R.settings.calmChrome || !R.focus.isOn()) return;
    idleTimer = setTimeout(() => {
      if (R.focus.isOn() && R.app.current() && !document.querySelector('.popover:not(.hidden)')) document.body.classList.add('calm-idle');
    }, 3000);
  }
  function wake() {
    if (document.body.classList.contains('calm-idle')) document.body.classList.remove('calm-idle');
    scheduleCalm();
  }

  return { init, todayStats, remainingText, openParking };
})();
