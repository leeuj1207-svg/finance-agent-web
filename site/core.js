// Exact, side-effect-free analysis. No network, browser storage or DOM access.
import { PLAN, RULES, CASE_FOLD, WHITESPACE, DIGITS } from './data.js';

export class AnalysisError extends Error {
  constructor(code, message) { super(message); this.name = 'AnalysisError'; this.code = code; }
}
const fail = (code, message) => { throw new AnalysisError(code, message); };
const SCALE = 1000000n;
export const MAX_BYTES = 2 * 1024 * 1024;
function strip(value) {
  let start = 0, end = value.length;
  while (start < end && WHITESPACE.includes(value[start])) start++;
  while (end > start && WHITESPACE.includes(value[end - 1])) end--;
  return value.slice(start, end);
}

export function amount(value) {
  // Decimal-compatible syntax, including scientific notation and underscores.
  const clean = [...strip(value)].map(c => DIGITS[c] ?? c).join('').replaceAll('_', '');
  const match = /^([+-]?)(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:e([+-]?\d+))?$/i.exec(clean);
  if (!match) fail('amount', '금액은 유한한 양수 숫자여야 합니다.');
  const exponent = Number(match[5] || 0) - (match[3] || match[4] || '').length;
  const digits = BigInt((match[2] || '') + (match[3] || match[4] || ''));
  if (match[1] === '-' || digits === 0n || exponent < -6 || exponent > 12)
    fail('amount', '금액은 양수·1조 이하·소수점 6자리 이하여야 합니다.');
  const result = digits * 10n ** BigInt(exponent + 6);
  if (result > 1000000000000n * SCALE) fail('amount', '금액은 1조 이하여야 합니다.');
  return result;
}

export function money(value) {
  const absolute = value < 0n ? -value : value;
  const cents = (absolute + 5000n) / 10000n;
  return `${value < 0n ? '-' : ''}${cents / 100n}.${String(cents % 100n).padStart(2, '0')}`;
}

export function validDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) fail('date', '날짜는 YYYY-MM-DD 형식이어야 합니다.');
  const [, y, m, d] = match.map(Number);
  const leap = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (y < 1 || m < 1 || m > 12 || d < 1 || d > days[m - 1])
    fail('date', '실제로 존재하는 날짜를 입력해 주세요.');
  return value;
}

export function validMonth(value) {
  if (!/^\d{4}-\d{2}$/.test(value)) fail('month', '분석할 월을 YYYY-MM 형식으로 선택해 주세요.');
  validDate(`${value}-01`);
  return value;
}

export function csvRows(text, required, optional = []) {
  // A small state machine handles quoted commas/newlines, escaped quotes and CRLF.
  text = text.replace(/^\uFEFF/, '');
  const rows = [];
  let row = [], field = '', quoted = false, afterQuote = false, line = 1, touched = false;
  const endField = () => {
    if ([...field].length > 131072) fail('csv', 'CSV 필드가 너무 깁니다. 내용을 나누어 주세요.');
    row.push(field); field = ''; afterQuote = false;
  };
  const endRow = () => {
    if (touched || row.length || field.length) { endField(); rows.push({ row, line }); }
    else if (!rows.length) rows.push({ row: [], line });
    row = []; field = ''; touched = false; afterQuote = false;
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else { quoted = false; afterQuote = true; }
      } else {
        field += c;
        if (c === '\n' || (c === '\r' && text[i + 1] !== '\n')) line++;
      }
    } else if (c === ',') { endField(); touched = true; }
    else if (c === '\r' || c === '\n') {
      endRow(); if (c === '\r' && text[i + 1] === '\n') i++; line++;
    } else if (c === '"' && field === '' && !afterQuote) { quoted = true; touched = true; }
    else if (afterQuote) fail('csv', 'CSV 따옴표 뒤에 잘못된 문자가 있습니다.');
    else { field += c; touched = true; }
  }
  if (quoted) fail('csv', 'CSV 따옴표가 닫히지 않았습니다.');
  endRow();
  const headers = rows.shift()?.row;
  const allowed = [...required, ...optional];
  if (!headers || new Set(headers).size !== headers.length || required.some(h => !headers.includes(h))
      || headers.some(h => !allowed.includes(h)))
    fail('headers', `CSV 열을 확인해 주세요. 필수: ${required.join(', ')}${optional.length ? ` / 선택: ${optional.join(', ')}` : ''}`);
  return rows.map(({row: values, line: number}) => {
    if (values.length !== headers.length) fail('csv', `CSV ${number}행의 열 개수가 올바르지 않습니다.`);
    return { ...Object.fromEntries(headers.map((h, i) => [h, strip(values[i])])), line: number };
  });
}

const normalize = text => [...text.normalize('NFKC')].map(c => CASE_FOLD[c] ?? c.toLowerCase()).join('');
export function classify(merchant, description) {
  for (const text of [merchant, description]) {
    const normalized = normalize(text);
    for (const rule of RULES) if (rule.keywords.some(word => normalized.includes(normalize(word)))) return rule.category;
  }
  return '미분류';
}

export function parseExpenses(text) {
  return csvRows(text, ['date', 'merchant', 'amount', 'description']).map(row => {
    validDate(row.date);
    if (!row.merchant) fail('merchant', '가맹점이 비어 있는 행이 있습니다.');
    // Only retain month, amount and derived category, never raw merchants or descriptions.
    return { month: row.date.slice(0, 7), amount: amount(row.amount), category: classify(row.merchant, row.description) };
  });
}

export function summarizeExpenses(rows, month) {
  if (month !== null) validMonth(month);
  const categories = new Map(), months = new Map();
  let count = 0, total = 0n;
  for (const row of rows) {
    if (month !== null && row.month !== month) continue;
    total += row.amount; count++;
    categories.set(row.category, (categories.get(row.category) || 0n) + row.amount);
    months.set(row.month, (months.get(row.month) || 0n) + row.amount);
  }
  const output = map => Object.fromEntries([...map].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => [k, money(v)]));
  return { month, transaction_count: count, total_expenses: money(total), by_category: output(categories), by_month: output(months) };
}

const instruments = new Map(PLAN.instruments.map(item => [item.symbol, item]));
export function parsePurchases(text) {
  const seen = new Set();
  return csvRows(text, ['date', 'account', 'symbol', 'amount'], ['kind', 'transaction_id']).map(row => {
    validDate(row.date);
    if (!PLAN.accounts.some(a => a.id === row.account)) fail('account', '계좌 별칭은 new_funds, pension, irp, isa만 사용할 수 있습니다.');
    const symbol = row.symbol.toUpperCase();
    if (!symbol || symbol === 'UNCLASSIFIED') fail('symbol', '종목이 비어 있거나 예약된 식별자입니다.');
    const kind = row.kind || 'purchase';
    if (!['purchase', 'reserve'].includes(kind)) fail('kind', '종류는 purchase 또는 reserve여야 합니다.');
    if (instruments.has(symbol) && instruments.get(symbol).kind !== kind) fail('kind', '종목에 맞는 매수·적립 종류를 확인해 주세요.');
    if (kind === 'reserve' && !PLAN.allocations.some(a => a.account === row.account && a.symbol === symbol))
      fail('reserve', '현금성 적립은 계획에 있는 계좌와 종목으로 기록해 주세요.');
    if (row.transaction_id && seen.has(row.transaction_id)) fail('duplicate', '중복 거래 ID가 있습니다. 파일 전체에서 고유한 ID를 사용해 주세요.');
    if (row.transaction_id) seen.add(row.transaction_id);
    // Drop IDs, exact transaction dates and unknown symbols after validation.
    return { month: row.date.slice(0, 7), account: row.account,
      symbol: instruments.has(symbol) ? symbol : 'UNCLASSIFIED', kind, amount: amount(row.amount) };
  });
}

export function scheduleReport(month) {
  validMonth(month);
  const first = new Date(`${month}-01T12:00:00Z`);
  const tuesday = 1 + (2 - first.getUTCDay() + 7) % 7;
  return { base_dates: [tuesday + 7, tuesday + 21].map(day => `${month}-${String(day).padStart(2, '0')}`),
    holiday_adjustment_supported: false, notice: '휴장일 조정 미지원' };
}

const fields = ['purchaseTarget', 'reserveTarget', 'purchased', 'reserved', 'unexecuted', 'unfunded'];
const zero = () => Object.fromEntries(fields.map(key => [key, 0n]));
const add = (a, b) => { for (const key of fields) a[key] += b[key]; };
function totalsReport(t, actual) {
  const target = t.purchaseTarget + t.reserveTarget;
  const result = { target_amount: money(target), purchase_target_amount: money(t.purchaseTarget), reserve_target_amount: money(t.reserveTarget) };
  if (actual) Object.assign(result, {
    purchased_amount: money(t.purchased), reserved_amount: money(t.reserved), actual_amount: money(t.purchased + t.reserved),
    difference: money(t.purchased + t.reserved - target), unexecuted_amount: money(t.unexecuted),
    unfunded_reserve_amount: money(t.unfunded), remaining_amount: money(t.unexecuted + t.unfunded),
  });
  return result;
}
const metadata = item => Object.fromEntries(['name', 'asset_class', 'kind', 'is_mixed_asset', 'note'].map(k => [k, item[k]]));
function rollup(rows, actual) {
  const symbols = new Map([...instruments].map(([key, item]) => [key, metadata(item)]));
  if (rows.some(r => r.symbol === 'UNCLASSIFIED')) symbols.set('UNCLASSIFIED', { name: '미분류 종목', asset_class: 'unclassified', kind: 'purchase', is_mixed_asset: false, note: '설정에 없는 종목을 합산하며 원문 종목은 출력하지 않습니다.' });
  const pairs = new Map();
  const pair = (account, symbol) => {
    const key = `${account}:${symbol}`;
    if (!pairs.has(key)) pairs.set(key, { account, symbol, ...zero() });
    return pairs.get(key);
  };
  for (const entry of PLAN.allocations) pair(entry.account, entry.symbol)[instruments.get(entry.symbol).kind === 'reserve' ? 'reserveTarget' : 'purchaseTarget'] = amount(entry.per_session_target) * 2n;
  for (const entry of rows) pair(entry.account, entry.symbol)[entry.kind === 'reserve' ? 'reserved' : 'purchased'] += entry.amount;
  const accounts = new Map(PLAN.accounts.map(a => [a.id, zero()]));
  const bySymbol = new Map([...symbols.keys()].map(key => [key, zero()]));
  const assets = new Map(PLAN.asset_classes.map(a => [a.id, zero()]));
  const assetNames = new Map([...PLAN.asset_classes.map(a => [a.id, a.name]), ['unclassified', '미분류']]);
  const accountSymbols = Object.fromEntries(PLAN.accounts.map(a => [a.id, {}]));
  const total = zero();
  for (const entry of pairs.values()) {
    entry.unexecuted = entry.purchaseTarget > entry.purchased ? entry.purchaseTarget - entry.purchased : 0n;
    entry.unfunded = entry.reserveTarget > entry.reserved ? entry.reserveTarget - entry.reserved : 0n;
    const info = symbols.get(entry.symbol);
    if (!assets.has(info.asset_class)) assets.set(info.asset_class, zero());
    for (const group of [total, accounts.get(entry.account), bySymbol.get(entry.symbol), assets.get(info.asset_class)]) add(group, entry);
    accountSymbols[entry.account][entry.symbol] = { ...info, ...totalsReport(entry, actual) };
  }
  return {
    total: totalsReport(total, actual),
    by_account: Object.fromEntries(PLAN.accounts.map(a => [a.id, { name: a.name, ...totalsReport(accounts.get(a.id), actual), by_symbol: accountSymbols[a.id] }])),
    by_symbol: Object.fromEntries([...symbols].map(([key, info]) => [key, { ...info, ...totalsReport(bySymbol.get(key), actual) }])),
    by_asset_class: Object.fromEntries([...assets].map(([key, t]) => [key, { name: assetNames.get(key), ...totalsReport(t, actual) }])),
  };
}

export function planReport(month) {
  const schedule = scheduleReport(month);
  return { month, currency: PLAN.currency, plan_version: PLAN.version, schedule, ...rollup([], false),
    sessions: schedule.base_dates.map(day => ({ base_date: day, allocations: PLAN.allocations.map(a => ({ account: a.account, symbol: a.symbol, kind: instruments.get(a.symbol).kind, target_amount: money(amount(a.per_session_target)) })) })) };
}

export function monthlyReview(rows, month) {
  validMonth(month);
  const selected = rows.filter(row => row.month === month);
  return { month, currency: PLAN.currency, plan_version: PLAN.version, schedule: scheduleReport(month), transaction_count: selected.length,
    unclassified_transaction_count: selected.filter(row => row.symbol === 'UNCLASSIFIED').length, ...rollup(selected, true) };
}
