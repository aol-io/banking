/* =============================================================
   MERIDIAN — Admin panel
   pages/admin/admin-kyc.js

   Boot sequence: requireAdmin() → initAdminLayout() → data load.

   The queue is now document-based: one row per identity_documents
   row with status = 'pending'. Reviewing opens a drawer with the
   submitted details (checked against the applicant's profile), a
   private preview of the uploaded file, and the applicant's other
   submissions. Every outcome goes through one server-side function,
   admin_process_identity_document() (see admin-kyc-setup.sql), so
   this page never writes status, slot, tier or account status itself.
   It wraps the existing admin_review_identity_document() and, for a
   verification, also raises the tier and activates the account:

     verified         → the reviewer confirms name / ID number / DOB /
                        gender (saved on the record), identity docs
                        take the next Linked ID slot, tier is raised,
                        pending accounts are activated (BVN and
                        identity documents only)
     action_required  → reason required, applicant should fix and
                        resubmit
     rejected         → reason required

   Depends on four helpers added to supabase/admin.js — see
   admin-identity-additions.js.

   FIX LOG
   -------
   - openDrawer()/closeDrawer(): admin.css's drawer visibility rules
     (.admin-drawer-overlay / .admin-drawer-overlay.is-open) key off
     an `.is-open` class, not the `aria-hidden` attribute. This file
     was only ever toggling `aria-hidden`, so the drawer was built
     and populated correctly but stayed permanently
     opacity:0/visibility:hidden — no console error, nothing visible.
     Now toggles `.is-open` alongside `aria-hidden` (kept for a11y).
   ============================================================= */

import { requireAdmin, canAccess } from '../../assets/js/admin/admin-guard.js';
import { initAdminLayout } from '../../assets/js/admin/admin-layout.js';
import {
  listPendingIdentityDocuments,
  getIdentityDocumentsForUser,
  getIdentityDocumentUrl,
  getUserDetail,
  reviewIdentityDocument,
} from '../../supabase/admin.js';
import { $, $$, debounce, getInitials, formatTimestamp } from '../../assets/js/utils.js';

const PAGE_SIZE = 25;

const DOCUMENT_LABELS = {
  bvn: 'Bank Verification Number (BVN)',
  nin: 'National ID number (NIN)',
  drivers_license: "Driver's license",
  passport: 'International passport',
  voters_card: "Voter's card",
  electricity_bill: 'Electricity bill',
  bank_statement: 'Bank statement',
  waste_bill: 'Waste bill',
  water_bill: 'Water bill',
  house_rent_receipt: 'House rent receipt',
  tenancy_agreement: 'Tenancy agreement',
  land_use_charge: 'Land Use Charge document',
};

// tier mirrors the mapping in admin_review_identity_document()
const CATEGORY_META = {
  bvn: { label: 'BVN', tier: 1, chip: 'bvn' },
  identity: { label: 'Identity', tier: 2, chip: 'identity' },
  proof_of_address: { label: 'Address', tier: 3, chip: 'address' },
};

const STATUS_META = {
  pending: { label: 'Pending', tone: 'warning' },
  verified: { label: 'Verified', tone: 'success' },
  rejected: { label: 'Rejected', tone: 'danger' },
  action_required: { label: 'Action required', tone: 'info' },
};

const GENDER_LABELS = { female: 'Female', male: 'Male', nonbinary: 'Non-binary' };

const DECISIONS = {
  verified: {
    title: 'Verify document',
    lede: 'Confirm the document is genuine and matches the applicant.',
    submit: 'Verify',
    busy: 'Verifying…',
    submitClass: 'btn-primary',
    reason: 'optional',
    reasonLabel: 'Note (optional)',
    placeholder: 'Recorded with the review',
    defaultReason: 'Document verified',
    details: true,
    toast: 'Document verified.',
    // Mirrors admin_process_identity_document() in admin-kyc-setup.sql
    effect: (doc) => {
      const category = doc.document_category;
      const meta = CATEGORY_META[category];
      const parts = [`Raises the account to at least Tier ${meta ? meta.tier : '—'}.`];
      if (category === 'identity') parts.push('Uses the next free Linked ID slot.');
      if (category === 'bvn' || category === 'identity') parts.push('Activates the account if it is still pending.');
      return parts.join(' ');
    },
  },
  action_required: {
    title: 'Request changes',
    lede: 'Ask the applicant to fix this document and submit it again.',
    submit: 'Request changes',
    busy: 'Sending…',
    submitClass: 'btn-primary',
    reason: 'required',
    reasonLabel: 'What needs to change?',
    placeholder: 'For example: the photo is blurry, please upload a clearer copy',
    toast: 'Changes requested.',
    effect: () => 'The account’s tier and status stay as they are.',
  },
  rejected: {
    title: 'Reject document',
    lede: 'The applicant can submit a different document afterwards.',
    submit: 'Reject',
    busy: 'Rejecting…',
    submitClass: 'btn-danger',
    reason: 'required',
    reasonLabel: 'Reason',
    placeholder: 'Required — recorded with the review and cannot be blank',
    toast: 'Document rejected.',
    effect: () => 'The account’s tier and status stay as they are.',
  },
};

const state = {
  admin: null,
  page: 1,
  total: 0,
  rows: [],
  search: '',
  category: '',
  activeDocId: null,
  activeUserId: null,
  activeDoc: null,
  activeName: '',
  pendingDecision: null,
};

let loadToken = 0;
let lastFocused = null;

/* -----------------------------------------------------------
   Boot
   ----------------------------------------------------------- */
async function init() {
  const admin = await requireAdmin();
  if (!admin) return;

  state.admin = admin;
  initAdminLayout(admin, { pageTitle: 'KYC queue' });

  wireToolbar();
  wireDrawer();
  wireDecisionModal();
  wireKeyboard();

  await loadQueue();
}

/* -----------------------------------------------------------
   Toolbar
   ----------------------------------------------------------- */
function wireToolbar() {
  $('#kyc-search').addEventListener(
    'input',
    debounce((e) => {
      state.search = e.target.value.trim();
      state.page = 1;
      loadQueue();
    }, 300)
  );

  $('#kyc-category').addEventListener('change', (e) => {
    state.category = e.target.value;
    state.page = 1;
    loadQueue();
  });

  $('#kyc-prev-page').addEventListener('click', () => {
    if (state.page > 1) {
      state.page -= 1;
      loadQueue();
    }
  });

  $('#kyc-next-page').addEventListener('click', () => {
    const maxPage = Math.max(1, Math.ceil(state.total / PAGE_SIZE));
    if (state.page < maxPage) {
      state.page += 1;
      loadQueue();
    }
  });

  $('#kyc-table-body').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-open-kyc]');
    if (btn) {
      lastFocused = btn;
      openDrawer(btn.dataset.openKyc);
    }
  });
}

/* -----------------------------------------------------------
   Load + render the queue
   ----------------------------------------------------------- */
async function loadQueue() {
  const token = ++loadToken;
  const tbody = $('#kyc-table-body');
  const empty = $('#kyc-empty');

  tbody.innerHTML = `<tr class="admin-table-skeleton-row"><td colspan="5">Loading queue…</td></tr>`;
  empty.hidden = true;

  const { data, error } = await listPendingIdentityDocuments({
    search: state.search || undefined,
    category: state.category || undefined,
    page: state.page,
    pageSize: PAGE_SIZE,
  });

  // A newer request started while this one was in flight — drop this result.
  if (token !== loadToken) return;

  if (error) {
    tbody.innerHTML = '';
    empty.hidden = false;
    empty.textContent = error;
    showToast(error, 'error');
    return;
  }

  // The last row of the last page was just decided — step back a page.
  if (!data.rows.length && data.total > 0 && state.page > 1) {
    state.page = Math.max(1, Math.ceil(data.total / PAGE_SIZE));
    return loadQueue();
  }

  state.rows = data.rows;
  state.total = data.total;
  renderTable();
  renderPagination();
  renderSummary();
  $('#kyc-count').textContent = `${state.total} waiting`;
}

function renderSummary() {
  $('#stat-pending').textContent = state.total.toLocaleString('en-US');
  const oldest = state.page === 1 ? state.rows[0] : null;
  $('#stat-oldest').textContent = oldest ? formatTimestamp(oldest.submitted_at) : state.total ? '—' : 'None';
}

function renderTable() {
  const tbody = $('#kyc-table-body');
  const empty = $('#kyc-empty');

  if (!state.rows.length) {
    tbody.innerHTML = '';
    empty.hidden = false;
    empty.textContent = state.search || state.category ? 'No documents match this filter.' : 'The queue is empty.';
    return;
  }

  empty.hidden = true;
  tbody.innerHTML = state.rows
    .map((row) => {
      const name = applicantName(row.applicant);
      const typeLabel = DOCUMENT_LABELS[row.document_type] || row.document_type || '—';
      return `
        <tr data-kyc-row="${escapeHtml(row.id)}">
          <td>
            <div class="admin-table-identity">
              <span class="avatar-initial avatar-initial--sm">${escapeHtml(getInitials(name))}</span>
              <span>${escapeHtml(name)}</span>
            </div>
          </td>
          <td>${escapeHtml(row.applicant?.email || '—')}</td>
          <td>
            <div class="kyc-doc-cell">
              <span class="kyc-doc-name">${escapeHtml(typeLabel)}</span>
              ${categoryChip(row.document_category)}
            </div>
          </td>
          <td>${formatTimestamp(row.submitted_at)}</td>
          <td class="admin-table-actions">
            <button type="button" class="btn btn-ghost btn-sm" data-open-kyc="${escapeHtml(row.id)}">Review</button>
          </td>
        </tr>`;
    })
    .join('');
}

function renderPagination() {
  const maxPage = Math.max(1, Math.ceil(state.total / PAGE_SIZE));
  $('#kyc-page-indicator').textContent = `Page ${state.page} of ${maxPage}`;
  $('#kyc-prev-page').disabled = state.page <= 1;
  $('#kyc-next-page').disabled = state.page >= maxPage;
}

/* -----------------------------------------------------------
   Review drawer
   ----------------------------------------------------------- */
function wireDrawer() {
  $('#kyc-drawer-close').addEventListener('click', closeDrawer);
  $('#kyc-drawer-overlay').addEventListener('click', (e) => {
    if (e.target === $('#kyc-drawer-overlay')) closeDrawer();
  });
}

function closeDrawer() {
  const overlay = $('#kyc-drawer-overlay');
  overlay.classList.remove('is-open');
  overlay.setAttribute('aria-hidden', 'true');
  state.activeDocId = null;
  state.activeUserId = null;
  state.activeDoc = null;
  if (lastFocused && document.contains(lastFocused)) lastFocused.focus();
}

async function openDrawer(docId) {
  const row = state.rows.find((r) => String(r.id) === String(docId));
  if (!row) return;

  state.activeDocId = row.id;
  state.activeUserId = row.user_id;

  const name = applicantName(row.applicant);
  $('#kyc-drawer-title').textContent = name;
  $('#kyc-drawer-subtitle').textContent = row.applicant?.email || '—';
  $('#kyc-drawer-avatar').textContent = getInitials(name);
  $('#kyc-drawer-body').innerHTML = `<p class="kyc-hint">Loading…</p>`;

  const overlay = $('#kyc-drawer-overlay');
  overlay.classList.add('is-open');
  overlay.setAttribute('aria-hidden', 'false');
  $('#kyc-drawer-close').focus();

  const [detail, docsResult] = await Promise.all([
    getUserDetail(row.user_id),
    getIdentityDocumentsForUser(row.user_id),
  ]);

  // Drawer was closed or switched to another document while loading.
  if (state.activeDocId !== row.id) return;

  const loadError = detail.error || docsResult.error;
  if (loadError) {
    $('#kyc-drawer-body').innerHTML = `<p class="kyc-modal-error">${escapeHtml(loadError)}</p>`;
    return;
  }

  const doc = (docsResult.data || []).find((d) => String(d.id) === String(row.id));
  if (!doc) {
    $('#kyc-drawer-body').innerHTML = `<p class="kyc-modal-error">This document no longer exists. Refresh the queue.</p>`;
    return;
  }

  renderDrawer({ profile: detail.data.profile, doc, docs: docsResult.data });
}

function renderDrawer({ profile, doc, docs }) {
  const fullName = applicantName(profile);
  const category = doc.document_category;
  const meta = CATEGORY_META[category] || { label: category, tier: null };
  const typeLabel = DOCUMENT_LABELS[doc.document_type] || doc.document_type || '—';
  const isPending = doc.status === 'pending';
  const canDecide = canAccess(state.admin.profile, ['admin', 'superadmin']);
  const others = docs.filter((d) => String(d.id) !== String(doc.id));

  state.activeDoc = doc;
  state.activeName = fullName;

  $('#kyc-drawer-title').textContent = fullName;
  $('#kyc-drawer-subtitle').textContent = profile.email || '—';
  $('#kyc-drawer-avatar').textContent = getInitials(fullName);

  /* ---- Document ---- */
  const documentSection = `
    <section class="admin-drawer-section">
      <h4>Document</h4>
      ${detailRow('Type', escapeHtml(typeLabel))}
      ${detailRow('Category', `${categoryChip(category)}${meta.tier ? `<span class="kyc-detail-sub">Counts toward Tier ${meta.tier}</span>` : ''}`)}
      ${detailRow('Status', statusPill(doc.status))}
      ${detailRow('Submitted', escapeHtml(formatTimestamp(doc.submitted_at)))}
      ${!isPending && doc.reviewed_at ? detailRow('Reviewed', escapeHtml(formatTimestamp(doc.reviewed_at))) : ''}
      ${doc.rejection_reason ? detailRow('Reason', escapeHtml(doc.rejection_reason)) : ''}
    </section>`;

  /* ---- Submitted details (BVN + identity) or profile address (proof of address) ---- */
  let detailsSection = '';
  if (category === 'bvn' || category === 'identity') {
    const nameCheck = namesMatch(doc.full_name, fullName);
    const dobCheck = datesMatch(doc.date_of_birth, profile.date_of_birth);
    const genderCheck = doc.gender && profile.gender ? doc.gender === profile.gender : null;

    const idNumberHtml = doc.id_number
      ? `<span class="kyc-secret-line"><span class="kyc-secret" id="kyc-id-number">${escapeHtml(maskSecret(doc.id_number))}</span><button type="button" class="kyc-link-btn" id="kyc-reveal-id" aria-pressed="false" aria-controls="kyc-id-number">Reveal</button></span>`
      : '—';

    detailsSection = `
      <section class="admin-drawer-section">
        <h4>Details the applicant entered</h4>
        ${detailRow('Full name', escapeHtml(doc.full_name || '—'), checkMark(nameCheck, fullName))}
        ${detailRow('ID number', idNumberHtml)}
        ${detailRow('Date of birth', escapeHtml(doc.date_of_birth || '—'), checkMark(dobCheck, profile.date_of_birth))}
        ${detailRow('Gender', escapeHtml(GENDER_LABELS[doc.gender] || doc.gender || '—'), checkMark(genderCheck, GENDER_LABELS[profile.gender] || profile.gender))}
        <p class="kyc-hint">${
          category === 'bvn'
            ? 'BVN submissions have no file. Check the number against your BVN lookup provider before verifying.'
            : 'Compare these details with the document below.'
        }</p>
      </section>`;
  } else {
    const addressLine = [profile.address, profile.city, profile.state, profile.postal_code, profile.country]
      .filter(Boolean)
      .join(', ');
    detailsSection = `
      <section class="admin-drawer-section">
        <h4>Address on profile</h4>
        ${detailRow('Name', escapeHtml(fullName))}
        ${detailRow('Address', escapeHtml(addressLine || '—'))}
        <p class="kyc-hint">The name and address on the document should match the profile.</p>
      </section>`;
  }

  /* ---- File ---- */
  const fileSection = doc.file_path
    ? `<section class="admin-drawer-section">
         <h4>File</h4>
         <div class="kyc-file-panel">
           <div class="kyc-file-actions">
             <button type="button" class="btn btn-ghost btn-sm" id="kyc-file-btn">View document</button>
             <span class="kyc-file-note">Opens a private link that expires in 5 minutes.</span>
           </div>
           <div id="kyc-file-view"></div>
         </div>
       </section>`
    : '';

  /* ---- Applicant ---- */
  const applicantSection = `
    <section class="admin-drawer-section">
      <h4>Applicant</h4>
      ${detailRow('Phone', escapeHtml(profile.phone || '—'))}
      ${detailRow('Nationality', escapeHtml(profile.nationality || '—'))}
      ${detailRow('Country', escapeHtml(profile.country || '—'))}
      ${detailRow('Account status', escapeHtml(profile.account_status || '—'))}
      ${detailRow('Tier', escapeHtml(profile.account_tier != null ? `Tier ${profile.account_tier}` : '—'))}
      ${detailRow('Joined', escapeHtml(formatTimestamp(profile.created_at)))}
    </section>`;

  /* ---- Other submissions ---- */
  const othersSection = `
    <section class="admin-drawer-section">
      <h4>Other submissions</h4>
      ${
        others.length
          ? `<ul class="kyc-doc-list">${others
              .map(
                (d) => `
              <li>
                <div class="kyc-doc-list-meta">
                  <strong>${escapeHtml(DOCUMENT_LABELS[d.document_type] || d.document_type || '—')}</strong>
                  <span>${escapeHtml(formatTimestamp(d.submitted_at))}</span>
                </div>
                ${statusPill(d.status)}
              </li>`
              )
              .join('')}</ul>`
          : `<p class="kyc-hint">No other submissions from this applicant.</p>`
      }
    </section>`;

  /* ---- Actions ---- */
  let footer;
  if (!isPending) {
    const label = (STATUS_META[doc.status]?.label || doc.status || 'reviewed').toLowerCase();
    footer = `<p class="kyc-hint">This document is no longer pending (${escapeHtml(label)}), so it can’t be decided here.</p>`;
  } else if (!canDecide) {
    footer = `<p class="kyc-hint">Your role can review documents but not decide them.</p>`;
  } else {
    footer = `
      <div class="admin-drawer-footer">
        <button type="button" class="btn btn-ghost" id="drawer-reject-btn">Reject</button>
        <button type="button" class="btn btn-ghost" id="drawer-changes-btn">Request changes</button>
        <button type="button" class="btn btn-primary" id="drawer-verify-btn">Verify</button>
      </div>`;
  }

  $('#kyc-drawer-body').innerHTML = documentSection + detailsSection + fileSection + applicantSection + othersSection + footer;

  const revealBtn = $('#kyc-reveal-id');
  if (revealBtn) {
    revealBtn.addEventListener('click', () => {
      const showing = revealBtn.getAttribute('aria-pressed') === 'true';
      $('#kyc-id-number').textContent = showing ? maskSecret(doc.id_number) : doc.id_number;
      revealBtn.setAttribute('aria-pressed', String(!showing));
      revealBtn.textContent = showing ? 'Reveal' : 'Hide';
    });
  }

  const fileBtn = $('#kyc-file-btn');
  if (fileBtn) fileBtn.addEventListener('click', () => loadFile(doc));

  if (isPending && canDecide) {
    $('#drawer-verify-btn').addEventListener('click', () => openDecisionModal('verified'));
    $('#drawer-changes-btn').addEventListener('click', () => openDecisionModal('action_required'));
    $('#drawer-reject-btn').addEventListener('click', () => openDecisionModal('rejected'));
  }
}

async function loadFile(doc) {
  const btn = $('#kyc-file-btn');
  const view = $('#kyc-file-view');
  if (!btn || !view) return;

  btn.disabled = true;
  btn.textContent = 'Loading…';

  const { data: url, error } = await getIdentityDocumentUrl(doc.file_path);

  // Drawer moved on to another document while the link was being created.
  if (state.activeDocId !== doc.id) return;

  btn.disabled = false;
  btn.textContent = 'View document';

  if (error || !url) {
    view.innerHTML = `<p class="kyc-modal-error">${escapeHtml(error || 'Could not open this file.')}</p>`;
    return;
  }

  const ext = String(doc.file_path).split('?')[0].split('.').pop().toLowerCase();
  const typeLabel = DOCUMENT_LABELS[doc.document_type] || 'document';

  if (['jpg', 'jpeg', 'png'].includes(ext)) {
    view.innerHTML = `
      <a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">
        <img class="kyc-file-image" src="${escapeHtml(url)}" alt="Submitted ${escapeHtml(typeLabel)}">
      </a>`;
  } else {
    view.innerHTML = `<a class="btn btn-ghost btn-sm" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">Open PDF in a new tab</a>`;
  }
}

/* -----------------------------------------------------------
   Decision modal (verify / request changes / reject)
   ----------------------------------------------------------- */
function wireDecisionModal() {
  const overlay = $('#decision-modal');
  $$('[data-close-modal]', overlay).forEach((btn) => btn.addEventListener('click', closeDecisionModal));
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeDecisionModal();
  });

  $('#decision-modal-form').addEventListener('submit', async (e) => {
    e.preventDefault();

    const decision = state.pendingDecision;
    const cfg = DECISIONS[decision];
    if (!cfg || !state.activeDocId) return;

    let reason = $('#decision-modal-reason').value.trim();

    if (cfg.reason === 'required' && !reason) {
      showModalError('A reason is required.');
      return;
    }
    // The database requires a reason for every decision, so a blank
    // verification note falls back to a default.
    if (!reason) reason = cfg.defaultReason || '';

    let details = {};
    if (needsDetails(cfg, state.activeDoc)) {
      details = {
        fullName: $('#decision-full-name').value.trim(),
        idNumber: $('#decision-id-number').value.trim(),
        dateOfBirth: $('#decision-dob').value,
        gender: $('#decision-gender').value,
      };
      if (!details.fullName || !details.idNumber) {
        showModalError('Full name and ID number are required to verify this document.');
        return;
      }
    }

    const submitBtn = $('#decision-modal-submit');
    submitBtn.disabled = true;
    submitBtn.textContent = cfg.busy;
    hideModalError();

    const { error } = await reviewIdentityDocument(state.activeDocId, decision, reason, details);

    submitBtn.disabled = false;
    submitBtn.textContent = cfg.submit;

    if (error) {
      showModalError(error);
      return;
    }

    showToast(cfg.toast, 'success');
    closeDecisionModal();
    closeDrawer();
    await loadQueue();
  });
}

function openDecisionModal(decision) {
  const cfg = DECISIONS[decision];
  const doc = state.activeDoc;
  if (!cfg || !doc) return;

  state.pendingDecision = decision;

  $('#decision-modal-title').textContent = cfg.title;
  $('#decision-modal-lede').textContent = cfg.lede;
  $('#decision-modal-applicant').textContent = state.activeName || '—';
  $('#decision-modal-document').textContent = DOCUMENT_LABELS[doc.document_type] || doc.document_type || '—';
  $('#decision-modal-effect').textContent = cfg.effect(doc);

  const reasonInput = $('#decision-modal-reason');
  reasonInput.value = '';
  $('#decision-reason-label').textContent = cfg.reasonLabel;
  reasonInput.placeholder = cfg.placeholder || '';

  const showDetails = needsDetails(cfg, doc);
  $('#decision-details').hidden = !showDetails;
  if (showDetails) {
    $('#decision-full-name').value = doc.full_name || '';
    $('#decision-id-number').value = doc.id_number || '';
    $('#decision-dob').value = doc.date_of_birth ? String(doc.date_of_birth).slice(0, 10) : '';
    $('#decision-gender').value = doc.gender || '';
  }

  const submitBtn = $('#decision-modal-submit');
  submitBtn.className = `btn ${cfg.submitClass}`;
  submitBtn.textContent = cfg.submit;
  submitBtn.disabled = false;

  hideModalError();
  $('#decision-modal').classList.add('is-open');
  $('#decision-modal').setAttribute('aria-hidden', 'false');
  (showDetails ? $('#decision-full-name') : reasonInput).focus();
}

// Verifying a BVN or identity document saves the confirmed details on the
// record (the database function overwrites them with whatever is sent).
function needsDetails(cfg, doc) {
  return Boolean(cfg?.details && doc && (doc.document_category === 'bvn' || doc.document_category === 'identity'));
}

function closeDecisionModal() {
  $('#decision-modal').classList.remove('is-open');
  $('#decision-modal').setAttribute('aria-hidden', 'true');
  state.pendingDecision = null;
}

function showModalError(message) {
  const el = $('#decision-modal-error');
  el.textContent = message;
  el.hidden = false;
}

function hideModalError() {
  const el = $('#decision-modal-error');
  el.textContent = '';
  el.hidden = true;
}

/* -----------------------------------------------------------
   Keyboard: Escape closes the modal first, then the drawer
   ----------------------------------------------------------- */
function wireKeyboard() {
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if ($('#decision-modal').getAttribute('aria-hidden') === 'false') {
      closeDecisionModal();
      return;
    }
    if ($('#kyc-drawer-overlay').getAttribute('aria-hidden') === 'false') closeDrawer();
  });
}

/* -----------------------------------------------------------
   Review helpers — profile vs submitted details
   ----------------------------------------------------------- */
function nameTokens(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

// true = match, false = differs, null = nothing to compare.
// Middle names are common, so one name's words being contained in the other counts as a match.
function namesMatch(a, b) {
  const x = nameTokens(a);
  const y = nameTokens(b);
  if (!x.length || !y.length) return null;
  const contains = (big, small) => small.every((token) => big.includes(token));
  return contains(x, y) || contains(y, x);
}

function datesMatch(a, b) {
  if (!a || !b) return null;
  return String(a).slice(0, 10) === String(b).slice(0, 10);
}

function maskSecret(value) {
  const s = String(value || '');
  if (!s) return '—';
  if (s.length <= 4) return '••••';
  return `${'•'.repeat(Math.min(s.length - 4, 8))}${s.slice(-4)}`;
}

/* -----------------------------------------------------------
   Small render helpers
   ----------------------------------------------------------- */
function applicantName(person) {
  return `${person?.first_name || ''} ${person?.last_name || ''}`.trim() || person?.email || '—';
}

function detailRow(label, valueHtml, extraHtml = '') {
  return `<div class="admin-detail-row"><span>${label}</span><span class="kyc-detail-value">${valueHtml}${extraHtml}</span></div>`;
}

function statusPill(status) {
  const meta = STATUS_META[status] || { label: status || '—', tone: 'neutral' };
  return `<span class="kyc-pill kyc-pill--${meta.tone}">${escapeHtml(meta.label)}</span>`;
}

function categoryChip(category) {
  const meta = CATEGORY_META[category];
  if (!meta) return '';
  return `<span class="kyc-chip kyc-chip--${meta.chip}">${escapeHtml(meta.label)}</span>`;
}

function checkMark(result, profileValue) {
  if (result === null || result === undefined) return '';
  if (result) return `<span class="kyc-check kyc-check--match">Matches profile</span>`;
  const suffix = profileValue ? `: ${escapeHtml(profileValue)}` : '';
  return `<span class="kyc-check kyc-check--mismatch">Differs from profile${suffix}</span>`;
}

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
