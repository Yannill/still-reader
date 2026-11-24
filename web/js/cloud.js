/* cloud.js —— Supabase 账号登录与全量云同步（文件夹 / 书库进度 / 批注 / AI 对话 / 统计 / PDF 原件）
 *  - 本地优先：未登录时完全离线本地运行；登录后自动合并本地数据并实时双向同步
 *  - 隐私保护：用户的 AI API Key 仅保留在本机 localStorage，不上传至云端
 */
'use strict';
R.cloud = (() => {
  const SUPABASE_URL = 'https://wgdskyrfwxexysvfyknn.supabase.co';
  const SUPABASE_KEY = 'sb_publishable_MbczRXtrn7FRMIN-icHntw_Ta1ZASxg';
  const PDF_BUCKET = 'pdfs';
  const MAX_PDF_BYTES = 25 * 1024 * 1024; // 单文件 25MB 上限，保护免费 Storage 额度
  const REFRESH_MS = 30000;

  let sb = null;
  let sbReady = null;
  let user = null;
  let syncQueue = Promise.resolve();
  let fullSync = null;
  let lastSyncAt = 0;
  let syncStatus = 'idle'; // idle | syncing | ok | error
  let syncError = '';
  let applyingCloudSettings = false;
  let authMode = 'login'; // login | signup

  // 待同步队列（按 store 聚合，避免高频写入刷爆网络）
  const newDirtyQueue = () => ({
    boxes: new Set(),
    delBoxes: new Set(),
    docs: new Set(),
    delDocs: new Set(),
    annots: new Set(),
    delAnnots: new Set(),
    chats: new Set(),
    delChats: new Set(),
    kv: new Set(),
    pdfs: new Set(),
    settings: false,
  });
  let dirty = newDirtyQueue();

  const SYNC_KV_KEYS = new Set(['stats', 'parking', 'libraryView']);

  async function loadSdk() {
    if (sb) return sb;
    if (sbReady) return sbReady;
    sbReady = (async () => {
      const urls = [
        'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm',
        'https://esm.sh/@supabase/supabase-js@2',
      ];
      let mod = null;
      let lastErr = null;
      for (const u of urls) {
        try {
          mod = await import(u);
          if (mod?.createClient) break;
        } catch (e) { lastErr = e; }
      }
      if (!mod?.createClient) throw lastErr || new Error('无法加载云同步组件，请检查网络连接');
      sb = mod.createClient(SUPABASE_URL, SUPABASE_KEY, {
        auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
      });
      return sb;
    })().catch((e) => {
      sbReady = null;
      throw e;
    });
    return sbReady;
  }

  function translateError(err) {
    const m = String(err?.message || err || '');
    if (/Invalid login credentials/i.test(m)) return '邮箱或密码不正确';
    if (/User already registered/i.test(m)) return '该邮箱已注册，请直接切换为「登录」';
    if (/Email not confirmed/i.test(m)) return '该邮箱尚未完成验证，请前往邮箱点击确认链接（或在 Supabase 关闭 Confirm email）';
    if (/Password should be at least/i.test(m)) return '密码长度至少需要 6 位';
    if (/Unable to validate email|invalid format/i.test(m)) return '请输入有效的邮箱地址';
    if (/rate limit|too many requests/i.test(m)) return '操作过于频繁，请稍等一分钟再试';
    if (/Failed to fetch|NetworkError|Load failed/i.test(m)) return '网络连接失败，请检查网络或代理后重试';
    return m || '操作失败，请稍后重试';
  }

  function init() {
    bindUI();
    R.bus.on('settings', () => {
      if (!user || applyingCloudSettings) return;
      dirty.settings = true;
      schedulePush();
    });
    const refresh = () => {
      if (user && !document.hidden && navigator.onLine !== false) syncAll({ quiet: true, refreshOnly: true });
    };
    window.addEventListener('online', refresh);
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) flushPush();
      else refresh();
    });
    setInterval(refresh, REFRESH_MS);
    // 后台静默恢复已登录会话，不阻塞阅读器首屏启动
    loadSdk().then(async (client) => {
      const { data } = await client.auth.getSession();
      onAuthState(data?.session?.user || null, { initial: true });
      client.auth.onAuthStateChange((event, session) => {
        const nextUser = session?.user || null;
        if (event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED' || event === 'SIGNED_OUT') {
          onAuthState(nextUser, { event });
        }
      });
    }).catch(() => {
      updateAccountUI();
    });
  }

  function onAuthState(nextUser, { initial = false, event = '' } = {}) {
    const prevId = user?.id || null;
    const nextId = nextUser?.id || null;
    user = nextUser;
    if (prevId !== nextId) {
      dirty = newDirtyQueue();
      lastSyncAt = 0;
      syncStatus = 'idle';
      syncError = '';
    }
    updateAccountUI();
    if (nextId && (nextId !== prevId || (initial && !lastSyncAt))) {
      syncAll({ quiet: initial || event === 'TOKEN_REFRESHED' });
    }
  }

  /* ---------------- UI 交互 ---------------- */
  function bindUI() {
    const btn = R.$('#btnAccount');
    const pop = R.$('#accountPop');
    const modal = R.$('#authModal');
    if (!btn || !modal) return;

    btn.onclick = (e) => {
      e.stopPropagation();
      if (!user) {
        openAuthModal('login');
        return;
      }
      if (!pop.classList.contains('hidden')) {
        R.hide(pop);
        return;
      }
      renderAccountPop();
      const r = btn.getBoundingClientRect();
      R.show(pop);
      pop.style.left = Math.max(8, Math.min(window.innerWidth - pop.offsetWidth - 12, r.right - pop.offsetWidth)) + 'px';
      pop.style.top = r.bottom + 8 + 'px';
    };

    document.addEventListener('click', (e) => {
      if (pop && !pop.classList.contains('hidden') && !e.target.closest('#accountPop') && !e.target.closest('#btnAccount')) {
        R.hide(pop);
      }
    });

    R.$$('#authTabs button').forEach((b) => {
      b.onclick = () => setAuthMode(b.dataset.mode);
    });

    R.$('#authForm').onsubmit = async (e) => {
      e.preventDefault();
      await submitAuth();
    };

    R.$('#btnSyncNow').onclick = async () => {
      R.hide(pop);
      await syncAll({ quiet: false });
    };

    R.$('#btnUploadPdfs').onclick = async () => {
      R.hide(pop);
      await uploadMissingPdfs({ quiet: false });
    };

    R.$('#btnSignOut').onclick = async () => {
      R.hide(pop);
      await signOut();
    };

    updateAccountUI();
  }

  function setAuthMode(mode) {
    authMode = mode === 'signup' ? 'signup' : 'login';
    R.$$('#authTabs button').forEach((b) => b.classList.toggle('on', b.dataset.mode === authMode));
    R.$('#authSubmit').textContent = authMode === 'signup' ? '创建账号并开启同步' : '登录并同步';
    R.$('#authErr').textContent = '';
    R.$('#authPass').autocomplete = authMode === 'signup' ? 'new-password' : 'current-password';
  }

  function openAuthModal(mode = 'login') {
    setAuthMode(mode);
    R.$('#authErr').textContent = '';
    R.show(R.$('#authModal'));
    setTimeout(() => R.$('#authEmail').focus(), 20);
  }

  async function submitAuth() {
    const email = R.$('#authEmail').value.trim();
    const password = R.$('#authPass').value;
    const errEl = R.$('#authErr');
    const submitBtn = R.$('#authSubmit');
    errEl.textContent = '';
    if (!email || !password) {
      errEl.textContent = '请填写邮箱和密码';
      return;
    }
    if (password.length < 6) {
      errEl.textContent = '密码长度至少需要 6 位';
      return;
    }
    submitBtn.disabled = true;
    const oldLabel = submitBtn.textContent;
    submitBtn.textContent = authMode === 'signup' ? '注册中…' : '登录中…';
    try {
      const client = await loadSdk();
      if (authMode === 'signup') {
        const { data, error } = await client.auth.signUp({
          email,
          password,
          options: { emailRedirectTo: location.origin + location.pathname },
        });
        if (error) throw error;
        if (data?.session?.user) {
          R.hide(R.$('#authModal'));
          R.$('#authPass').value = '';
          R.toast('注册并登录成功，正在为你同步书库…', 'success');
          onAuthState(data.session.user);
        } else {
          errEl.style.color = 'var(--done)';
          errEl.textContent = '注册成功！请前往邮箱点击验证链接后再登录。';
        }
      } else {
        const { data, error } = await client.auth.signInWithPassword({ email, password });
        if (error) throw error;
        R.hide(R.$('#authModal'));
        R.$('#authPass').value = '';
        R.toast('登录成功，正在同步云端书库…', 'success');
        onAuthState(data.user);
      }
    } catch (e) {
      errEl.style.color = 'var(--danger)';
      errEl.textContent = translateError(e);
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = oldLabel;
    }
  }

  async function signOut() {
    try {
      const client = await loadSdk();
      await flushPush();
      await client.auth.signOut();
      user = null;
      syncStatus = 'idle';
      lastSyncAt = 0;
      updateAccountUI();
      R.toast('已退出登录（本地书库仍完整保留）');
    } catch (e) {
      R.toast('退出失败：' + translateError(e), 'error');
    }
  }

  function shortUserLabel(u) {
    const email = u?.email || '';
    const prefix = email.split('@')[0] || '账号';
    return prefix.length > 10 ? prefix.slice(0, 9) + '…' : prefix;
  }

  function updateAccountUI() {
    const btn = R.$('#btnAccount');
    if (!btn) return;
    if (!user) {
      btn.classList.remove('signed-in', 'syncing', 'sync-err');
      btn.innerHTML = `<svg class="nav-ico" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg><span>登录</span>`;
      btn.title = '登录账号，多端云同步书库、批注与 PDF';
      return;
    }
    const initial = (user.email || 'U')[0].toUpperCase();
    btn.classList.add('signed-in');
    btn.classList.toggle('syncing', syncStatus === 'syncing');
    btn.classList.toggle('sync-err', syncStatus === 'error');
    btn.innerHTML = `<i class="acct-avatar">${R.esc(initial)}</i><span class="acct-name">${R.esc(shortUserLabel(user))}</span><u class="acct-dot" aria-hidden="true"></u>`;
    btn.title = `${user.email} · ${syncStatus === 'syncing' ? '正在同步' : syncStatus === 'error' ? '同步失败，点击重试' : '云同步已开启'}`;
    if (!R.$('#accountPop')?.classList.contains('hidden')) renderAccountPop();
  }

  function renderAccountPop() {
    if (!user) return;
    R.$('#acctEmail').textContent = user.email || '';
    const timeStr = lastSyncAt
      ? new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(lastSyncAt)
      : '尚未同步';
    const label = syncStatus === 'syncing' ? '正在同步云端数据…'
      : syncStatus === 'error' ? syncError
      : `云端已同步 · ${timeStr}`;
    R.$('#acctSyncMeta').textContent = label;
  }

  /* ---------------- 本地写入监听（自动防抖推送） ---------------- */
  function onLocalChange(events) {
    if (!user || !events?.length) return;
    let touched = false;
    for (const ev of events) {
      const { store, del, id, key } = ev;
      if (store === 'boxes' && id) {
        if (del) { dirty.boxes.delete(id); dirty.delBoxes.add(id); }
        else { dirty.delBoxes.delete(id); dirty.boxes.add(id); }
        touched = true;
      } else if (store === 'docs' && id) {
        if (del) { dirty.docs.delete(id); dirty.delDocs.add(id); }
        else { dirty.delDocs.delete(id); dirty.docs.add(id); }
        touched = true;
      } else if (store === 'annots' && id) {
        if (del) { dirty.annots.delete(id); dirty.delAnnots.add(id); }
        else { dirty.delAnnots.delete(id); dirty.annots.add(id); }
        touched = true;
      } else if (store === 'chats' && id) {
        if (del) { dirty.chats.delete(id); dirty.delChats.add(id); }
        else { dirty.delChats.delete(id); dirty.chats.add(id); }
        touched = true;
      } else if (store === 'kv' && key && SYNC_KV_KEYS.has(key)) {
        dirty.kv.add(key);
        touched = true;
      } else if (store === 'files' && id && !del) {
        dirty.pdfs.add(id);
        touched = true;
      }
    }
    if (touched) schedulePush();
  }

  const schedulePush = R.debounce(() => { flushPush(); }, 1200);

  const docVersion = doc => Math.max(doc?.updatedAt || 0, doc?.lastOpened || 0, doc?.addedAt || 0);

  function sanitizeDocForCloud(d) {
    const copy = structuredClone(d);
    // 仅上传轻量缩略图，避免单行 JSON 体积过大（本地保留清晰 thumb2x）
    if (copy.thumb2x && copy.thumb2x.length > 45000) delete copy.thumb2x;
    // Keep the edit time independent from upload/acknowledgement time.
    copy.updatedAt = docVersion(d) || Date.now();
    return copy;
  }

  function sanitizeSettingsForCloud() {
    const copy = structuredClone(R.settings);
    // 安全保护：AI API Key 仅留本机，不上传到云端表
    if (copy.ai) copy.ai.apiKey = '';
    return copy;
  }

  function hasPending() {
    return Object.values(dirty).some(value => value === true || value.size);
  }

  function enqueueSync(task) {
    const uid = user?.id;
    if (!uid) return Promise.resolve();
    const next = syncQueue.then(() => { if (user?.id === uid) return task(uid); });
    syncQueue = next.catch(() => {});
    return next;
  }

  function setSyncError(error, quiet) {
    syncStatus = 'error';
    syncError = '云同步遇到问题。' + translateError(error);
    updateAccountUI();
    if (!quiet) R.toast(syncError, 'error', 4500);
  }

  function flushPush() {
    return enqueueSync(async uid => {
      if (!sb || !hasPending()) return;
      syncStatus = 'syncing';
      updateAccountUI();
      try {
        await pushPending(uid);
        if (user?.id !== uid) return;
        lastSyncAt = Date.now();
        syncStatus = 'ok';
        updateAccountUI();
      } catch (e) {
        if (user?.id !== uid) return;
        console.warn('Cloud push error:', e);
        setSyncError(e, true);
      }
    });
  }

  async function pushPending(uid) {
    if (!hasPending()) return;
    const pending = dirty;
    dirty = newDirtyQueue();
    try {
      const nowIso = new Date().toISOString();

      // 1. Boxes
      if (pending.boxes.size) {
        const rows = [];
        for (const id of pending.boxes) {
          const b = await R.db.get('boxes', id);
          if (b) rows.push({ user_id: uid, id, data: { ...b, updatedAt: Date.now() }, updated_at: nowIso });
        }
        if (rows.length) {
          const { error } = await sb.from('user_boxes').upsert(rows);
          if (error) throw error;
        }
        pending.boxes.clear();
      }
      if (pending.delBoxes.size) {
        const { error } = await sb.from('user_boxes').delete().eq('user_id', uid).in('id', [...pending.delBoxes]);
        if (error) throw error;
        pending.delBoxes.clear();
      }

      // 2. Docs
      if (pending.docs.size) {
        const rows = [];
        for (const id of pending.docs) {
          const d = await R.db.get('docs', id);
          if (d) rows.push({ user_id: uid, id, data: sanitizeDocForCloud(d), updated_at: nowIso });
        }
        if (rows.length) {
          const { error } = await sb.from('user_docs').upsert(rows);
          if (error) throw error;
        }
        pending.docs.clear();
      }
      if (pending.delDocs.size) {
        const ids = [...pending.delDocs];
        const results = await Promise.all([
          sb.from('user_docs').delete().eq('user_id', uid).in('id', ids),
          sb.from('user_annots').delete().eq('user_id', uid).in('doc_id', ids),
          sb.from('user_chats').delete().eq('user_id', uid).in('doc_id', ids),
        ]);
        for (const { error } of results) if (error) throw error;
        // 尝试同步清理 Storage 里的 PDF（若 bucket 尚未创建则忽略）
        await sb.storage.from(PDF_BUCKET).remove(ids.map(id => pdfPath(uid, id))).catch(() => {});
        pending.delDocs.clear();
      }

      // 3. Annots
      if (pending.annots.size) {
        const rows = [];
        for (const id of pending.annots) {
          const a = await R.db.get('annots', id);
          if (a) rows.push({ user_id: uid, doc_id: id, list: a.list || [], updated_at: nowIso });
        }
        if (rows.length) {
          const { error } = await sb.from('user_annots').upsert(rows);
          if (error) throw error;
        }
        pending.annots.clear();
      }
      if (pending.delAnnots.size) {
        const { error } = await sb.from('user_annots').delete().eq('user_id', uid).in('doc_id', [...pending.delAnnots]);
        if (error) throw error;
        pending.delAnnots.clear();
      }

      // 4. Chats
      if (pending.chats.size) {
        const rows = [];
        for (const id of pending.chats) {
          const c = await R.db.get('chats', id);
          if (c) rows.push({ user_id: uid, doc_id: id, messages: c.messages || [], updated_at: nowIso });
        }
        if (rows.length) {
          const { error } = await sb.from('user_chats').upsert(rows);
          if (error) throw error;
        }
        pending.chats.clear();
      }
      if (pending.delChats.size) {
        const { error } = await sb.from('user_chats').delete().eq('user_id', uid).in('doc_id', [...pending.delChats]);
        if (error) throw error;
        pending.delChats.clear();
      }

      // 5. KV & Settings
      const stateRows = [];
      if (pending.kv.size) {
        for (const k of pending.kv) {
          const val = await R.db.kvGet(k, null);
          stateRows.push({ user_id: uid, key: k, value: val, updated_at: nowIso });
        }
      }
      if (pending.settings) {
        stateRows.push({ user_id: uid, key: 'settings', value: sanitizeSettingsForCloud(), updated_at: nowIso });
      }
      if (stateRows.length) {
        const { error } = await sb.from('user_state').upsert(stateRows);
        if (error) throw error;
      }
      pending.kv.clear();
      pending.settings = false;

      // 6. PDF 文件后台上传
      for (const id of pending.pdfs) {
        await uploadSinglePdf(uid, id);
        pending.pdfs.delete(id);
      }
    } catch (e) {
      if (user?.id === uid) {
        const opposite = { boxes: 'delBoxes', delBoxes: 'boxes', docs: 'delDocs', delDocs: 'docs',
          annots: 'delAnnots', delAnnots: 'annots', chats: 'delChats', delChats: 'chats', pdfs: 'delDocs' };
        for (const [key, values] of Object.entries(pending)) {
          if (key === 'settings') dirty.settings ||= values;
          else for (const value of values) if (!dirty[opposite[key]]?.has(value)) dirty[key].add(value);
        }
      }
      throw e;
    }
  }

  /* ---------------- 双向合并全量同步 ---------------- */
  function syncAll({ quiet = false, refreshOnly = false } = {}) {
    const uid = user?.id;
    if (!uid) return Promise.resolve();
    if (quiet && fullSync?.uid === uid) return fullSync.work;
    const work = enqueueSync(id => syncAllNow(id, { quiet, refreshOnly }));
    fullSync = { uid, work };
    return work.finally(() => { if (fullSync?.work === work) fullSync = null; });
  }

  async function syncAllNow(uid, { quiet, refreshOnly }) {
    syncStatus = 'syncing';
    updateAccountUI();
    try {
      const client = await loadSdk();
      // 保留本地未提交的写入，并允许成功的远程读取继续刷新书架。
      let pushError;
      try { await pushPending(uid); } catch (e) { pushError = e; }
      if (user?.id !== uid) return;
      const [rBoxes, rDocs, rAnnots, rChats, rState] = await Promise.all([
        client.from('user_boxes').select('id, data, updated_at').eq('user_id', uid),
        client.from('user_docs').select('id, data, updated_at').eq('user_id', uid),
        client.from('user_annots').select('doc_id, list, updated_at').eq('user_id', uid),
        client.from('user_chats').select('doc_id, messages, updated_at').eq('user_id', uid),
        client.from('user_state').select('key, value, updated_at').eq('user_id', uid),
      ]);
      for (const r of [rBoxes, rDocs, rAnnots, rChats, rState]) {
        if (r.error) throw r.error;
      }

      const [lBoxes, lDocs, lAnnots, lChats, statsRecord, parkingRecord] = await Promise.all([
        R.db.all('boxes'),
        R.db.all('docs'),
        R.db.all('annots'),
        R.db.all('chats'),
        R.db.get('kv', 'stats'),
        R.db.get('kv', 'parking'),
      ]);
      const lStats = statsRecord?.value || {};
      const lParking = parkingRecord?.value || [];
      if (user?.id !== uid) return;

      const nowIso = new Date().toISOString();
      const pushBoxes = [], pushDocs = [], pushAnnots = [], pushChats = [], pushState = [];
      const localOps = [];

      // 1) 合并文件夹 boxes
      const rBoxMap = new Map((rBoxes.data || []).map((x) => [x.id, x]));
      const lBoxMap = new Map(lBoxes.map((x) => [x.id, x]));
      const allBoxIds = new Set([...rBoxMap.keys(), ...lBoxMap.keys()]);
      for (const id of allBoxIds) {
        if (dirty.boxes.has(id) || dirty.delBoxes.has(id)) continue;
        const lb = lBoxMap.get(id), rb = rBoxMap.get(id);
        if (rb && !lb) {
          localOps.push({ store: 'boxes', value: { ...rb.data, id } });
        } else if (lb && !rb && !refreshOnly) {
          pushBoxes.push({ user_id: uid, id, data: { ...lb, updatedAt: lb.updatedAt || Date.now() }, updated_at: nowIso });
        } else if (lb && rb) {
          const rTime = Date.parse(rb.updated_at || '') || rb.data?.updatedAt || 0;
          const lTime = lb.updatedAt || lb.createdAt || 0;
          if (rTime >= lTime) {
            localOps.push({ store: 'boxes', value: { ...rb.data, id } });
          } else if (!refreshOnly) {
            pushBoxes.push({ user_id: uid, id, data: lb, updated_at: nowIso });
          }
        }
      }

      // 2) 合并文档元数据 docs
      const rDocMap = new Map((rDocs.data || []).map((x) => [x.id, x]));
      const lDocMap = new Map(lDocs.map((x) => [x.id, x]));
      const allDocIds = new Set([...rDocMap.keys(), ...lDocMap.keys()]);
      for (const id of allDocIds) {
        if (dirty.docs.has(id) || dirty.delDocs.has(id)) continue;
        const ld = lDocMap.get(id), rd = rDocMap.get(id);
        if (rd && !ld) {
          localOps.push({ store: 'docs', value: { ...rd.data, id } });
        } else if (ld && !rd && !refreshOnly) {
          pushDocs.push({ user_id: uid, id, data: sanitizeDocForCloud(ld), updated_at: nowIso });
        } else if (ld && rd) {
          const rTime = docVersion(rd.data) || Date.parse(rd.updated_at || '') || 0;
          const lTime = docVersion(ld);
          if (rTime >= lTime) {
            const merged = { ...ld, ...rd.data, id };
            if (ld.thumb2x && !rd.data?.thumb2x) merged.thumb2x = ld.thumb2x;
            if (ld.cloudPdf) merged.cloudPdf = true;
            localOps.push({ store: 'docs', value: merged });
          } else {
            const merged = rd.data?.cloudPdf ? { ...ld, cloudPdf: true } : ld;
            if (merged !== ld) localOps.push({ store: 'docs', value: merged });
            if (!refreshOnly) pushDocs.push({ user_id: uid, id, data: sanitizeDocForCloud(merged), updated_at: nowIso });
          }
        }
      }

      // 3) 合并批注 annots（按标注 id 取并集，绝不丢批注）
      const rAnnMap = new Map((rAnnots.data || []).map((x) => [x.doc_id, x]));
      const lAnnMap = new Map(lAnnots.map((x) => [x.id, x]));
      const allAnnIds = new Set([...rAnnMap.keys(), ...lAnnMap.keys()]);
      for (const id of allAnnIds) {
        if (dirty.annots.has(id) || dirty.delAnnots.has(id)) continue;
        const la = lAnnMap.get(id), ra = rAnnMap.get(id);
        if (ra && !la) {
          localOps.push({ store: 'annots', value: { id, list: ra.list || [] } });
        } else if (la && !ra && !refreshOnly) {
          if (la.list?.length) pushAnnots.push({ user_id: uid, doc_id: id, list: la.list, updated_at: nowIso });
        } else if (la && ra) {
          const byId = new Map();
          for (const item of (ra.list || [])) byId.set(item.id, item);
          for (const item of (la.list || [])) {
            const prev = byId.get(item.id);
            if (!prev || (item.comment && !prev.comment) || (item.created || 0) >= (prev.created || 0)) {
              byId.set(item.id, item);
            }
          }
          const mergedList = [...byId.values()];
          localOps.push({ store: 'annots', value: { id, list: mergedList } });
          if (!refreshOnly && mergedList.length !== (ra.list || []).length) {
            pushAnnots.push({ user_id: uid, doc_id: id, list: mergedList, updated_at: nowIso });
          }
        }
      }

      // 4) 合并 AI 对话 chats
      const rChatMap = new Map((rChats.data || []).map((x) => [x.doc_id, x]));
      const lChatMap = new Map(lChats.map((x) => [x.id, x]));
      const allChatIds = new Set([...rChatMap.keys(), ...lChatMap.keys()]);
      for (const id of allChatIds) {
        if (dirty.chats.has(id) || dirty.delChats.has(id)) continue;
        const lc = lChatMap.get(id), rc = rChatMap.get(id);
        if (rc && !lc) {
          localOps.push({ store: 'chats', value: { id, messages: rc.messages || [] } });
        } else if (lc && !rc && !refreshOnly) {
          if (lc.messages?.length) pushChats.push({ user_id: uid, doc_id: id, messages: lc.messages, updated_at: nowIso });
        } else if (lc && rc) {
          if ((rc.messages?.length || 0) >= (lc.messages?.length || 0)) {
            localOps.push({ store: 'chats', value: { id, messages: rc.messages || [] } });
          } else if (!refreshOnly) {
            pushChats.push({ user_id: uid, doc_id: id, messages: lc.messages || [], updated_at: nowIso });
          }
        }
      }

      // 5) 合并统计 stats、杂念 parking、偏好 settings
      const rStateMap = new Map((rState.data || []).map((x) => [x.key, x.value]));
      const rStats = rStateMap.get('stats') || {};
      const mergedStats = { ...rStats };
      for (const [day, val] of Object.entries(lStats || {})) {
        const prev = mergedStats[day] || { lines: 0, minutes: 0 };
        mergedStats[day] = {
          lines: Math.max(prev.lines || 0, val?.lines || 0),
          minutes: Math.max(prev.minutes || 0, val?.minutes || 0),
        };
      }
      if (!dirty.kv.has('stats')) {
        if (JSON.stringify(mergedStats) !== JSON.stringify(lStats)) localOps.push({ store: 'kv', value: { key: 'stats', value: mergedStats } });
        if (JSON.stringify(mergedStats) !== JSON.stringify(rStats)) pushState.push({ user_id: uid, key: 'stats', value: mergedStats, updated_at: nowIso });
      }

      const rParking = Array.isArray(rStateMap.get('parking')) ? rStateMap.get('parking') : [];
      const parkKey = (p) => p.id || `${p.at || 0}|${p.text || ''}`;
      const parkMap = new Map();
      for (const p of rParking) parkMap.set(parkKey(p), p);
      for (const p of (Array.isArray(lParking) ? lParking : [])) {
        if (!parkMap.has(parkKey(p))) parkMap.set(parkKey(p), p);
      }
      const mergedParking = [...parkMap.values()].sort((a, b) => (b.at || 0) - (a.at || 0));
      if (!dirty.kv.has('parking')) {
        if (JSON.stringify(mergedParking) !== JSON.stringify(lParking)) localOps.push({ store: 'kv', value: { key: 'parking', value: mergedParking } });
        if (mergedParking.length !== rParking.length) pushState.push({ user_id: uid, key: 'parking', value: mergedParking, updated_at: nowIso });
      }

      const rSettings = rStateMap.get('settings');
      if (rSettings && typeof rSettings === 'object' && !dirty.settings && JSON.stringify(rSettings) !== JSON.stringify(sanitizeSettingsForCloud())) {
        const localApiKey = R.settings.ai?.apiKey || '';
        Object.assign(R.settings, rSettings);
        if (rSettings.ai) R.settings.ai = Object.assign({}, R.DEFAULT_SETTINGS.ai, rSettings.ai, { apiKey: localApiKey });
        localStorage.setItem('adhd-reader-settings', JSON.stringify(R.settings));
        applyingCloudSettings = true;
        try { R.bus.emit('settings'); } finally { applyingCloudSettings = false; }
      } else if (!rSettings && !dirty.settings) {
        pushState.push({ user_id: uid, key: 'settings', value: sanitizeSettingsForCloud(), updated_at: nowIso });
      }

      // 静默写回本地 IndexedDB（不触发二次回弹推送）
      const previous = { boxes: lBoxMap, docs: lDocMap, annots: lAnnMap, chats: lChatMap,
        kv: new Map([['stats', statsRecord], ['parking', parkingRecord]]) };
      const changes = [];
      for (const op of localOps) {
        const expected = previous[op.store].get(op.value.id || op.value.key);
        if (JSON.stringify(expected) !== JSON.stringify(op.value)) changes.push({ ...op, expected });
      }
      const applied = changes.length ? await R.db.batch(changes, { silent: true }) : [];
      if (user?.id !== uid) return;

      // 批量上推本地新增/更新数据到云端
      const pushes = [];
      if (pushBoxes.length) pushes.push(client.from('user_boxes').upsert(pushBoxes));
      if (pushDocs.length) pushes.push(client.from('user_docs').upsert(pushDocs));
      if (pushAnnots.length) pushes.push(client.from('user_annots').upsert(pushAnnots));
      if (pushChats.length) pushes.push(client.from('user_chats').upsert(pushChats));
      if (pushState.length) pushes.push(client.from('user_state').upsert(pushState));
      const results = await Promise.all(pushes);
      for (const r of results) { if (r.error) throw r.error; }

      // 刷新界面展示
      if (applied.some(({ store }) => store === 'docs' || store === 'boxes')) {
        await R.library.load();
        await R.study.reloadBoxes?.();
        if (!R.$('#homeView').classList.contains('hidden')) await R.study.renderLibrary();
      }
      if (applied.length && !R.$('#notesView').classList.contains('hidden')) await R.study.renderNotes();
      if (applied.length && !R.$('#focusView').classList.contains('hidden')) await R.study.renderFocus();

      if (pushError) throw pushError;
      await repairPdfs(uid, { remoteIds: refreshOnly ? rDocMap : null });
      if (user?.id !== uid) return;
      lastSyncAt = Date.now();
      syncStatus = 'ok';
      updateAccountUI();
      if (!quiet) R.toast('云端书库与可上传的 PDF 原件已同步', 'success');
    } catch (e) {
      if (user?.id !== uid) return;
      console.warn('Cloud syncAll error:', e);
      setSyncError(e, quiet);
    }
  }

  /* ---------------- PDF 原件云端存储（Supabase Storage: pdfs） ---------------- */
  const pdfPath = (uid, docId) => `${uid}/${docId}.pdf`;

  async function uploadSinglePdf(uid, docId) {
    const [file, meta] = await Promise.all([R.db.get('files', docId), R.db.get('docs', docId)]);
    if (user?.id !== uid || !meta || !file?.bytes) return 'unavailable';
    const bytes = file.bytes instanceof Uint8Array ? file.bytes : new Uint8Array(file.bytes);
    if (bytes.byteLength > MAX_PDF_BYTES) return 'oversize';
    const blob = new Blob([bytes], { type: 'application/pdf' });
    const { error } = await sb.storage.from(PDF_BUCKET).upload(pdfPath(uid, docId), blob, {
      contentType: 'application/pdf',
      upsert: true,
    });
    if (error) {
      const detail = /bucket not found/i.test(error.message || '') ? '云端 PDF 存储不可用' : translateError(error);
      throw new Error('PDF 原件上传失败。' + detail);
    }
    const latest = await R.db.get('docs', docId);
    if (user?.id !== uid || !latest) return 'unavailable';
    if (!latest.cloudPdf) {
      const { error } = await sb.from('user_docs').upsert({
        user_id: uid,
        id: docId,
        data: sanitizeDocForCloud({ ...latest, cloudPdf: true }),
        updated_at: new Date().toISOString(),
      });
      if (error) throw error;
      if (user?.id !== uid) return 'unavailable';
      await R.db.patchDoc(docId, { cloudPdf: true }, { silent: true });
      const cached = R.library.get(docId);
      if (cached) cached.cloudPdf = true;
    }
    return 'uploaded';
  }

  async function repairPdfs(uid, { force = false, remoteIds = null } = {}) {
    let uploaded = 0;
    let oversize = 0;
    for (const doc of await R.db.all('docs')) {
      if (remoteIds && !remoteIds.has(doc.id)) continue;
      if (!force && (doc.cloudPdf || doc.size > MAX_PDF_BYTES)) continue;
      const outcome = await uploadSinglePdf(uid, doc.id);
      if (outcome === 'uploaded') uploaded++;
      if (outcome === 'oversize') oversize++;
    }
    return { uploaded, oversize };
  }

  function uploadMissingPdfs({ quiet = false } = {}) {
    return enqueueSync(async uid => {
      syncStatus = 'syncing';
      updateAccountUI();
      try {
        await loadSdk();
        await pushPending(uid);
        const { uploaded, oversize } = await repairPdfs(uid, { force: true });
        if (user?.id !== uid) return;
        lastSyncAt = Date.now();
        syncStatus = 'ok';
        updateAccountUI();
        if (!quiet) {
          const message = uploaded ? `已同步 ${uploaded} 份本地 PDF 原件` : '没有可补传的本地 PDF 原件';
          R.toast(message + (oversize ? `，${oversize} 份超过 25 MB，保留在本地` : ''), oversize ? 'info' : 'success');
        }
      } catch (e) {
        if (user?.id === uid) setSyncError(e, quiet);
      }
    });
  }

  async function downloadPdf(docId) {
    const uid = user?.id;
    if (!uid) return null;
    try {
      const client = await loadSdk();
      R.toast('正在从云端获取 PDF 原件…', 'info', 2200);
      const { data, error } = await client.storage.from(PDF_BUCKET).download(pdfPath(uid, docId));
      if (error) throw error;
      if (!data || user?.id !== uid) return null;
      const bytes = new Uint8Array(await data.arrayBuffer());
      if (user?.id !== uid) return null;
      const record = { id: docId, bytes };
      try { await R.db.put('files', record, { silent: true }); }
      catch (e) { console.warn('Cloud PDF cache failed:', e); }
      return record;
    } catch (e) {
      console.warn('Cloud PDF download failed:', e);
      return null;
    }
  }

  return {
    init,
    onLocalChange,
    syncAll,
    uploadMissingPdfs,
    downloadPdf,
    openAuthModal,
    user: () => user,
  };
})();
