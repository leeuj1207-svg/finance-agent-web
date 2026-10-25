import { AnalysisError } from './core.js';
import { SCHEMA_VERSION, validateRecords, validateRecord, restoreRecords } from './records.js';

export const DB_NAME = 'personal-finance-agent';
const storageError = () => new AnalysisError('storage', '기기 내 저장에 실패했습니다. 저장 공간·Safari 설정을 확인하고 백업해 주세요. 입력값은 화면에 유지됩니다.');
function openDatabase(create) {
  return new Promise((resolve, reject) => {
    if (!globalThis.indexedDB) { reject(storageError()); return; }
    let request, absent = false, blocked = false;
    try { request = indexedDB.open(DB_NAME, SCHEMA_VERSION); } catch { reject(storageError()); return; }
    request.onupgradeneeded = event => {
      // 1.2 had no database. A read on a fresh installation creates no persistent DB.
      if (!create && event.oldVersion === 0) { absent = true; request.transaction.abort(); return; }
      // Add future migrations here in increasing oldVersion order, inside this transaction.
      // Never delete/recreate stores as recovery, including on unknown newer versions.
      if (event.oldVersion < 1) {
        request.result.createObjectStore('records', { keyPath: 'id' });
        request.result.createObjectStore('meta');
      }
    };
    request.onblocked = () => { blocked = true; reject(new AnalysisError('blocked', '다른 탭을 닫고 다시 시도해 주세요. 저장소 변경이 차단되었습니다.')); };
    request.onerror = () => absent ? resolve(null) : reject(storageError());
    request.onsuccess = () => {
      if (blocked) { request.result.close(); return; }
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
  });
}
// Every write checks the revision and validates the complete result inside ONE transaction.
// Readers and competing tabs can never see a partly restored snapshot.
async function transaction(mutation, expectedRevision) {
  const db = await openDatabase(Boolean(mutation));
  if (!db) return { records: [], revision: 0, exists: false };
  return new Promise((resolve, reject) => {
    let tx, result, failure;
    try { tx = db.transaction(['records', 'meta'], mutation ? 'readwrite' : 'readonly'); }
    catch { db.close(); reject(storageError()); return; }
    tx.onabort = () => { db.close(); reject(failure || storageError()); };
    tx.onerror = () => {}; // onabort is the single failure path; never claim request success is a saved transaction.
    tx.oncomplete = () => { db.close(); resolve(result); };
    const store = tx.objectStore('records'), meta = tx.objectStore('meta');
    const rowsRequest = store.getAll(), revisionRequest = meta.get('revision');
    let pending = 2;
    const apply = () => {
      if (--pending) return;
      try {
        const records = validateRecords(rowsRequest.result), revision = revisionRequest.result ?? 0;
        if (!Number.isSafeInteger(revision) || revision < 0) throw storageError();
        if (mutation && expectedRevision !== revision)
          throw new AnalysisError('conflict', '다른 탭에서 기록이 변경되었습니다. 새로고침 후 다시 시도해 주세요.');
        const next = mutation ? validateRecords(mutation(records)) : records;
        result = { records: next, revision: revision + (mutation ? 1 : 0), exists: true };
        if (mutation) {
          const nextIds = new Set(next.map(r => r.id));
          for (const row of records) if (!nextIds.has(row.id)) store.delete(row.id);
          for (const row of next) store.put(row);
          meta.put(result.revision, 'revision');
        }
      } catch (error) { failure = error instanceof AnalysisError ? error : storageError(); tx.abort(); }
    };
    rowsRequest.onsuccess = apply; revisionRequest.onsuccess = apply;
  });
}
export const readRecords = () => transaction(null);
export const saveRecord = (input, revision, editing = false) => transaction(records => {
  const row = validateRecord(input), exists = records.some(r => r.id === row.id);
  if (exists !== editing) throw new AnalysisError('conflict', '수정할 기록의 상태가 변경되었습니다. 새로고침해 주세요.');
  return [...records.filter(r => r.id !== row.id), row];
}, revision);
export const deleteRecord = (id, revision) => transaction(records => records.filter(r => r.id !== id), revision);
export const restoreBackup = (records, mode, revision) => transaction(existing => restoreRecords(existing, records, mode), revision);
