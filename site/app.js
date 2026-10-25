import { AnalysisError, MAX_BYTES, validMonth, parsePurchases, monthlyReview, planReport,
  parseExpenses, summarizeExpenses } from './core.js';
import { DEMO_PURCHASES, DEMO_EXPENSES } from './data.js';
import { initLocal } from './local.js';
import { purchaseRow, expenseRow } from './records.js';

const $ = id => document.getElementById(id);
const state = { purchases: null, expenses: null, purchaseSource: '', expenseSource: '' };
const revision = { purchases: 0, expenses: 0 };
const monthInput = $('month');
let localUI;
const sourceLabel = source => source === 'demo' ? '합성 데모' : source === 'saved' ? '기기 내 저장 기록' : '로컬 CSV';
const now = new Date();
monthInput.value = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
const error = message => { $('error').textContent = message; $('error').hidden = !message; };
const text = (tag, value, className) => { const e = document.createElement(tag); e.textContent = value; if (className) e.className = className; return e; };
function krw(value) {
  if (value === null || value === undefined) return '—';
  const [whole, fraction] = value.split('.');
  return `${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}${fraction && fraction !== '00' ? `.${fraction}` : ''}원`;
}
function cards(id, entries) {
  $(id).replaceChildren(...entries.map(([label, value, note], index) => {
    const card = text('div', '', `card${index === 0 ? ' accent' : ''}`);
    card.append(text('p', label, 'label'), text('p', value, 'value'), text('span', note, 'small'));
    return card;
  }));
}
function table(target, caption, headers, rows) {
  if (!rows.length) { target.replaceChildren(text('p', '선택한 월의 기록이 없습니다.', 'empty')); return; }
  const wrap = text('div', '', 'table-scroll');
  wrap.tabIndex = 0; wrap.setAttribute('role', 'region'); wrap.setAttribute('aria-label', `${caption} · 좌우로 스크롤할 수 있습니다`);
  const element = document.createElement('table');
  element.append(text('caption', caption));
  const head = document.createElement('thead'), headRow = document.createElement('tr');
  for (const label of headers) { const cell = text('th', label); cell.scope = 'col'; headRow.append(cell); }
  head.append(headRow); element.append(head);
  const body = document.createElement('tbody');
  for (const row of rows) {
    const tr = document.createElement('tr');
    row.forEach((value, index) => { const cell = text(index === 0 ? 'th' : 'td', value); if (!index) cell.scope = 'row'; tr.append(cell); });
    body.append(tr);
  }
  element.append(body); wrap.append(element); target.replaceChildren(wrap);
}
function investmentRows(group, hasData, symbols = false) {
  return Object.entries(group).map(([key, item]) => [symbols ? `${item.name} (${key})` : item.name,
    krw(item.target_amount), hasData ? krw(item.purchased_amount) : '—',
    hasData ? krw(item.reserved_amount) : '—', hasData ? krw(item.difference) : '—',
    hasData ? krw(item.unexecuted_amount) : '—', hasData ? krw(item.unfunded_reserve_amount) : '—']);
}
const headers = ['구분', '월 목표', '매수 실적', '현금성 적립', '차이', '미집행 매수', '적립 부족'];
function render() {
  localUI?.render();
  let month;
  try { month = validMonth(monthInput.value); }
  catch { error('분석할 월을 YYYY-MM 형식으로 선택해 주세요.'); for (const id of ['overview', 'investment-cards', 'expense-cards', 'account-table', 'symbol-table', 'asset-table', 'category-table', 'account-details', 'schedule']) $(id).replaceChildren(); return; }
  const plan = planReport(month);
  const investment = state.purchases === null ? plan : monthlyReview(state.purchases, month);
  const expense = state.expenses === null ? null : summarizeExpenses(state.expenses, month);
  const hasPurchases = state.purchases !== null;
  $('data-mode').textContent = [state.purchaseSource, state.expenseSource].some(s => s === 'saved') ? '기기 내 저장 기록' : [state.purchaseSource, state.expenseSource].some(s => s === 'local') ? '로컬 기록' : state.purchaseSource || state.expenseSource ? '합성 데모' : '기록 선택 전';
  cards('overview', [
    ['월 투자·적립 목표', krw(plan.total.target_amount), '매수 118만 원 + 적립 8만 원'],
    ['이번 달 투자·적립', hasPurchases ? krw(investment.total.actual_amount) : '—', hasPurchases ? `${investment.transaction_count}건 · ${sourceLabel(state.purchaseSource)}` : '투자 CSV를 선택해 주세요'],
    ['이번 달 지출', expense ? krw(expense.total_expenses) : '—', expense ? `${expense.transaction_count}건 · ${sourceLabel(state.expenseSource)}` : '지출 CSV를 선택해 주세요'],
  ]);
  $('schedule').textContent = `기본 예정일 ${plan.schedule.base_dates.join(' / ')} · 휴장일 조정 미지원. 실제 영업일은 별도로 확인해 주세요.`;
  $('purchases-state').textContent = hasPurchases ? `${sourceLabel(state.purchaseSource)} · 선택 월 ${investment.transaction_count}건${investment.unclassified_transaction_count ? ` · 미분류 ${investment.unclassified_transaction_count}건` : ''}` : '아직 기록을 선택하지 않았습니다. 아래에는 목표만 표시합니다.';
  cards('investment-cards', [
    ['월 목표', krw(plan.total.target_amount), '계좌·종목별 합계'],
    ['상품 매수', hasPurchases ? krw(investment.total.purchased_amount) : '—', '현금성 적립 제외'],
    ['현금성 보류·적립', hasPurchases ? krw(investment.total.reserved_amount) : '—', '매수 실적과 구분'],
    ['목표와의 차이', hasPurchases ? krw(investment.total.difference) : '—', '실적 − 목표'],
    ['미집행 매수', hasPurchases ? krw(investment.total.unexecuted_amount) : '—', '계좌·종목별 부족액 합계'],
    ['현금성 적립 부족', hasPurchases ? krw(investment.total.unfunded_reserve_amount) : '—', '매수 부족액과 별도'],
  ]);
  table($('account-table'), '계좌별 결산', headers, investmentRows(investment.by_account, hasPurchases));
  table($('symbol-table'), '종목별 결산', headers, investmentRows(investment.by_symbol, hasPurchases, true));
  table($('asset-table'), '자산군별 결산', headers, investmentRows(investment.by_asset_class, hasPurchases));
  $('account-details').replaceChildren(...Object.values(investment.by_account).map(account => {
    const details = document.createElement('details'); details.append(text('summary', account.name));
    const content = document.createElement('div'); table(content, `${account.name} 종목별 결산`, headers, investmentRows(account.by_symbol, hasPurchases, true)); details.append(content); return details;
  }));
  $('expenses-state').textContent = expense ? `${sourceLabel(state.expenseSource)} · 선택 월 ${expense.transaction_count}건` : '아직 기록을 선택하지 않았습니다.';
  cards('expense-cards', [
    ['이번 달 총지출', expense ? krw(expense.total_expenses) : '—', expense ? '선택한 월의 지출만 집계' : '지출 CSV를 선택해 주세요'],
    ['거래 건수', expense ? `${expense.transaction_count}건` : '—', '동일 금액도 별도 거래'],
    ['미분류 지출', expense ? krw(expense.by_category['미분류'] || '0.00') : '—', '키워드 규칙으로 판단하지 못한 금액'],
  ]);
  table($('category-table'), '카테고리별 지출', ['분류', '지출액'], expense ? Object.entries(expense.by_category).sort((a,b) => Number(b[1]) - Number(a[1])).map(([k,v]) => [k, krw(v)]) : []);
  if (!expense) $('category-table').replaceChildren(text('p', 'CSV를 선택하거나 합성 데모를 눌러 주세요.', 'empty'));
}
async function loadFile(kind, file) {
  const version = ++revision[kind];
  const sourceKey = kind === 'purchases' ? 'purchaseSource' : 'expenseSource';
  state[kind] = null; state[sourceKey] = ''; error(''); $('status').textContent = '';
  render();
  if (!file) return;
  try {
    if (/\.xlsx?$/i.test(file.name)) throw new AnalysisError('xlsx', 'XLSX·XLS 파일은 미지원입니다. UTF-8 CSV로 변환해 주세요.');
    if (!/\.csv$/i.test(file.name)) throw new AnalysisError('file', 'CSV 파일을 선택해 주세요.');
    if (file.size > MAX_BYTES) throw new AnalysisError('size', '아이폰의 안정적인 처리를 위해 2MB 이하 CSV만 지원합니다.');
    const bytes = await file.arrayBuffer();
    if (revision[kind] !== version) return;
    let content;
    try { content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
    catch { throw new AnalysisError('encoding', '파일 인코딩을 UTF-8로 저장해 주세요.'); }
    const parsed = kind === 'purchases' ? parsePurchases(content) : parseExpenses(content);
    state[kind] = parsed; state[sourceKey] = 'local';
    $('status').textContent = '브라우저에서 분석했습니다. 파일과 결과는 전송하거나 저장하지 않습니다.';
    render();
  } catch (e) {
    if (revision[kind] !== version) return;
    state[kind] = null; state[sourceKey] = '';
    error(e instanceof AnalysisError ? e.message : '파일을 읽을 수 없습니다. UTF-8 CSV 형식을 확인해 주세요.');
    render();
  }
}
for (const kind of ['purchases', 'expenses']) $(kind + '-file').addEventListener('change', async event => {
  const file = event.target.files[0]; event.target.value = ''; await loadFile(kind, file);
});
monthInput.addEventListener('change', () => { error(''); render(); });
$('demo').addEventListener('click', () => {
  revision.purchases++; revision.expenses++;
  monthInput.value = '2026-01'; state.purchases = parsePurchases(DEMO_PURCHASES); state.expenses = parseExpenses(DEMO_EXPENSES);
  state.purchaseSource = 'demo'; state.expenseSource = 'demo';
  error(''); $('status').textContent = '2026년 1월 합성 데모입니다. 실제 금융 데이터가 아닙니다.'; render();
});
$('clear').addEventListener('click', () => {
  revision.purchases++; revision.expenses++;
  state.purchases = null; state.expenses = null; state.purchaseSource = ''; state.expenseSource = '';
  error(''); $('status').textContent = '선택한 기록과 분석 결과를 메모리에서 지웠습니다.'; render();
});
for (const button of document.querySelectorAll('[data-view]')) button.addEventListener('click', () => {
  for (const control of document.querySelectorAll('[data-view]')) control.setAttribute('aria-pressed', String(control === button));
  for (const view of document.querySelectorAll('.view')) view.hidden = view.id !== button.dataset.view;
});
render();

function useSaved(records) {
  revision.purchases++; revision.expenses++;
  state.purchases = records.filter(r => r.type === 'investment').map(purchaseRow);
  state.expenses = records.filter(r => r.type === 'expense').map(expenseRow);
  state.purchaseSource = state.expenseSource = 'saved'; render();
}
localUI = initLocal({ monthInput, krw, onUse: useSaved,
  onLoad: records => { if (!revision.purchases && !revision.expenses) useSaved(records); },
  onError: message => { error(message); if (message) { $('error').tabIndex = -1; $('error').focus(); } },
});
