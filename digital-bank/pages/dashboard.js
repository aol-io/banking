/* =============================================================
   MERIDIAN — Dashboard / overview page
   Script: pages/dashboard.js
   Loaded as a module by dashboard.html only. Handles:
     1. Auth guard (via supabase/page-guard.js) + reveal
     2. Personalized greeting + real last-login line, both from
        the signed-in user's profile / login_sessions row
     3. Notification badge count
     4. Header identity — name + avatar, deferred until the
        app-navbar component (loaded separately by components.js)
        has actually landed in the DOM; see waitForNavbar() below.
        Avatar rendering mirrors profile.js's paintAvatar(): shows
        the uploaded profile photo when there is one, initials
        otherwise — dashboard previously only ever showed initials
        and never checked profile.profile_photo at all.
     5. User menu dropdown + mobile nav toggle + log out — also
        deferred behind waitForNavbar() (previously these ran
        immediately, racing components.js's fetch() for the
        app-navbar partial; on a slow connection they'd each
        silently find nothing and never retry)
     6. Total balance — a single figure converted to the user's
        chosen default display currency (see FIX LOG)
     7. Hide-balance toggle — masks the total balance with
        "••••••", persisted in localStorage; see
        initBalanceVisibilityToggle() / applyBalanceVisibility()
     8. Recent transactions, spending breakdown, savings goals,
        and card preview — all scoped to the user's primary
        (first-opened) account. See the note above
        renderPrimaryAccountSections() for why.
     9. Live crypto ticker (band under the header)
    10. "Market pulse" panel — live crypto prices + finance
        headlines, with an honestly-labelled fallback if either
        feed is unreachable (never fakes "live" data)
    11. Automation showcase — animates a real stat (total saved
        across the user's goals) into the sidebar upsell card

   FIX LOG (this revision)
   ----------------------------------------------------------------
   TOTAL BALANCE CURRENCY: the balance card previously did two
   things wrong at once — it showed a per-account "account strip"
   with an "Add currency" tile bolted on, AND the headline total was
   hardcoded to `getTotalBalance(undefined, 'USD')` regardless of
   what the person actually picked in Settings -> General ->
   "Default display currency" (user_profiles.default_currency,
   settings.js's initGeneralForm()/initLanguageSelect() save it).
   Changing that setting had zero visible effect here.
   Fixed both: renderBalanceAndAccounts() no longer builds the
   account-strip markup at all (dashboard.html's account-strip
   block was removed to match — nothing calls into it anymore), and
   the total now reads the signed-in user's own profile on every
   dashboard load and converts to profile.default_currency (falling
   back to USD only for a brand-new profile that hasn't set one
   yet). Since this re-fetches the profile fresh each time
   dashboard.html loads, changing the currency in Settings and then
   opening/reloading the dashboard is enough to see it reflected —
   no separate cache to invalidate.

   PRIOR FIX LOG
   ----------------------------------------------------------------
   translation.js self-inits on DOMContentLoaded using only
   localStorage -> geo -> browser language -> English. It has no
   access to the logged-in user's saved user_profiles.language on
   its own (see that file's own header comment) — every
   authenticated page has to hand that value over once its own
   profile fetch resolves, by calling
   window.MeridianI18n.setLanguage(profile.language, { persist: false }).
   settings.js already does this in its init(). dashboard.js never
   did, so the dashboard ignored the saved profile language and
   just showed whatever localStorage/geo/browser guessed. Fixed
   below inside populateGreeting(), since it already fetches the
   profile.

   Note: this only fixes the static data-i18n markup in
   dashboard.html. The dynamic strings this file builds itself
   (greeting text, "Yesterday", transaction/type labels, empty
   states, "Last login...", market news panel, automation copy)
   are still hardcoded English with no t()-style lookup, unlike
   settings.js — those need to be wired through a translation
   helper separately.
   ============================================================= */

import { guardPage } from '../supabase/page-guard.js';
import { signOutUser } from '../supabase/auth.js';
import { supabase } from '../supabase/config.js';
import {
  getMyProfile,
  getUnreadNotificationCount,
  getMyAccounts,
  getTotalBalance,
  getTransactions,
  getSavingsGoals,
  getCardsForAccount,
} from '../supabase/database.js';

const $ = (selector, scope) => (scope || document).querySelector(selector);
const $$ = (selector, scope) => Array.from((scope || document).querySelectorAll(selector));

const CURRENCY_SYMBOLS = {
  USD: '$', EUR: '€', GBP: '£', SGD: 'S$', JPY: '¥', NGN: '₦', CAD: 'C$', AUD: 'A$', CHF: 'CHF',
};

function currencySymbol(code) {
  return CURRENCY_SYMBOLS[code] || code || '';
}

function formatAmount(value) {
  return Number(value || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** Currency-sign-first formatting ("$1,234.56", "€980.00") — the
 *  standard everywhere on the dashboard now, instead of a mix of
 *  bare numbers and numbers with a trailing currency code. */
function formatMoney(value, currency) {
  return `${currencySymbol(currency)}${formatAmount(value)}`;
}

function capitalizeWords(str) {
  return String(str || 'Transaction')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function formatTxTime(isoString) {
  const date = new Date(isoString);
  const now = new Date();
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);

  if (date.toDateString() === now.toDateString()) {
    return date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  }
  if (date.toDateString() === yesterday.toDateString()) {
    return 'Yesterday';
  }
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/** Clears any skeleton styling left over from the loading state —
 *  call this on a container right before writing real content into
 *  it, since .skeleton forces color:transparent. */
function unskeleton(el) {
  el?.classList.remove('skeleton');
}

function emptyStateNote(container, message) {
  if (!container) return;
  container.classList.remove('skeleton');
  container.innerHTML = `<p style="font-size:0.88rem;">${message}</p>`;
}

/** Small text/attribute escaper — the ticker and news panel both
 *  inject third-party strings (coin names, headline titles) into
 *  innerHTML, so anything that isn't already trusted local markup
 *  goes through this first. */
function esc(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

/* -----------------------------------------------------------
   Toasts (same pattern as the other pages)
   ----------------------------------------------------------- */
function showToast(message, variant = 'error') {
  const stack = $('#toast-stack');
  if (!stack) return;
  const toast = document.createElement('div');
  toast.className = `toast${variant === 'error' ? ' toast--error' : ' toast--success'}`;
  toast.innerHTML = `
    <svg class="toast-ic" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      ${variant === 'error'
        ? '<path d="M10 6.5v4M10 13.2v.1" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><circle cx="10" cy="10" r="8" stroke="currentColor" stroke-width="1.4"/>'
        : '<path d="M4 10.5 8 14.5 16 5.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>'}
    </svg>
    <span>${message}</span>
  `;
  stack.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(6px)';
    toast.style.transition = 'opacity 0.2s ease, transform 0.2s ease';
    setTimeout(() => toast.remove(), 220);
  }, 3200);
}

/* -----------------------------------------------------------
   Wait for the app-navbar component
   dashboard.html loads its header from components/app-navbar.html
   via components.js's loadComponents(), which runs as its own
   module and dispatches `component:loaded` on `document` once
   injection finishes. That can resolve before OR after this
   module's own async init — calling header-dependent functions
   before the partial lands means they each query for elements
   that aren't in the DOM yet and silently no-op. This checks
   whether the navbar markup is already in the DOM first, and only
   falls back to listening for the event if it isn't there yet, so
   it's correct either way. Same pattern as accounts.js/profile.js.
   ----------------------------------------------------------- */
function waitForNavbar() {
  return new Promise((resolve) => {
    if ($('.app-user-menu')) {
      resolve();
      return;
    }
    document.addEventListener('component:loaded', () => resolve(), { once: true });
  });
}

/* -----------------------------------------------------------
   Greeting + last login
   ----------------------------------------------------------- */
function timeOfDayGreeting() {
  const hour = new Date().getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

async function populateGreeting() {
  const heading = $('#dashboard-greeting');
  if (!heading) return;

  const { data: profile } = await getMyProfile();

  // FIX: apply the logged-in user's saved language preference.
  // translation.js can't know this on its own (see its header
  // comment) — every authenticated page has to hand it over once
  // its own profile fetch resolves, same as settings.js already
  // does in its init(). persist: false because this is re-applying
  // the DB's existing value, not registering a fresh manual choice.
  if (profile?.language && window.MeridianI18n) {
    window.MeridianI18n.setLanguage(profile.language, { persist: false });
  }

  const firstName = profile?.first_name;
  unskeleton(heading);
  heading.textContent = `${timeOfDayGreeting()}${firstName ? `, ${firstName}` : ''}.`;
}

/** Real "last login" line, built from login_sessions (written by
 *  auth.js on every sign-in) rather than a hardcoded string. Shows
 *  the session before the current one, since "today, just now" from
 *  this very session isn't useful context for the person reading it. */
async function populateLastLogin(userId) {
  const el = $('#dashboard-last-login');
  if (!el) return;

  const { data, error } = await supabase
    .from('login_sessions')
    .select('login_time, browser, device')
    .eq('user_id', userId)
    .order('login_time', { ascending: false })
    .range(1, 1); // skip the current session (row 0), take the one before it

  if (error || !data?.length) {
    el.textContent = '';
    return;
  }

  const last = data[0];
  const when = new Date(last.login_time).toLocaleString('en-US', {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });
  const context = [last.browser, last.device].filter(Boolean).join(' on ');
  el.textContent = `Last login ${when}${context ? ` from ${context}` : ''}.`;
}

/* -----------------------------------------------------------
   Notification badge
   ----------------------------------------------------------- */
async function populateNotificationBadge() {
  const badge = $('.app-icon-btn-badge');
  if (!badge) return;

  const { data: count } = await getUnreadNotificationCount();
  if (!count) {
    badge.style.display = 'none';
    return;
  }
  badge.textContent = count > 9 ? '9+' : String(count);
  badge.style.display = 'flex';
}

/* -----------------------------------------------------------
   Header: name + avatar
   Avatar handling now mirrors profile.js's paintAvatar(): an
   uploaded profile photo renders as an <img>, falling back to
   initials only when there isn't one. Previously this only ever
   set initials and never looked at profile.profile_photo.
   ----------------------------------------------------------- */
function initials(firstName, lastName) {
  const a = (firstName || '').trim().charAt(0);
  const b = (lastName || '').trim().charAt(0);
  return (a + b).toUpperCase() || 'M';
}

function paintAvatar(url, firstName, lastName) {
  const label = initials(firstName, lastName);
  $$('.avatar-initial--sm, .avatar-initial--lg').forEach((el) => {
    if (url) {
      el.innerHTML = `<img class="avatar-photo" src="${url}" alt="">`;
    } else {
      el.textContent = label;
    }
  });
}

async function populateHeaderIdentity() {
  const { data: profile } = await getMyProfile();
  const nameEl = $('.app-user-name');
  const firstName = profile?.first_name || '';
  const lastName = profile?.last_name || '';

  if (nameEl) nameEl.textContent = `${firstName} ${lastName}`.trim() || 'Your account';
  paintAvatar(profile?.profile_photo, firstName, lastName);
}

/* -----------------------------------------------------------
   User menu dropdown
   ----------------------------------------------------------- */
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
    if (event.key === 'Escape') {
      close();
      trigger.focus();
    }
  }

  trigger.addEventListener('click', (event) => {
    event.stopPropagation();
    if (menu.classList.contains('is-open')) close();
    else open();
  });
}

/* -----------------------------------------------------------
   Mobile nav toggle
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

/* -----------------------------------------------------------
   Log out
   ----------------------------------------------------------- */
function initLogout() {
  const logoutLink = $('#logout-link');
  if (!logoutLink) return;

  logoutLink.addEventListener('click', async (event) => {
    event.preventDefault();
    await signOutUser();
    window.location.href = logoutLink.getAttribute('href');
  });
}

/* -----------------------------------------------------------
   Hide-balance toggle
   Masks the [data-sensitive-amount] total balance element with
   "••••••". State persists across reloads via localStorage.
   Re-apply after any render that rewrites that element's
   innerHTML (renderBalanceAndAccounts does, every load), since the
   stored "real" value lives in a data attribute on the element
   itself.
   ----------------------------------------------------------- */
const BALANCE_HIDDEN_KEY = 'meridian-hide-balance';
const MASK = '••••••';
let balanceHidden = localStorage.getItem(BALANCE_HIDDEN_KEY) === 'true';

function balanceToggleIcon(hidden) {
  return hidden
    ? '<svg viewBox="0 0 20 20" fill="none" aria-hidden="true" width="18" height="18"><path d="M3 3l14 14M8.3 8.4a2.4 2.4 0 0 0 3.3 3.3M6 6.2C3.6 7.6 2 10 2 10s3 5.5 8 5.5c1.4 0 2.7-.4 3.8-1M10 4.5c5 0 8 5.5 8 5.5s-.6 1.1-1.7 2.3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>'
    : '<svg viewBox="0 0 20 20" fill="none" aria-hidden="true" width="18" height="18"><path d="M2 10s3-5.5 8-5.5S18 10 18 10s-3 5.5-8 5.5S2 10 2 10Z" stroke="currentColor" stroke-width="1.4"/><circle cx="10" cy="10" r="2.4" stroke="currentColor" stroke-width="1.4"/></svg>';
}

function applyBalanceVisibility(hidden) {
  const btn = $('#toggle-balance-visibility');
  if (btn) {
    btn.setAttribute('aria-pressed', String(hidden));
    btn.setAttribute('aria-label', hidden ? 'Show balance' : 'Hide balance');
    btn.innerHTML = balanceToggleIcon(hidden);
  }

  $$('[data-sensitive-amount]').forEach((el) => {
    if (hidden) {
      if (el.dataset.realHtml === undefined) el.dataset.realHtml = el.innerHTML;
      el.innerHTML = MASK;
    } else if (el.dataset.realHtml !== undefined) {
      el.innerHTML = el.dataset.realHtml;
      delete el.dataset.realHtml;
    }
  });
}

function initBalanceVisibilityToggle() {
  const btn = $('#toggle-balance-visibility');
  if (!btn) return;

  btn.addEventListener('click', () => {
    balanceHidden = !balanceHidden;
    localStorage.setItem(BALANCE_HIDDEN_KEY, String(balanceHidden));
    applyBalanceVisibility(balanceHidden);
  });
}

/* -----------------------------------------------------------
   Total balance
   -----------------------------------------------------------
   Shows ONE figure — the user's whole portfolio converted into
   whichever currency they've set as their "Default display
   currency" in Settings -> General (user_profiles.default_currency).
   No per-account strip / "Add currency" tile anymore (removed from
   dashboard.html to match) — accounts.html is still the place to
   see or manage individual accounts; this card is a single summary
   number by design.

   The profile is fetched fresh on every call rather than cached,
   so the figure always reflects whatever was last saved in
   Settings — no separate invalidation needed when the person
   changes their currency preference and comes back to the
   dashboard.
   ----------------------------------------------------------- */
async function renderBalanceAndAccounts(accounts) {
  const balanceEl = $('#dashboard-balance-amount') || $('.dashboard-balance-card .balance-amount');

  if (!balanceEl) return;

  if (!accounts.length) {
    unskeleton(balanceEl);
    balanceEl.innerHTML = '$0<small>.00</small>';
    return;
  }

  const { data: profile } = await getMyProfile();
  const displayCurrency = profile?.default_currency || 'USD';

  const { data: totalData } = await getTotalBalance(undefined, displayCurrency);
  unskeleton(balanceEl);
  const resolvedCurrency = totalData?.currency || displayCurrency;
  const [intPart, decPart = '00'] = Number(totalData?.total || 0).toFixed(2).split('.');
  balanceEl.innerHTML = `${currencySymbol(resolvedCurrency)}${Number(intPart).toLocaleString('en-US')}<small>.${decPart}</small>`;

  // Re-apply the persisted hide/show state — the element above was
  // just rewritten, so any earlier masking is gone.
  applyBalanceVisibility(balanceHidden);
}

/* -----------------------------------------------------------
   Recent transactions, spending breakdown, savings goals, and
   card preview — all scoped to a single "primary" account
   (the first one the user opened, per getMyAccounts()'s
   created_at ascending order).

   Why: transactions, savings_goals, and cards all key off a
   single account_id in the schema, not the user directly. A
   fully accurate dashboard would merge these across every
   account the user holds, but that means N extra queries (one
   per account per section) and de-duplicating transfers between
   a user's own accounts. For a dashboard summary, showing the
   primary account's activity — with "View all" links already in
   the markup pointing to accounts.html / transactions.html for
   the full picture — is the simpler, honest tradeoff. Revisit
   this if the product needs a true cross-account activity feed.
   ----------------------------------------------------------- */
async function renderRecentTransactions(accountId) {
  const listEl = $('.tx-list');
  if (!listEl) return;

  const { data: transactions } = await getTransactions(accountId, { limit: 3 });

  if (!transactions.length) {
    emptyStateNote(listEl, "No transactions yet — they'll show up here once money moves.");
    return;
  }

  listEl.innerHTML = '';
  transactions.forEach((tx) => {
    const isIncoming = tx.receiver_account === accountId;
    const row = document.createElement('li');
    row.className = 'tx-row';
    row.innerHTML = `
      <span class="tx-icon ${isIncoming ? 'tx-icon--in' : 'tx-icon--out'}">
        <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
          ${isIncoming
            ? '<path d="M10 17V3M4 9l6-6 6 6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>'
            : '<rect x="3" y="6" width="14" height="9" rx="1.5" stroke="currentColor" stroke-width="1.4"/>'}
        </svg>
      </span>
      <div class="tx-row-main">
        <strong>${tx.description || tx.transaction_reference || 'Transaction'}</strong>
        <span>${capitalizeWords(tx.transaction_type)}</span>
      </div>
      <span class="amt ${isIncoming ? 'pos' : ''}">${isIncoming ? '+' : '-'}${formatMoney(tx.amount, tx.currency)}</span>
      <time>${formatTxTime(tx.created_at)}</time>
    `;
    listEl.appendChild(row);
  });
}

async function renderSpendingBreakdown(accountId, currency) {
  const listEl = $('.spend-breakdown');
  if (!listEl) return;

  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);

  const { data: transactions } = await getTransactions(accountId, { from: monthStart.toISOString(), limit: 100 });

  const totals = {};
  transactions.forEach((tx) => {
    if (tx.sender_account !== accountId) return; // only outgoing counts as spend
    const key = tx.transaction_type || 'other';
    totals[key] = (totals[key] || 0) + Number(tx.amount) + Number(tx.fee || 0);
  });

  const entries = Object.entries(totals).sort((a, b) => b[1] - a[1]);

  if (!entries.length) {
    emptyStateNote(listEl, 'No spending recorded yet this month.');
    return;
  }

  const max = entries[0][1];
  listEl.innerHTML = '';
  entries.forEach(([type, amount]) => {
    const row = document.createElement('li');
    row.className = 'spend-row';
    const pct = max > 0 ? Math.max(6, Math.round((amount / max) * 100)) : 0;
    row.innerHTML = `
      <span class="spend-row-label">${capitalizeWords(type)}</span>
      <span class="spend-bar-track"><span class="spend-bar-fill" style="width:${pct}%"></span></span>
      <span class="mono">${formatMoney(amount, currency)}</span>
    `;
    listEl.appendChild(row);
  });
}

async function renderSavingsGoals(accountId, currency) {
  const goalItems = Array.from(document.querySelectorAll('.goal-item'));
  const container = goalItems.length ? goalItems[0].parentElement : null;
  goalItems.forEach((el) => el.remove());
  if (!container) return;

  const { data: goals } = await getSavingsGoals(accountId);

  if (!goals.length) {
    const p = document.createElement('p');
    p.style.fontSize = '0.88rem';
    p.textContent = 'No savings goals yet — start one to track progress here.';
    container.appendChild(p);
    return;
  }

  goals.forEach((goal) => {
    const target = Number(goal.target_amount) || 0;
    const current = Number(goal.current_amount) || 0;
    const pct = target > 0 ? Math.min(100, Math.round((current / target) * 100)) : 0;

    const item = document.createElement('div');
    item.className = 'goal-item';
    item.innerHTML = `
      <div class="goal-item-head">
        <strong>${goal.goal_name}</strong>
        <span class="mono">${formatMoney(current, currency)} / ${formatMoney(target, currency)}</span>
      </div>
      <span class="goal-bar-track"><span class="goal-bar-fill" style="width:${pct}%"></span></span>
    `;
    container.appendChild(item);
  });
}

async function renderCardPreview(accountId) {
  const previewEl = $('.mini-card-preview');
  if (!previewEl) return;

  const { data: cards } = await getCardsForAccount(accountId);

  if (!cards.length) {
    // Targets .mini-card-preview itself, not its parent .profile-card
    // — that parent also holds the "Your cards / Manage" heading,
    // which an empty state shouldn't wipe out along with it.
    emptyStateNote(previewEl, "You haven't added a card yet.");
    return;
  }

  const card = cards[0];
  const last4 = (card.card_number || '').slice(-4) || '····';
  const statusClass = card.card_status === 'Active'
    ? 'status-pill--verified'
    : card.card_status === 'Blocked'
      ? 'status-pill--blocked'
      : 'status-pill--pending';

  previewEl.innerHTML = `
    <div class="mini-card mini-card--dark">
      <span>MERIDIAN</span>
      <span class="mono">···· ${last4}</span>
    </div>
    <div>
      <strong>${capitalizeWords(card.card_type)} card</strong>
      <span class="status-pill ${statusClass}">${card.card_status || 'Pending'}</span>
    </div>
  `;
}

async function renderPrimaryAccountSections(accounts) {
  if (!accounts.length) {
    emptyStateNote($('.tx-list'), 'Open your first account to start seeing transactions here.');
    emptyStateNote($('.spend-breakdown'), 'Open your first account to see spending by category.');
    const goalItems = Array.from(document.querySelectorAll('.goal-item'));
    if (goalItems.length) emptyStateNote(goalItems[0].parentElement, 'Open an account to start a savings goal.');
    emptyStateNote($('.mini-card-preview'), 'Open an account to add a card.');
    return;
  }

  const primaryAccountId = accounts[0].id;
  const primaryCurrency = accounts[0].currency;

  await Promise.all([
    renderRecentTransactions(primaryAccountId),
    renderSpendingBreakdown(primaryAccountId, primaryCurrency),
    renderSavingsGoals(primaryAccountId, primaryCurrency),
    renderCardPreview(primaryAccountId),
  ]);
}

/* =============================================================
   LIVE CRYPTO TICKER
   Populates the .ticker-band already in dashboard.html (the same
   component the marketing homepage uses) with real prices from
   CoinGecko's public, key-free endpoint. Refreshes on an interval
   so the band stays "live" while the dashboard is open.
   ============================================================= */
const TICKER_COINS = [
  { id: 'bitcoin', symbol: 'BTC' },
  { id: 'ethereum', symbol: 'ETH' },
  { id: 'solana', symbol: 'SOL' },
  { id: 'ripple', symbol: 'XRP' },
  { id: 'cardano', symbol: 'ADA' },
  { id: 'dogecoin', symbol: 'DOGE' },
];
const TICKER_REFRESH_MS = 90_000;

async function fetchCryptoPrices() {
  const ids = TICKER_COINS.map((c) => c.id).join(',');
  const url = `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd&include_24hr_change=true`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`CoinGecko ${res.status}`);
  return res.json();
}

function tickerItemMarkup(symbol, price, change) {
  const isUp = change >= 0;
  const priceStr = price >= 1
    ? price.toLocaleString('en-US', { maximumFractionDigits: 2, minimumFractionDigits: 2 })
    : price.toLocaleString('en-US', { maximumFractionDigits: 4 });
  return `
    <div class="ticker-item">
      <span class="pair">${esc(symbol)}/USD</span>
      <span class="mono">$${priceStr}</span>
      <span class="delta ${isUp ? 'pos' : 'neg'}">${isUp ? '▲' : '▼'} ${Math.abs(change).toFixed(2)}%</span>
    </div>
  `;
}

async function initDashboardTicker() {
  const track = $('#dashboard-ticker-track');
  if (!track) return;

  async function refresh() {
    try {
      const prices = await fetchCryptoPrices();
      const itemsHtml = TICKER_COINS
        .filter((c) => prices[c.id])
        .map((c) => tickerItemMarkup(c.symbol, prices[c.id].usd, prices[c.id].usd_24h_change || 0))
        .join('');
      // Duplicated once so the CSS marquee (if it scrolls the track's
      // full width) loops seamlessly instead of snapping at the end.
      track.innerHTML = itemsHtml + itemsHtml;
    } catch (err) {
      track.innerHTML = '<div class="ticker-item"><span class="pair">Market data unavailable right now</span></div>';
    }
  }

  await refresh();
  setInterval(refresh, TICKER_REFRESH_MS);
}

/* =============================================================
   MARKET PULSE PANEL
   A new card injected into the main column: live crypto prices
   at a glance plus a small finance-headlines feed. If the news
   feed can't be reached, the panel honestly relabels itself
   "Insights" and shows evergreen tips instead of pretending
   stale content is live — never fakes a live feed.
   ============================================================= */
async function fetchFinanceHeadlines() {
  const rssUrl = encodeURIComponent('https://www.cnbc.com/id/10001147/device/rss/rss.html');
  const res = await fetch(`https://api.rss2json.com/v1/api.json?rss_url=${rssUrl}&count=4`);
  if (!res.ok) throw new Error(`rss2json ${res.status}`);
  const data = await res.json();
  if (data.status !== 'ok' || !data.items?.length) throw new Error('empty feed');
  return data.items.slice(0, 4).map((item) => ({
    title: item.title,
    link: item.link,
    source: 'CNBC Finance',
  }));
}

const FALLBACK_INSIGHTS = [
  { title: 'Automating a fixed transfer the day you get paid is the single easiest way to make saving stick.' },
  { title: 'Splitting savings into named goals (a trip, an emergency fund) tends to keep money there longer than one generic pot.' },
  { title: 'Reviewing recurring subscriptions once a quarter is a quick way to catch spend creep.' },
  { title: 'Keeping 1–2 months of expenses in an easy-access account covers most short-notice costs without touching savings goals.' },
];

function renderMarketNewsCard(container, items, isLive) {
  const heading = isLive ? 'Market pulse' : 'Insights';
  const sub = isLive ? 'Live headlines' : 'Shown while live headlines are unavailable';

  container.innerHTML = `
    <div class="profile-card-head">
      <h3>
        ${isLive ? '<span class="live-dot" aria-hidden="true"></span>' : ''}
        ${heading}
      </h3>
      <span class="tx-summary-label">${sub}</span>
    </div>
    <ul class="market-news-list">
      ${items.map((item) => `
        <li class="news-item">
          ${item.link
            ? `<a href="${esc(item.link)}" target="_blank" rel="noopener noreferrer">${esc(item.title)}</a>`
            : `<span>${esc(item.title)}</span>`}
          ${item.source ? `<span class="news-item-source">${esc(item.source)}</span>` : ''}
        </li>
      `).join('')}
    </ul>
  `;
}

async function initMarketNewsPanel() {
  const mainCol = $('.dashboard-main-col');
  const balanceCard = $('.dashboard-balance-card');
  if (!mainCol || !balanceCard) return;

  const section = document.createElement('section');
  section.className = 'profile-card market-news-card';
  section.innerHTML = `
    <div class="profile-card-head">
      <h3><span class="live-dot" aria-hidden="true"></span> Market pulse</h3>
      <span class="tx-summary-label">Loading…</span>
    </div>
    <ul class="market-news-list">
      <li class="news-item skeleton" style="height:1.1rem;"></li>
      <li class="news-item skeleton" style="height:1.1rem;"></li>
      <li class="news-item skeleton" style="height:1.1rem;"></li>
    </ul>
  `;
  balanceCard.insertAdjacentElement('afterend', section);

  try {
    const headlines = await fetchFinanceHeadlines();
    renderMarketNewsCard(section, headlines, true);
  } catch (err) {
    renderMarketNewsCard(section, FALLBACK_INSIGHTS, false);
  }
}

/* =============================================================
   AUTOMATION SHOWCASE
   Enhances the existing "Automate your money" upsell card with a
   real, animated stat pulled from the user's own savings goals —
   total currently automated and how many goals it's spread
   across — instead of a generic static pitch. Prefix now uses the
   funding account's own currency symbol rather than a hardcoded $.
   ============================================================= */
function animateCount(el, target, { prefix = '', duration = 1100 } = {}) {
  if (!el) return;
  const start = performance.now();
  const from = 0;
  function tick(now) {
    const progress = Math.min(1, (now - start) / duration);
    const eased = 1 - Math.pow(1 - progress, 3); // ease-out cubic
    const value = from + (target - from) * eased;
    el.textContent = `${prefix}${value.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
    if (progress < 1) requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}

async function enhanceAutomationShowcase(accountId, currency) {
  const upsell = $('.dashboard-upsell');
  if (!upsell) return;

  const statRow = document.createElement('div');
  statRow.className = 'automation-stat-row';
  const actions = $('.automation-card-actions', upsell);
  if (actions) upsell.insertBefore(statRow, actions);
  else upsell.appendChild(statRow);

  if (!accountId) {
    statRow.innerHTML = `<p class="automation-stat-empty">Open an account to start automating your savings.</p>`;
    return;
  }

  const { data: goals } = await getSavingsGoals(accountId);

  if (!goals?.length) {
    statRow.innerHTML = `<p class="automation-stat-empty">You're not automating any savings yet — start your first goal below.</p>`;
    return;
  }

  const total = goals.reduce((sum, g) => sum + (Number(g.current_amount) || 0), 0);

  statRow.innerHTML = `
    <span class="automation-stat-value mono" id="automation-stat-value">0</span>
    <span class="automation-stat-label">saved automatically across ${goals.length} goal${goals.length === 1 ? '' : 's'}</span>
  `;
  animateCount($('#automation-stat-value', statRow), total, { prefix: currencySymbol(currency || 'USD') });
}

/* -----------------------------------------------------------
   Init
   ----------------------------------------------------------- */
(async function init() {
  const user = await guardPage();
  if (!user) return; // guardPage() already redirected to login.html

  populateGreeting();
  populateLastLogin(user.id);
  initDashboardTicker();
  initMarketNewsPanel();
  initBalanceVisibilityToggle();

  // Header-dependent init waits for the app-navbar component to
  // actually be in the DOM — see waitForNavbar() above.
  waitForNavbar().then(() => {
    populateHeaderIdentity();
    populateNotificationBadge();
    initUserMenu();
    initMobileNav();
    initLogout();
  });

  const { data: accounts, error } = await getMyAccounts(user.id);
  if (error) showToast("Couldn't load your accounts. Please refresh.");

  await renderBalanceAndAccounts(accounts || []);
  await renderPrimaryAccountSections(accounts || []);
  await enhanceAutomationShowcase(accounts?.[0]?.id, accounts?.[0]?.currency);
})();
