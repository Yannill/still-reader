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
    async batch(operations) {
      const d = await open();
      return new Promise((resolve, reject) => {
        const t = d.transaction([...new Set(operations.map(o => o.store))], 'readwrite');
        operations.forEach(o => t.objectStore(o.store)[o.del ? 'delete' : 'put'](o.value));
        t.oncomplete = () => resolve();
        t.onerror = t.onabort = () => reject(t.error || new Error('存储事务未完成'));
      });
    },
    get: (store, key) => run(store, 'readonly', (s) => s.get(key)),
    all: (store) => run(store, 'readonly', (s) => s.getAll()),
    put: (store, val) => run(store, 'readwrite', (s) => s.put(val)),
    del: (store, key) => run(store, 'readwrite', (s) => s.delete(key)),
    async kvGet(key, def) {
      const r = await run('kv', 'readonly', (s) => s.get(key));
      return r ? r.value : def;
    },
    kvSet: (key, value) => run('kv', 'readwrite', (s) => s.put({ key, value })),
  };
})();
