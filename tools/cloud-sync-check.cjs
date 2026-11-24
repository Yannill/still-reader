const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../web/js/cloud.js'), 'utf8')
  .replace('await import(u)', 'await mockImport(u)');
const tables = ['user_boxes', 'user_docs', 'user_annots', 'user_chats', 'user_state'];
const stores = ['boxes', 'docs', 'annots', 'chats', 'kv', 'files'];
const account = { id: 'test-account', email: 'reader@example.test' };
const bytes = new Uint8Array(fs.readFileSync(path.join(__dirname, '../web/samples/sample.pdf')));
const importTime = 1710000000000;
class FixedDate extends Date {
  constructor(...args) { super(...(args.length ? args : [importTime])); }
  static now() { return importTime; }
}
const waitForJobs = () => new Promise(resolve => setImmediate(resolve));
const clone = value => structuredClone(value);

function mockCloud() {
  const rows = Object.fromEntries(tables.map(table => [table, new Map()]));
  const originals = new Map();
  let rejectWrite = '';
  let rejectUpload = false;
  const sdk = {
    auth: {
      getSession: async () => ({ data: { session: { user: account } } }),
      onAuthStateChange() {},
    },
    from(table) {
      const data = rows[table];
      return {
        select: () => ({ eq: async (field, id) => ({ data: [...data.values()].filter(row => row[field] === id).map(clone) }) }),
        async upsert(values) {
          if (rejectWrite === table) {
            rejectWrite = '';
            return { error: new Error('Failed to fetch') };
          }
          for (const row of [values].flat()) data.set(row.id || row.doc_id || row.key, clone(row));
          return { error: null };
        },
        delete: () => ({ eq: () => ({ in: async (field, ids) => { for (const id of ids) data.delete(id); return { error: null }; } }) }),
      };
    },
    storage: {
      from: () => ({
        async upload(key, value) {
          if (rejectUpload) {
            rejectUpload = false;
            return { error: new Error('Bucket not found') };
          }
          originals.set(key, value);
          return { error: null };
        },
        async download(key) { return { data: originals.get(key) }; },
        async remove(keys) { for (const key of keys) originals.delete(key); return { error: null }; },
      }),
    },
  };
  return { sdk, rows, originals, failWrite(table) { rejectWrite = table; }, failUpload() { rejectUpload = true; } };
}

function device(cloud, local = Object.fromEntries(stores.map(store => [store, new Map()]))) {
  const scheduled = new Set();
  const events = new Map();
  const messages = [];
  let shelf = [];
  let silent = false;
  let onBatch;
  let rejectCache = false;
  const document = { hidden: false, addEventListener: (name, callback) => events.set(name, callback) };
  const R = {
    $: selector => selector.endsWith('View') ? { classList: { contains: () => false } } : null,
    settings: { ai: { apiKey: 'local-only' } },
    DEFAULT_SETTINGS: { ai: {} },
    bus: { on() {}, emit() {} },
    debounce: fn => () => scheduled.add(fn),
    toast: (message, severity) => messages.push({ message, severity }),
    library: {
      all: () => shelf,
      get: id => shelf.find(doc => doc.id === id),
      async load() { shelf = await R.db.all('docs'); },
    },
    study: { async renderLibrary() {}, async renderNotes() {}, async renderFocus() {} },
    db: {
      async all(store) { return [...local[store].values()].map(clone); },
      async get(store, id) { return clone(local[store].get(id)); },
      async kvGet(key, fallback) { return (await this.get('kv', key))?.value ?? fallback; },
      async put(store, value, options) {
        if (store === 'files' && rejectCache) throw new Error('QuotaExceededError');
        await this.batch([{ store, value }], options);
      },
      async patchDoc(id, fields, options) {
        const existing = await this.get('docs', id);
        if (existing) await this.put('docs', { ...existing, ...fields }, options);
      },
      async runSilent(fn) { silent = true; try { return await fn(); } finally { silent = false; } },
      async batch(operations, options) {
        if (onBatch && options?.silent) { const fn = onBatch; onBatch = null; await fn(); }
        const applied = [];
        for (const operation of operations) {
          const { store, value, del, expected } = operation;
          const key = del ? value : value.id || value.key;
          if (Object.hasOwn(operation, 'expected') && JSON.stringify(local[store].get(key)) !== JSON.stringify(expected)) continue;
          if (del) local[store].delete(value);
          else {
            const record = clone(value);
            if (store === 'docs' && !options?.silent && !silent) {
              const lastEdit = Math.max(record.updatedAt || 0, local.docs.get(key)?.updatedAt || 0, record.addedAt || 0, record.lastOpened || 0);
              record.updatedAt = Math.max(FixedDate.now(), lastEdit + 1);
            }
            local[store].set(key, record);
          }
          applied.push(operation);
        }
        if (!silent && !options?.silent) R.cloud.onLocalChange(applied.map(({ store, value, del }) => ({
          store, del, id: del ? value : value.id, key: value?.key,
        })));
        return applied;
      },
    },
  };
  vm.runInNewContext(source, {
    R, document, Blob, Date: FixedDate, Uint8Array, structuredClone,
    mockImport: async () => ({ createClient: () => cloud.sdk }),
    console: { warn() {} },
    localStorage: { setItem() {} },
    navigator: { onLine: true },
    window: { addEventListener: (name, callback) => events.set(name, callback) },
    setTimeout: fn => scheduled.add(fn),
    setInterval: fn => events.set('interval', fn),
    clearTimeout() {},
  });
  R.cloud.init();
  return {
    R, local, messages,
    onNextRemoteBatch(fn) { onBatch = fn; },
    rejectCacheWrites() { rejectCache = true; },
    async sync() { await R.cloud.syncAll({ quiet: true }); await waitForJobs(); },
    async flush() {
      const jobs = [...scheduled];
      scheduled.clear();
      for (const job of jobs) job();
      await waitForJobs();
    },
    async foreground() {
      document.hidden = true;
      events.get('visibilitychange')?.();
      await waitForJobs();
      document.hidden = false;
      events.get('visibilitychange')?.();
      await waitForJobs();
    },
    async poll() { events.get('interval')?.(); await waitForJobs(); },
    async add(id, boxId = 'unsorted') {
      await R.db.batch([
        { store: 'files', value: { id, bytes } },
        { store: 'docs', value: { id, title: id, boxId, addedAt: importTime } },
      ]);
      await R.library.load();
    },
  };
}

async function foregroundSync() {
  const cloud = mockCloud();
  const desktop = device(cloud);
  const iPad = device(cloud);
  await waitForJobs();
  await desktop.add('desktop-paper');
  await desktop.flush();
  await iPad.foreground();
  assert.ok(iPad.R.library.get('desktop-paper'), 'iPad foreground did not discover the PDF imported on desktop');
  assert.deepEqual((await iPad.R.cloud.downloadPdf('desktop-paper'))?.bytes, bytes);
  await iPad.add('ipad-paper');
  await iPad.flush();
  await desktop.poll();
  desktop.rejectCacheWrites();
  assert.deepEqual((await desktop.R.cloud.downloadPdf('ipad-paper'))?.bytes, bytes);
  assert.equal(desktop.R.library.get('ipad-paper')?.addedAt, importTime);
}

async function retrySync() {
  const cloud = mockCloud();
  const iPad = device(cloud);
  await waitForJobs();
  await iPad.add('pending-paper', 'box-1');
  cloud.failWrite('user_docs');
  await iPad.flush();
  assert.equal(cloud.rows.user_docs.has('pending-paper'), false);
  cloud.failUpload();
  await iPad.R.cloud.syncAll();
  await waitForJobs();
  assert.ok(iPad.messages.some(({ severity }) => severity === 'error'), 'missing PDF original was reported as synced');
  await iPad.sync();
  assert.ok(cloud.rows.user_docs.get('pending-paper')?.data.cloudPdf, 'manual sync did not recover the failed original upload');
  const desktop = device(cloud);
  await waitForJobs();
  assert.equal(desktop.R.library.get('pending-paper')?.boxId, 'box-1');
  assert.deepEqual((await desktop.R.cloud.downloadPdf('pending-paper'))?.bytes, bytes);
  await iPad.R.db.patchDoc('pending-paper', { boxId: 'box-2' });
  await iPad.flush();
  await desktop.foreground();
  assert.equal(desktop.R.library.get('pending-paper')?.boxId, 'box-2');
  // A missing original must be repairable even if earlier sync marked it present.
  cloud.originals.delete('test-account/pending-paper.pdf');
  await iPad.R.cloud.uploadMissingPdfs({ quiet: true });
  assert.ok(cloud.originals.has('test-account/pending-paper.pdf'));
}

async function concurrentMove() {
  const cloud = mockCloud();
  const desktop = device(cloud);
  const iPad = device(cloud);
  await waitForJobs();
  await desktop.add('moving-paper');
  await desktop.flush();
  await iPad.poll();
  await desktop.R.db.patchDoc('moving-paper', { boxId: 'box-1' });
  await desktop.flush();
  iPad.onNextRemoteBatch(() => iPad.R.db.patchDoc('moving-paper', { boxId: 'box-2' }));
  await iPad.poll();
  assert.equal((await iPad.R.db.get('docs', 'moving-paper')).boxId, 'box-2');
  await iPad.flush();
  await desktop.poll();
  assert.equal(desktop.R.library.get('moving-paper').boxId, 'box-2');

  const originalMetadata = await iPad.R.db.get('docs', 'moving-paper');
  await iPad.R.db.put('docs', { ...originalMetadata, boxId: 'box-3' });
  await iPad.R.db.put('docs', { ...originalMetadata, boxId: 'box-4' });
  device(cloud, iPad.local); // Reload without flushing the old page's in-memory queue.
  await waitForJobs();
  await desktop.poll();
  assert.equal(desktop.R.library.get('moving-paper').boxId, 'box-4');

  cloud.rows.user_docs.delete('moving-paper');
  await desktop.poll();
  assert.equal(cloud.rows.user_docs.has('moving-paper'), false, 'a periodic refresh resurrected a cloud-removed record');
}

(async () => {
  for (const check of [foregroundSync, retrySync, concurrentMove]) {
    try { await check(); console.log(`PASS ${check.name}`); }
    catch (error) { console.error(`${check.name}: ${error.message}`); process.exitCode = 1; }
  }
})();
