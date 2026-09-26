/* =============================================================
   MERIDIAN — Transactions page
   Script: pages/transactions.js
   Loaded as a module by transactions.html only.

   Changes in THIS pass:

   A. COUNTERPARTY NAME instead of purpose/description as each
      row's (and the detail panel's) headline. Every transaction
      only carries sender_account/receiver_account (account IDs),
      so showing a real name needs a lookup: account -> user_id ->
      user_profiles.first_name/last_name — same resolution
      admin-transactions.js's resolveReceiverContact() already does
      for a single transaction. Doing that per-row here would fire
      one query per row, so resolveCounterparties() instead collects
      every unique counterparty account ID across the whole merged
      list ONCE per load and resolves them in two batched queries,
      caching results in a module-level Map that persists across
      filter changes and "load more" clicks (only ids not already
      cached are re-queried).

      Three cases, in counterpartyLabel():
        - Resolved to a real Meridian user -> their name.
        - Resolved to one of the CURRENT USER's OWN other accounts
          (a self-transfer between e.g. a USD and EUR account) ->
          "Your <currency> account" rather than the user's own name,
          which would read oddly as a "counterparty".
        - Unresolvable (external wire, card swipe, bank fee — no
          receiver_account/sender_account pointing at a Meridian
          account) -> falls back to the original description, or a
          generic label if there's none.

   B. MOBILE FILTER CONTROLS — the new .tx-filter-mobile markup in
      transactions.html (category chip, status chip, timeframe chip)
      is wired here. Key design point: these controls do NOT keep
      separate state from the desktop filter bar — they read and
      write the SAME state.status / state.dateFrom / state.dateTo
      the desktop <select>/<input> elements use, just through a
      different widget. That way switching viewport width mid-
      session never desyncs the two. The one exception is category
      (Debit/Credit/Other), which has no desktop equivalent — it's
      a new client-side-only filter dimension (categoryFor()),
      computed from direction + transaction type, never sent to the
      server.

      Known gap, flagged rather than silently patched: the mobile
      status dropdown includes "Reversed", which the desktop
      <select> in transactions.html doesn't yet have as an <option>.
      Selecting Reversed on mobile still filters correctly (state.status
      drives the actual server query), but if the viewport is then
      widened past the breakpoint, the desktop select can't visually
      display that as its selected value (browsers ignore assigning
      a value with no matching <option>). Add
      <option value="Reversed">Reversed</option> to the desktop
      select in transactions.html to close this gap.

   ---- Everything else (auth guard, header wiring, load/render
   pipeline shape, summary calc, CSV export, mobile nav) is
   unchanged from the previous revision. ----
   ============================================================= */

import { requireAuth, signOutUser } from '../supabase/auth.js';
import {
  getMyProfile,
  getUnreadNotificationCount,
  getMyAccounts,
  getTransactions,
} from '../supabase/database.js';
import { supabase } from '../supabase/config.js'; // NEW — used by resolveCounterparties()
import { formatCurrency, $, $$, debounce, getInitials } from '../assets/js/utils.js';

/* -----------------------------------------------------------
   Constants & state
   ----------------------------------------------------------- */
const FETCH_LIMIT_STEP = 60;     // per-account rows fetched from the server per "page"
const VISIBLE_STEP = 20;         // rows revealed per "Load more" click, client-side

const state = {
  accounts: [],
  ownAccountIds: new Set(),
  fetchLimit: FETCH_LIMIT_STEP,
  visibleCount: VISIBLE_STEP,
  merged: [],
  filtered: [],
  selectedId: null,
  loading: false,

  // NEW — single source of truth for status/date, shared by the
  // desktop <select>/<input> elements AND the mobile status/
  // timeframe widgets. See file header, section B.
  status: 'all',
  dateFrom: '',
  dateTo: '',
  timeframe: { range: 'all', from: '', to: '' }, // mirrors dateFrom/dateTo, plus which preset (if any) produced them — drives the mobile timeframe chip's label and re-opens with the right preset highlighted.

  // NEW — mobile-only filter dimension, no desktop equivalent.
  mobileCategory: 'all', // 'all' | 'debit' | 'credit' | 'other'
};

// NEW — accountId -> { name: string|null }, resolved once and
// reused across loads/filter changes/"load more" for as long as the
// page is open. See resolveCounterparties() below.
const counterpartyCache = new Map();

const CATEGORY_LABELS = { all: 'Category', debit: 'Debit', credit: 'Credit', other: 'Other' };
const STATUS_LABELS = { all: 'Status', Completed: 'Successful', Processing: 'Pending', Reversed: 'Reversed', Failed: 'Failed' };

function isSameDay(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function dayLabel(isoString) {
  const date = new Date(isoString);
  const now = new Date();
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  const weekAgo = new Date(now);
  weekAgo.setDate(now.getDate() - 7);

  if (isSameDay(date, now)) return 'Today';
  if (isSameDay(date, yesterday)) return 'Yesterday';
  if (date > weekAgo) return 'This week';
  return date.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
}

function rowTime(isoString) {
  const date = new Date(isoString);
  const now = new Date();
  const timePart = date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  if (isSameDay(date, now)) return timePart;
  return `${date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}, ${timePart}`;
}

function fullTimestamp(isoString) {
  return new Date(isoString).toLocaleString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit',
  });
}

function statusPillClass(status) {
  const s = (status || '').toLowerCase();
  if (s === 'completed') return 'status-pill--verified';
  if (s === 'failed') return 'status-pill--blocked';
  if (s === 'pending' || s === 'processing') return 'status-pill--pending';
  return 'status-pill--neutral';
}

function typeLabel(type) {
  return String(type || 'transaction').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

const ICON_IN = '<path d="M10 17V3M4 9l6-6 6 6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>';
const ICON_OUT = '<rect x="3" y="6" width="14" height="9" rx="1.5" stroke="currentColor" stroke-width="1.4"/>';

function directionFor(tx) {
  if (state.ownAccountIds.has(tx.sender_account)) return 'out';
  if (state.ownAccountIds.has(tx.receiver_account)) return 'in';
  return 'out';
}

/**
 * NEW — which category a transaction falls into for the mobile
 * Category filter. Fees and reversed entries are pulled out into
 * "Other" (adjustments) rather than counted as an ordinary debit,
 * since they aren't a payment the user directed at a person.
 * Everything else is a straightforward debit/credit by direction.
 */
function categoryFor(tx) {
  const type = (tx.transaction_type || '').toLowerCase();
  if (type === 'fee' || (tx.status || '').toLowerCase() === 'reversed') return 'other';
  return directionFor(tx) === 'in' ? 'credit' : 'debit';
}

/**
 * NEW — the account ID on the "other side" of a transaction from
 * the current user's perspective: the receiver's account for
 * something the user sent, the sender's account for something the
 * user received. Returns null when that side is external (no
 * matching Meridian account) — there's nothing to resolve a name
 * for in that case.
 */
function counterpartyAccountFor(tx) {
  if (state.ownAccountIds.has(tx.sender_account)) return tx.receiver_account || null;
  if (state.ownAccountIds.has(tx.receiver_account)) return tx.sender_account || null;
  return tx.receiver_account || tx.sender_account || null;
}

/**
 * NEW — resolves tx.counterpartyName for every transaction in the
 * given list, batching the network round trips:
 *   1. Collect every unique counterparty account ID not already in
 *      counterpartyCache and not one of the user's OWN accounts
 *      (self-transfers are handled directly, no query needed).
 *   2. One query: accounts.id -> user_id for all of those.
 *   3. One query: user_profiles.id -> first_name/last_name for the
 *      resulting user_ids.
 *   4. Cache each resolved (or unresolved -> null) name by account
 *      ID so a second load never re-queries the same account.
 * Mutates each tx in place with counterpartyAccountId/counterpartyName
 * rather than returning a new array, since callers already hold
 * references to these objects (state.merged).
 */
async function resolveCounterparties(transactions) {
  const idsToResolve = new Set();

  transactions.forEach((tx) => {
    const id = counterpartyAccountFor(tx);
    if (id && !state.ownAccountIds.has(id) && !counterpartyCache.has(id)) {
      idsToResolve.add(id);
    }
  });

  if (idsToResolve.size) {
    const ids = [...idsToResolve];

    const { data: accts } = await supabase.from('accounts').select('id, user_id').in('id', ids);
    const userIdByAccount = new Map((accts || []).map((a) => [a.id, a.user_id]));
    const userIds = [...new Set((accts || []).map((a) => a.user_id).filter(Boolean))];

    let profilesById = new Map();
    if (userIds.length) {
      const { data: profiles } = await supabase
        .from('user_profiles')
        .select('id, first_name, last_name')
        .in('id', userIds);
      profilesById = new Map((profiles || []).map((p) => [p.id, p]));
    }

    ids.forEach((accountId) => {
      const userId = userIdByAccount.get(accountId);
      const profile = userId ? profilesById.get(userId) : null;
      const name = profile ? [profile.first_name, profile.last_name].filter(Boolean).join(' ').trim() : '';
      counterpartyCache.set(accountId, { name: name || null });
    });
  }

  transactions.forEach((tx) => {
    const id = counterpartyAccountFor(tx);
    tx.counterpartyAccountId = id || null;

    if (!id) {
      tx.counterpartyName = null;
      return;
    }

    if (state.ownAccountIds.has(id)) {
      const ownAccount = state.accounts.find((a) => a.id === id);
      tx.counterpartyName = ownAccount ? `Your ${ownAccount.currency} account` : 'Your account';
      return;
    }

    tx.counterpartyName = counterpartyCache.get(id)?.name || null;
  });
}

/**
 * NEW — the single headline label used for a transaction's row
 * title and the detail panel's heading. Prefers a resolved
 * counterparty name; falls back to the original description (or a
 * generic label) for transactions with no resolvable Meridian
 * counterparty — external wires, card swipes, bank fees.
 */
function counterpartyLabel(tx) {
  if (tx.counterpartyName) return tx.counterpartyName;

  const type = (tx.transaction_type || '').toLowerCase();
  if (type === 'fee') return tx.description || 'Meridian fee';
  if (type === 'card') return tx.description || 'Card payment';
  if (type === 'deposit') return tx.description || 'Deposit';
  if (type === 'withdrawal') return tx.description || 'Withdrawal';

  const direction = directionFor(tx);
  return tx.description || (direction === 'in' ? 'External sender' : 'External transfer');
}

function waitForNavbar() {
  return new Promise((resolve) => {
    if ($('.app-user-menu')) {
      resolve();
      return;
    }
    document.addEventListener('component:loaded', () => resolve(), { once: true });
  });
}

async function populateUserChrome() {
  const { data: profile } = await getMyProfile();
  const fullName = profile ? `${profile.first_name || ''} ${profile.last_name || ''}`.trim() : '';

  const nameEl = $('.app-user-name');
  const avatarEl = $('.avatar-initial--sm');
  if (nameEl && fullName) nameEl.textContent = fullName;
  if (avatarEl) avatarEl.textContent = getInitials(fullName || 'Meridian User');

  const { data: count } = await getUnreadNotificationCount();
  const badge = $('.app-icon-btn-badge');
  if (badge) {
    if (count) {
      badge.hidden = false;
      badge.textContent = count > 9 ? '9+' : String(count);
    } else {
      badge.hidden = true;
    }
  }
}

function initUserMenu() {
  const menu = $('.app-user-menu');
  const trigger = $('.app-user-trigger', menu);
  if (!menu || !trigger) return;

  function open() {
    menu.classList.add('is-open');
    trigger.setAttribute('aria-expanded', 'true');
    document.addEventListener('click', handleOutsideClick);
    document.addEventListener('keydown', handleKeydown);
  }
  function close() {
    menu.classList.remove('is-open');
    trigger.setAttribute('aria-expanded', 'false');
    document.removeEventListener('click', handleOutsideClick);
    document.removeEventListener('keydown', handleKeydown);
  }
  function handleOutsideClick(event) {
    if (!menu.contains(event.target)) close();
  }
  function handleKeydown(event) {
    if (event.key === 'Escape') { close(); trigger.focus(); }
  }

  trigger.addEventListener('click', (event) => {
    event.stopPropagation();
    menu.classList.contains('is-open') ? close() : open();
  });
}

/* -----------------------------------------------------------
   Mobile nav toggle — wires up the hamburger (.app-nav-toggle) in
   the shared app-navbar partial.
   ----------------------------------------------------------- */
function initMobileNav() {
  const toggle = $('.app-nav-toggle');
  const nav = $('.app-nav');
  if (!toggle || !nav) return;

  toggle.addEventListener('click', () => {
    const isOpen = nav.classList.toggle('is-mobile-open');
    toggle.setAttribute('aria-expanded', String(isOpen));
  });
  nav.addEventListener('click', (event) => {
    if (event.target.tagName === 'A') {
      nav.classList.remove('is-mobile-open');
      toggle.setAttribute('aria-expanded', 'false');
    }
  });
  document.addEventListener('click', (event) => {
    if (!nav.classList.contains('is-mobile-open')) return;
    if (!nav.contains(event.target) && !toggle.contains(event.target)) {
      nav.classList.remove('is-mobile-open');
      toggle.setAttribute('aria-expanded', 'false');
    }
  });
}

function initLogout() {
  const logoutLink = $('.app-user-dropdown a[href="../index.html"]');
  if (!logoutLink) return;
  logoutLink.addEventListener('click', async (event) => {
    event.preventDefault();
    await signOutUser();
    window.location.href = logoutLink.getAttribute('href');
  });
}

function showToast(message, variant = 'default') {
  const stack = $('#toast-stack');
  if (!stack) return;
  const toast = document.createElement('div');
  toast.className = `toast${variant === 'error' ? ' toast--error' : ''}`;
  toast.textContent = message;
  stack.appendChild(toast);
  window.setTimeout(() => toast.remove(), 4000);
}

function populateFilterOptions() {
  const accountSelect = $('#tx-filter-account');
  const currencySelect = $('#tx-filter-currency');

  state.accounts.forEach((account) => {
    const opt = document.createElement('option');
    opt.value = account.id;
    opt.textContent = `${account.currency} account · ${maskTail(account)}`;
    accountSelect.appendChild(opt);
  });

  const currencies = [...new Set(state.accounts.map((a) => a.currency))].sort();
  currencies.forEach((code) => {
    const opt = document.createElement('option');
    opt.value = code;
    opt.textContent = code;
    currencySelect.appendChild(opt);
  });
}

function maskTail(account) {
  const raw = account.account_number || account.iban || '';
  const digits = String(raw).replace(/\s+/g, '');
  return digits ? `···· ${digits.slice(-4)}` : account.currency;
}

function currentFilters() {
  return {
    accountId: $('#tx-filter-account').value,
    type: $('#tx-filter-type').value,
    status: state.status, // NEW — read from shared state, not the select directly
    currency: $('#tx-filter-currency').value,
    from: state.dateFrom, // NEW
    to: state.dateTo,     // NEW
    search: $('#tx-search-input').value.trim().toLowerCase(),
    category: state.mobileCategory, // NEW
  };
}

function accountIdsForFilter(filters) {
  if (filters.accountId === 'all') return state.accounts.map((a) => a.id);
  return [filters.accountId];
}

async function loadTransactions({ resetFetchLimit = true, resetVisible = true } = {}) {
  if (state.loading) return;
  state.loading = true;

  if (resetFetchLimit) state.fetchLimit = FETCH_LIMIT_STEP;
  if (resetVisible) state.visibleCount = VISIBLE_STEP;

  renderSkeleton();

  const filters = currentFilters();
  const accountIds = accountIdsForFilter(filters);

  if (!accountIds.length) {
    state.merged = [];
    applyClientFilters();
    state.loading = false;
    return;
  }

  const serverParams = {
    type: filters.type,
    status: filters.status,
    from: filters.from ? new Date(filters.from).toISOString() : undefined,
    to: filters.to ? new Date(`${filters.to}T23:59:59`).toISOString() : undefined,
    limit: state.fetchLimit,
  };

  try {
    const results = await Promise.all(
      accountIds.map((id) => getTransactions(id, serverParams))
    );

    const anyError = results.find((r) => r.error);
    if (anyError && results.every((r) => r.error)) {
      renderError(anyError.error);
      state.loading = false;
      return;
    }

    const byId = new Map();
    results.forEach(({ data }) => {
      (data || []).forEach((tx) => {
        if (!byId.has(tx.id)) byId.set(tx.id, tx);
      });
    });

    state.merged = Array.from(byId.values()).sort(
      (a, b) => new Date(b.created_at) - new Date(a.created_at)
    );

    await resolveCounterparties(state.merged); // NEW — before render, so names are ready

    applyClientFilters();
  } catch (err) {
    renderError(err.message || 'Something went wrong loading transactions.');
  } finally {
    state.loading = false;
  }
}

function applyClientFilters() {
  const filters = currentFilters();

  let list = state.merged;

  if (filters.currency !== 'all') {
    list = list.filter((tx) => tx.currency === filters.currency);
  }

  // NEW — mobile Category filter (direction-based), purely
  // client-side since the server has no concept of it.
  if (filters.category && filters.category !== 'all') {
    list = list.filter((tx) => categoryFor(tx) === filters.category);
  }

  if (filters.search) {
    list = list.filter((tx) => {
      const haystack = [
        counterpartyLabel(tx), // NEW — searchable by counterparty name too
        tx.description,
        tx.transaction_reference,
        tx.transaction_type,
        String(tx.amount),
      ].filter(Boolean).join(' ').toLowerCase();
      return haystack.includes(filters.search);
    });
  }

  state.filtered = list;

  if (!state.selectedId && list.length) {
    state.selectedId = list[0].id;
  }

  renderList();
  renderDetail();
}

function renderSkeleton() {
  const body = $('#tx-list-body');
  body.innerHTML = `
    <div class="tx-day-group" data-skeleton>
      <div class="tx-day-heading skeleton" style="width:90px;height:14px;"></div>
      <ul class="tx-list">
        ${Array.from({ length: 4 }).map(() => `
          <li class="tx-row tx-row--skeleton">
            <span class="tx-icon skeleton"></span>
            <div class="tx-row-main">
              <strong class="skeleton" style="width:60%;height:14px;display:block;margin-bottom:6px;"></strong>
              <span class="skeleton" style="width:40%;height:11px;display:block;"></span>
            </div>
            <span class="skeleton" style="width:64px;height:20px;border-radius:999px;"></span>
            <span class="skeleton" style="width:80px;height:20px;border-radius:999px;"></span>
            <span class="skeleton" style="width:70px;height:14px;"></span>
            <span class="skeleton" style="width:50px;height:12px;"></span>
          </li>
        `).join('')}
      </ul>
    </div>
  `;
  $('#tx-list-count').textContent = '';
  $('#tx-load-more-btn').hidden = true;
}

function renderError(message) {
  const body = $('#tx-list-body');
  body.innerHTML = `
    <div class="tx-error-state">
      <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="12" cy="12" r="9.5" stroke="currentColor" stroke-width="1.4"/><path d="M12 7.5v6M12 16.5h.01" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>
      <strong>Couldn't load transactions</strong>
      <p>${escapeHtml(message)}</p>
      <button type="button" class="btn btn-ghost btn-sm" id="tx-retry-btn" style="margin-top:1rem;">Try again</button>
    </div>
  `;
  $('#tx-load-more-btn').hidden = true;
  $('#tx-list-count').textContent = '';
  const retryBtn = $('#tx-retry-btn');
  if (retryBtn) retryBtn.addEventListener('click', () => loadTransactions());
}

function renderList() {
  const body = $('#tx-list-body');
  const countEl = $('#tx-list-count');
  const loadMoreBtn = $('#tx-load-more-btn');

  if (!state.filtered.length) {
    body.innerHTML = `
      <div class="tx-empty-state">
        <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="3.5" y="5" width="17" height="14" rx="2" stroke="currentColor" stroke-width="1.4"/><path d="M3.5 9.5h17" stroke="currentColor" stroke-width="1.4"/></svg>
        <strong>No transactions found</strong>
        <p>Try widening your filters or search terms.</p>
      </div>
    `;
    countEl.textContent = '';
    loadMoreBtn.hidden = true;
    return;
  }

  const visible = state.filtered.slice(0, state.visibleCount);

  const groups = [];
  const groupIndex = new Map();
  visible.forEach((tx) => {
    const label = dayLabel(tx.created_at);
    if (!groupIndex.has(label)) {
      groupIndex.set(label, groups.length);
      groups.push({ label, items: [] });
    }
    groups[groupIndex.get(label)].items.push(tx);
  });

  body.innerHTML = groups.map((group) => `
    <div class="tx-day-group">
      <h2 class="tx-day-heading">${escapeHtml(group.label)}</h2>
      <ul class="tx-list">
        ${group.items.map((tx) => rowMarkup(tx)).join('')}
      </ul>
    </div>
  `).join('');

  $$('.tx-row[data-tx-id]', body).forEach((row) => {
    row.addEventListener('click', () => selectTransaction(row.getAttribute('data-tx-id')));
    row.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        selectTransaction(row.getAttribute('data-tx-id'));
      }
    });
  });

  const showingCount = Math.min(state.visibleCount, state.filtered.length);
  countEl.textContent = `Showing ${showingCount} of ${state.filtered.length} transaction${state.filtered.length === 1 ? '' : 's'}`;

  const moreOnServerPossible = state.filtered.length >= state.fetchLimit * accountIdsForFilter(currentFilters()).length;
  loadMoreBtn.hidden = !(state.visibleCount < state.filtered.length || moreOnServerPossible);
}

function rowMarkup(tx) {
  const direction = directionFor(tx);
  const isIn = direction === 'in';
  const amountText = `${isIn ? '+' : '−'}${formatCurrency(Math.abs(Number(tx.amount) || 0), tx.currency)}`;

  return `
    <li class="tx-row${tx.id === state.selectedId ? ' is-selected' : ''}" data-tx-id="${tx.id}" tabindex="0" role="button" aria-pressed="${tx.id === state.selectedId}">
      <span class="tx-icon ${isIn ? 'tx-icon--in' : 'tx-icon--out'}">
        <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">${isIn ? ICON_IN : ICON_OUT}</svg>
      </span>
      <div class="tx-row-main">
        <strong>${escapeHtml(counterpartyLabel(tx))}</strong>
        <span>${escapeHtml(typeLabel(tx.transaction_type))} · Ref ${escapeHtml(tx.transaction_reference || '—')}</span>
      </div>
      <span class="tag">${escapeHtml(typeLabel(tx.transaction_type))}</span>
      <span class="status-pill ${statusPillClass(tx.status)}">${escapeHtml(tx.status || 'Unknown')}</span>
      <span class="amt${isIn ? ' pos' : ''}">${amountText}</span>
      <time>${rowTime(tx.created_at)}</time>
    </li>
  `;
}

function selectTransaction(id) {
  state.selectedId = id;
  $$('.tx-row[data-tx-id]').forEach((row) => {
    const active = row.getAttribute('data-tx-id') === id;
    row.classList.toggle('is-selected', active);
    row.setAttribute('aria-pressed', String(active));
  });
  renderDetail();
  openDetailPanelOnMobile();
}

function renderDetail() {
  const content = $('#tx-detail-content');
  const tx = state.filtered.find((t) => t.id === state.selectedId);

  if (!tx) {
    content.className = 'tx-detail-empty';
    content.innerHTML = '<p>Select a transaction to see the full details here.</p>';
    return;
  }

  const direction = directionFor(tx);
  const isIn = direction === 'in';
  const amountText = `${isIn ? '+' : '−'}${formatCurrency(Math.abs(Number(tx.amount) || 0), tx.currency)}`;
  const senderAccount = state.accounts.find((a) => a.id === tx.sender_account);
  const receiverAccount = state.accounts.find((a) => a.id === tx.receiver_account);

  content.className = '';
  content.innerHTML = `
    <div class="tx-detail-head">
      <span class="tx-icon ${isIn ? 'tx-icon--in' : 'tx-icon--out'}">
        <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">${isIn ? ICON_IN : ICON_OUT}</svg>
      </span>
      <div>
        <strong>${escapeHtml(counterpartyLabel(tx))}</strong>
        <span class="status-pill ${statusPillClass(tx.status)}">${escapeHtml(tx.status || 'Unknown')}</span>
      </div>
    </div>

    <div class="tx-detail-amount amt${isIn ? ' pos' : ''}">${amountText}</div>

    <dl class="tx-detail-list">
      <div><dt>Reference</dt><dd>${escapeHtml(tx.transaction_reference || '—')}
        <button type="button" class="copy-btn" data-copy="${escapeHtml(tx.transaction_reference || '')}" aria-label="Copy reference">
          <svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><rect x="5.5" y="5.5" width="8" height="8" rx="1.2" stroke="currentColor" stroke-width="1.3"/><path d="M2.5 10.5v-7A1 1 0 0 1 3.5 2.5h7" stroke="currentColor" stroke-width="1.3"/></svg>
        </button>
      </dd></div>
      <div><dt>Type</dt><dd>${escapeHtml(typeLabel(tx.transaction_type))}</dd></div>
      ${senderAccount ? `<div><dt>From</dt><dd>${escapeHtml(senderAccount.currency)} account ${escapeHtml(maskTail(senderAccount))}</dd></div>` : ''}
      ${receiverAccount ? `<div><dt>To account</dt><dd>${escapeHtml(receiverAccount.currency)} account ${escapeHtml(maskTail(receiverAccount))}</dd></div>` : ''}
      <div><dt>Fee</dt><dd>${formatCurrency(Number(tx.fee) || 0, tx.currency)}</dd></div>
      <div><dt>Date</dt><dd>${fullTimestamp(tx.created_at)}</dd></div>
      ${tx.description ? `<div><dt>Purpose</dt><dd>${escapeHtml(tx.description)}</dd></div>` : ''}
    </dl>

    <div class="tx-detail-actions">
      <button type="button" class="btn btn-ghost btn-block" id="tx-detail-report">Report a problem</button>
    </div>
  `;

  const copyBtn = $('.copy-btn', content);
  if (copyBtn) {
    copyBtn.addEventListener('click', async () => {
      const ref = copyBtn.getAttribute('data-copy');
      if (!ref) return;
      try {
        await navigator.clipboard.writeText(ref);
        showToast('Reference copied to clipboard.');
      } catch (err) {
        showToast('Could not copy — please copy it manually.', 'error');
      }
    });
  }

  const reportBtn = $('#tx-detail-report', content);
  if (reportBtn) {
    reportBtn.addEventListener('click', () => showToast('Your report has been sent to support.'));
  }
}

function initDetailPanelMobileControls() {
  const panel = $('#tx-detail-panel');
  const scrim = $('#tx-detail-scrim');
  const closeBtn = $('#tx-detail-close');

  function close() {
    panel.classList.remove('is-open');
    scrim.classList.remove('is-open');
    scrim.hidden = true;
  }

  closeBtn.addEventListener('click', close);
  scrim.addEventListener('click', close);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && panel.classList.contains('is-open')) close();
  });

  panel._close = close;
}

function openDetailPanelOnMobile() {
  if (window.innerWidth > 1080) return;
  const panel = $('#tx-detail-panel');
  const scrim = $('#tx-detail-scrim');
  panel.classList.add('is-open');
  scrim.hidden = false;
  requestAnimationFrame(() => scrim.classList.add('is-open'));
}

async function loadSummary() {
  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);

  try {
    const results = await Promise.all(
      state.accounts.map((account) =>
        getTransactions(account.id, { from: monthStart.toISOString(), limit: 500 }).then((res) => ({
          accountId: account.id,
          currency: account.currency,
          data: res.data || [],
        }))
      )
    );

    let moneyIn = 0;
    let moneyOut = 0;
    let pendingCount = 0;
    const seenIds = new Set();

    results.forEach(({ accountId, data }) => {
      data.forEach((tx) => {
        if (tx.sender_account === accountId) {
          moneyOut += Number(tx.amount) + Number(tx.fee || 0);
        }
        if (tx.receiver_account === accountId) {
          moneyIn += Number(tx.amount);
        }
        if (!seenIds.has(tx.id)) {
          seenIds.add(tx.id);
          const s = (tx.status || '').toLowerCase();
          if (s === 'pending' || s === 'processing') pendingCount += 1;
        }
      });
    });

    const displayCurrency = state.accounts[0]?.currency || 'USD';
    $('#tx-summary-in').textContent = `+${formatCurrency(moneyIn, displayCurrency)}`;
    $('#tx-summary-in').classList.remove('skeleton');
    $('#tx-summary-out').textContent = `−${formatCurrency(moneyOut, displayCurrency)}`;
    $('#tx-summary-out').classList.remove('skeleton');

    const net = moneyIn - moneyOut;
    const netEl = $('#tx-summary-net');
    netEl.textContent = `${net >= 0 ? '+' : '−'}${formatCurrency(Math.abs(net), displayCurrency)}`;
    netEl.classList.toggle('pos', net >= 0);
    netEl.classList.remove('skeleton');

    const pendingEl = $('#tx-summary-pending');
    pendingEl.textContent = `${pendingCount} transaction${pendingCount === 1 ? '' : 's'}`;
    pendingEl.classList.remove('skeleton');
  } catch (err) {
    ['#tx-summary-in', '#tx-summary-out', '#tx-summary-net', '#tx-summary-pending'].forEach((sel) => {
      const el = $(sel);
      el.textContent = '—';
      el.classList.remove('skeleton');
    });
  }
}

function exportCsv() {
  if (!state.filtered.length) {
    showToast('No transactions to export for the current filters.', 'error');
    return;
  }

  const headers = ['Date', 'Counterparty', 'Description', 'Reference', 'Type', 'Status', 'Direction', 'Amount', 'Fee', 'Currency'];
  const rows = state.filtered.map((tx) => {
    const direction = directionFor(tx);
    return [
      new Date(tx.created_at).toISOString(),
      counterpartyLabel(tx), // NEW
      tx.description || '',
      tx.transaction_reference || '',
      tx.transaction_type || '',
      tx.status || '',
      direction === 'in' ? 'In' : 'Out',
      tx.amount,
      tx.fee || 0,
      tx.currency,
    ];
  });

  const csv = [headers, ...rows]
    .map((row) => row.map(csvEscape).join(','))
    .join('\n');

  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `meridian-transactions-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function csvEscape(value) {
  const str = String(value ?? '');
  if (/[",\n]/.test(str)) return `"${str.replace(/"/g, '""')}"`;
  return str;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

/* -----------------------------------------------------------
   NEW — mobile filter widgets (category / status / timeframe)
   -----------------------------------------------------------
   Small, generic dropdown wiring shared by the category and
   status chips: a trigger button toggles a hidden panel of
   `.tx-filter-option` buttons; clicking one marks it selected,
   closes the panel, and runs the caller's onSelect callback.
   ----------------------------------------------------------- */
function closeAllMobileDropdowns(except = null) {
  [
    { btn: $('#tx-category-btn'), panel: $('#tx-category-dropdown') },
    { btn: $('#tx-status-btn'), panel: $('#tx-status-dropdown') },
    { btn: $('#tx-timeframe-btn'), panel: $('#tx-timeframe-panel') },
  ].forEach(({ btn, panel }) => {
    if (!btn || !panel || panel === except) return;
    panel.hidden = true;
    btn.setAttribute('aria-expanded', 'false');
  });
}

function wireOptionDropdown(btnId, panelId, onSelect) {
  const btn = $(`#${btnId}`);
  const panel = $(`#${panelId}`);
  if (!btn || !panel) return;

  btn.addEventListener('click', (event) => {
    event.stopPropagation();
    const willOpen = panel.hidden;
    closeAllMobileDropdowns(willOpen ? panel : null);
    panel.hidden = !willOpen;
    btn.setAttribute('aria-expanded', String(willOpen));
  });

  $$('.tx-filter-option', panel).forEach((opt) => {
    opt.addEventListener('click', () => {
      $$('.tx-filter-option', panel).forEach((o) => {
        o.classList.remove('is-selected');
        o.setAttribute('aria-selected', 'false');
      });
      opt.classList.add('is-selected');
      opt.setAttribute('aria-selected', 'true');
      panel.hidden = true;
      btn.setAttribute('aria-expanded', 'false');
      onSelect(opt);
    });
  });
}

function syncMobileStatusUi() {
  const label = $('#tx-status-label');
  if (label) label.textContent = STATUS_LABELS[state.status] || 'Status';
  $$('.tx-filter-option[data-status]').forEach((o) => {
    const match = o.dataset.status === state.status;
    o.classList.toggle('is-selected', match);
    o.setAttribute('aria-selected', String(match));
  });
}

function toDateInputValue(date) {
  return date.toISOString().slice(0, 10); // matches <input type="date">'s value format
}

function computePresetRange(preset) {
  const now = new Date();
  if (preset === '7d') return { from: toDateInputValue(new Date(now.getTime() - 7 * 86400000)), to: '' };
  if (preset === '30d') return { from: toDateInputValue(new Date(now.getTime() - 30 * 86400000)), to: '' };
  if (preset === 'month') return { from: toDateInputValue(new Date(now.getFullYear(), now.getMonth(), 1)), to: '' };
  return { from: '', to: '' }; // 'all'
}

function timeframeLabelFor(range, from, to) {
  if (range === '7d') return 'Last 7 days';
  if (range === '30d') return 'Last 30 days';
  if (range === 'month') return 'This month';
  if (range === 'custom') {
    const fmt = (d) => new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    if (from && to) return `${fmt(from)} – ${fmt(to)}`;
    if (from) return `From ${fmt(from)}`;
    if (to) return `Until ${fmt(to)}`;
    return 'Custom range';
  }
  return 'All time'; // 'all'
}

function syncMobileTimeframeUi() {
  const label = $('#tx-timeframe-label');
  if (label) label.textContent = timeframeLabelFor(state.timeframe.range, state.timeframe.from, state.timeframe.to);
}

/**
 * Applies a resolved (range, from, to) to both the shared filter
 * state and the mobile chip's label, then triggers the same
 * server refetch the desktop date inputs trigger — from/to are
 * server-side query params (see loadTransactions()'s serverParams),
 * not something applyClientFilters() alone can handle.
 */
function applyTimeframe(range, from, to) {
  state.timeframe = { range, from: from || '', to: to || '' };
  state.dateFrom = from || '';
  state.dateTo = to || '';
  syncMobileTimeframeUi();
  state.selectedId = null;
  loadTransactions();
}

function wireTimeframePanel() {
  const btn = $('#tx-timeframe-btn');
  const panel = $('#tx-timeframe-panel');
  const customBlock = $('#tx-timeframe-custom');
  const fromInput = $('#tx-filter-from-mobile');
  const toInput = $('#tx-filter-to-mobile');
  if (!btn || !panel) return;

  btn.addEventListener('click', (event) => {
    event.stopPropagation();
    const willOpen = panel.hidden;

    if (willOpen) {
      // Reflect the currently applied timeframe when reopening,
      // rather than always resetting to "All time".
      $$('.tx-filter-preset', panel).forEach((p) => p.classList.toggle('is-selected', p.dataset.range === state.timeframe.range));
      if (customBlock) customBlock.hidden = state.timeframe.range !== 'custom';
      if (fromInput) fromInput.value = state.timeframe.from || '';
      if (toInput) toInput.value = state.timeframe.to || '';
    }

    closeAllMobileDropdowns(willOpen ? panel : null);
    panel.hidden = !willOpen;
    btn.setAttribute('aria-expanded', String(willOpen));
  });

  $$('.tx-filter-preset', panel).forEach((presetBtn) => {
    presetBtn.addEventListener('click', () => {
      $$('.tx-filter-preset', panel).forEach((p) => p.classList.remove('is-selected'));
      presetBtn.classList.add('is-selected');
      const range = presetBtn.dataset.range;

      if (range === 'custom') {
        if (customBlock) customBlock.hidden = false;
        return; // wait for Apply — needs the two date inputs filled in first
      }

      if (customBlock) customBlock.hidden = true;
      const { from, to } = computePresetRange(range);
      applyTimeframe(range, from, to);
      panel.hidden = true;
      btn.setAttribute('aria-expanded', 'false');
    });
  });

  $('#tx-timeframe-apply')?.addEventListener('click', () => {
    applyTimeframe('custom', fromInput?.value || '', toInput?.value || '');
    panel.hidden = true;
    btn.setAttribute('aria-expanded', 'false');
  });

  $('#tx-timeframe-cancel')?.addEventListener('click', () => {
    panel.hidden = true;
    btn.setAttribute('aria-expanded', 'false');
  });
}

function wireMobileFilters() {
  wireOptionDropdown('tx-category-btn', 'tx-category-dropdown', (opt) => {
    state.mobileCategory = opt.dataset.category;
    const label = $('#tx-category-label');
    if (label) label.textContent = CATEGORY_LABELS[state.mobileCategory] || 'Category';
    applyClientFilters(); // client-side only — no server round trip needed
  });

  wireOptionDropdown('tx-status-btn', 'tx-status-dropdown', (opt) => {
    state.status = opt.dataset.status;
    syncMobileStatusUi();
    // Best-effort mirror to the desktop select — succeeds only for
    // values that exist there as an <option> (see file header re:
    // "Reversed" not yet being one of them).
    const desktopSelect = $('#tx-filter-status');
    if (desktopSelect) desktopSelect.value = state.status;
    state.selectedId = null;
    loadTransactions();
  });

  wireTimeframePanel();

  document.addEventListener('click', (event) => {
    if (!event.target.closest('.tx-filter-select-wrap')) closeAllMobileDropdowns();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeAllMobileDropdowns();
  });
}

/**
 * Shared by both the desktop "Reset" button and the mobile "Reset
 * filters" link — clears every filter (server and client-side) back
 * to defaults and reloads, rather than each button maintaining its
 * own partial reset.
 */
function resetAllFilters() {
  $('#tx-filter-account').value = 'all';
  $('#tx-filter-type').value = 'all';
  $('#tx-filter-status').value = 'all';
  $('#tx-filter-currency').value = 'all';
  $('#tx-filter-from').value = '';
  $('#tx-filter-to').value = '';
  $('#tx-search-input').value = '';

  state.status = 'all';
  state.dateFrom = '';
  state.dateTo = '';
  state.mobileCategory = 'all';
  state.timeframe = { range: 'all', from: '', to: '' };
  state.selectedId = null;

  const categoryLabel = $('#tx-category-label');
  if (categoryLabel) categoryLabel.textContent = 'Category';
  $$('.tx-filter-option[data-category]').forEach((o) => {
    const match = o.dataset.category === 'all';
    o.classList.toggle('is-selected', match);
    o.setAttribute('aria-selected', String(match));
  });

  syncMobileStatusUi();
  syncMobileTimeframeUi();

  const customBlock = $('#tx-timeframe-custom');
  if (customBlock) customBlock.hidden = true;
  $$('.tx-filter-preset').forEach((p) => p.classList.toggle('is-selected', p.dataset.range === 'all'));
  const fromMobile = $('#tx-filter-from-mobile');
  const toMobile = $('#tx-filter-to-mobile');
  if (fromMobile) fromMobile.value = '';
  if (toMobile) toMobile.value = '';

  loadTransactions();
}

function initFilters() {
  $('#tx-filter-account').addEventListener('change', () => {
    state.selectedId = null;
    loadTransactions();
  });

  $('#tx-filter-type').addEventListener('change', () => {
    state.selectedId = null;
    loadTransactions();
  });

  // CHANGED — status/date now update shared state (and the mobile
  // widgets' displayed labels) before triggering the same refetch,
  // instead of loadTransactions() reading these elements directly.
  $('#tx-filter-status').addEventListener('change', (e) => {
    state.status = e.target.value;
    syncMobileStatusUi();
    state.selectedId = null;
    loadTransactions();
  });

  $('#tx-filter-from').addEventListener('change', (e) => {
    state.dateFrom = e.target.value;
    state.timeframe = (!state.dateFrom && !state.dateTo)
      ? { range: 'all', from: '', to: '' }
      : { range: 'custom', from: state.dateFrom, to: state.dateTo };
    syncMobileTimeframeUi();
    state.selectedId = null;
    loadTransactions();
  });

  $('#tx-filter-to').addEventListener('change', (e) => {
    state.dateTo = e.target.value;
    state.timeframe = (!state.dateFrom && !state.dateTo)
      ? { range: 'all', from: '', to: '' }
      : { range: 'custom', from: state.dateFrom, to: state.dateTo };
    syncMobileTimeframeUi();
    state.selectedId = null;
    loadTransactions();
  });

  $('#tx-filter-currency').addEventListener('change', () => {
    applyClientFilters();
  });

  const debouncedSearch = debounce(() => applyClientFilters(), 250);
  $('#tx-search-input').addEventListener('input', debouncedSearch);

  $('#tx-filter-reset').addEventListener('click', resetAllFilters);
  $('#tx-filter-reset-mobile')?.addEventListener('click', resetAllFilters); // NEW

  $('#tx-load-more-btn').addEventListener('click', () => {
    if (state.visibleCount < state.filtered.length) {
      state.visibleCount += VISIBLE_STEP;
      renderList();
      return;
    }
    state.fetchLimit += FETCH_LIMIT_STEP;
    state.visibleCount += VISIBLE_STEP;
    loadTransactions({ resetFetchLimit: false, resetVisible: false });
  });

  $('#tx-export-btn').addEventListener('click', exportCsv);

  wireMobileFilters(); // NEW
}

(async function init() {
  const user = await requireAuth();
  if (!user) return;

  document.body.classList.remove('auth-pending');

  initDetailPanelMobileControls();

  waitForNavbar().then(() => {
    populateUserChrome();
    initUserMenu();
    initMobileNav();
    initLogout();
  });

  const { data: accounts, error } = await getMyAccounts();
  if (error) {
    renderError(error);
    return;
  }

  state.accounts = accounts || [];
  state.ownAccountIds = new Set(state.accounts.map((a) => a.id));

  if (!state.accounts.length) {
    renderList();
    $('#tx-summary-grid').querySelectorAll('.skeleton').forEach((el) => {
      el.textContent = '—';
      el.classList.remove('skeleton');
    });
    return;
  }

  populateFilterOptions();
  initFilters();

  await Promise.all([loadTransactions(), loadSummary()]);
})();
