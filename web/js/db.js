/* db.js —— IndexedDB 本地存储
 * docs   : 文档元数据 {id, name, title, pageCount, addedAt, lastOpened, progress, thumb, scanned}
 * files  : PDF 原始字节 {id, bytes}
 * annots : 标注 {id: docId, list: [...]}
 * chats  : AI 对话 {id: docId, messages: [...]}
 * kv     : 其他 {key, value}（统计、杂念停车场…）
 */
'use strict';
R.db = (() => {
  let dbp = null;
  const STORES = { docs: 'id', files: 'id', annots: 'id', chats: 'id', kv: 'key', boxes: 'id' };

  function timestampDoc(value, previous) {
    const lastEdit = Math.max(value.updatedAt || 0, previous?.updatedAt || 0, value.lastOpened || 0, value.addedAt || 0);
    return { ...value, updatedAt: Math.max(Date.now(), lastEdit + 1) };
  }

  function notify(events) {
    if (events?.length) R.cloud?.onLocalChange?.(events);
  }

  function open() {
    if (dbp) return dbp;
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open('adhd-reader', 2);
      req.onupgradeneeded = event => {
        const d = req.result;
        for (const [name, keyPath] of Object.entries(STORES)) {
          if (!d.objectStoreNames.contains(name)) d.createObjectStore(name, { keyPath });
        }
        if (event.oldVersion < 2) {
          ['数学', '英语', '学习方法', '专业', '兴趣', '未归档'].forEach((name, order) => {
            req.transaction.objectStore('boxes').put({ id: order === 5 ? 'unsorted' : 'box-' + order, name, order, createdAt: Date.now(), ...(order === 5 ? { system: 'unsorted' } : {}) });
          });
        }
      };
      req.onsuccess = () => { req.result.onversionchange = () => { req.result.close(); dbp = null; }; resolve(req.result); };
      req.onerror = () => { dbp = null; reject(req.error); };
      req.onblocked = () => R.toast('请关闭其它静读标签页，再刷新以完成书库升级', 'error', 6000);
    });
    return dbp;
  }

  async function run(store, mode, fn) {
    const d = await open();
    return new Promise((resolve, reject) => {
      const t = d.transaction(store, mode);
      const req = fn(t.objectStore(store));
      t.oncomplete = () => resolve(req ? req.result : undefined);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  }

  return {
    async batch(operations, { silent = false } = {}) {
      const d = await open();
      const applied = [];
      await new Promise((resolve, reject) => {
        const t = d.transaction([...new Set(operations.map(o => o.store))], 'readwrite');
        for (const operation of operations) {
          const { store, value, del, expected } = operation;
          const objectStore = t.objectStore(store);
          const stamp = store === 'docs' && !silent && !del;
          const conditional = Object.hasOwn(operation, 'expected');
          const apply = previous => {
            const stored = stamp ? timestampDoc(value, previous) : value;
            objectStore[del ? 'delete' : 'put'](stored);
            applied.push(operation);
          };
          if (!conditional && !stamp) {
            apply();
            continue;
          }
          // An edit may have landed after the cloud read, including in another tab.
          const key = del ? value : value[STORES[store]];
          const request = objectStore.get(key);
          request.onsuccess = () => {
            if (!conditional || JSON.stringify(request.result) === JSON.stringify(expected)) apply(request.result);
          };
        }
        t.oncomplete = () => resolve();
        t.onerror = t.onabort = () => reject(t.error || new Error('存储事务未完成'));
      });
      if (!silent) notify(applied.map(o => ({
        store: o.store,
        del: !!o.del,
        id: o.del ? o.value : o.value?.id,
        key: o.store === 'kv' ? (o.del ? o.value : o.value?.key) : undefined,
      })));
      return applied;
    },
    // Merge progress atomically with changes made in other tabs.
    async patchDoc(id, fields, { silent = false } = {}) {
      await run('docs', 'readwrite', store => {
        const request = store.get(id);
        request.onsuccess = () => {
          if (request.result) {
            const value = { ...request.result, ...fields };
            store.put(silent ? value : timestampDoc(value, request.result));
          }
        };
      });
      if (!silent) notify([{ store: 'docs', del: false, id }]);
    },
    get: (store, key) => run(store, 'readonly', (s) => s.get(key)),
    all: (store) => run(store, 'readonly', (s) => s.getAll()),
    async put(store, val, { silent = false } = {}) {
      if (store === 'docs' && !silent) {
        await run('docs', 'readwrite', s => {
          const req = s.get(val.id);
          req.onsuccess = () => s.put(timestampDoc(val, req.result));
        });
        notify([{ store, del: false, id: val.id }]);
        return val.id;
      }
      const res = await run(store, 'readwrite', (s) => s.put(val));
      if (!silent) notify([{ store, del: false, id: val?.id, key: store === 'kv' ? val?.key : undefined }]);
      return res;
    },
    async del(store, key) {
      const res = await run(store, 'readwrite', (s) => s.delete(key));
      notify([{ store, del: true, id: key, key: store === 'kv' ? key : undefined }]);
      return res;
    },
    async kvGet(key, def) {
      const r = await run('kv', 'readonly', (s) => s.get(key));
      return r ? r.value : def;
    },
    async kvSet(key, value) {
      const res = await run('kv', 'readwrite', (s) => s.put({ key, value }));
      notify([{ store: 'kv', del: false, key }]);
      return res;
    },
  };
})();
