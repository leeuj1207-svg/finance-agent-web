import { AnalysisError, MAX_BYTES, money, validMonth, monthlyReview, summarizeExpenses } from './core.js';
import { PLAN } from './data.js';
import { validateRecord, makeBackup, parseBackup, restoreRecords, purchaseRow, expenseRow } from './records.js';
import { readRecords, saveRecord, deleteRecord, restoreBackup } from './storage.js';

const $ = id => document.getElementById(id);
const node = (tag, value, className) => {
  const element = document.createElement(tag); element.textContent = value;
  if (className) element.className = className;
  return element;
};
export function initLocal({ monthInput, onUse, onLoad, onError, krw }) {
  let snapshot = { records: [], revision: 0 }, busy = true, preview = null, fileRevision = 0, backupURL = null;
  const forms = ['investment', 'expense'];
  const message = value => { $('storage-status').textContent = value; };
  const reportError = error => {
    const value = error instanceof AnalysisError ? error.message : '기기 내 처리를 완료하지 못했습니다. 원본 기록은 보존됩니다. 입력값을 확인하고 다시 시도해 주세요.';
    message(value); onError(value);
  };
  const disable = value => { busy = value; $('local-controls').disabled = value; };
  function cancelPreview() {
    fileRevision++; preview = null; $('restore-preview').hidden = true;
    for (const radio of document.querySelectorAll('[name=restore-mode]')) radio.checked = false;
  }
  function invalidateBackup() {
    if (backupURL) URL.revokeObjectURL(backupURL);
    backupURL = null; $('backup-link').hidden = true; $('backup-link').removeAttribute('href');
  }
  function reset(type) {
    const form = $(type + '-form'); form.reset(); delete form.dataset.id;
    const today = new Date();
    form.elements.namedItem('date').value = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    $(type + '-edit-state').textContent = type === 'investment' ? '새 투자 기록' : '새 지출 기록';
  }
  const use = () => onUse(snapshot.records);
  async function write(action, success, after) {
    if (busy) return;
    disable(true); onError(''); message('저장 중… 완료 표시를 확인해 주세요.');
    try {
      snapshot = await action(); cancelPreview(); invalidateBackup(); after?.();
      message(`${success} · 이 기기에 ${snapshot.records.length}건 저장됨`); use(); render();
    } catch (error) { reportError(error); }
    finally { disable(false); }
  }
  function edit(row) {
    const form = $(row.type + '-form');
    for (const [key, value] of Object.entries(row)) if (form.elements.namedItem(key)) form.elements.namedItem(key).value = value;
    form.dataset.id = row.id; $(row.type + '-edit-state').textContent = '기존 기록 수정 중 · 저장 전까지 원본 유지';
    form.elements.namedItem('date').focus();
  }
  function render() {
    let month;
    try { month = validMonth(monthInput.value); } catch { $('saved-records').replaceChildren(); return; }
    const selected = snapshot.records.filter(row => row.date.startsWith(month)).sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
    // Render in bounded pages so 10,000 imported records cannot freeze mobile Safari.
    const offset = Number($('saved-records').dataset.offset || 0);
    const start = offset < selected.length ? offset : 0;
    const elements = [node('p', `선택 월 ${selected.length}건 · 전체 ${snapshot.records.length}건`, 'small')];
    for (const row of selected.slice(start, start + 50)) {
      const item = node('article', '', 'saved-record');
      const detail = row.type === 'investment' ?
        `${PLAN.accounts.find(a => a.id === row.account).name} · ${row.symbol} · ${row.kind === 'reserve' ? '현금성 적립' : '매수'}` :
        `${row.merchant} · ${expenseRow(row).category}${row.category ? ' (수동)' : ' (자동)'}`;
      // Display amounts through the exact core converter, never floating point.
      const amount = (row.type === 'investment' ? purchaseRow(row) : expenseRow(row)).amount;
      item.append(node('p', `${row.date} · ${krw(money(amount))}`, 'small'));
      item.append(node('p', detail));
      const memo = row.type === 'investment' ? row.memo : row.description;
      if (memo) item.append(node('p', memo, 'small'));
      const update = node('button', '수정', 'quiet'), remove = node('button', '삭제', 'quiet');
      update.type = remove.type = 'button';
      update.setAttribute('aria-label', `${row.date} ${detail} 수정`);
      remove.setAttribute('aria-label', `${row.date} ${detail} 삭제`);
      update.addEventListener('click', () => edit(row));
      remove.addEventListener('click', () => {
        if (confirm('이 저장 기록 1건을 삭제할까요? 백업하지 않은 삭제는 되돌릴 수 없습니다.'))
          void write(() => deleteRecord(row.id, snapshot.revision), '삭제 완료', () => {
            if ($(row.type + '-form').dataset.id === row.id) reset(row.type);
          });
      });
      item.append(update, remove); elements.push(item);
    }
    if (selected.length > 50) {
      elements.push(node('p', `${start + 1}–${Math.min(start + 50, selected.length)} / ${selected.length}건`, 'small'));
      for (const [label, next] of [['이전 기록', start - 50], ['다음 기록', start + 50]]) {
        const button = node('button', label, 'quiet'); button.type = 'button'; button.disabled = next < 0 || next >= selected.length;
        button.addEventListener('click', () => { $('saved-records').dataset.offset = next; render(); }); elements.push(button);
      }
    }
    $('saved-records').replaceChildren(...elements);
  }
  for (const type of forms) {
    reset(type);
    const form = $(type + '-form');
    form.addEventListener('submit', event => {
      event.preventDefault(); if (busy) return;
      try {
        const editing = Boolean(form.dataset.id);
        const id = form.dataset.id || Array.from(crypto.getRandomValues(new Uint8Array(16)), n => n.toString(16).padStart(2, '0')).join('');
        const row = validateRecord({ id, type, ...Object.fromEntries(new FormData(form)) });
        if (!confirm(editing ? '이 기록의 수정 내용을 기기에 저장할까요?' : '이 새 기록을 기기에 저장할까요?')) return;
        void write(() => saveRecord(row, snapshot.revision, editing), '저장 완료', () => reset(type));
      } catch (error) { reportError(error); }
    });
    document.querySelector(`[data-cancel=${type}]`).addEventListener('click', () => { reset(type); form.elements.namedItem('date').focus(); });
  }
  $('use-saved').addEventListener('click', () => { use(); message(`저장 기록 ${snapshot.records.length}건으로 분석합니다. 분석 탭에서 확인하세요.`); });
  $('export-backup').addEventListener('click', () => {
    if (busy || !confirm('암호화되지 않은 민감정보가 포함될 수 있는 JSON을 내보냅니다. 개인 저장 공간에 보관하고 공유·공개 업로드하지 마세요. 계속할까요?')) return;
    try {
      invalidateBackup();
      backupURL = URL.createObjectURL(new Blob([makeBackup(snapshot.records)], { type: 'application/json' }));
      const link = $('backup-link'); link.href = backupURL; link.hidden = false; link.click();
      message('백업 파일을 만들었습니다. Safari 다운로드 또는 공유 메뉴에서 파일 저장을 완료해 주세요.');
    } catch (error) { reportError(error); }
  });
  $('restore-file').addEventListener('change', async event => {
    const file = event.target.files[0]; event.target.value = ''; cancelPreview(); onError('');
    const version = fileRevision;
    if (!file || busy) return;
    try {
      if (file.size > MAX_BYTES) throw new AnalysisError('size', '백업은 최대 2MB까지 지원합니다.');
      const bytes = await file.arrayBuffer();
      if (version !== fileRevision) return;
      let content;
      try { content = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
      catch { throw new AnalysisError('encoding', 'UTF-8 JSON 백업을 선택해 주세요.'); }
      const data = parseBackup(content);
      preview = { ...data, revision: snapshot.revision };
      const investment = data.records.filter(r => r.type === 'investment').map(purchaseRow);
      const expenses = data.records.filter(r => r.type === 'expense').map(expenseRow);
      const dates = data.records.map(r => r.date).sort();
      $('restore-summary').textContent = `생성 ${data.createdAt} · 전체 ${data.records.length}건 (투자 ${investment.length}건 / 지출 ${expenses.length}건) · ${dates[0] || '날짜 없음'} ~ ${dates.at(-1) || '날짜 없음'}`;
      const months = [...new Set(data.records.map(r => r.date.slice(0, 7)))].sort();
      $('restore-totals').replaceChildren(node('p', `전체 ${months.length}개월 중 처음 12개월의 합계를 표시합니다. 복원은 모든 월에 적용합니다.`, 'small'), ...months.slice(0, 12).map(month => node('p', `${month} · 매수 ${krw(monthlyReview(investment, month).total.purchased_amount)} · 적립 ${krw(monthlyReview(investment, month).total.reserved_amount)} · 지출 ${krw(summarizeExpenses(expenses, month).total_expenses)}`, 'small')));
      $('restore-preview').hidden = false; message('백업 검증 완료. 미리보기와 복원 방법을 확인해 주세요. 아직 저장하지 않았습니다.');
    } catch (error) { if (version === fileRevision) { cancelPreview(); reportError(error); } }
  });
  $('cancel-restore').addEventListener('click', () => { cancelPreview(); message('복원을 취소했습니다. 기존 기록을 유지합니다.'); });
  $('apply-restore').addEventListener('click', () => {
    if (!preview || busy) return;
    try {
      const mode = document.querySelector('[name=restore-mode]:checked')?.value;
      const next = restoreRecords(snapshot.records, preview.records, mode);
      if (!confirm(`${mode === 'replace' ? '모든 월의 기존 기록을 전체 교체' : '기존 기록과 병합'}합니다. 결과 ${next.length}건. 진행할까요?`)) return;
      const incoming = preview;
      void write(() => restoreBackup(incoming.records, mode, incoming.revision), '복원 완료', () => forms.forEach(reset));
    } catch (error) { reportError(error); }
  });
  void readRecords().then(value => {
    snapshot = value; disable(false); message(`기기 저장소 준비됨 · ${snapshot.records.length}건 저장됨`); render();
    if (value.exists) onLoad(value.records);
  }).catch(error => { reportError(error); disable(true); });
  return { render };
}
