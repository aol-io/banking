/* =============================================================
   MERIDIAN — Send money page
   Script: pages/transfer.js

   Changes in THIS pass:

   D. TRANSACTION EMAIL NOTIFICATIONS — every completed transfer
      now fires the same sendTransactionEmail() helper the admin
      panel's reversal flow already uses (assets/js/email.js).
      Two sends, both fire-and-forget (a failed send is logged but
      never blocks the UI, same pattern as
      admin-transactions.js's reversal email):
        - 'transfer_sent'     -> the sender, using the profile
          fetched once at init (myProfile) rather than a fresh
          query per send.
        - 'transfer_received' -> the receiver, but ONLY when the
          receiver is an internal Meridian account. An external
          beneficiary has no Meridian login/email to notify, so
          resolveReceiverContact() (copied from
          admin-transactions.js's identical helper) resolves
          tx.receiver_account -> accounts.user_id ->
          user_profiles.email and simply returns null when there's
          nothing to resolve.
      Requires the EmailJS SDK script tag added to transfer.html
      before this file (see that file's own change note).

   ---- Everything below this point (A, B, C from the previous
   revision) is unchanged. ----

   A. HEADER — transfer.html now loads the shared app-navbar
      component (same as dashboard.html/profile.html) instead of
      its own hand-written header, which never had a notification
      dropdown panel at all. Since that component now loads
      asynchronously, populateHeader()/initUserMenu()/initLogout()
      are deferred behind waitForNavbar() — same pattern
      dashboard.js already uses — instead of running immediately
      and silently finding nothing.

   B. EXCHANGE RATE STABILITY — recalcConversion() previously ran
      a fresh network round-trip (getExchangeRate + a second one
      inside getLimitsInCurrency for non-USD currencies) on EVERY
      keystroke in the amount field. Typing quickly fired several
      overlapping requests that could resolve out of order, so an
      older/slower response could land after a newer one and the
      displayed rate would visibly flip back and forth. This also
      made the minimum-transfer warning feel slow, since it was
      re-doing that full round trip on every keystroke too, even
      though the rate for a given currency pair doesn't change
      between keystrokes.

      Fixed two ways:
        1. getCachedRate() and the cache added to
           getLimitsInCurrency() only hit the network when the
           CURRENCY PAIR changes, not on every amount keystroke.
        2. rateCallToken is a staleness guard — if a newer
           recalcConversion() call starts while an older one is
           still awaiting the network, the older one's result is
           discarded instead of painting over the newer one.

   C. HERO_COPY reworded for a warmer, more professional tone.

   NOTE: the "beneficiaries not displaying" issue is NOT touched
   in this pass. RLS and the addBeneficiary()/getMyBeneficiaries()
   code were checked and are correct — the open question is
   whether rows exist in the table at all, which needs one more
   SQL query before a real fix (vs. a guess) can be written.
   ============================================================= */

import { signOutUser } from '../supabase/auth.js';
import { guardPage } from '../supabase/page-guard.js';
import { verifyCurrentPassword } from '../supabase/auth.js';
import { supabase } from '../supabase/config.js'; // NEW — used by resolveReceiverContact()
import {
  getMyProfile,
  getUnreadNotificationCount,
  getMyAccounts,
  getMyBeneficiaries,
  addBeneficiary,
  findRecipient,
  getExchangeRate,
  createTransfer,
  getTransferPolicy,
  getMyTransferLimitOverrides,
} from '../supabase/database.js';
import { sendTransactionEmail } from '../assets/js/email.js'; // NEW

const $ = (selector, scope) => (scope || document).querySelector(selector);
const $$ = (selector, scope) => Array.from((scope || document).querySelectorAll(selector));

const CURRENCY_SYMBOLS = {
  USD: '$', EUR: '€', GBP: '£', SGD: 'S$', JPY: '¥', NGN: '₦', CAD: 'C$', AUD: 'A$', CHF: 'CHF',
};

// Best-effort ONLY — a Meridian account's currency doesn't reliably
// tell you the holder's country (a USD account isn't necessarily
// US-based). Used purely to fill the recipient card's Country row
// with something more useful than a blank dash, until
// find_account_holder() is extended to return a real country.
const CURRENCY_COUNTRY_HINT = {
  USD: 'United States', EUR: 'Eurozone', GBP: 'United Kingdom', SGD: 'Singapore',
  JPY: 'Japan', NGN: 'Nigeria', CAD: 'Canada', AUD: 'Australia', CHF: 'Switzerland',
};

const RECENT_RECIPIENTS_KEY = 'meridian_recent_recipients';
const TOTAL_STEPS = 5;
const MAX_AUTH_ATTEMPTS = 5;
const AUTH_LOCKOUT_MS = 60000;

const ACCOUNT_NUMBER_MIN_LENGTH = 10;

const HERO_COPY = {
  1: {
    title: "Who's this transfer for?",
    sub: "Enter an account number, IBAN, or Meridian tag and we'll verify your recipient automatically — always at the mid-market rate, with every fee shown upfront.",
  },
  2: {
    title: 'How much would you like to send?',
    sub: "We'll show you exactly what arrives on the other end, so there's never a surprise later.",
  },
  3: {
    title: 'Review your transfer',
    sub: 'Take a moment to check everything below — you can still make changes before confirming.',
  },
  4: {
    title: "Let's confirm it's you",
    sub: 'Just one more step to keep your money safe.',
  },
  5: {
    title: 'Transfer sent!',
    sub: "You're all set — track this transfer anytime from your transaction history.",
  },
};

function currencySymbol(code) {
  return CURRENCY_SYMBOLS[code] || code || '';
}

function formatAmount(value) {
  return Number(value || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function setCardHidden(elId, isHidden) {
  const el = document.getElementById(elId);
  if (!el) {
    console.warn(`[Meridian] transfer.js expected an element with id="${elId}" but didn't find one — check transfer.html.`);
    return;
  }
  el.hidden = isHidden;
  el.style.display = isHidden ? 'none' : '';
}

/* -----------------------------------------------------------
   State
   ----------------------------------------------------------- */
let accounts = [];
let beneficiaries = [];
let currentStep = 1;
let selectedFromAccountId = null;
let selectedBeneficiary = null;
let verifiedRecipient = null;
let identifierLookupTimer = null;
let authFailedAttempts = 0;
let authLockedUntil = 0;
let lastTransferReceipt = null; // populated right before step 5, read by the PDF download
let effectiveLimits = null; // { maxSingleTransfer, minTransfer, dailyTransferLimit }, resolved once per wizard pass
let myProfile = null; // NEW — the sender's own profile, fetched once at init for transfer_sent emails

// Caches so recalcConversion() only hits the network when the
// currency pair actually changes, not on every amount keystroke.
let limitsByCurrency = new Map();  // currency -> converted limits
let rateCallToken = 0;             // staleness guard for recalcConversion
let cachedRatePair = null;         // `${from}_${to}` of the last-fetched rate
let cachedRateResult = null;       // { rate, isFallback } for cachedRatePair

/* -----------------------------------------------------------
   Toasts
   ----------------------------------------------------------- */
function showToast(message, variant = 'success') {
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
    <span>${escapeHtml(message)}</span>
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
   Header
   ----------------------------------------------------------- */
async function populateHeader() {
  const nameEl = $('.app-user-name');
  const avatarEl = $('.app-user-trigger .avatar-initial');

  const { data: profile } = await getMyProfile();
  const firstName = profile?.first_name || '';
  const lastName = profile?.last_name || '';
  const fullName = `${firstName} ${lastName}`.trim() || 'Your account';

  if (nameEl) nameEl.textContent = fullName;
  if (avatarEl) avatarEl.textContent = (firstName[0] || 'M').toUpperCase();

  const badge = $('.app-icon-btn-badge');
  if (badge) {
    const { data: count } = await getUnreadNotificationCount();
    if (count) {
      badge.textContent = count > 9 ? '9+' : String(count);
      badge.style.display = 'flex';
    } else {
      badge.style.display = 'none';
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
    if (event.key === 'Escape') {
      close();
      trigger.focus();
    }
  }

  trigger.addEventListener('click', (event) => {
    event.stopPropagation();
    menu.classList.contains('is-open') ? close() : open();
  });
}

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
   Wait for the app-navbar component
   transfer.html now loads its header from components/app-navbar.html
   via components.js's loadComponents(), same as dashboard.html/
   profile.js. That can resolve before OR after this module's own
   async init — calling header-dependent functions before the
   partial lands means they each query for elements that aren't in
   the DOM yet and silently no-op. This checks whether the navbar
   markup is already there first, and only falls back to listening
   for the event if it isn't yet.
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
   Receiver contact lookup (NEW)
   -----------------------------------------------------------
   Identical to admin-transactions.js's resolveReceiverContact():
   the committed transaction row only carries sender_account/
   receiver_account (account ids), not an email address. Resolves
   the account that RECEIVED the money -> its owning user_profiles
   row, so a 'transfer_received' notification has somewhere real
   to send. Returns { email: null, name: null } for an external
   transfer (no receiver_account) or a receiver account whose owner
   can't be found — callers treat that as "nothing to notify",
   never as an error.
   ----------------------------------------------------------- */
async function resolveReceiverContact(tx) {
  if (!tx?.receiver_account) return { email: null, name: null };

  const { data: account } = await supabase
    .from('accounts')
    .select('user_id')
    .eq('id', tx.receiver_account)
    .maybeSingle();

  if (!account?.user_id) return { email: null, name: null };

  const { data: profile } = await supabase
    .from('user_profiles')
    .select('email, first_name, last_name')
    .eq('id', account.user_id)
    .maybeSingle();

  if (!profile) return { email: null, name: null };

  return {
    email: profile.email,
    name: [profile.first_name, profile.last_name].filter(Boolean).join(' ') || 'Customer',
  };
}

/* -----------------------------------------------------------
   Wizard navigation
   ----------------------------------------------------------- */
function goToStep(n) {
  currentStep = n;
  $$('.send-panel').forEach((panel) => panel.classList.toggle('is-active', Number(panel.dataset.panel) === n));
  $$('.send-rail-step').forEach((step) => {
    const stepNum = Number(step.dataset.step);
    step.classList.toggle('is-active', stepNum === n);
    step.classList.toggle('is-complete', stepNum < n);
  });

  const fill = $('#send-rail-fill');
  if (fill) fill.style.width = `${((n - 1) / (TOTAL_STEPS - 1)) * 100}%`;

  const copy = HERO_COPY[n];
  const titleEl = $('#send-hero-title');
  const subEl = $('#send-hero-sub');
  if (copy && titleEl && subEl) {
    titleEl.style.opacity = '0';
    subEl.style.opacity = '0';
    setTimeout(() => {
      titleEl.textContent = copy.title;
      subEl.textContent = n === 2 ? `Sending to ${getRecipientSummary().name || 'your recipient'} — check the numbers as you type.` : copy.sub;
      titleEl.style.opacity = '1';
      subEl.style.opacity = '1';
    }, 120);
  }

  if (n === 2) recalcConversion();
  if (n === 3 || n === 4) populateReview();

  updateLedger();

  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function wireSegmented(name) {
  const inputs = $$(`input[name="${name}"]`);
  inputs.forEach((input) => {
    input.addEventListener('change', () => {
      inputs.forEach((i) => i.closest('.send-segmented-btn')?.classList.toggle('is-selected', i.checked));
    });
  });
}

/* -----------------------------------------------------------
   The Ledger
   ----------------------------------------------------------- */
function updateLedger() {
  const ledger = $('#ledger');
  if (!ledger) return;

  const recipient = getRecipientSummary();
  const hasRecipient = Boolean(recipient.name);

  $('#ledger-avatar').textContent = hasRecipient ? recipient.name.trim().charAt(0).toUpperCase() : '·';
  $('#ledger-name').textContent = hasRecipient ? recipient.name : 'Add a recipient';
  $('#ledger-meta').textContent = hasRecipient ? (recipient.meta || '\u2014') : 'Their details will appear here';
  $('#ledger-seal').classList.toggle('is-visible', hasRecipient && !recipient.isNew);

  const fromAccount = currentFromAccount();
  const sendAmount = Number($('#transfer-send-amount')?.value) || 0;
  const toCurrency = $('#transfer-receive-currency')?.value || 'USD';
  const receiveAmount = Number($('#transfer-receive-amount')?.value) || 0;

  $('#ledger-send-amount').textContent = fromAccount ? `${currencySymbol(fromAccount.currency)}${formatAmount(sendAmount)}` : formatAmount(sendAmount);
  $('#ledger-receive-amount').textContent = `${currencySymbol(toCurrency)}${formatAmount(receiveAmount)}`;

  $('#ledger-rate').textContent = $('#fee-rate-note-value')?.textContent || '—';
  $('#ledger-fee').textContent = $('#fee-amount-value')?.textContent || '—';
  $('#ledger-arrives').textContent = $('#fee-arrives-value')?.textContent || '—';
  $('#ledger-available').textContent = $('#fee-available-value')?.textContent || '—';
  $('#ledger-remaining').textContent = $('#fee-remaining-value')?.textContent || '—';
  $('#ledger-total').textContent = $('#fee-total-value')?.textContent || '—';

  const eyebrow = $('#ledger-eyebrow');
  const footText = $('#ledger-foot-text');
  const stamp = $('#ledger-stamp');

  if (currentStep === 5) {
    eyebrow.textContent = 'Transfer receipt';
    footText.textContent = 'Completed transfer';
    ledger.classList.add('is-complete');
    stamp.classList.add('is-visible');
  } else {
    eyebrow.textContent = 'Transfer ledger';
    footText.textContent = 'Verified before every send';
    ledger.classList.remove('is-complete');
    stamp.classList.remove('is-visible');
  }
}

/* -----------------------------------------------------------
   Saved beneficiaries
   ----------------------------------------------------------- */
function maskAccount(value) {
  if (!value) return '';
  const clean = String(value).replace(/\s+/g, '');
  return clean.length > 4 ? `···· ${clean.slice(-4)}` : clean;
}

function beneficiaryInitial(b) {
  return (b?.beneficiary_name || '?').trim().charAt(0).toUpperCase();
}

function beneficiarySubtitle(b) {
  return [b?.bank_name, maskAccount(b?.account_number)].filter(Boolean).join(' · ');
}

function renderBeneficiaryList(filterText = '') {
  const container = $('#beneficiary-list');
  if (!container) return;
  const q = filterText.trim().toLowerCase();

  if (!beneficiaries.length) {
    container.innerHTML = `
      <div class="send-empty">
        <div class="send-empty-icon">
          <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="12" cy="8" r="3.5" stroke="currentColor" stroke-width="1.5"/><path d="M4.5 19.5c0-3.6 3.4-6 7.5-6s7.5 2.4 7.5 6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
        </div>
        <h3>No saved beneficiaries yet</h3>
        <p>Add a recipient above — you'll be able to choose them here next time.</p>
      </div>
    `;
    return;
  }

  const filtered = beneficiaries.filter(
    (b) => !q || b.beneficiary_name?.toLowerCase().includes(q) || b.bank_name?.toLowerCase().includes(q)
  );

  if (!filtered.length) {
    container.innerHTML = `<p class="balance-note">No saved recipients match "${escapeHtml(filterText)}".</p>`;
    return;
  }

  container.innerHTML = filtered
    .map(
      (b) => `
    <label class="beneficiary-card${selectedBeneficiary?.id === b.id ? ' is-selected' : ''}" data-beneficiary-id="${b.id}">
      <input type="radio" name="beneficiary" value="${b.id}" ${selectedBeneficiary?.id === b.id ? 'checked' : ''}>
      <span class="avatar-initial avatar-initial--sm">${beneficiaryInitial(b)}</span>
      <span class="beneficiary-card-info">
        <strong>${escapeHtml(b.beneficiary_name)}</strong>
        <span>${escapeHtml(beneficiarySubtitle(b))}</span>
      </span>
      <span class="beneficiary-card-check">
        <svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3 8.5 6.5 12 13 4.5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </span>
    </label>
  `
    )
    .join('');

  $$('.beneficiary-card', container).forEach((card) => {
    card.addEventListener('click', () => {
      const id = card.dataset.beneficiaryId;
      selectedBeneficiary = beneficiaries.find((b) => String(b.id) === id) || null;
      resetNewRecipientUi();
      $('#recipient-identifier').value = '';
      $$('.beneficiary-card', container).forEach((c) => c.classList.toggle('is-selected', c === card));
      pushRecentRecipient(selectedBeneficiary);
      updateStep1ContinueState();
      updateLedger();
    });
  });
}

/* -----------------------------------------------------------
   Recent recipients
   ----------------------------------------------------------- */
function getRecentIds() {
  try {
    return JSON.parse(localStorage.getItem(RECENT_RECIPIENTS_KEY) || '[]');
  } catch {
    return [];
  }
}

function pushRecentRecipient(b) {
  if (!b?.id) return;
  let ids = getRecentIds().filter((id) => String(id) !== String(b.id));
  ids.unshift(b.id);
  ids = ids.slice(0, 6);
  try {
    localStorage.setItem(RECENT_RECIPIENTS_KEY, JSON.stringify(ids));
  } catch {
    /* ignore quota/availability errors */
  }
}

function renderRecentStrip() {
  const wrap = $('#recipient-recent-wrap');
  const strip = $('#recipient-recent-strip');
  if (!wrap || !strip) return;

  const matches = getRecentIds()
    .map((id) => beneficiaries.find((b) => String(b.id) === String(id)))
    .filter(Boolean);

  if (!matches.length) {
    setCardHidden('recipient-recent-wrap', true);
    return;
  }
  setCardHidden('recipient-recent-wrap', false);
  strip.innerHTML = matches
    .map(
      (b) => `
    <button type="button" class="send-quick-chip" data-recent-id="${b.id}" title="${escapeHtml(b.beneficiary_name)}">
      <span class="avatar-initial">${beneficiaryInitial(b)}</span>
      <span>${escapeHtml((b.beneficiary_name || '').split(' ')[0] || '—')}</span>
    </button>
  `
    )
    .join('');

  $$('.send-quick-chip', strip).forEach((chip) => {
    chip.addEventListener('click', () => {
      const b = beneficiaries.find((x) => String(x.id) === chip.dataset.recentId);
      if (!b) return;
      selectedBeneficiary = b;
      resetNewRecipientUi();
      $('#recipient-identifier').value = '';
      $('#beneficiary-search').value = '';
      renderBeneficiaryList('');
      pushRecentRecipient(b);
      updateStep1ContinueState();
      updateLedger();
    });
  });
}

/* -----------------------------------------------------------
   New recipient — account-number auto-verification
   ----------------------------------------------------------- */
function toggleVerifiedSaveOption(show) {
  const card = $('#recipient-verified-card');
  if (!card) return;
  let row = $('#save-verified-beneficiary-row', card);
  if (show) {
    if (!row) {
      row = document.createElement('label');
      row.id = 'save-verified-beneficiary-row';
      row.className = 'send-checkbox';
      row.innerHTML = `
        <input type="checkbox" id="save-verified-beneficiary-checkbox" checked>
        Save this recipient as a beneficiary for future transfers
      `;
      const clearBtn = $('#recipient-verified-clear', card);
      if (clearBtn) clearBtn.insertAdjacentElement('beforebegin', row);
      else card.appendChild(row);
    }
    row.hidden = false;
  } else if (row) {
    row.hidden = true;
  }
}

function showVerifiedCard({ name, bank, account, country, initial, isInternal = false }) {
  $('#recipient-verified-name').textContent = name || '—';
  $('#recipient-verified-bank').textContent = bank || '—';
  $('#recipient-verified-account').textContent = account ? maskAccount(account) : '—';
  $('#recipient-verified-country').textContent = country || '—';
  $('#recipient-verified-avatar').textContent = initial || '?';
  setCardHidden('recipient-verified-card', false);
  setCardHidden('recipient-not-found-card', true);
  setCardHidden('recipient-manual-fields', true);
  toggleVerifiedSaveOption(isInternal);
}

function resetNewRecipientUi() {
  verifiedRecipient = null;
  setCardHidden('recipient-verified-card', true);
  setCardHidden('recipient-not-found-card', true);
  setCardHidden('recipient-manual-fields', true);
  toggleVerifiedSaveOption(false);
  const statusEl = $('#recipient-lookup-status');
  if (statusEl) statusEl.innerHTML = '';
}

function handleIdentifierInput(event) {
  const value = event.target.value;
  clearTimeout(identifierLookupTimer);
  resetNewRecipientUi();
  selectedBeneficiary = null;
  renderBeneficiaryList($('#beneficiary-search')?.value || '');
  updateStep1ContinueState();
  updateLedger();

  const trimmed = value.trim();
  if (!trimmed) return;

  if (trimmed.replace(/\s+/g, '').length < ACCOUNT_NUMBER_MIN_LENGTH) return;

  const statusEl = $('#recipient-lookup-status');
  statusEl.innerHTML = `<span class="recipient-lookup-spinner"></span> Verifying recipient…`;

  identifierLookupTimer = setTimeout(async () => {
    const { data } = await findRecipient(value, { beneficiaries });

    if (data?.source === 'beneficiary') {
      verifiedRecipient = data;
      const b = data.beneficiary;
      showVerifiedCard({
        name: b.beneficiary_name,
        bank: b.bank_name,
        account: b.account_number,
        country: b.country,
        initial: beneficiaryInitial(b),
        isInternal: false,
      });
      statusEl.innerHTML = '';
    } else if (data?.source === 'internal') {
      verifiedRecipient = data;
      showVerifiedCard({
        name: data.display_name,
        bank: `${data.bank_name} · ${data.currency} Meridian account`,
        account: value,
        country: CURRENCY_COUNTRY_HINT[data.currency] ? `${CURRENCY_COUNTRY_HINT[data.currency]} (est.)` : '—',
        initial: (data.display_name || '?').charAt(0).toUpperCase(),
        isInternal: true,
      });
      statusEl.innerHTML = '';
    } else {
      statusEl.innerHTML = '';
      setCardHidden('recipient-not-found-card', false);
      setCardHidden('recipient-manual-fields', false);
      const manualAccountInput = $('#new-beneficiary-account');
      if (manualAccountInput) manualAccountInput.value = value;
    }
    updateStep1ContinueState();
    updateLedger();
  }, 550);
}

function manualFieldsValid() {
  return Boolean(
    $('#new-beneficiary-name').value.trim() &&
    $('#new-beneficiary-bank').value.trim() &&
    $('#new-beneficiary-account').value.trim()
  );
}

function updateStep1ContinueState() {
  const valid = Boolean(selectedBeneficiary) || Boolean(verifiedRecipient) || (!$('#recipient-manual-fields').hidden && manualFieldsValid());
  $('#step1-continue').disabled = !valid;
}

function getRecipientSummary() {
  if (selectedBeneficiary) {
    return {
      name: selectedBeneficiary.beneficiary_name,
      meta: beneficiarySubtitle(selectedBeneficiary),
      currency: null,
      beneficiaryId: selectedBeneficiary.id,
      isNew: false,
    };
  }
  if (verifiedRecipient?.source === 'beneficiary') {
    const b = verifiedRecipient.beneficiary;
    return { name: b.beneficiary_name, meta: beneficiarySubtitle(b), currency: null, beneficiaryId: b.id, isNew: false };
  }
  if (verifiedRecipient?.source === 'internal') {
    return {
      name: verifiedRecipient.display_name,
      meta: `${verifiedRecipient.bank_name} · ${verifiedRecipient.currency}`,
      currency: verifiedRecipient.currency,
      beneficiaryId: null,
      isNew: false,
      isInternal: true,
    };
  }
  const nameVal = $('#new-beneficiary-name')?.value.trim();
  if (!nameVal && !$('#new-beneficiary-bank')?.value.trim()) {
    return { name: '', meta: '', currency: null, beneficiaryId: null, isNew: true };
  }
  const countrySelect = $('#new-beneficiary-country');
  return {
    name: nameVal,
    meta: [$('#new-beneficiary-bank').value.trim(), countrySelect.options[countrySelect.selectedIndex]?.textContent].filter(Boolean).join(' · '),
    currency: null,
    beneficiaryId: null,
    isNew: true,
    manual: {
      beneficiaryName: nameVal,
      bankName: $('#new-beneficiary-bank').value.trim(),
      accountNumber: $('#new-beneficiary-account').value.trim(),
      swiftCode: $('#new-beneficiary-swift').value.trim(),
      country: countrySelect.value,
    },
  };
}

function getRecipientIdentifierForTransfer() {
  if (selectedBeneficiary?.account_number) return selectedBeneficiary.account_number;
  if (verifiedRecipient?.source === 'beneficiary') return verifiedRecipient.beneficiary?.account_number || null;
  if (verifiedRecipient?.source === 'internal') return $('#recipient-identifier')?.value.trim() || null;
  const manualAccount = $('#new-beneficiary-account')?.value.trim();
  return manualAccount || null;
}

/* -----------------------------------------------------------
   Amount step — from-account picker
   ----------------------------------------------------------- */
function currentFromAccount() {
  return accounts.find((a) => String(a.id) === String(selectedFromAccountId));
}

function renderFromAccountStrip() {
  const strip = $('#from-account-strip');
  if (!strip) return;

  if (!accounts.length) {
    strip.innerHTML = `<p class="balance-note">Open a currency account before you can send money.</p>`;
    return;
  }
  if (!selectedFromAccountId || !currentFromAccount()) selectedFromAccountId = accounts[0].id;

  strip.innerHTML = accounts
    .map((a) => {
      const selected = String(a.id) === String(selectedFromAccountId);
      return `
      <button type="button" class="send-account-pill" data-account-id="${a.id}"
              role="radio" aria-checked="${selected}">
        <span class="send-account-pill-flag">${currencySymbol(a.currency)}</span>
        <span class="send-account-pill-text">
          <strong>${a.currency} account</strong>
          <span>${formatAmount(a.available_balance ?? a.balance)}</span>
        </span>
      </button>
    `;
    })
    .join('');

  $$('.send-account-pill[data-account-id]', strip).forEach((btn) => {
    btn.addEventListener('click', () => {
      selectedFromAccountId = btn.dataset.accountId;
      renderFromAccountStrip();
      recalcConversion();
    });
  });
}

/* -----------------------------------------------------------
   Live conversion + fee breakdown
   ----------------------------------------------------------- */
function computeFee(amount, speed) {
  const amt = Math.max(0, Number(amount) || 0);
  return speed === 'instant' ? Math.max(2.5, +(amt * 0.012).toFixed(2)) : Math.max(1, +(amt * 0.0021).toFixed(2));
}

function ensureFeeCache() {
  if ($('#fee-rate-note-value')) return;
  const cache = document.createElement('div');
  cache.hidden = true;
  cache.innerHTML = `
    <span id="fee-rate-note-value"></span>
    <span id="fee-amount-value"></span>
    <span id="fee-available-value"></span>
    <span id="fee-total-value"></span>
    <span id="fee-remaining-value"></span>
    <span id="fee-arrives-value"></span>
  `;
  document.body.appendChild(cache);
}

/**
 * Only re-fetches the exchange rate when the currency pair itself
 * changes. The rate doesn't move between keystrokes on the amount
 * field, so there's no reason to hit the network on every single
 * one. This is what makes the rate row (and the minimum-transfer
 * message, which depends on it) feel instant instead of laggy, and
 * stops the flicker from overlapping requests resolving out of
 * order.
 */
async function getCachedRate(fromCurrency, toCurrency) {
  const pairKey = `${fromCurrency}_${toCurrency}`;
  if (cachedRatePair === pairKey && cachedRateResult) return cachedRateResult;

  const { data: rateData } = await getExchangeRate(fromCurrency, toCurrency);
  const rate = Number(rateData?.exchange_rate ?? 1);
  const isFallback = fromCurrency !== toCurrency && rate === 1;
  const result = { rate, isFallback };
  cachedRatePair = pairKey;
  cachedRateResult = result;
  return result;
}

async function recalcConversion() {
  ensureFeeCache();
  const callId = ++rateCallToken; // staleness guard

  const fromAccount = currentFromAccount();
  const fromCurrency = fromAccount?.currency || 'USD';
  $('#transfer-send-currency-tag').textContent = fromCurrency;

  const recipient = getRecipientSummary();
  const receiveSelect = $('#transfer-receive-currency');
  if (recipient.currency) {
    receiveSelect.value = recipient.currency;
    receiveSelect.disabled = true;
  } else {
    receiveSelect.disabled = false;
  }
  const toCurrency = receiveSelect.value;

  const sendAmount = Number($('#transfer-send-amount').value) || 0;
  const speed = $('input[name="speed"]:checked')?.value || 'standard';
  const fee = computeFee(sendAmount, speed);

  const { rate, isFallback } = await getCachedRate(fromCurrency, toCurrency); // cached
  const limits = await getLimitsInCurrency(fromCurrency); // cached

  // If a newer call started while these awaits were in flight (fast
  // typing, quick currency switches), drop this pass instead of
  // painting stale numbers over a newer result. This is what was
  // causing the rate/limit note to visibly flip back and forth.
  if (callId !== rateCallToken) return null;

  const receiveAmount = sendAmount * rate;
  $('#transfer-receive-amount').value = receiveAmount.toFixed(2);

  $('#fee-rate-note-value').textContent = `1 ${fromCurrency} = ${rate.toFixed(4)} ${toCurrency}${isFallback ? ' · indicative' : ' · mid-market'}`;
  $('#fee-amount-value').textContent = `${currencySymbol(fromCurrency)}${formatAmount(fee)}`;
  $('#fee-total-value').textContent = `${currencySymbol(fromCurrency)}${formatAmount(sendAmount + fee)}`;
  $('#fee-arrives-value').textContent = speed === 'instant' ? 'Within minutes' : 'Within a few hours';

  const available = Number(fromAccount?.available_balance ?? fromAccount?.balance ?? 0);
  const total = sendAmount + fee;
  $('#fee-available-value').textContent = fromAccount ? `${currencySymbol(fromCurrency)}${formatAmount(available)}` : '—';
  $('#fee-remaining-value').textContent = fromAccount ? `${currencySymbol(fromCurrency)}${formatAmount(Math.max(0, available - total))}` : '—';

  const noteEl = $('#balance-note');
  const note = buildAmountNote({ fromAccount, fromCurrency, sendAmount, total, available }, limits);
  if (note) {
    noteEl.textContent = note.message;
    noteEl.classList.toggle('balance-note--warning', note.type === 'error');
  } else {
    noteEl.textContent = '';
    noteEl.classList.remove('balance-note--warning');
  }

  updateLedger();

  return { fromAccount, fromCurrency, toCurrency, sendAmount, fee, rate, receiveAmount, speed, total, available };
}

/* -----------------------------------------------------------
   Transfer limits (override-wins-over-global)
   -----------------------------------------------------------
   Mirrors the precedence admin-policy.html documents for the admin
   side ("Leave blank to inherit the global value"): a value in the
   customer's own user_limit_overrides row wins; otherwise fall back
   to the bank-wide bank_policies 'transfer_controls' row. Resolved
   once per wizard pass and cached in effectiveLimits (cleared by
   resetWizard()) so re-entering step 2 repeatedly doesn't re-fetch.

   NOT covered here: daily_transfer_limit / weekly_transfer_limit /
   monthly_transfer_limit are fetched (in case you want them later)
   but NOT enforced — that needs summing the customer's already-sent
   transfers within the relevant period, which is a getTransactions()-
   style aggregation this function doesn't attempt, since the exact
   rule (which transfer types/statuses count, and whether a
   scheduled-for-later transfer counts against today or its future
   send date) hasn't been decided.

   ALSO NOT covered: this is enforced client-side only. If
   process_transfer() (the RPC createTransfer() calls) doesn't check
   these limits itself server-side, a customer bypassing this JS
   could still exceed them — this function is a UX guardrail, not a
   security boundary.
   ----------------------------------------------------------- */
async function getEffectiveTransferLimits() {
  const [{ data: policy }, { data: overrides }] = await Promise.all([
    getTransferPolicy(),
    getMyTransferLimitOverrides(),
  ]);
  const global = policy?.policy_values || {};
  const custom = overrides?.override_values || {};

  const pick = (key) => {
    const overrideVal = custom[key];
    if (overrideVal !== null && overrideVal !== undefined && overrideVal !== '') return Number(overrideVal);
    const globalVal = global[key];
    return globalVal !== null && globalVal !== undefined && globalVal !== '' ? Number(globalVal) : null;
  };

  return {
    maxSingleTransfer: pick('max_single_transfer'),
    minTransfer: pick('min_transfer'),
    dailyTransferLimit: pick('daily_transfer_limit'),
  };
}

/**
 * Caches the converted result per currency, so this only does a
 * network round-trip the first time a given currency is seen in
 * this wizard pass, not on every keystroke.
 */
async function getLimitsInCurrency(currency) {
  if (!effectiveLimits) effectiveLimits = await getEffectiveTransferLimits();
  if (currency === 'USD') return effectiveLimits;
  if (limitsByCurrency.has(currency)) return limitsByCurrency.get(currency);

  const { data: rateData } = await getExchangeRate('USD', currency);
  const rate = Number(rateData?.exchange_rate ?? 1);
  const convert = (v) => (v == null ? null : v * rate);

  const converted = {
    maxSingleTransfer: convert(effectiveLimits.maxSingleTransfer),
    minTransfer: convert(effectiveLimits.minTransfer),
    dailyTransferLimit: convert(effectiveLimits.dailyTransferLimit),
  };
  limitsByCurrency.set(currency, converted);
  return converted;
}

/**
 * Single source of truth for the #balance-note message, used by
 * both recalcConversion() (live, on every keystroke) and
 * validateStep2() (blocking, on Continue) so the two can never
 * disagree. Priority: insufficient balance > below minimum > above
 * per-transfer maximum > above daily limit > default "remaining
 * after send" info line.
 *
 * NOTE on the daily check: this only catches a single transfer
 * that alone exceeds the daily limit — it does NOT sum the
 * customer's already-sent transfers today, since that needs a
 * getTransactions()-style aggregation this function doesn't
 * attempt (see the same caveat on getEffectiveTransferLimits()'s
 * dailyTransferLimit field).
 */
function buildAmountNote(info, limits) {
  if (!info.fromAccount || info.sendAmount <= 0) return null;

  const sym = currencySymbol(info.fromCurrency);

  if (info.total > info.available) {
    return { type: 'error', message: `Insufficient balance — you have ${sym}${formatAmount(info.available)} available in this account.` };
  }
  if (limits.minTransfer != null && info.sendAmount < limits.minTransfer) {
    return { type: 'error', message: `The minimum transfer amount is ${sym}${formatAmount(limits.minTransfer)}.` };
  }
  if (limits.maxSingleTransfer != null && info.sendAmount > limits.maxSingleTransfer) {
    return { type: 'error', message: `This exceeds your maximum single transfer limit of ${sym}${formatAmount(limits.maxSingleTransfer)}.` };
  }
  if (limits.dailyTransferLimit != null && info.sendAmount > limits.dailyTransferLimit) {
    return { type: 'error', message: `This exceeds your daily transfer limit of ${sym}${formatAmount(limits.dailyTransferLimit)}.` };
  }

  return { type: 'info', message: `${sym}${formatAmount(Math.max(0, info.available - info.total))} left in this account after sending.` };
}

/**
 * recalcConversion() can now return null if a newer call
 * superseded it (see the staleness guard above). This is a
 * deliberate click, not rapid typing, so a second call is
 * essentially guaranteed to land — retry once rather than treat a
 * superseded pass as "no account selected".
 */
async function validateStep2() {
  let info = await recalcConversion();
  if (!info) info = await recalcConversion();

  if (!info.fromAccount) {
    showToast('Open a currency account before sending money.', 'error');
    return false;
  }
  if (info.sendAmount <= 0) {
    showToast('Enter an amount greater than zero.', 'error');
    $('#transfer-send-amount').focus();
    return false;
  }

  const limits = await getLimitsInCurrency(info.fromCurrency);
  const note = buildAmountNote(info, limits);
  if (note?.type === 'error') {
    // #balance-note (updated live by recalcConversion()) already
    // shows this message — just block Continue and focus the
    // field, rather than depend on the toast for it too.
    $('#transfer-send-amount').focus();
    return false;
  }

  return true;
}

/* -----------------------------------------------------------
   Review + Verify steps
   ----------------------------------------------------------- */
function formatScheduledDate() {
  const val = $('#schedule-later-datetime').value;
  if (!val) return 'a later date';
  return new Date(val).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

async function populateReview() {
  const recipient = getRecipientSummary();
  const fromAccount = currentFromAccount();
  const sendAmount = Number($('#transfer-send-amount').value) || 0;
  const speed = $('input[name="speed"]:checked')?.value || 'standard';
  const schedule = $('input[name="schedule"]:checked')?.value || 'now';
  const purpose = $('#transfer-purpose').value;
  const fee = computeFee(sendAmount, speed);
  const receiveAmount = Number($('#transfer-receive-amount').value) || 0;
  const toCurrency = $('#transfer-receive-currency').value;
  const { rate } = await getCachedRate(fromAccount?.currency || 'USD', toCurrency); // cached

  const scheduleText = `${speed === 'instant' ? 'Instant' : 'Standard'} · ${
    schedule === 'later' ? `Scheduled for ${formatScheduledDate()}` : 'Sending now'
  }`;
  const sendAmountText = fromAccount ? `${currencySymbol(fromAccount.currency)}${formatAmount(sendAmount)}` : '—';
  const feeText = fromAccount ? `${currencySymbol(fromAccount.currency)}${formatAmount(fee)}` : '—';
  const totalText = fromAccount ? `${currencySymbol(fromAccount.currency)}${formatAmount(sendAmount + fee)}` : '—';

  $('[data-review="from_account"]').textContent = fromAccount
    ? `${fromAccount.currency} account · ${currencySymbol(fromAccount.currency)}${formatAmount(fromAccount.available_balance ?? fromAccount.balance)} available`
    : '—';
  $('[data-review="beneficiary"]').textContent = recipient.name || '—';
  $('[data-review="send_amount"]').textContent = sendAmountText;
  $('[data-review="receive_amount"]').textContent = `${currencySymbol(toCurrency)}${formatAmount(receiveAmount)}`;
  $('[data-review="rate"]').textContent = `1 ${fromAccount?.currency || 'USD'} = ${rate.toFixed(4)} ${toCurrency}`;
  $('[data-review="fee"]').textContent = feeText;
  $('[data-review="total"]').textContent = totalText;
  $('[data-review="purpose"]').textContent = purpose;
  $('[data-review="schedule"]').textContent = scheduleText;

  $('[data-review="verify_amount"]').textContent = `${sendAmountText} (total ${totalText})`;
  $('[data-review="verify_recipient"]').textContent = recipient.name || '—';
}

/* -----------------------------------------------------------
   Confirm & send
   ----------------------------------------------------------- */
async function handleConfirmSend() {
  const errorEl = $('#review-error');
  errorEl.style.display = 'none';

  const pwErrorEl = $('#auth-password-error');
  const pwInput = $('#transfer-auth-password');
  pwErrorEl.textContent = '';
  pwInput.closest('.field')?.classList.remove('has-error');

  if (authLockedUntil && Date.now() < authLockedUntil) {
    const secondsLeft = Math.ceil((authLockedUntil - Date.now()) / 1000);
    pwErrorEl.textContent = `Too many attempts. Try again in ${secondsLeft}s.`;
    pwInput.closest('.field')?.classList.add('has-error');
    return;
  }

  const btn = $('#confirm-send-btn');
  btn.disabled = true;
  btn.querySelector('.auth-submit-label').textContent = 'Verifying…';

  const { data: verified, error: verifyError } = await verifyCurrentPassword(pwInput.value);

  if (!verified) {
    authFailedAttempts += 1;
    btn.disabled = false;
    btn.querySelector('.auth-submit-label').textContent = 'Confirm & send';
    pwInput.closest('.field')?.classList.add('has-error');

    if (authFailedAttempts >= MAX_AUTH_ATTEMPTS) {
      authLockedUntil = Date.now() + AUTH_LOCKOUT_MS;
      pwInput.disabled = true;
      pwErrorEl.textContent = `Too many failed attempts. Try again in ${Math.round(AUTH_LOCKOUT_MS / 1000)}s.`;
      setTimeout(() => {
        authFailedAttempts = 0;
        authLockedUntil = 0;
        pwInput.disabled = false;
        pwErrorEl.textContent = '';
      }, AUTH_LOCKOUT_MS);
    } else {
      pwErrorEl.textContent = verifyError || "That password doesn't match your account.";
      pwInput.value = '';
      pwInput.focus();
    }
    return;
  }

  authFailedAttempts = 0;

  const sendAmount = Number($('#transfer-send-amount').value) || 0;
  const fromAccount = currentFromAccount();
  if (!fromAccount) {
    showToast('Choose an account to send from first.', 'error');
    btn.disabled = false;
    btn.querySelector('.auth-submit-label').textContent = 'Confirm & send';
    return;
  }

  const recipient = getRecipientSummary();
  const speed = $('input[name="speed"]:checked')?.value || 'standard';
  const fee = computeFee(sendAmount, speed);
  const reference = $('#transfer-reference').value.trim();
  const purpose = $('#transfer-purpose').value;

  btn.querySelector('.auth-submit-label').textContent = 'Sending…';

  let beneficiaryRecordId = recipient.beneficiaryId;

  if (recipient.isNew && $('#save-beneficiary-checkbox').checked && recipient.manual?.beneficiaryName) {
    const { data: newBeneficiary, error: benError } = await addBeneficiary(recipient.manual);
    if (benError) {
      showToast(`Couldn't save this recipient: ${benError}`, 'error');
    } else if (newBeneficiary) {
      beneficiaries.push(newBeneficiary);
      beneficiaryRecordId = newBeneficiary.id;
    }
  }

  if (!recipient.isNew && verifiedRecipient?.source === 'internal') {
    const saveInternalCheckbox = $('#save-verified-beneficiary-checkbox');
    if (saveInternalCheckbox?.checked) {
      const { data: newBeneficiary, error: benError } = await addBeneficiary({
        beneficiaryName: verifiedRecipient.display_name,
        bankName: verifiedRecipient.bank_name,
        accountNumber: getRecipientIdentifierForTransfer(),
        swiftCode: '',
        country: '',
        currency: verifiedRecipient.currency,
      });
      if (benError) {
        showToast(`Couldn't save this recipient: ${benError}`, 'error');
      } else if (newBeneficiary) {
        beneficiaries.push(newBeneficiary);
        beneficiaryRecordId = newBeneficiary.id;
      }
    }
  }

  const { data: tx, error } = await createTransfer({
    senderAccountId: fromAccount.id,
    receiverAccountId: null,
    receiverIdentifier: getRecipientIdentifierForTransfer(),
    amount: sendAmount,
    fee,
    currency: fromAccount.currency,
    description: reference ? `${purpose} — ${reference}` : `${purpose} transfer to ${recipient.name}`,
  });

  btn.disabled = false;
  btn.querySelector('.auth-submit-label').textContent = 'Confirm & send';

  if (error) {
    errorEl.textContent = error;
    errorEl.style.display = 'block';
    showToast(error, 'error');
    return;
  }

  if (beneficiaryRecordId) {
    const saved = beneficiaries.find((b) => b.id === beneficiaryRecordId);
    if (saved) pushRecentRecipient(saved);
  }

  const speedLabel = speed === 'instant' ? 'minutes' : 'a few hours';
  const remainingBalance = Number(fromAccount.available_balance ?? fromAccount.balance ?? 0) - (sendAmount + fee);
  const toCurrency = $('#transfer-receive-currency').value;
  const receiveAmount = Number($('#transfer-receive-amount').value) || 0;

  $('#success-reference').textContent = tx.transaction_reference;
  $('#success-status').textContent = tx.status;
  $('#success-balance').textContent = `${currencySymbol(fromAccount.currency)}${formatAmount(Math.max(0, remainingBalance))}`;
  $('#success-message').textContent = tx.status === 'Completed'
    ? `${currencySymbol(fromAccount.currency)}${formatAmount(sendAmount)} has been sent to ${recipient.name} and is already available to them.`
    : `${currencySymbol(fromAccount.currency)}${formatAmount(sendAmount)} is on its way to ${recipient.name}. Most transfers arrive within ${speedLabel}.`;

  // -----------------------------------------------------------
  // NEW — transaction email notifications, outgoing + incoming.
  // Fire-and-forget: the transfer has already succeeded by this
  // point, so a failed send is logged only, never surfaced as a
  // blocking error — same pattern as admin-transactions.js's
  // reversal email.
  // -----------------------------------------------------------
  const nowText = new Date().toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });

  // Outgoing — notify the sender (this device's own account).
  if (myProfile?.email) {
    const senderName = [myProfile.first_name, myProfile.last_name].filter(Boolean).join(' ') || 'Customer';
    sendTransactionEmail('transfer_sent', {
      to_email: myProfile.email,
      customer_name: senderName,
      email_title: 'Your transfer is on its way',
      email_message: `This confirms your transfer to ${recipient.name || 'your recipient'} has been submitted.`,
      preheader_text: `You sent ${currencySymbol(fromAccount.currency)}${formatAmount(sendAmount)} to ${recipient.name || 'your recipient'}.`,
      amount_label: 'Amount sent',
      amount: `${currencySymbol(fromAccount.currency)}${formatAmount(sendAmount)}`,
      from_label: 'From',
      from_value: `${fromAccount.currency} account`,
      to_label: 'To',
      to_value: recipient.name || 'Recipient',
      reference: tx.transaction_reference,
      transaction_type: 'Transfer',
      date: nowText,
    }).then((result) => {
      if (!result.ok) console.error('[Meridian] transfer_sent email failed:', result.error);
    });
  } else {
    console.warn('[Meridian] Transfer completed but no sender email on file — transfer_sent notification not sent.');
  }

  // Incoming — notify the receiver, but only when they're an
  // internal Meridian account (an external beneficiary has no
  // Meridian login/email to notify).
  resolveReceiverContact(tx).then((contact) => {
    if (!contact.email) return;
    sendTransactionEmail('transfer_received', {
      to_email: contact.email,
      customer_name: contact.name,
      email_title: "You\u2019ve received a transfer",
      email_message: myProfile
        ? `You've received a transfer from ${[myProfile.first_name, myProfile.last_name].filter(Boolean).join(' ') || 'a Meridian customer'}.`
        : "You've received a transfer.",
      preheader_text: `You received ${currencySymbol(toCurrency)}${formatAmount(receiveAmount)}.`,
      amount_label: 'Amount received',
      amount: `${currencySymbol(toCurrency)}${formatAmount(receiveAmount)}`,
      from_label: 'From',
      from_value: myProfile ? ([myProfile.first_name, myProfile.last_name].filter(Boolean).join(' ') || 'External sender') : 'External sender',
      to_label: 'To',
      to_value: `${toCurrency} account`,
      reference: tx.transaction_reference,
      transaction_type: 'Transfer',
      date: nowText,
    }).then((result) => {
      if (!result.ok) console.error('[Meridian] transfer_received email failed:', result.error);
    });
  });

  lastTransferReceipt = {
    reference: tx.transaction_reference,
    status: tx.status,
    date: new Date(),
    fromCurrency: fromAccount.currency,
    fromMasked: maskAccount(fromAccount.account_number || fromAccount.iban || ''),
    recipientName: recipient.name || '—',
    recipientMeta: recipient.meta || '',
    sendAmount,
    fee,
    total: sendAmount + fee,
    receiveAmount,
    toCurrency,
    rateText: $('#fee-rate-note-value')?.textContent || '—',
    speed,
    purpose,
    remainingBalance: Math.max(0, remainingBalance),
  };

  pwInput.value = '';
  goToStep(5);
}

/* -----------------------------------------------------------
   Receipt PDF
   ----------------------------------------------------------- */
function loadJsPDF() {
  return new Promise((resolve, reject) => {
    if (window.jspdf?.jsPDF) return resolve(window.jspdf.jsPDF);
    let script = document.querySelector('script[data-meridian-jspdf]');
    if (!script) {
      script = document.createElement('script');
      script.src = 'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js';
      script.dataset.meridianJspdf = 'true';
      document.head.appendChild(script);
    }
    script.addEventListener('load', () => resolve(window.jspdf?.jsPDF), { once: true });
    script.addEventListener('error', () => reject(new Error('Could not load the PDF library.')), { once: true });
  });
}

function buildReceiptPdf(JsPDFCtor, data) {
  const doc = new JsPDFCtor({ unit: 'pt', format: 'a4' });
  const pageWidth = doc.internal.pageSize.getWidth();
  const marginX = 56;
  let y = 64;

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(20);
  doc.setTextColor('#0A1628');
  doc.text('MERIDIAN', marginX, y);
  doc.setFontSize(10);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor('#7A6A4F');
  doc.text('International Digital Banking', marginX, y + 16);

  doc.setFontSize(10);
  doc.setTextColor('#0A1628');
  doc.text('TRANSFER RECEIPT', pageWidth - marginX, y, { align: 'right' });
  doc.setTextColor('#7A6A4F');
  doc.text(data.date.toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' }), pageWidth - marginX, y + 16, { align: 'right' });

  y += 36;
  doc.setDrawColor('#B58A44');
  doc.setLineWidth(1);
  doc.line(marginX, y, pageWidth - marginX, y);
  y += 30;

  const statusColor = data.status === 'Completed' ? '#1E7A44' : '#B5842A';
  doc.setFontSize(11);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor('#0A1628');
  doc.text('Status', marginX, y);
  doc.setTextColor(statusColor);
  doc.text(data.status, marginX + 120, y);

  doc.setTextColor('#0A1628');
  doc.text('Reference', pageWidth - marginX - 180, y);
  doc.setFont('helvetica', 'normal');
  doc.text(data.reference, pageWidth - marginX, y, { align: 'right' });
  y += 30;

  const row = (label, value, opts = {}) => {
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(10);
    doc.setTextColor('#7A6A4F');
    doc.text(label, marginX, y);
    doc.setFont('helvetica', opts.bold ? 'bold' : 'normal');
    doc.setFontSize(opts.size || 11);
    doc.setTextColor(opts.color || '#0A1628');
    doc.text(String(value), pageWidth - marginX, y, { align: 'right' });
    y += opts.gap || 22;
  };

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10);
  doc.setTextColor('#7A6A4F');
  doc.text('RECIPIENT', marginX, y);
  y += 18;
  row('Name', data.recipientName, { bold: true });
  if (data.recipientMeta) row('Details', data.recipientMeta);

  y += 8;
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10);
  doc.setTextColor('#7A6A4F');
  doc.text('FROM', marginX, y);
  y += 18;
  row('Account', `${data.fromCurrency} account${data.fromMasked ? ' · ' + data.fromMasked : ''}`);

  y += 8;
  doc.setDrawColor('#E5DDCC');
  doc.setLineWidth(0.75);
  doc.line(marginX, y, pageWidth - marginX, y);
  y += 24;

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10);
  doc.setTextColor('#7A6A4F');
  doc.text('AMOUNT', marginX, y);
  y += 18;
  row('You sent', `${currencySymbol(data.fromCurrency)}${formatAmount(data.sendAmount)}`);
  row('Transfer fee', `${currencySymbol(data.fromCurrency)}${formatAmount(data.fee)}`);
  row('Total debited', `${currencySymbol(data.fromCurrency)}${formatAmount(data.total)}`, { bold: true, size: 13 });
  row('Exchange rate', data.rateText);
  row('Recipient receives', `${currencySymbol(data.toCurrency)}${formatAmount(data.receiveAmount)}`, { bold: true, size: 13, color: '#1E7A44' });

  y += 8;
  doc.setDrawColor('#E5DDCC');
  doc.line(marginX, y, pageWidth - marginX, y);
  y += 24;

  row('Purpose', data.purpose);
  row('Speed', data.speed === 'instant' ? 'Instant' : 'Standard');
  row('Remaining balance', `${currencySymbol(data.fromCurrency)}${formatAmount(data.remainingBalance)}`);

  y += 24;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8.5);
  doc.setTextColor('#9C9080');
  doc.text(
    'This receipt confirms your transfer instruction with Meridian. Keep it for your records.',
    marginX,
    y,
    { maxWidth: pageWidth - marginX * 2 }
  );

  return doc;
}

async function handleDownloadReceipt() {
  if (!lastTransferReceipt) {
    showToast("No receipt to download yet.", 'error');
    return;
  }
  const btn = $('#download-receipt-btn');
  const label = $('.download-receipt-label', btn);
  if (btn) btn.disabled = true;
  if (label) label.textContent = 'Preparing…';

  try {
    const JsPDFCtor = await loadJsPDF();
    if (!JsPDFCtor) throw new Error('PDF library unavailable.');
    const doc = buildReceiptPdf(JsPDFCtor, lastTransferReceipt);
    doc.save(`meridian-receipt-${lastTransferReceipt.reference}.pdf`);
  } catch (err) {
    showToast("Couldn't generate the receipt PDF — try again.", 'error');
  } finally {
    if (btn) btn.disabled = false;
    if (label) label.textContent = 'Download receipt (PDF)';
  }
}

function ensureDownloadReceiptButton() {
  const actions = $('.send-success-actions');
  if (!actions || $('#download-receipt-btn')) return;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.id = 'download-receipt-btn';
  btn.className = 'btn btn-ghost';
  btn.innerHTML = `<span class="download-receipt-label">Download receipt (PDF)</span>`;
  btn.addEventListener('click', handleDownloadReceipt);
  actions.insertBefore(btn, actions.firstChild);
}

/* -----------------------------------------------------------
   Reset wizard for "Send another"
   ----------------------------------------------------------- */
function resetWizard() {
  selectedBeneficiary = null;
  resetNewRecipientUi();
  $('#transfer-form').reset();
  $('#recipient-identifier').value = '';
  $('#beneficiary-search').value = '';
  $('#transfer-send-amount').value = '';
  effectiveLimits = null; // re-resolve limits on next step-2 validation
  limitsByCurrency.clear();
  cachedRatePair = null;
  cachedRateResult = null;
  $('#recipient-saved-toggle').open = false;
  $('#auth-password-error').textContent = '';
  authFailedAttempts = 0;
  authLockedUntil = 0;
  $$('input[name="speed"]').forEach((r) => r.closest('.send-segmented-btn')?.classList.toggle('is-selected', r.checked));
  $$('input[name="schedule"]').forEach((r) => r.closest('.send-segmented-btn')?.classList.toggle('is-selected', r.checked));
  setCardHidden('schedule-later-field', true);
  renderBeneficiaryList('');
  renderRecentStrip();
  renderFromAccountStrip();
  updateStep1ContinueState();
  recalcConversion();
  goToStep(1);
}

/* -----------------------------------------------------------
   Query params
   ----------------------------------------------------------- */
function applyQueryParams() {
  const params = new URLSearchParams(window.location.search);
  const fromId = params.get('from');
  if (fromId && accounts.some((a) => String(a.id) === fromId)) selectedFromAccountId = fromId;

  const benId = params.get('beneficiary');
  if (benId) {
    const match = beneficiaries.find((b) => String(b.id) === benId);
    if (match) {
      selectedBeneficiary = match;
      const toggle = $('#recipient-saved-toggle');
      if (toggle) toggle.open = true;
    }
  }
}

/* -----------------------------------------------------------
   Password visibility toggle
   ----------------------------------------------------------- */
function initPasswordToggle() {
  const toggle = $('#auth-password-toggle');
  const input = $('#transfer-auth-password');
  if (!toggle || !input) return;
  toggle.addEventListener('click', () => {
    const showing = toggle.getAttribute('aria-pressed') === 'true';
    toggle.setAttribute('aria-pressed', String(!showing));
    input.type = showing ? 'password' : 'text';
    toggle.setAttribute('aria-label', showing ? 'Show password' : 'Hide password');
  });
}

/* -----------------------------------------------------------
   Init
   ----------------------------------------------------------- */
(async function init() {
  const user = await guardPage();
  if (!user) return;

  // Header now loads asynchronously via the shared app-navbar
  // component, so header-dependent init waits for it, same
  // pattern dashboard.js uses.
  waitForNavbar().then(() => {
    populateHeader();
    initUserMenu();
    initLogout();
  });

  initPasswordToggle();
  wireSegmented('speed');
  wireSegmented('schedule');
  ensureDownloadReceiptButton();

  resetNewRecipientUi();
  setCardHidden('schedule-later-field', true);

  $('#transfer-form').addEventListener('submit', (event) => event.preventDefault());

  $('#beneficiary-search').addEventListener('input', (e) => renderBeneficiaryList(e.target.value));
  $('#recipient-identifier').addEventListener('input', handleIdentifierInput);
  $('#recipient-verified-clear').addEventListener('click', () => {
    resetNewRecipientUi();
    $('#recipient-identifier').value = '';
    $('#recipient-identifier').focus();
    updateStep1ContinueState();
    updateLedger();
  });
  $$('#recipient-manual-fields input, #recipient-manual-fields select').forEach((el) =>
    el.addEventListener('input', () => {
      updateStep1ContinueState();
      updateLedger();
    })
  );

  $$('.send-next').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (currentStep === 2) {
        const ok = await validateStep2();
        if (!ok) return;
      }
      goToStep(Number(btn.dataset.goto));
    });
  });
  $$('.send-back, .send-edit-link[data-goto]').forEach((btn) => {
    btn.addEventListener('click', () => goToStep(Number(btn.dataset.goto)));
  });

  $('#transfer-send-amount').addEventListener('input', recalcConversion);
  $('#transfer-receive-currency').addEventListener('change', recalcConversion);
  $$('input[name="speed"]').forEach((r) => r.addEventListener('change', recalcConversion));
  $$('input[name="schedule"]').forEach((r) =>
    r.addEventListener('change', () => {
      setCardHidden('schedule-later-field', $('input[name="schedule"]:checked').value !== 'later');
    })
  );

  $('#confirm-send-btn').addEventListener('click', handleConfirmSend);
  $('#send-another-btn').addEventListener('click', resetWizard);
  $('#copy-reference-btn').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText($('#success-reference').textContent);
      showToast('Reference copied.');
    } catch {
      showToast("Couldn't copy — copy it manually instead.", 'error');
    }
  });

  const [{ data: accs, error: accError }, { data: bens, error: benError }, limits, { data: profile }] = await Promise.all([
    getMyAccounts(user.id),
    getMyBeneficiaries(user.id),
    getEffectiveTransferLimits(), // prefetch so the first keystroke on step 2 is instant
    getMyProfile(), // NEW — captured once, used by transfer_sent emails
  ]);
  if (accError) showToast("Couldn't load your accounts. Please refresh.", 'error');
  if (benError) showToast("Couldn't load your beneficiaries. Please refresh.", 'error');
  accounts = accs || [];
  beneficiaries = bens || [];
  effectiveLimits = limits;
  myProfile = profile || null; // NEW

  applyQueryParams();
  renderFromAccountStrip();

  $('#transfer-send-amount').value = '';
  await recalcConversion();

  renderBeneficiaryList('');
  renderRecentStrip();
  updateStep1ContinueState();
  updateLedger();

  if (!accounts.length) {
    showToast('Open a currency account before you can send money.', 'error');
  }
})();
