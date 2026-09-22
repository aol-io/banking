/* =============================================================
   MERIDIAN — Admin panel
   pages/admin/admin-transactions.js

   Boot sequence: requireAdmin() → initAdminLayout() → data load.
   Same table+drawer shape as admin-users.js, extended with:
     - sortable columns (amount / date)
     - combinable filters reflected in the URL (bookmarkable/shareable)
     - a filtered aggregate stat row (not a sum of the visible page)
     - CSV export of the current filtered result set
     - typed-confirmation reversal (REVERSE) — the highest-risk
       action in the panel, so it gets the strictest confirmation
       tier per the architecture doc's "typed-confirmation for the
       most dangerous actions" line.

   FIX LOG (this revision)
   ---------------------------
   - openDrawer()/closeDrawer() and openReverseModal()/
     closeReverseModal() only ever toggled aria-hidden. Both
     overlays' actual visibility is gated on the .is-open class
     (admin.css's .admin-drawer-overlay / .modal-overlay rules),
     which nothing here ever added — so "View" (and "Reverse this
     transaction") ran correctly and populated content, but the
     panel stayed invisible (opacity: 0; visibility: hidden). Fixed
     to toggle the `hidden` attribute + `.is-open` together, same
     pattern admin-approvals.js's modal already uses correctly.
   - The drawer's injected markup used .admin-drawer-section /
     .admin-detail-row, which admin-transactions.css never defines
     (that file defines .admin-tx-flow / .admin-tx-summary /
     .admin-tx-summary-field instead). Rewrote openDrawer() to
     render the sender→receiver flow + summary grid the CSS was
     actually built for.
   - statusPill() emitted .admin-status-pill--success/warning/
     danger/neutral, none of which exist anywhere in the shared or
     page CSS. Replaced with .admin-tx-status-chip--completed/
     processing/failed/reversed, which admin-transactions.css
     defines with real colors for this table's actual status set.
   - The reverse modal's markup used .modal-card in the HTML
     (renamed to .modal-panel there) — nothing to change here since
     this file never referenced that class directly, only the ids.
   ============================================================= */

import { requireAdmin, canAccess } from '../../assets/js/admin/admin-guard.js';
import { initAdminLayout } from '../../assets/js/admin/admin-layout.js';
import { listTransactions, getTransactionSummary, reverseTransaction } from '../../supabase/admin.js';
import { $, $$, debounce, formatTimestamp, formatCurrency, getQueryParam } from '../../assets/js/utils.js';

const PAGE_SIZE = 25;

const state = {
  admin: null,
  page: 1,
  total: 0,
  rows: [],
  sortField: 'created_at',
  sortDir: 'desc',
  filters: {
    search: getQueryParam('search') || '',
    status: getQueryParam('status') || '',
    currency: getQueryParam('currency') || '',
    from: getQueryParam('from') || '',
    to: getQueryParam('to') || '',
  },
  activeTx: null,
};

/* -----------------------------------------------------------
   Boot
   ----------------------------------------------------------- */
async function init() {
  const admin = await requireAdmin();
  if (!admin) return;

  state.admin = admin;
  initAdminLayout(admin, { pageTitle: 'Transactions' });

  applyFiltersToInputs();
  wireToolbar();
  wireSorting();
  wireDrawer();
  wireReverseModal();
  wireExport();

  await Promise.all([loadTransactions(), loadSummary()]);
}

function applyFiltersToInputs() {
  $('#tx-search').value = state.filters.search;
  $('#status-filter').value = state.filters.status;
  $('#currency-filter').value = state.filters.currency;
  $('#date-from').value = state.filters.from;
  $('#date-to').value = state.filters.to;
}

/* -----------------------------------------------------------
   Toolbar
   ----------------------------------------------------------- */
function wireToolbar() {
  $('#tx-search').addEventListener(
    'input',
    debounce((e) => {
      state.filters.search = e.target.value.trim();
      refresh();
    }, 300)
  );

  $('#status-filter').addEventListener('change', (e) => {
    state.filters.status = e.target.value;
    refresh();
  });

  $('#currency-filter').addEventListener('change', (e) => {
    state.filters.currency = e.target.value;
    refresh();
  });

  $('#date-from').addEventListener('change', (e) => {
    state.filters.from = e.target.value;
    refresh();
  });

  $('#date-to').addEventListener('change', (e) => {
    state.filters.to = e.target.value;
    refresh();
  });

  $('#clear-filters').addEventListener('click', () => {
    state.filters = { search: '', status: '', currency: '', from: '', to: '' };
    applyFiltersToInputs();
    refresh();
  });

  $('#tx-prev-page').addEventListener('click', () => {
    if (state.page > 1) {
      state.page -= 1;
      loadTransactions();
    }
  });

  $('#tx-next-page').addEventListener('click', () => {
    const maxPage = Math.max(1, Math.ceil(state.total / PAGE_SIZE));
    if (state.page < maxPage) {
      state.page += 1;
      loadTransactions();
    }
  });
}

function refresh() {
  state.page = 1;
  syncUrl();
  loadTransactions();
  loadSummary();
}

function syncUrl() {
  const params = new URLSearchParams();
  Object.entries(state.filters).forEach(([key, value]) => {
    if (value) params.set(key, value);
  });
  const query = params.toString();
  window.history.replaceState(null, '', query ? `?${query}` : window.location.pathname);
}

/* -----------------------------------------------------------
   Sorting
   ----------------------------------------------------------- */
function wireSorting() {
  $$('.is-sortable').forEach((th) => {
    th.addEventListener('click', () => {
      const field = th.dataset.sort;
      if (state.sortField === field) {
        state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc';
      } else {
        state.sortField = field;
        state.sortDir = 'desc';
      }
      $$('.is-sortable').forEach((h) => h.classList.remove('is-sorted-asc', 'is-sorted-desc'));
      th.classList.add(state.sortDir === 'asc' ? 'is-sorted-asc' : 'is-sorted-desc');
      loadTransactions();
    });
  });
}

/* -----------------------------------------------------------
   Load + render
   ----------------------------------------------------------- */
async function loadTransactions() {
  const tbody = $('#tx-table-body');
  const empty = $('#tx-empty');

  tbody.innerHTML = `<tr class="admin-table-skeleton-row"><td colspan="6">Loading transactions…</td></tr>`;
  empty.hidden = true;

  const { data, error } = await listTransactions({
    status: state.filters.status || undefined,
    currency: state.filters.currency || undefined,
    search: state.filters.search || undefined,
    from: state.filters.from || undefined,
    to: state.filters.to || undefined,
    sortField: state.sortField,
    sortDir: state.sortDir,
    page: state.page,
    pageSize: PAGE_SIZE,
  });

  if (error) {
    tbody.innerHTML = '';
    empty.hidden = false;
    empty.textContent = error;
    showToast(error, 'error');
    return;
  }

  state.rows = data.rows;
  state.total = data.total;
  renderTable();
  renderPagination();
  $('#tx-count').textContent = `${state.total} transaction${state.total === 1 ? '' : 's'}`;
}

async function loadSummary() {
  const { data, error } = await getTransactionSummary({
    status: state.filters.status || undefined,
    currency: state.filters.currency || undefined,
    search: state.filters.search || undefined,
    from: state.filters.from || undefined,
    to: state.filters.to || undefined,
  });

  if (error) return; // stat row just stays at "—" — non-fatal

  const primaryCurrency = state.filters.currency || Object.keys(data.volumeByCurrency)[0] || 'USD';
  const volume = data.volumeByCurrency[primaryCurrency] || 0;

  $('#stat-volume').textContent = formatCurrency(volume, primaryCurrency);
  $('#stat-count').textContent = data.count.toLocaleString('en-US');
  $('#stat-reversed').textContent = data.reversedCount.toLocaleString('en-US');
  $('#stat-processing').textContent = data.processingCount.toLocaleString('en-US');
}

function renderTable() {
  const tbody = $('#tx-table-body');
  const empty = $('#tx-empty');

  if (!state.rows.length) {
    tbody.innerHTML = '';
    empty.hidden = false;
    empty.textContent = 'No transactions match these filters.';
    return;
  }

  empty.hidden = true;
  tbody.innerHTML = state.rows
    .map(
      (row) => `
        <tr data-tx-row="${row.id}">
          <td><code>${escapeHtml(row.transaction_reference || '—')}</code></td>
          <td>${escapeHtml(row.transaction_type || '—')}</td>
          <td class="admin-table-amount ${Number(row.amount) < 0 ? 'neg' : 'pos'}">${formatCurrency(row.amount, row.currency)}</td>
          <td>${statusChip(row.status)}</td>
          <td>${formatTimestamp(row.created_at)}</td>
          <td class="admin-table-actions">
            <button type="button" class="btn btn-ghost btn-sm" data-open-tx="${row.id}">View</button>
          </td>
        </tr>`
    )
    .join('');

  $$('[data-open-tx]', tbody).forEach((btn) => {
    btn.addEventListener('click', () => openDrawer(rowById(btn.dataset.openTx)));
  });
}

function rowById(id) {
  return state.rows.find((r) => r.id === id);
}

function renderPagination() {
  const maxPage = Math.max(1, Math.ceil(state.total / PAGE_SIZE));
  $('#tx-page-indicator').textContent = `Page ${state.page} of ${maxPage}`;
  $('#tx-prev-page').disabled = state.page <= 1;
  $('#tx-next-page').disabled = state.page >= maxPage;
}

const STATUS_CHIP_TONES = {
  Completed: 'completed',
  Processing: 'processing',
  Failed: 'failed',
  Reversed: 'reversed',
};

function statusChip(status) {
  const tone = STATUS_CHIP_TONES[status] || 'reversed';
  return `<span class="admin-tx-status-chip admin-tx-status-chip--${tone}">${escapeHtml(status || 'Unknown')}</span>`;
}

/* -----------------------------------------------------------
   Drawer
   -----------------------------------------------------------
   .admin-drawer-overlay's visibility is entirely gated on the
   .is-open class (admin.css) — the `hidden` attribute is what
   removes it from the accessibility tree and layout between uses.
   Both must be toggled together, same as admin-approvals.js's
   modal (`modal.hidden = false; requestAnimationFrame(() =>
   modal.classList.add('is-open'))`).
   ----------------------------------------------------------- */
function wireDrawer() {
  $('#tx-drawer-close').addEventListener('click', closeDrawer);
  $('#tx-drawer-overlay').addEventListener('click', (e) => {
    if (e.target === $('#tx-drawer-overlay')) closeDrawer();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('#tx-drawer-overlay').hidden) closeDrawer();
  });
}

function closeDrawer() {
  const overlay = $('#tx-drawer-overlay');
  overlay.classList.remove('is-open');
  overlay.setAttribute('aria-hidden', 'true');
  setTimeout(() => {
    overlay.hidden = true;
  }, 200); // matches admin.css's overlay/drawer transition duration
  state.activeTx = null;
}

function openDrawer(tx) {
  if (!tx) return;
  state.activeTx = tx;

  const overlay = $('#tx-drawer-overlay');
  overlay.hidden = false;
  requestAnimationFrame(() => overlay.classList.add('is-open'));
  overlay.setAttribute('aria-hidden', 'false');

  $('#tx-drawer-title').textContent = tx.transaction_reference || 'Transaction';
  $('#tx-drawer-subtitle').textContent = formatTimestamp(tx.created_at);

  const canReverse =
    canAccess(state.admin.profile, ['admin', 'superadmin']) &&
    tx.status !== 'Reversed' &&
    !tx.reversed_by;

  $('#tx-drawer-body').innerHTML = `
    <div class="admin-tx-flow">
      <div class="admin-tx-flow-party">
        <span>Sender account</span>
        <strong>${escapeHtml(tx.sender_account || 'External')}</strong>
      </div>
      <span class="admin-tx-flow-arrow">
        <svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M4 10h12M12 5l5 5-5 5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </span>
      <div class="admin-tx-flow-party admin-tx-flow-party--receiver">
        <span>Receiver account</span>
        <strong>${escapeHtml(tx.receiver_account || 'External')}</strong>
      </div>
    </div>

    <div class="admin-tx-summary">
      <div class="admin-tx-summary-field admin-tx-summary-field--amount">
        <span>Amount</span>
        <p>${formatCurrency(tx.amount, tx.currency)}</p>
      </div>
      <div class="admin-tx-summary-field">
        <span>Fee</span>
        <p>${formatCurrency(tx.fee, tx.currency)}</p>
      </div>
      <div class="admin-tx-summary-field">
        <span>Type</span>
        <p>${escapeHtml(tx.transaction_type || '—')}</p>
      </div>
      <div class="admin-tx-summary-field">
        <span>Status</span>
        <p>${statusChip(tx.status)}</p>
      </div>
      <div class="admin-tx-summary-field" style="grid-column: 1 / -1;">
        <span>Description</span>
        <p>${escapeHtml(tx.description || '—')}</p>
      </div>
    </div>

    ${
      canReverse
        ? `<div class="admin-drawer-footer-actions">
            <button type="button" class="btn btn-danger" id="drawer-reverse-btn">Reverse this transaction</button>
            <p class="admin-drawer-footer-note">This creates an offsetting entry and cannot be undone.</p>
          </div>`
        : ''
    }
  `;

  if (canReverse) {
    $('#drawer-reverse-btn').addEventListener('click', () => openReverseModal(tx));
  }
}

/* -----------------------------------------------------------
   Reverse modal — typed confirmation
   ----------------------------------------------------------- */
function wireReverseModal() {
  const overlay = $('#reverse-modal');
  $$('[data-close-modal]', overlay).forEach((btn) => btn.addEventListener('click', closeReverseModal));
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeReverseModal();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !overlay.hidden) closeReverseModal();
  });

  $('#reverse-confirm-text').addEventListener('input', (e) => {
    $('#reverse-modal-submit').disabled = e.target.value.trim().toUpperCase() !== 'REVERSE';
  });

  $('#reverse-modal-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const tx = state.activeTx;
    if (!tx) return;

    const reason = $('#reverse-reason').value.trim();
    const errorEl = $('#reverse-modal-error');

    if (!reason) {
      errorEl.textContent = 'A reason is required.';
      errorEl.style.display = 'block';
      return;
    }

    const submitBtn = $('#reverse-modal-submit');
    submitBtn.disabled = true;
    submitBtn.textContent = 'Reversing…';

    const { error } = await reverseTransaction(tx.id, reason);

    submitBtn.textContent = 'Reverse transaction';

    if (error) {
      errorEl.textContent = error;
      errorEl.style.display = 'block';
      submitBtn.disabled = false;
      return;
    }

    showToast('Transaction reversed.', 'success');
    closeReverseModal();
    closeDrawer();
    await Promise.all([loadTransactions(), loadSummary()]);
  });
}

function openReverseModal(tx) {
  state.activeTx = tx;
  $('#reverse-reason').value = '';
  $('#reverse-confirm-text').value = '';
  $('#reverse-modal-submit').disabled = true;
  $('#reverse-modal-error').style.display = 'none';

  const overlay = $('#reverse-modal');
  overlay.hidden = false;
  requestAnimationFrame(() => overlay.classList.add('is-open'));
  overlay.setAttribute('aria-hidden', 'false');
}

function closeReverseModal() {
  const overlay = $('#reverse-modal');
  overlay.classList.remove('is-open');
  overlay.setAttribute('aria-hidden', 'true');
  setTimeout(() => {
    overlay.hidden = true;
  }, 200);
}

/* -----------------------------------------------------------
   CSV export — current filtered set, not just the visible page.
   Pages through listTransactions() at a larger page size rather
   than adding a second server-side "export" endpoint.
   ----------------------------------------------------------- */
function wireExport() {
  $('#export-csv').addEventListener('click', async () => {
    const btn = $('#export-csv');
    btn.disabled = true;
    btn.textContent = 'Exporting…';

    const rows = [];
    let page = 1;
    const exportPageSize = 500;
    // Hard ceiling so a runaway filter (or lack thereof) can't hang
    // the tab pulling the entire ledger — 20 pages @ 500 = 10k rows.
    const maxPages = 20;

    while (page <= maxPages) {
      const { data, error } = await listTransactions({
        status: state.filters.status || undefined,
        currency: state.filters.currency || undefined,
        search: state.filters.search || undefined,
        from: state.filters.from || undefined,
        to: state.filters.to || undefined,
        sortField: state.sortField,
        sortDir: state.sortDir,
        page,
        pageSize: exportPageSize,
      });
      if (error || !data.rows.length) break;
      rows.push(...data.rows);
      if (rows.length >= data.total) break;
      page += 1;
    }

    downloadCsv(rows);
    btn.disabled = false;
    btn.innerHTML = `<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M8 2v8m0 0 3-3m-3 3-3-3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/><path d="M3 12v1.5A1.5 1.5 0 0 0 4.5 15h7a1.5 1.5 0 0 0 1.5-1.5V12" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg> Export CSV`;
  });
}

function downloadCsv(rows) {
  const headers = ['reference', 'type', 'amount', 'fee', 'currency', 'status', 'created_at'];
  const lines = [headers.join(',')];

  rows.forEach((r) => {
    const line = [
      r.transaction_reference || '',
      r.transaction_type || '',
      r.amount,
      r.fee,
      r.currency,
      r.status,
      r.created_at,
    ]
      .map((v) => `"${String(v).replace(/"/g, '""')}"`)
      .join(',');
    lines.push(line);
  });

  const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `meridian-transactions-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/* -----------------------------------------------------------
   Small helpers
   ----------------------------------------------------------- */
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function showToast(message, type = 'info') {
  const stack = $('#toast-stack');
  if (!stack) return;
  const toast = document.createElement('div');
  toast.className = `toast toast--${type}`;
  toast.textContent = message;
  stack.appendChild(toast);
  setTimeout(() => toast.remove(), 4000);
}

init();
