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

  let sb = null;
  let sbReady = null;
  let user = null;
  let syncing = false;
  let lastSyncAt = 0;
  let syncStatus = 'idle'; // idle | syncing | ok | error
  let bucketWarned = false;
  let authMode = 'login'; // login | signup

  // 待同步队列（按 store 聚合，避免高频写入刷爆网络）
  const dirty = {
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
  };

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
      if (!user) return;
      dirty.settings = true;
      schedulePush();
    });
    window.addEventListener('online', () => { if (user) syncAll({ quiet: true }); });
    document.addEventListener('visibilitychange', () => {
      if (document.hidden && user) flushPush();
    });
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
    updateAccountUI();
    if (nextId && (nextId !== prevId || (initial && !lastSyncAt))) {
      syncAll({ quiet: initial || event === 'TOKEN_REFRESHED' });
    }
    if (!nextId && prevId) {
      lastSyncAt = 0;
      syncStatus = 'idle';
      updateAccountUI();
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
      : syncStatus === 'error' ? '上次同步遇到网络异常，可点下方重试'
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

  function sanitizeDocForCloud(d) {
    const copy = structuredClone(d);
    // 仅上传轻量缩略图，避免单行 JSON 体积过大（本地保留清晰 thumb2x）
    if (copy.thumb2x && copy.thumb2x.length > 45000) delete copy.thumb2x;
    copy.updatedAt = Date.now();
    return copy;
  }

  function sanitizeSettingsForCloud() {
    const copy = structuredClone(R.settings);
    // 安全保护：AI API Key 仅留本机，不上传到云端表
    if (copy.ai) copy.ai.apiKey = '';
    return copy;
  }

  async function flushPush() {
    if (!user || !sb) return;
    const uid = user.id;
    const hasPending = dirty.boxes.size || dirty.delBoxes.size || dirty.docs.size || dirty.delDocs.size ||
      dirty.annots.size || dirty.delAnnots.size || dirty.chats.size || dirty.delChats.size ||
      dirty.kv.size || dirty.settings || dirty.pdfs.size;
    if (!hasPending) return;

    syncStatus = 'syncing';
    updateAccountUI();
    try {
      const nowIso = new Date().toISOString();

      // 1. Boxes
      if (dirty.boxes.size) {
        const ids = [...dirty.boxes]; dirty.boxes.clear();
        const rows = [];
        for (const id of ids) {
          const b = await R.db.get('boxes', id);
          if (b) rows.push({ user_id: uid, id, data: { ...b, updatedAt: Date.now() }, updated_at: nowIso });
        }
        if (rows.length) {
          const { error } = await sb.from('user_boxes').upsert(rows);
          if (error) throw error;
        }
      }
      if (dirty.delBoxes.size) {
        const ids = [...dirty.delBoxes]; dirty.delBoxes.clear();
        const { error } = await sb.from('user_boxes').delete().eq('user_id', uid).in('id', ids);
        if (error) throw error;
      }

      // 2. Docs
      if (dirty.docs.size) {
        const ids = [...dirty.docs]; dirty.docs.clear();
        const rows = [];
        for (const id of ids) {
          const d = await R.db.get('docs', id);
          if (d) rows.push({ user_id: uid, id, data: sanitizeDocForCloud(d), updated_at: nowIso });
        }
        if (rows.length) {
          const { error } = await sb.from('user_docs').upsert(rows);
          if (error) throw error;
        }
      }
      if (dirty.delDocs.size) {
        const ids = [...dirty.delDocs]; dirty.delDocs.clear();
        await sb.from('user_docs').delete().eq('user_id', uid).in('id', ids);
        await sb.from('user_annots').delete().eq('user_id', uid).in('doc_id', ids);
        await sb.from('user_chats').delete().eq('user_id', uid).in('doc_id', ids);
        // 尝试同步清理 Storage 里的 PDF（若 bucket 尚未创建则忽略）
        sb.storage.from(PDF_BUCKET).remove(ids.map((id) => `${uid}/${id}.pdf`)).catch(() => {});
      }

      // 3. Annots
      if (dirty.annots.size) {
        const ids = [...dirty.annots]; dirty.annots.clear();
        const rows = [];
        for (const id of ids) {
          const a = await R.db.get('annots', id);
          if (a) rows.push({ user_id: uid, doc_id: id, list: a.list || [], updated_at: nowIso });
        }
        if (rows.length) {
          const { error } = await sb.from('user_annots').upsert(rows);
          if (error) throw error;
        }
      }
      if (dirty.delAnnots.size) {
        const ids = [...dirty.delAnnots]; dirty.delAnnots.clear();
        await sb.from('user_annots').delete().eq('user_id', uid).in('doc_id', ids);
      }

      // 4. Chats
      if (dirty.chats.size) {
        const ids = [...dirty.chats]; dirty.chats.clear();
        const rows = [];
        for (const id of ids) {
          const c = await R.db.get('chats', id);
          if (c) rows.push({ user_id: uid, doc_id: id, messages: c.messages || [], updated_at: nowIso });
        }
        if (rows.length) {
          const { error } = await sb.from('user_chats').upsert(rows);
          if (error) throw error;
        }
      }
      if (dirty.delChats.size) {
        const ids = [...dirty.delChats]; dirty.delChats.clear();
        await sb.from('user_chats').delete().eq('user_id', uid).in('doc_id', ids);
      }

      // 5. KV & Settings
      const stateRows = [];
      if (dirty.kv.size) {
        const keys = [...dirty.kv]; dirty.kv.clear();
        for (const k of keys) {
          const val = await R.db.kvGet(k, null);
          stateRows.push({ user_id: uid, key: k, value: val, updated_at: nowIso });
        }
      }
      if (dirty.settings) {
        dirty.settings = false;
        stateRows.push({ user_id: uid, key: 'settings', value: sanitizeSettingsForCloud(), updated_at: nowIso });
      }
      if (stateRows.length) {
        const { error } = await sb.from('user_state').upsert(stateRows);
        if (error) throw error;
      }

      // 6. PDF 文件后台上传
      if (dirty.pdfs.size) {
        const pdfIds = [...dirty.pdfs]; dirty.pdfs.clear();
        for (const id of pdfIds) {
          await uploadSinglePdf(id, { quiet: true });
        }
      }

      lastSyncAt = Date.now();
      syncStatus = 'ok';
      updateAccountUI();
    } catch (e) {
      console.warn('Cloud push error:', e);
      syncStatus = 'error';
      updateAccountUI();
    }
  }

  /* ---------------- 双向合并全量同步 ---------------- */
  async function syncAll({ quiet = false } = {}) {
    if (!user || syncing) return;
    syncing = true;
    syncStatus = 'syncing';
    updateAccountUI();
    try {
      const client = await loadSdk();
      const uid = user.id;

      // 先把尚未发出的本地变更冲刷掉（避免覆盖）
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

      const [lBoxes, lDocs, lAnnots, lChats] = await Promise.all([
        R.db.all('boxes'),
        R.db.all('docs'),
        R.db.all('annots'),
        R.db.all('chats'),
      ]);
      const lStats = await R.db.kvGet('stats', {});
      const lParking = await R.db.kvGet('parking', []);

      const nowIso = new Date().toISOString();
      const pushBoxes = [], pushDocs = [], pushAnnots = [], pushChats = [], pushState = [];
      const localOps = [];

      // 1) 合并文件夹 boxes
      const rBoxMap = new Map((rBoxes.data || []).map((x) => [x.id, x]));
      const lBoxMap = new Map(lBoxes.map((x) => [x.id, x]));
      const allBoxIds = new Set([...rBoxMap.keys(), ...lBoxMap.keys()]);
      for (const id of allBoxIds) {
        const lb = lBoxMap.get(id), rb = rBoxMap.get(id);
        if (rb && !lb) {
          localOps.push({ store: 'boxes', value: { ...rb.data, id } });
        } else if (lb && !rb) {
          pushBoxes.push({ user_id: uid, id, data: { ...lb, updatedAt: lb.updatedAt || Date.now() }, updated_at: nowIso });
        } else if (lb && rb) {
          const rTime = Date.parse(rb.updated_at || '') || rb.data?.updatedAt || 0;
          const lTime = lb.updatedAt || lb.createdAt || 0;
          if (rTime >= lTime) {
            localOps.push({ store: 'boxes', value: { ...rb.data, id } });
          } else {
            pushBoxes.push({ user_id: uid, id, data: lb, updated_at: nowIso });
          }
        }
      }

      // 2) 合并文档元数据 docs
      const rDocMap = new Map((rDocs.data || []).map((x) => [x.id, x]));
      const lDocMap = new Map(lDocs.map((x) => [x.id, x]));
      const allDocIds = new Set([...rDocMap.keys(), ...lDocMap.keys()]);
      for (const id of allDocIds) {
        const ld = lDocMap.get(id), rd = rDocMap.get(id);
        if (rd && !ld) {
          localOps.push({ store: 'docs', value: { ...rd.data, id } });
        } else if (ld && !rd) {
          pushDocs.push({ user_id: uid, id, data: sanitizeDocForCloud(ld), updated_at: nowIso });
        } else if (ld && rd) {
          const rTime = Math.max(Date.parse(rd.updated_at || '') || 0, rd.data?.lastOpened || 0, rd.data?.updatedAt || 0);
          const lTime = Math.max(ld.lastOpened || 0, ld.updatedAt || 0, ld.addedAt || 0);
          if (rTime > lTime) {
            const merged = { ...ld, ...rd.data, id };
            if (ld.thumb2x && !rd.data?.thumb2x) merged.thumb2x = ld.thumb2x;
            localOps.push({ store: 'docs', value: merged });
          } else {
            const merged = { ...rd.data, ...ld, id };
            if (rd.data?.cloudPdf) merged.cloudPdf = true;
            localOps.push({ store: 'docs', value: merged });
            pushDocs.push({ user_id: uid, id, data: sanitizeDocForCloud(merged), updated_at: nowIso });
          }
        }
      }

      // 3) 合并批注 annots（按标注 id 取并集，绝不丢批注）
      const rAnnMap = new Map((rAnnots.data || []).map((x) => [x.doc_id, x]));
      const lAnnMap = new Map(lAnnots.map((x) => [x.id, x]));
      const allAnnIds = new Set([...rAnnMap.keys(), ...lAnnMap.keys()]);
      for (const id of allAnnIds) {
        const la = lAnnMap.get(id), ra = rAnnMap.get(id);
        if (ra && !la) {
          localOps.push({ store: 'annots', value: { id, list: ra.list || [] } });
        } else if (la && !ra) {
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
          if (mergedList.length !== (ra.list || []).length) {
            pushAnnots.push({ user_id: uid, doc_id: id, list: mergedList, updated_at: nowIso });
          }
        }
      }

      // 4) 合并 AI 对话 chats
      const rChatMap = new Map((rChats.data || []).map((x) => [x.doc_id, x]));
      const lChatMap = new Map(lChats.map((x) => [x.id, x]));
      const allChatIds = new Set([...rChatMap.keys(), ...lChatMap.keys()]);
      for (const id of allChatIds) {
        const lc = lChatMap.get(id), rc = rChatMap.get(id);
        if (rc && !lc) {
          localOps.push({ store: 'chats', value: { id, messages: rc.messages || [] } });
        } else if (lc && !rc) {
          if (lc.messages?.length) pushChats.push({ user_id: uid, doc_id: id, messages: lc.messages, updated_at: nowIso });
        } else if (lc && rc) {
          if ((rc.messages?.length || 0) >= (lc.messages?.length || 0)) {
            localOps.push({ store: 'chats', value: { id, messages: rc.messages || [] } });
          } else {
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
      localOps.push({ store: 'kv', value: { key: 'stats', value: mergedStats } });
      pushState.push({ user_id: uid, key: 'stats', value: mergedStats, updated_at: nowIso });

      const rParking = Array.isArray(rStateMap.get('parking')) ? rStateMap.get('parking') : [];
      const parkKey = (p) => p.id || `${p.at || 0}|${p.text || ''}`;
      const parkMap = new Map();
      for (const p of rParking) parkMap.set(parkKey(p), p);
      for (const p of (Array.isArray(lParking) ? lParking : [])) {
        if (!parkMap.has(parkKey(p))) parkMap.set(parkKey(p), p);
      }
      const mergedParking = [...parkMap.values()].sort((a, b) => (b.at || 0) - (a.at || 0));
      localOps.push({ store: 'kv', value: { key: 'parking', value: mergedParking } });
      if (mergedParking.length !== rParking.length) {
        pushState.push({ user_id: uid, key: 'parking', value: mergedParking, updated_at: nowIso });
      }

      const rSettings = rStateMap.get('settings');
      if (rSettings && typeof rSettings === 'object') {
        const localApiKey = R.settings.ai?.apiKey || '';
        Object.assign(R.settings, rSettings);
        if (rSettings.ai) R.settings.ai = Object.assign({}, R.DEFAULT_SETTINGS.ai, rSettings.ai, { apiKey: localApiKey });
        localStorage.setItem('adhd-reader-settings', JSON.stringify(R.settings));
        R.bus.emit('settings');
      } else {
        pushState.push({ user_id: uid, key: 'settings', value: sanitizeSettingsForCloud(), updated_at: nowIso });
      }

      // 静默写回本地 IndexedDB（不触发二次回弹推送）
      if (localOps.length) {
        await R.db.runSilent(() => R.db.batch(localOps));
      }

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
      await R.library.load();
      await R.study.reloadBoxes?.();
      if (!R.$('#homeView').classList.contains('hidden')) await R.study.renderLibrary();
      if (!R.$('#notesView').classList.contains('hidden')) await R.study.renderNotes();
      if (!R.$('#focusView').classList.contains('hidden')) await R.study.renderFocus();

      lastSyncAt = Date.now();
      syncStatus = 'ok';
      updateAccountUI();
      if (!quiet) R.toast('云端书库与批注已同步完成', 'success');

      // 后台静默补传本地 PDF 原件至 Supabase Storage
      uploadMissingPdfs({ quiet: true });
    } catch (e) {
      console.warn('Cloud syncAll error:', e);
      syncStatus = 'error';
      updateAccountUI();
      if (!quiet) R.toast('云同步失败：' + translateError(e), 'error', 4500);
    } finally {
      syncing = false;
    }
  }

  /* ---------------- PDF 原件云端存储（Supabase Storage: pdfs） ---------------- */
  async function uploadSinglePdf(docId, { quiet = true } = {}) {
    if (!user || !sb) return false;
    const file = await R.db.get('files', docId);
    if (!file?.bytes) return false;
    const bytes = file.bytes instanceof Uint8Array ? file.bytes : new Uint8Array(file.bytes);
    const meta = R.library.get(docId);
    if (bytes.byteLength > MAX_PDF_BYTES) {
      if (!quiet) R.toast(`《${meta?.title || '文档'}》超过 25MB，仅本地保留，批注和进度仍会云端同步`, 'info', 4500);
      return false;
    }
    const path = `${user.id}/${docId}.pdf`;
    const blob = new Blob([bytes], { type: 'application/pdf' });
    const { error } = await sb.storage.from(PDF_BUCKET).upload(path, blob, {
      contentType: 'application/pdf',
      upsert: true,
    });
    if (error) {
      if (/bucket not found/i.test(error.message || '')) {
        if (!bucketWarned) {
          bucketWarned = true;
          R.toast('书库和批注已同步；如需同步 PDF 原件，请先在 Supabase 创建名为 pdfs 的 Storage 桶', 'info', 6000);
        }
        return false;
      }
      throw error;
    }
    if (meta && !meta.cloudPdf) {
      meta.cloudPdf = true;
      await R.db.runSilent(() => R.db.put('docs', structuredClone(meta)));
      await sb.from('user_docs').upsert({
        user_id: user.id,
        id: docId,
        data: sanitizeDocForCloud(meta),
        updated_at: new Date().toISOString(),
      });
    }
    return true;
  }

  async function uploadMissingPdfs({ quiet = false } = {}) {
    if (!user) return;
    try {
      await loadSdk();
      const docs = R.library.all();
      let uploaded = 0;
      for (const d of docs) {
        if (d.cloudPdf) continue;
        const ok = await uploadSinglePdf(d.id, { quiet });
        if (ok) uploaded++;
        if (bucketWarned) break;
      }
      if (!quiet && !bucketWarned) {
        R.toast(uploaded ? `已将 ${uploaded} 份 PDF 原件同步到云端` : '所有符合大小的 PDF 原件均已在云端', 'success');
      }
    } catch (e) {
      if (!quiet) R.toast('PDF 上传失败：' + translateError(e), 'error', 4500);
    }
  }

  async function downloadPdf(docId) {
    if (!user) return null;
    try {
      const client = await loadSdk();
      R.toast('正在从云端获取 PDF 原件…', 'info', 2200);
      const path = `${user.id}/${docId}.pdf`;
      const { data, error } = await client.storage.from(PDF_BUCKET).download(path);
      if (error || !data) return null;
      const bytes = new Uint8Array(await data.arrayBuffer());
      const record = { id: docId, bytes };
      await R.db.runSilent(() => R.db.put('files', record));
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
