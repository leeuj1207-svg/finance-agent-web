// Versioned, JSON-safe local records. Reuse the 1.2 calculation/validation rules.
import { AnalysisError, MAX_BYTES, amount, validDate, parsePurchases, classify } from './core.js';
export const SCHEMA_VERSION = 1;
export const MAX_RECORDS = 10000;
const fail = message => { throw new AnalysisError('records', message); };
const csv = value => `"${value.replaceAll('"', '""')}"`;
const string = (value, max, required = false) => {
  if (typeof value !== 'string' || value.length > max || (required && !value.trim()))
    fail('입력값의 형식과 길이를 확인해 주세요.');
  return value.trim();
};
export function canonicalAmount(value) {
  const units = amount(string(value, 60, true));
  return `${units / 1000000n}.${String(units % 1000000n).padStart(6, '0')}`.replace(/\.?0+$/, '');
}
export function purchaseRow(record) {
  return parsePurchases('date,account,symbol,amount,kind\n' +
    [record.date, record.account, record.symbol, record.amount, record.kind].map(csv).join(','))[0];
}
export function expenseRow(record) {
  return { month: record.date.slice(0, 7), amount: amount(record.amount),
    category: record.category || classify(record.merchant, record.description) };
}
export function validateRecord(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('거래 레코드 형식이 올바르지 않습니다.');
  const common = ['id', 'type', 'date', 'amount'];
  const fields = input.type === 'investment' ? ['account', 'symbol', 'kind', 'memo'] :
    input.type === 'expense' ? ['merchant', 'description', 'category'] : null;
  if (!fields || Object.keys(input).length !== common.length + fields.length ||
      [...common, ...fields].some(k => !Object.hasOwn(input, k))) fail('거래 레코드 필드를 확인해 주세요.');
  const id = string(input.id, 80, true);
  if (!/^[A-Za-z0-9_-]+$/.test(id)) fail('거래 식별자 형식이 올바르지 않습니다.');
  const result = { id, type: input.type, date: validDate(string(input.date, 10, true)), amount: canonicalAmount(input.amount) };
  if (input.type === 'investment') {
    Object.assign(result, { account: string(input.account, 20, true), symbol: string(input.symbol, 40, true).toUpperCase(),
      kind: string(input.kind, 10, true), memo: string(input.memo, 1000) });
    purchaseRow(result);
  } else Object.assign(result, { merchant: string(input.merchant, 120, true), description: string(input.description, 1000),
    category: string(input.category, 40) });
  return result;
}
// Notes and classification do not turn the same underlying transaction into a new one.
export const fingerprint = r => JSON.stringify(r.type === 'investment' ?
  [r.type, r.date, r.account, r.symbol, r.kind, r.amount] : [r.type, r.date, r.merchant, r.amount, r.description]);
export function validateRecords(records) {
  if (!Array.isArray(records) || records.length > MAX_RECORDS) fail('기록은 최대 10,000건까지 지원합니다.');
  const ids = new Set(), values = new Set();
  const result = records.map(input => {
    const row = validateRecord(input), key = fingerprint(row);
    if (ids.has(row.id)) fail('중복 거래 ID가 있습니다.');
    if (values.has(key)) fail('동일한 거래가 이미 있습니다. 기존 기록을 수정해 주세요.');
    ids.add(row.id); values.add(key); return row;
  });
  if (new TextEncoder().encode(JSON.stringify(result)).length > MAX_BYTES - 256)
    fail('기록과 백업은 최대 2MB까지 지원합니다.');
  return result;
}
export function makeBackup(records, createdAt = new Date().toISOString()) {
  return JSON.stringify({ app: 'personal-finance-agent', schemaVersion: SCHEMA_VERSION,
    createdAt, records: validateRecords(records) }, null, 0);
}
export function parseBackup(content) {
  if (new TextEncoder().encode(content).length > MAX_BYTES) fail('백업은 최대 2MB까지 지원합니다.');
  let data;
  try { data = JSON.parse(content); } catch { fail('손상된 JSON 백업입니다.'); }
  if (!data || typeof data !== 'object' || Array.isArray(data) ||
      Object.keys(data).sort().join(',') !== 'app,createdAt,records,schemaVersion' ||
      data.app !== 'personal-finance-agent' || data.schemaVersion !== SCHEMA_VERSION)
    fail('지원하지 않는 백업 형식 또는 스키마 버전입니다.');
  if (typeof data.createdAt !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(data.createdAt) ||
      !Number.isFinite(Date.parse(data.createdAt)) || new Date(data.createdAt).toISOString() !== data.createdAt) fail('백업 생성 시각이 올바르지 않습니다.');
  return { ...data, records: validateRecords(data.records) };
}
export function restoreRecords(existing, incoming, mode) {
  existing = validateRecords(existing); incoming = validateRecords(incoming);
  if (mode === 'replace') return incoming;
  if (mode !== 'merge') fail('병합 또는 전체 교체를 명시적으로 선택해 주세요.');
  const ids = new Map(existing.map(r => [r.id, r]));
  const values = new Map(existing.map(r => [fingerprint(r), r]));
  const additions = [];
  for (const row of incoming) {
    if (ids.has(row.id)) {
      if (JSON.stringify(ids.get(row.id)) !== JSON.stringify(row))
        fail('같은 ID의 내용이 충돌합니다. 원본은 보존됩니다. 백업을 확인해 주세요.');
      continue;
    }
    const match = values.get(fingerprint(row));
    if (match) {
      const { id: ignoredA, ...a } = match, { id: ignoredB, ...b } = row;
      if (JSON.stringify(a) !== JSON.stringify(b)) fail('동일 거래의 메모 또는 분류가 충돌합니다. 백업을 확인해 주세요.');
      continue;
    }
    additions.push(row);
  }
  return validateRecords([...existing, ...additions]);
}
