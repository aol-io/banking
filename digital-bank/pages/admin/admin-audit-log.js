/* =============================================================
   MERIDIAN — Admin panel
   pages/admin/admin-audit-log.js

   Standalone audit trail page — extracted from the "Audit trail"
   tab inside admin-approvals.js so it has its own dedicated URL
   (admin-navbar.html already links here: the sidebar's "Audit log"
   entry and the user dropdown's "My recent actions" shortcut).

   admin-approvals.js's own Audit trail tab is left as-is for now
   (not removed) — see the note in that file's own header if/when
   it's retired in favor of this page.

   Logic here is a near-verbatim port of admin-approvals.js's
   initAuditFilters() / getAuditFilters() / formatMetadata() /
   loadAuditLog() / exportAuditCsv(), minus the tab-visibility gate
   (that block used to only load audit data the first time the
   Audit trail tab was clicked — here it just loads on page load).
   ============================================================= */

import { requireAdmin } from '../../assets/js/admin/admin-guard.js';
import { initAdminLayout } from '../../assets/js/admin/admin-layout.js';
import { listAdminAuditLog, getAuditFilterOptions } from '../../supabase/admin.js';

const $ = (selector, scope) => (scope || document).querySelector(selector);
const $$ = (selector, scope) => Array.from((scope || document).querySelectorAll(selector));

let auditPage = 0;
const AUDIT_PAGE_SIZE = 25;

/* -----------------------------------------------------------
   Toast — same shape as admin-approvals.js's showToast(), reusing
   the .profile-toast-region container already in this page's HTML.
   ----------------------------------------------------------- */
function showToast(message, type = 'success') {
  const region = $('.profile-toast-region');
  if (!region) return;
  const toast = document.createElement('div');
  toast.className = `profile-toast profile-toast--${type}`;
  toast.textContent = message;
  region.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add('is-visible'));
  setTimeout(() => {
    toast.classList.remove('is-visible');
    setTimeout(() => toast.remove(), 250);
  }, 3600);
}

/* -----------------------------------------------------------
   Filters
   ----------------------------------------------------------- */
async function initAuditFilters() {
  const { data } = await getAuditFilterOptions();
  const adminSelect = $('#audit-admin-filter');
  const actionSelect = $('#audit-action-filter');

  data.admins.forEach((a) => {
    const opt = document.createElement('option');
    opt.value = a.id;
    opt.textContent = `${a.first_name} ${a.last_name}`;
    adminSelect.appendChild(opt);
  });

  data.actions.forEach((action) => {
    const opt = document.createElement('option');
    opt.value = action;
    opt.textContent = action;
    actionSelect.appendChild(opt);
  });

  [adminSelect, actionSelect, $('#audit-from-date'), $('#audit-to-date')].forEach((el) => {
    el.addEventListener('change', () => { auditPage = 0; loadAuditLog(); });
  });

  let searchDebounce;
  $('#audit-reason-search').addEventListener('input', () => {
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => { auditPage = 0; loadAuditLog(); }, 300);
  });

  $('#audit-prev-page').addEventListener('click', () => { if (auditPage > 0) { auditPage -= 1; loadAuditLog(); } });
  $('#audit-next-page').addEventListener('click', () => { auditPage += 1; loadAuditLog(); });

  $('#audit-export-btn').addEventListener('click', exportAuditCsv);
}

function getAuditFilters() {
  const adminId = $('#audit-admin-filter').value;
  const action = $('#audit-action-filter').value;
  return {
    adminId: adminId && adminId !== 'all' ? adminId : undefined,
    action: action && action !== 'all' ? action : undefined,
    from: $('#audit-from-date').value || undefined,
    to: $('#audit-to-date').value ? `${$('#audit-to-date').value}T23:59:59` : undefined,
    search: $('#audit-reason-search').value.trim() || undefined,
  };
}

function formatMetadata(metadata) {
  if (!metadata || (typeof metadata === 'object' && !Object.keys(metadata).length)) return '—';
  const str = JSON.stringify(metadata);
  return str.length > 60 ? `${str.slice(0, 60)}…` : str;
}

/* -----------------------------------------------------------
   Load + render
   ----------------------------------------------------------- */
async function loadAuditLog() {
  const body = $('#audit-log-body');
  const empty = $('#audit-log-empty');
  body.innerHTML = '<tr class="admin-table-skeleton-row"><td colspan="6"><div class="skeleton"></div></td></tr>'.repeat(4);
  empty.hidden = true;

  const { data, error } = await listAdminAuditLog({
    ...getAuditFilters(),
    page: auditPage + 1,
    pageSize: AUDIT_PAGE_SIZE,
  });

  if (error) { showToast(error, 'error'); body.innerHTML = ''; empty.hidden = false; return; }
  if (!data.rows.length) { body.innerHTML = ''; empty.hidden = false; return; }

  body.innerHTML = data.rows.map((row) => `
    <tr>
      <td>${new Date(row.created_at).toLocaleString('en-US')}</td>
      <td>${row.admin ? `${row.admin.first_name} ${row.admin.last_name}` : '—'}</td>
      <td>${row.action}</td>
      <td class="mono">${row.target_table || '—'}${row.target_id ? ` #${String(row.target_id).slice(0, 8)}` : ''}</td>
      <td class="mono">${formatMetadata(row.metadata)}</td>
      <td>${row.reason || '—'}</td>
    </tr>
  `).join('');

  $('#audit-page-indicator').textContent = `Page ${auditPage + 1}`;
  $('#audit-prev-page').disabled = auditPage === 0;
  $('#audit-next-page').disabled = (auditPage + 1) * AUDIT_PAGE_SIZE >= data.total;
}

async function exportAuditCsv() {
  const { data, error } = await listAdminAuditLog({ ...getAuditFilters(), page: 1, pageSize: 5000 });
  if (error || !data.rows.length) { showToast('Nothing to export for these filters.', 'error'); return; }

  const escape = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const header = ['Timestamp', 'Administrator', 'Action', 'Target table', 'Target ID', 'Metadata', 'Reason'];
  const lines = [header.map(escape).join(',')];
  data.rows.forEach((row) => {
    lines.push([
      new Date(row.created_at).toLocaleString('en-US'),
      row.admin ? `${row.admin.first_name} ${row.admin.last_name}` : '',
      row.action,
      row.target_table || '',
      row.target_id || '',
      row.metadata ? JSON.stringify(row.metadata) : '',
      row.reason || '',
    ].map(escape).join(','));
  });

  const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `meridian-audit-log-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

/* -----------------------------------------------------------
   Init
   ----------------------------------------------------------- */
(async function init() {
  const admin = await requireAdmin();
  if (!admin) return;

  await initAdminLayout(admin, { pageTitle: 'Audit Log' });

  await initAuditFilters();
  await loadAuditLog();
})();
