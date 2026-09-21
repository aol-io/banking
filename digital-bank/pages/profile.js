/* =============================================================
   MERIDIAN — International Digital Banking
   Script: pages/profile.js
   Loaded as a module by profile.html only. Wires up:
     1. Screen-stack navigation (root → sublist/content, back, history)
     2. Password show/hide toggles
     3. Profile banner + Personal info (read-only display)
     4. Overview summary cards + activity
     5. Security > Password, Two-factor (display only), Sessions
     6. Account & security > Login settings (password, forgot
        password, session preference, Face ID — status only)
     7. Account & security > Account limits (info, tier badges,
        Linked ID, accepted docs, VERIFICATION FLOW — see 7b)
     8. Danger zone (no backend yet — honest placeholders)
     9. Avatar upload

   -----------------------------------------------------------
   WHAT CHANGED IN THIS REVISION — sequential KYC verification
   -----------------------------------------------------------
   The old "Upload documents" form (one dropdown with all 12
   document types, always available) is replaced by a stepper
   rendered into #kyc-flow (created automatically inside
   #screen-limits-upload if profile.html doesn't have it yet; the
   legacy form card is hidden, not deleted). Rules it enforces:

     - Tiers are applied for in order: 1 = BVN, 2 = identity
       document, 3 = proof of address. Only the NEXT step is ever
       shown as a form; later steps stay hidden until the previous
       one is verified. Verified steps collapse into a compact row.
     - A step with a pending submission cannot be submitted again.
       It shows "Application submitted — under review" instead.
     - A step whose latest submission was rejected (or sent back
       with "action required") shows the admin's reason and
       re-opens the form, prefilled, as a resubmission.
     - ID numbers are validated per document type (BVN and NIN are
       exactly 11 digits; the other three use a length/charset
       range — see ID_RULES). Input is sanitised as you type.
     - Tier badges everywhere on the page now show the real
       user_profiles.account_tier.
     - Decisions arrive live: this page listens for new rows in
       `notifications` (same table/realtime feed the header bell
       uses) and re-reads the profile + submissions when one lands,
       so the status flips from "under review" without a reload.
       The notification rows themselves are created SERVER-SIDE
       when an admin decides — see the SQL delivered with this file.

   These client-side checks are a convenience, not the security
   boundary: the "one open application per step" rule must also be
   enforced in the database (partial unique index) — see the SQL.

   -----------------------------------------------------------
   KNOWN GAPS / ASSUMPTIONS — flagged rather than silently
   guessed, per the files actually available at the time this
   was written:

   - getMyIdentityDocumentHistory() (supabase/database.js) must
     select/order by `submitted_at`, NOT `created_at` —
     identity_documents has no created_at column, so the query
     errors and the verification flow shows its error state.
   - AVATAR FIELD MISMATCH: storage.js's uploadAvatar() writes
     user_profiles.profile_photo, but auth-ui.js reads
     user_profiles.avatar_url. This file reads whichever is
     present (avatar_url first, profile_photo as fallback).
   - SESSIONS: no exported "list my sessions" function exists in
     database.js, so fetchLoginSessions() queries login_sessions
     directly (assumes an owner-scoped SELECT policy).
   - ACTIVITY LIST: no exported getter for audit_logs exists, so
     the Overview activity list says it isn't wired up yet.
   - NOTIFICATION PREFERENCES: no known user_profiles column, so
     the toggles are UI feedback only. (Login session preference
     is the same: it records stated intent only.)
   - ACCOUNT TIER: user_profiles.account_tier is admin-write-only
     (DB trigger). Displayed verbatim; this file never writes it.
   - ACCOUNT NUMBER: user_profiles.account_number (migration 016
     PART B) is the single customer number on Account information.
   - DANGER ZONE: no backend functions yet — honest placeholders.
   - FACE ID: status display only ("Coming soon").

   I18N: every user-facing string goes through t(). New strings in
   the verification flow go through tr(key, englishFallback) so
   they render in English until the keys are added to
   assets/js/translation.js.
   ============================================================= */

import { getCurrentUser, updateUserPassword, verifyCurrentPassword, requestPasswordReset } from '../supabase/auth.js';
import {
  getMyProfile,
  getMyAccounts,
  getCardsForAccount,
  getMyIdentityDocuments,
  getMyIdentityDocumentHistory,
  getMyWebauthnCredentials,
  submitIdentityDocument,
} from '../supabase/database.js';
import { uploadAvatar } from '../supabase/storage.js';
import { supabase } from '../supabase/config.js';

const $ = (selector, scope) => (scope || document).querySelector(selector);
const $$ = (selector, scope) => Array.from((scope || document).querySelectorAll(selector));

function t(key) {
  return (window.MeridianI18n && typeof window.MeridianI18n.t === 'function')
    ? window.MeridianI18n.t(key)
    : key;
}

/**
 * t() with an English fallback and {placeholder} substitution.
 * If the key isn't in translation.js yet (t() hands the key back),
 * the fallback is used, so new UI never shows a raw key.
 */
function tr(key, fallback, vars) {
  let out = t(key);
  if (!out || out === key) out = fallback;
  if (vars) {
    Object.entries(vars).forEach(([name, value]) => {
      out = out.split(`{${name}}`).join(String(value));
    });
  }
  return out;
}

// Same BCP-47 map used by settings.js, kept local here so this
// file doesn't depend on settings.js having run first.
const LOCALE_MAP = {
  en: 'en-US', fr: 'fr-FR', es: 'es-ES', ko: 'ko-KR', de: 'de-DE',
  pt: 'pt-PT', ar: 'ar-SA', zh: 'zh-CN', ja: 'ja-JP', ha: 'ha-NG',
};

function currentLocale() {
  const lang = (window.MeridianI18n && typeof window.MeridianI18n.getLanguage === 'function')
    ? window.MeridianI18n.getLanguage()
    : 'en';
  return LOCALE_MAP[lang] || 'en-US';
}

let currentUser = null;
let currentProfile = null;
let screenStack = null;

/* -----------------------------------------------------------
   Small shared helpers
   ----------------------------------------------------------- */

function getInitials(name) {
  return (
    String(name || '')
      .split(' ')
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0].toUpperCase())
      .join('') || '·'
  );
}

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function formatDate(value, withTime = false) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString(currentLocale(), withTime ? { dateStyle: 'medium', timeStyle: 'short' } : { dateStyle: 'medium' });
}

/** Mirrors auth-ui.js's renderAvatar() locally — that function isn't exported, so this page owns its own copy for the elements it controls. */
function renderAvatarLocal(el, avatarUrl, initials) {
  if (!el) return;
  const existingImg = el.querySelector('img.avatar-image');
  if (avatarUrl) {
    const img = existingImg || document.createElement('img');
    img.className = 'avatar-image';
    img.alt = '';
    img.onerror = () => {
      img.remove();
      el.classList.remove('has-avatar-image');
      el.textContent = initials;
    };
    img.src = avatarUrl;
    if (!existingImg) {
      el.textContent = '';
      el.appendChild(img);
    }
    el.classList.add('has-avatar-image');
  } else {
    if (existingImg) existingImg.remove();
    el.classList.remove('has-avatar-image');
    el.textContent = initials;
  }
}

function currentFullName() {
  return document.querySelector('.profile-banner-identity h1')?.textContent?.trim() || '';
}

/* -----------------------------------------------------------
   Toast — uses the canonical #toast-stack element from
   components.css, but doesn't assume any specific class names
   from that (unseen) file — styled inline so it renders
   correctly regardless of what components.css defines.
   ----------------------------------------------------------- */
function toast(message, tone = 'success') {
  const stack = document.getElementById('toast-stack');
  if (!stack) return;

  const el = document.createElement('div');
  el.setAttribute('role', 'status');
  el.style.cssText = `
    display:flex;align-items:center;gap:.6rem;
    background:${tone === 'error' ? '#c0453b' : '#0a1628'};
    color:#f6f5f0;padding:.85rem 1.1rem;border-radius:14px;
    box-shadow:0 20px 60px -20px rgba(10,22,40,.35);
    font-size:.87rem;font-weight:500;max-width:340px;
    opacity:0;transform:translateY(8px);
    transition:opacity .2s ease, transform .2s ease;
  `;
  el.textContent = message;
  stack.appendChild(el);

  requestAnimationFrame(() => {
    el.style.opacity = '1';
    el.style.transform = 'translateY(0)';
  });

  window.setTimeout(() => {
    el.style.opacity = '0';
    el.style.transform = 'translateY(8px)';
    window.setTimeout(() => el.remove(), 250);
  }, 4200);
}

/* -----------------------------------------------------------
   1. Screen-stack navigation
   ----------------------------------------------------------- */
function initScreenStack() {
  const stack = document.getElementById('settings-stack');
  if (!stack) return null;

  function showScreen(id, { pushHistory = true } = {}) {
    const target = document.getElementById(id);
    if (!target) return;
    const current = stack.querySelector('.settings-screen.is-active');
    if (current === target) return;
    if (current) current.classList.remove('is-active');
    target.classList.add('is-active');
    window.scrollTo({ top: 0, behavior: 'auto' });
    if (pushHistory) {
      history.pushState({ meridianScreen: id }, '', `#${id}`);
    }
  }

  $$('.settings-row[data-target], .settings-back[data-target]', stack).forEach((btn) => {
    btn.addEventListener('click', () => showScreen(btn.getAttribute('data-target')));
  });

  window.addEventListener('popstate', (event) => {
    showScreen(event.state?.meridianScreen || 'screen-root', { pushHistory: false });
  });

  const initial = window.location.hash.replace('#', '');
  if (initial && document.getElementById(initial)) {
    $$('.settings-screen', stack).forEach((s) => s.classList.remove('is-active'));
    document.getElementById(initial).classList.add('is-active');
    history.replaceState({ meridianScreen: initial }, '', `#${initial}`);
  } else {
    history.replaceState({ meridianScreen: 'screen-root' }, '', '#screen-root');
  }

  return { showScreen };
}

/* -----------------------------------------------------------
   2. Password show/hide toggles (every .password-toggle on the page)
   ----------------------------------------------------------- */
function wirePasswordToggles() {
  $$('.password-toggle').forEach((btn) => {
    const wrap = btn.closest('.password-field-wrap');
    const input = wrap?.querySelector('input');
    if (!input) return;
    btn.addEventListener('click', () => {
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      btn.setAttribute('aria-pressed', String(show));
      btn.setAttribute('aria-label', show ? t('profile.password.hide') : t('profile.password.show'));
    });
  });
}

/* -----------------------------------------------------------
   3. Profile banner + Personal info + tier badges
   ----------------------------------------------------------- */
function populateBanner(user, profile) {
  const h1 = document.querySelector('.profile-banner-identity h1');
  const meta = user.user_metadata || {};
  const firstName = profile?.first_name || meta.first_name || '';
  const lastName = profile?.last_name || meta.last_name || '';
  const fullName = [firstName, lastName].filter(Boolean).join(' ') || user.email || t('profile.default.customer');
  if (h1) h1.textContent = fullName;

  const avatarEl = document.querySelector('.profile-avatar-wrap .avatar-initial');
  const avatarUrl = profile?.avatar_url || profile?.profile_photo || null;
  renderAvatarLocal(avatarEl, avatarUrl, getInitials(fullName));

  const statusWrap = document.querySelector('.profile-banner-status');
  if (statusWrap) {
    const status = profile?.account_status || t('profile.status.pending');
    const lower = String(status).toLowerCase();
    const cls =
      lower === 'active' || lower === 'verified'
        ? 'status-pill--verified'
        : lower === 'pending'
        ? 'status-pill--pending'
        : lower === 'suspended' || lower === 'closed'
        ? 'status-pill--blocked'
        : 'status-pill--neutral';
    statusWrap.innerHTML = `<span class="status-pill ${cls}">${escapeHtml(status)}</span>`;
  }
}

function populatePersonalInfo(user, profile) {
  const form = document.getElementById('personal-info-form');
  if (!form) return;

  const values = {
    first_name: profile?.first_name || user.user_metadata?.first_name || '',
    last_name: profile?.last_name || user.user_metadata?.last_name || '',
    email: profile?.email || user.email || '',
    phone: profile?.phone || '',
    date_of_birth: profile?.date_of_birth || '',
    gender: profile?.gender || '',
    nationality: profile?.nationality || '',
    occupation: profile?.occupation || '',
    address: profile?.address || '',
    city: profile?.city || '',
    state: profile?.state || '',
    postal_code: profile?.postal_code || '',
    country: profile?.country || '',
  };

  Object.entries(values).forEach(([name, value]) => {
    const field = form.elements.namedItem(name);
    if (field) field.value = value;
  });
}

function populateAccountInfo(profile) {
  const nameEl = document.getElementById('account-info-name');
  if (nameEl) {
    const fullName = [profile?.first_name, profile?.last_name].filter(Boolean).join(' ');
    nameEl.textContent = fullName || '—';
  }
}

/** The user's real tier (user_profiles.account_tier). Falls back to 1 — the value the markup ships with — if the column is empty. */
function resolveTier() {
  const n = Number(currentProfile?.account_tier);
  return Number.isFinite(n) && n >= 0 ? n : 1;
}

function renderTierBadges() {
  const tier = resolveTier();
  const label = tr('profile.tier.label', 'Tier {n}', { n: tier });
  ['account-security-tier-preview', 'account-info-tier-preview', 'account-tier-badge'].forEach((id) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = label;
    el.setAttribute('data-tier', String(tier));
  });
}

function wireAccountNumberToggle(profile, accounts) {
  const valueEl = document.getElementById('account-number-value');
  const toggleBtn = document.getElementById('account-number-toggle');
  if (!valueEl || !toggleBtn) return;

  // user_profiles.account_number is the customer number (migration 016
  // PART B); a currency account's own number is only a fallback.
  const primary = accounts?.[0];
  const full = profile?.account_number || primary?.account_number || primary?.iban || null;

  if (!full) {
    valueEl.textContent = t('profile.limits_info.no_account');
    toggleBtn.disabled = true;
    return;
  }

  const masked = `•••• •••• ${String(full).slice(-2)}`;
  valueEl.textContent = masked;

  toggleBtn.addEventListener('click', () => {
    const showing = toggleBtn.getAttribute('aria-pressed') === 'true';
    toggleBtn.setAttribute('aria-pressed', String(!showing));
    toggleBtn.textContent = showing ? t('profile.limits_info.show') : t('profile.limits_info.hide');
    valueEl.textContent = showing ? masked : full;
  });
}

/* -----------------------------------------------------------
   4. Overview summary + activity
   ----------------------------------------------------------- */
function populateActivityPlaceholder() {
  const list = document.getElementById('activity-list');
  if (!list) return;
  list.innerHTML = `
    <li>
      <span class="activity-dot"></span>
      <div><strong>${t('profile.overview.activity_unavailable_title')}</strong><span>${t('profile.overview.activity_unavailable_desc')}</span></div>
    </li>`;
}

function overviewValueEls() {
  return $$('.profile-summary-card .profile-summary-value');
}

async function loadOverviewSummary(userId, accounts) {
  const [accountStatusEl, linkedEl, cardsEl, sessionsEl] = overviewValueEls();

  if (accountStatusEl) accountStatusEl.textContent = currentProfile?.account_status || '—';

  const { data: idDocs } = await getMyIdentityDocuments(userId);
  if (linkedEl) linkedEl.textContent = `${idDocs?.length || 0} / 3`;

  let cardCount = 0;
  for (const account of accounts) {
    const { data: accountCards } = await getCardsForAccount(account.id);
    cardCount += (accountCards || []).filter((c) => String(c.card_status || '').toLowerCase() !== 'cancelled').length;
  }
  if (cardsEl) cardsEl.textContent = String(cardCount);

  const { data: sessions } = await fetchLoginSessions(userId);
  if (sessionsEl) sessionsEl.textContent = String((sessions || []).filter((s) => !s.logout_time).length);
}

/** Lightweight refresh used when a KYC decision lands — avoids re-walking every card. */
async function refreshOverviewAfterDecision() {
  const [accountStatusEl, linkedEl] = overviewValueEls();
  if (accountStatusEl) accountStatusEl.textContent = currentProfile?.account_status || '—';
  if (!currentUser) return;
  const { data: idDocs } = await getMyIdentityDocuments(currentUser.id);
  if (linkedEl) linkedEl.textContent = `${idDocs?.length || 0} / 3`;
}

/* -----------------------------------------------------------
   5. Sessions (see KNOWN GAPS note at the top of this file)
   ----------------------------------------------------------- */
async function fetchLoginSessions(userId) {
  try {
    const { data, error } = await supabase
      .from('login_sessions')
      .select('id, browser, device, login_time, logout_time')
      .eq('user_id', userId)
      .order('login_time', { ascending: false })
      .limit(20);
    if (error) return { data: [], error: error.message };
    return { data: data || [], error: null };
  } catch (err) {
    return { data: [], error: err.message };
  }
}

async function loadSessions(userId) {
  const list = document.getElementById('session-list');
  if (!list) return;

  const { data: sessions, error } = await fetchLoginSessions(userId);

  if (error || !sessions.length) {
    list.innerHTML = `<li class="session-item"><div><strong>${
      error ? t('profile.security.sessions.error') : t('profile.security.sessions.empty')
    }</strong></div></li>`;
    return;
  }

  const locale = currentLocale();
  list.innerHTML = sessions
    .map((s) => {
      const active = !s.logout_time;
      const when = s.login_time ? new Date(s.login_time).toLocaleString(locale) : t('profile.security.sessions.unknown_time');
      return `
      <li class="session-item">
        <span class="session-icon">
          <svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><rect x="2.5" y="4" width="15" height="10" rx="1.6" stroke="currentColor" stroke-width="1.4"/><path d="M7 17h6" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>
        </span>
        <div>
          <strong>${escapeHtml(s.browser || t('profile.security.sessions.unknown_browser'))} · ${escapeHtml(s.device || t('profile.security.sessions.unknown_device'))}</strong>
          <span>${active ? t('profile.security.sessions.active_now') : t('profile.security.sessions.signed_out')} · ${escapeHtml(when)}</span>
        </div>
      </li>`;
    })
    .join('');
}

/* -----------------------------------------------------------
   6a. Password change (shared by Security > Password and
       Account & security > Login settings > Change password)
   ----------------------------------------------------------- */
function passwordMeetsRequirements(pw) {
  return pw.length >= 10 && /[a-z]/.test(pw) && /[A-Z]/.test(pw) && /[0-9]/.test(pw) && /[^A-Za-z0-9]/.test(pw);
}

function wirePasswordForms() {
  const configs = [
    { formId: 'password-change-form', currentId: 'current-password', newId: 'new-password', confirmId: 'new-password-confirm' },
    { formId: 'login-password-change-form', currentId: 'login-current-password', newId: 'login-new-password', confirmId: 'login-new-password-confirm' },
  ];

  configs.forEach(({ formId, currentId, newId, confirmId }) => {
    const form = document.getElementById(formId);
    if (!form) return;

    form.addEventListener('submit', async (event) => {
      event.preventDefault();

      const currentInput = document.getElementById(currentId);
      const newInput = document.getElementById(newId);
      const confirmInput = document.getElementById(confirmId);
      const submitBtn = form.querySelector('button[type="submit"]');

      const currentPassword = currentInput?.value || '';
      const newPassword = newInput?.value || '';
      const confirmPassword = confirmInput?.value || '';

      if (!currentPassword) {
        toast(t('profile.password_toast.enter_current'), 'error');
        currentInput?.focus();
        return;
      }
      if (!passwordMeetsRequirements(newPassword)) {
        toast(t('profile.password_toast.requirements'), 'error');
        newInput?.focus();
        return;
      }
      if (newPassword !== confirmPassword) {
        toast(t('profile.password_toast.mismatch'), 'error');
        confirmInput?.focus();
        return;
      }

      submitBtn?.classList.add('is-loading');
      if (submitBtn) submitBtn.disabled = true;

      try {
        const { data: verified, error: verifyError } = await verifyCurrentPassword(currentPassword);
        if (verifyError || !verified) {
          toast(verifyError || t('profile.password_toast.incorrect_current'), 'error');
          return;
        }
        const { error: updateError } = await updateUserPassword(newPassword);
        if (updateError) {
          toast(updateError, 'error');
          return;
        }
        toast(t('profile.password_toast.updated'));
        form.reset();
      } catch (err) {
        toast(t('profile.password_toast.generic_error'), 'error');
      } finally {
        submitBtn?.classList.remove('is-loading');
        if (submitBtn) submitBtn.disabled = false;
      }
    });
  });
}

/* -----------------------------------------------------------
   6b. Forgot password (Login settings)
   ----------------------------------------------------------- */
function wireForgotPassword() {
  const btn = document.getElementById('login-forgot-password-btn');
  const status = document.getElementById('login-forgot-password-status');
  if (!btn) return;

  btn.addEventListener('click', async () => {
    if (!currentUser?.email) {
      if (status) status.textContent = t('profile.forgot_password.error_no_email');
      return;
    }
    btn.classList.add('is-loading');
    btn.disabled = true;
    const { error } = await requestPasswordReset(currentUser.email);
    btn.classList.remove('is-loading');
    btn.disabled = false;

    if (status) status.textContent = error || t('profile.forgot_password.sent_status').replace('{email}', currentUser.email);
    toast(error ? t('profile.forgot_password.toast_error') : t('profile.forgot_password.toast_sent'), error ? 'error' : 'success');
  });
}

/* -----------------------------------------------------------
   6c. Two-factor method picker (display + dead-end, matching
       login.js's existing pattern — no backend to switch method)
   ----------------------------------------------------------- */
function wireTwoFactorPicker() {
  $$('.auth-method-btn[data-method]').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (btn.classList.contains('is-selected')) return;
      const method = btn.getAttribute('data-method') === 'authenticator' ? t('profile.security.twofa.method_name_app') : t('profile.security.twofa.method_name_email');
      toast(t('profile.security.twofa.switch_unavailable').replace('{method}', method), 'error');
    });
  });
}

/* -----------------------------------------------------------
   6d. Notification preferences (UI-only — see KNOWN GAPS)
   ----------------------------------------------------------- */
function wireNotificationToggles() {
  $$('.preference-row .switch input:not(:disabled)').forEach((input) => {
    input.addEventListener('change', () => {
      toast(t('profile.notifications.toast_unsaved'));
    });
  });
}

/* -----------------------------------------------------------
   6e. Login session preference (UI-only — see KNOWN GAPS)
   ----------------------------------------------------------- */
function wireLoginSessionPreference() {
  const form = document.getElementById('login-session-preference-form');
  const preview = document.getElementById('login-session-preview');
  const status = document.getElementById('login-session-preference-status');
  if (!form) return;

  const labelKeys = {
    until_logout: 'profile.login_session.value.until_logout',
    sixty_minutes: 'profile.login_session.value.sixty',
    always: 'profile.login_session.value.always',
  };

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const selected = form.querySelector('input[name="login_session_preference"]:checked');
    const value = selected?.value || 'always';
    if (preview) preview.textContent = t(labelKeys[value] || labelKeys.always);
    if (status) status.textContent = t('profile.login_session.status_saved');
    toast(t('profile.login_session.toast_saved'));
  });
}

/* -----------------------------------------------------------
   6f. Face ID — status display only, deferred per instruction
   ----------------------------------------------------------- */
async function loadFaceIdStatus(userId) {
  const { data: creds } = await getMyWebauthnCredentials(userId);
  const enabled = !!(creds && creds.length);

  const previewPill = document.getElementById('login-faceid-preview');
  if (previewPill) {
    previewPill.textContent = enabled ? t('profile.faceid.enabled') : t('profile.faceid.disabled');
    previewPill.classList.toggle('status-pill--verified', enabled);
    previewPill.classList.toggle('status-pill--neutral', !enabled);
  }

  const statusPill = document.getElementById('faceid-status-pill');
  if (statusPill) {
    statusPill.textContent = `${t('profile.faceid.status_prefix')} ${enabled ? t('profile.faceid.enabled') : t('profile.faceid.disabled')}`;
    statusPill.classList.toggle('status-pill--verified', enabled);
    statusPill.classList.toggle('status-pill--neutral', !enabled);
  }

  const toggleBtn = document.getElementById('faceid-toggle-btn');
  if (toggleBtn) {
    toggleBtn.textContent = t('profile.faceid.button_coming_soon');
    toggleBtn.disabled = true;
    toggleBtn.title = t('profile.faceid.button_title');
  }

  const unavailableNote = document.getElementById('faceid-unavailable');
  if (unavailableNote && !window.PublicKeyCredential) {
    unavailableNote.hidden = false;
  }
}

/* -----------------------------------------------------------
   7a. Linked ID — password-gated reveal
   ----------------------------------------------------------- */
function wireLinkedId() {
  const viewBtn = document.getElementById('view-linked-id-btn');
  const modal = document.getElementById('linked-id-auth-modal');
  const closeBtn = document.getElementById('linked-id-modal-close');
  const cancelBtn = document.getElementById('linked-id-modal-cancel');
  const form = document.getElementById('linked-id-verify-form');
  const passwordInput = document.getElementById('linked-id-password');
  const errorEl = document.getElementById('linked-id-modal-error');
  const details = document.getElementById('linked-id-details');
  if (!viewBtn || !modal || !form) return;

  function openModal() {
    modal.hidden = false;
    requestAnimationFrame(() => modal.classList.add('is-open'));
    passwordInput?.focus();
  }

  function closeModal() {
    modal.classList.remove('is-open');
    if (errorEl) errorEl.textContent = '';
    form.reset();
    window.setTimeout(() => {
      modal.hidden = true;
    }, 200);
  }

  viewBtn.addEventListener('click', openModal);
  closeBtn?.addEventListener('click', closeModal);
  cancelBtn?.addEventListener('click', closeModal);
  modal.addEventListener('click', (event) => {
    if (event.target === modal) closeModal();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !modal.hidden) closeModal();
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const submitBtn = document.getElementById('linked-id-modal-submit');
    const password = passwordInput?.value || '';

    if (!password) {
      if (errorEl) errorEl.textContent = t('profile.linked_id.modal.error_empty');
      return;
    }

    submitBtn?.classList.add('is-loading');
    if (submitBtn) submitBtn.disabled = true;

    try {
      const { data: verified, error } = await verifyCurrentPassword(password);
      if (error || !verified) {
        if (errorEl) errorEl.textContent = error || t('profile.password_toast.incorrect_current');
        return;
      }
      await renderLinkedIdCards();
      if (details) details.hidden = false;
      closeModal();
    } finally {
      submitBtn?.classList.remove('is-loading');
      if (submitBtn) submitBtn.disabled = false;
    }
  });

  $$('[data-add-document-for]').forEach((btn) => {
    btn.addEventListener('click', () => {
      screenStack?.showScreen('screen-limits-upload');
    });
  });
}

async function renderLinkedIdCards() {
  if (!currentUser) return;
  const { data: docs, error } = await getMyIdentityDocuments(currentUser.id);
  if (error) {
    toast(t('profile.linked_id.load_error'), 'error');
    return;
  }

  const bySlot = new Map((docs || []).map((d) => [String(d.slot), d]));

  [1, 2, 3].forEach((slot) => {
    const card = document.getElementById(`linked-id-card-${slot}`);
    if (!card) return;
    const doc = bySlot.get(String(slot));
    const statusPill = card.querySelector('[data-linked-id-status]');
    const emptyState = card.querySelector('.linked-id-empty');
    const fieldsList = card.querySelector('.linked-id-fields');

    if (!doc) {
      if (statusPill) {
        statusPill.textContent = t('profile.linked_id.status_empty');
        statusPill.className = 'status-pill status-pill--neutral';
        statusPill.setAttribute('data-linked-id-status', '');
      }
      if (emptyState) emptyState.hidden = false;
      if (fieldsList) fieldsList.hidden = true;
      return;
    }

    if (statusPill) {
      statusPill.textContent = t('profile.linked_id.status_verified');
      statusPill.className = 'status-pill status-pill--verified';
      statusPill.setAttribute('data-linked-id-status', '');
    }
    if (emptyState) emptyState.hidden = true;
    if (fieldsList) {
      fieldsList.hidden = false;
      const setField = (name, value) => {
        const dd = fieldsList.querySelector(`[data-field="${name}"]`);
        if (dd) dd.textContent = value || '—';
      };
      setField('id_type', doc.id_type || doc.document_type);
      setField('full_name', doc.full_name);
      setField('id_number', doc.id_number);
      setField('date_of_birth', doc.date_of_birth);
      setField('gender', doc.gender);
    }
  });
}



/* -----------------------------------------------------------
   7b. Identity verification (KYC) — sequential tiers
   -----------------------------------------------------------
   Data comes from getMyIdentityDocumentHistory(): EVERY submission
   with its status, so pending / rejected documents are visible.
   A step's state is derived from the documents in its category:

     verified          any document in the category is verified
     pending           otherwise, any document is pending
     rejected          otherwise, the newest document was rejected
     action_required   otherwise, the newest was sent back for changes
     available         no submission yet

   Statuses only ever change through the admin review RPC — this
   file never writes status, slot, tier or account status.
   ----------------------------------------------------------- */

const KYC_STEPS = [
  {
    key: 'bvn',
    category: 'bvn',
    tier: 1,
    needsDetails: true,
    needsFile: false,
    types: ['bvn'],
  },
  {
    key: 'identity',
    category: 'identity',
    tier: 2,
    needsDetails: true,
    needsFile: true,
    types: ['nin', 'drivers_license', 'passport', 'voters_card'],
  },
  {
    key: 'address',
    category: 'proof_of_address',
    tier: 3,
    needsDetails: false,
    needsFile: true,
    types: ['electricity_bill', 'bank_statement', 'waste_bill', 'water_bill', 'house_rent_receipt', 'tenancy_agreement', 'land_use_charge'],
  },
];

const DOC_LABEL_FALLBACKS = {
  bvn: 'Bank Verification Number (BVN)',
  nin: 'National Identification Number (NIN)',
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

function docLabel(type) {
  return tr(`profile.accepted_docs.${type}`, DOC_LABEL_FALLBACKS[type] || type || '—');
}

/**
 * ID-number rules per document type.
 *   BVN and NIN: exactly 11 digits (confirmed by CBN/NIBSS and NIMC).
 *   Driver's license, passport, voter's card: issuer formats vary by
 *   series, so these only enforce charset + a sensible length range
 *   rather than risk rejecting a genuine number. Tighten min/max here
 *   once you have your KYC provider's exact formats.
 */
const ID_RULES = {
  bvn: {
    label: 'BVN',
    mode: 'digits',
    min: 11,
    max: 11,
    hint: 'Your 11-digit Bank Verification Number. Dial *565*0# from your registered phone to retrieve it.',
  },
  nin: {
    label: 'NIN',
    mode: 'digits',
    min: 11,
    max: 11,
    hint: 'Your 11-digit National Identification Number, shown on your NIN slip. Dial *346# to retrieve it.',
  },
  drivers_license: {
    label: "Driver's license number",
    mode: 'alnum',
    min: 10,
    max: 14,
    hint: 'Usually 12 letters and numbers, exactly as printed on the card.',
  },
  passport: {
    label: 'Passport number',
    mode: 'alnum',
    min: 8,
    max: 10,
    hint: 'Usually a letter followed by 8 digits, as printed on the data page.',
  },
  voters_card: {
    label: 'Voter identification number (VIN)',
    mode: 'alnum',
    min: 9,
    max: 20,
    hint: "Letters and numbers, exactly as printed on your voter's card.",
  },
};

function idRule(type) {
  const base = ID_RULES[type];
  if (!base) return null;
  return {
    ...base,
    label: tr(`profile.kyc.id_label.${type}`, base.label),
    hint: tr(`profile.kyc.id_hint.${type}`, base.hint),
  };
}

/** Strips anything the rule doesn't allow and caps the length — applied live as the user types. */
function sanitizeIdInput(raw, rule) {
  const value = String(raw || '');
  const cleaned = rule.mode === 'digits' ? value.replace(/\D/g, '') : value.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  return cleaned.slice(0, rule.max);
}

function validateIdNumber(value, rule) {
  const v = String(value || '');
  const unit = rule.mode === 'digits' ? tr('profile.kyc.unit.digits', 'digits') : tr('profile.kyc.unit.characters', 'characters');

  if (!v) return tr('profile.kyc.error.id_required', 'Enter your {label}.', { label: rule.label });

  if (v.length < rule.min || v.length > rule.max) {
    return rule.min === rule.max
      ? tr('profile.kyc.error.id_exact', '{label} must be exactly {n} {unit}.', { label: rule.label, n: rule.min, unit })
      : tr('profile.kyc.error.id_range', '{label} must be {min}–{max} {unit}.', { label: rule.label, min: rule.min, max: rule.max, unit });
  }

  const looksFake = rule.mode === 'digits' ? /^(\d)\1+$/.test(v) : !/\d/.test(v);
  if (looksFake) return tr('profile.kyc.error.id_invalid', 'Enter your {label} exactly as it was issued to you.', { label: rule.label });

  return '';
}

const NAME_PATTERN = /^[\p{L}][\p{L}\p{M}'’.\- ]*$/u;

function validateFullName(value) {
  const v = String(value || '').trim().replace(/\s+/g, ' ');
  if (!v) return tr('profile.kyc.error.name_required', 'Enter your full name.');
  if (!NAME_PATTERN.test(v) || v.split(' ').filter(Boolean).length < 2) {
    return tr('profile.kyc.error.name_invalid', 'Enter your first and last name exactly as on the document.');
  }
  return '';
}

function validateDob(value) {
  if (!value) return tr('profile.kyc.error.dob_required', 'Enter your date of birth.');
  const date = new Date(`${value}T00:00:00`);
  if (Number.isNaN(date.getTime()) || date > new Date() || date.getFullYear() < 1900) {
    return tr('profile.kyc.error.dob_invalid', 'Enter a valid date of birth.');
  }
  return '';
}

const KYC_ALLOWED_FILE_TYPES = ['application/pdf', 'image/jpeg', 'image/png'];
const KYC_MAX_FILE_BYTES = 10 * 1024 * 1024; // matches the identity-documents bucket limit

function validateKycFile(file) {
  if (!file) return tr('profile.kyc.error.file_required', 'Upload a copy of your document.');
  if (!KYC_ALLOWED_FILE_TYPES.includes(file.type)) return tr('profile.kyc.error.file_type', 'Only PDF, JPG or PNG files are accepted.');
  if (file.size > KYC_MAX_FILE_BYTES) return tr('profile.kyc.error.file_size', 'The file is larger than the 10MB limit.');
  return '';
}

/* ----- State ----- */
const kyc = {
  docs: [],
  loaded: false,
  error: null,
  submitting: false,
  file: null,
  signature: '',
};

let kycLoadToken = 0;

const KYC_CONTROL_IDS = {
  type: 'kyc-doc-type',
  'id-number': 'kyc-id-number',
  'full-name': 'kyc-full-name',
  dob: 'kyc-dob',
  gender: 'kyc-gender',
  file: 'kyc-dropzone',
};

function kycSignature(docs) {
  return (docs || []).map((d) => `${d.id}:${d.status}`).sort().join('|');
}

function computeKycSteps(docs) {
  const sorted = [...(docs || [])].sort((a, b) => new Date(b.submitted_at || 0) - new Date(a.submitted_at || 0));

  return KYC_STEPS.map((step) => {
    const inCategory = sorted.filter((d) => d.document_category === step.category);
    const verified = inCategory.find((d) => d.status === 'verified');
    const pending = inCategory.find((d) => d.status === 'pending');
    const latest = inCategory[0] || null;

    let status = 'available';
    let doc = null;

    if (verified) {
      status = 'verified';
      doc = verified;
    } else if (pending) {
      status = 'pending';
      doc = pending;
    } else if (latest && (latest.status === 'rejected' || latest.status === 'action_required')) {
      status = latest.status;
      doc = latest;
    }

    return { ...step, status, doc };
  });
}

function kycHasPending() {
  return computeKycSteps(kyc.docs).some((s) => s.status === 'pending');
}

/* ----- Copy ----- */
function stepTitle(step) {
  if (step.key === 'bvn') return tr('profile.kyc.step_bvn.title', 'Tier 1 — Bank Verification Number');
  if (step.key === 'identity') return tr('profile.kyc.step_identity.title', 'Tier 2 — Identity document');
  return tr('profile.kyc.step_address.title', 'Tier 3 — Proof of address');
}

function stepShortTitle(step) {
  if (step.key === 'bvn') return tr('profile.kyc.step_bvn.short', 'Tier 1 · BVN');
  if (step.key === 'identity') return tr('profile.kyc.step_identity.short', 'Tier 2 · Identity');
  return tr('profile.kyc.step_address.short', 'Tier 3 · Proof of address');
}

function stepDescription(step) {
  if (step.key === 'bvn') {
    return tr('profile.kyc.step_bvn.desc', 'Enter your BVN together with the name and date of birth registered against it.');
  }
  if (step.key === 'identity') {
    return tr('profile.kyc.step_identity.desc', 'Choose one government-issued ID, enter its details exactly as printed, and upload a clear copy.');
  }
  return tr('profile.kyc.step_address.desc', 'Upload a recent document that shows your name and your current address.');
}

function maskIdNumber(value) {
  const s = String(value || '');
  if (!s) return '—';
  if (s.length <= 4) return '••••';
  return `${'•'.repeat(Math.min(s.length - 4, 8))}${s.slice(-4)}`;
}

const KYC_ICONS = {
  check: '<circle cx="10" cy="10" r="7.5" stroke="currentColor" stroke-width="1.5"/><path d="m6.7 10.3 2.2 2.2 4.4-4.7" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>',
  clock: '<circle cx="10" cy="10" r="7.5" stroke="currentColor" stroke-width="1.5"/><path d="M10 5.8V10l2.8 1.7" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>',
  alert: '<path d="M10 3 17.5 16h-15L10 3Z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M10 8.3v3.2M10 13.7v.1" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>',
  upload: '<path d="M10 13V4M10 4 6.5 7.5M10 4l3.5 3.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/><path d="M4 14v1.5A1.5 1.5 0 0 0 5.5 17h9a1.5 1.5 0 0 0 1.5-1.5V14" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>',
};

function kycIcon(name) {
  return `<svg viewBox="0 0 20 20" fill="none" aria-hidden="true">${KYC_ICONS[name] || ''}</svg>`;
}

/* -----------------------------------------------------------
   Container — created inside the Upload documents screen if the
   markup doesn't already have #kyc-flow. The legacy single-form
   card is hidden (not removed) so nothing else breaks.
   ----------------------------------------------------------- */
function ensureKycContainer() {
  let root = document.getElementById('kyc-flow');
  if (root) return root;

  const screen = document.getElementById('screen-limits-upload');
  if (!screen) return null;

  screen.querySelectorAll(':scope > .profile-card').forEach((card) => {
    card.hidden = true;
  });

  root = document.createElement('div');
  root.id = 'kyc-flow';
  screen.appendChild(root);
  return root;
}

/* -----------------------------------------------------------
   Rendering
   ----------------------------------------------------------- */
function renderKyc() {
  const root = document.getElementById('kyc-flow');
  if (!root) return;

  if (!kyc.loaded) {
    root.innerHTML = `
      <div class="profile-card kyc-card kyc-card--loading" aria-busy="true">
        <p class="profile-card-desc">${escapeHtml(tr('profile.kyc.loading', 'Loading your verification status…'))}</p>
      </div>`;
    return;
  }

  if (kyc.error) {
    root.innerHTML = `
      <div class="profile-card kyc-card" role="alert">
        <div class="profile-card-head"><h3>${escapeHtml(tr('profile.kyc.load_error_title', "We couldn't load your verification status"))}</h3></div>
        <p class="profile-card-desc">${escapeHtml(tr('profile.kyc.load_error_desc', 'Check your connection and try again. Your existing applications are not affected.'))}</p>
        <button type="button" class="btn btn-ghost" id="kyc-retry-btn">${escapeHtml(tr('profile.kyc.retry', 'Try again'))}</button>
      </div>`;
    $('#kyc-retry-btn')?.addEventListener('click', () => reloadKyc());
    return;
  }

  const steps = computeKycSteps(kyc.docs);
  const doneCount = steps.filter((s) => s.status === 'verified').length;
  const current = steps.find((s) => s.status !== 'verified') || null;

  const parts = [renderKycOverview(steps, doneCount)];

  steps.forEach((step) => {
    if (step.status === 'verified') parts.push(renderVerifiedStep(step));
    else if (step === current) parts.push(step.status === 'pending' ? renderPendingStep(step) : renderKycForm(step));
    else if (step.status === 'pending') parts.push(renderPendingStep(step)); // out-of-order legacy submission
  });

  if (!current) parts.push(renderAllComplete());

  root.innerHTML = parts.join('');

  if (current && current.status !== 'pending') wireKycForm(current);
  $('[data-kyc-focus]', root)?.focus({ preventScroll: false });
}

function renderKycOverview(steps, doneCount) {
  const tier = resolveTier();
  const segments = steps
    .map((s) => `<span class="kyc-progress-seg${s.status === 'verified' ? ' is-done' : s.status === 'pending' ? ' is-active' : ''}"></span>`)
    .join('');

  return `
    <div class="profile-card kyc-card kyc-overview">
      <div class="profile-card-head">
        <h3>${escapeHtml(tr('profile.kyc.heading', 'Verification'))}</h3>
        <span class="tier-badge kyc-tier-badge" data-tier="${tier}">${escapeHtml(tr('profile.tier.label', 'Tier {n}', { n: tier }))}</span>
      </div>
      <p class="profile-card-desc">${escapeHtml(tr('profile.kyc.intro', 'Complete each step in order to raise your account tier and limits. The next step opens once the previous one is approved.'))}</p>
      <div class="kyc-progress" role="progressbar" aria-valuemin="0" aria-valuemax="${steps.length}" aria-valuenow="${doneCount}" aria-label="${escapeHtml(tr('profile.kyc.progress_label', 'Verification progress'))}">${segments}</div>
      <p class="field-hint kyc-progress-text">${escapeHtml(tr('profile.kyc.progress_text', '{done} of {total} steps verified', { done: doneCount, total: steps.length }))}</p>
    </div>`;
}

function renderVerifiedStep(step) {
  const when = step.doc?.reviewed_at ? formatDate(step.doc.reviewed_at) : '';
  return `
    <div class="profile-card kyc-card kyc-step kyc-step--verified">
      <div class="profile-card-head">
        <h4>${escapeHtml(stepShortTitle(step))}</h4>
        <span class="status-pill status-pill--verified">${kycIcon('check')}${escapeHtml(tr('profile.kyc.status.verified', 'Verified'))}</span>
      </div>
      <p class="profile-card-desc">${escapeHtml(docLabel(step.doc?.document_type))}${when ? ` · ${escapeHtml(tr('profile.kyc.verified_on', 'Verified on {date}', { date: when }))}` : ''}</p>
    </div>`;
}

function renderAllComplete() {
  return `
    <div class="profile-card kyc-card kyc-step kyc-step--complete" role="status">
      <div class="kyc-submitted">
        <span class="kyc-submitted-icon kyc-submitted-icon--done">${kycIcon('check')}</span>
        <div>
          <h3 data-kyc-focus tabindex="-1">${escapeHtml(tr('profile.kyc.complete.title', 'Verification complete'))}</h3>
          <p class="profile-card-desc">${escapeHtml(tr('profile.kyc.complete.desc', 'All verification steps are approved. Your account is at the highest tier.'))}</p>
        </div>
      </div>
    </div>`;
}

function renderPendingStep(step) {
  const doc = step.doc || {};
  const rows = [
    [tr('profile.kyc.summary.document', 'Document'), docLabel(doc.document_type)],
  ];
  if (doc.id_number) rows.push([tr('profile.kyc.summary.id_number', 'ID number'), maskIdNumber(doc.id_number)]);
  rows.push([tr('profile.kyc.summary.submitted', 'Submitted'), formatDate(doc.submitted_at, true)]);

  return `
    <div class="profile-card kyc-card kyc-step kyc-step--pending" role="status">
      <div class="kyc-submitted">
        <span class="kyc-submitted-icon kyc-submitted-icon--pending">${kycIcon('clock')}</span>
        <div>
          <div class="profile-card-head">
            <h3 data-kyc-focus tabindex="-1">${escapeHtml(tr('profile.kyc.pending.title', 'Application submitted'))}</h3>
            <span class="status-pill status-pill--pending">${escapeHtml(tr('profile.kyc.status.under_review', 'Under review'))}</span>
          </div>
          <p class="profile-card-desc">${escapeHtml(tr('profile.kyc.pending.desc', 'Your {doc} is being reviewed. We’ll notify you here and in your notifications as soon as a decision is made — you don’t need to submit it again.', { doc: docLabel(doc.document_type) }))}</p>
        </div>
      </div>

      <ol class="kyc-timeline" aria-label="${escapeHtml(tr('profile.kyc.timeline_label', 'Application progress'))}">
        <li class="is-done"><span>${escapeHtml(tr('profile.kyc.timeline.submitted', 'Submitted'))}</span></li>
        <li class="is-current" aria-current="step"><span>${escapeHtml(tr('profile.kyc.timeline.review', 'Under review'))}</span></li>
        <li><span>${escapeHtml(tr('profile.kyc.timeline.decision', 'Decision'))}</span></li>
      </ol>

      <dl class="kyc-summary">
        ${rows.map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`).join('')}
      </dl>
    </div>`;
}

function renderKycForm(step) {
  const resubmit = step.status === 'rejected' || step.status === 'action_required';
  const prev = resubmit ? step.doc : null;
  const singleType = step.types.length === 1;
  const selectedType = singleType ? step.types[0] : (prev && step.types.includes(prev.document_type) ? prev.document_type : '');
  const rule = idRule(selectedType);
  const today = new Date().toISOString().slice(0, 10);

  /* ---- Rejection / changes-requested banner ---- */
  let alertHtml = '';
  if (resubmit) {
    const rejected = step.status === 'rejected';
    const reason = prev?.rejection_reason || tr('profile.kyc.no_reason', 'No reason was recorded.');
    alertHtml = `
      <div class="kyc-alert kyc-alert--${rejected ? 'danger' : 'warning'}" role="alert" data-kyc-focus tabindex="-1">
        <span class="kyc-alert-icon">${kycIcon('alert')}</span>
        <div>
          <strong>${escapeHtml(rejected
            ? tr('profile.kyc.rejected.title', 'Your {doc} was not approved', { doc: docLabel(prev?.document_type) })
            : tr('profile.kyc.action_required.title', 'Your {doc} needs changes', { doc: docLabel(prev?.document_type) }))}</strong>
          <p class="kyc-alert-reason"><span>${escapeHtml(tr('profile.kyc.reason_label', 'Reason'))}:</span> ${escapeHtml(reason)}</p>
          <small>${escapeHtml(tr('profile.kyc.reviewed_on', 'Reviewed {date}', { date: formatDate(prev?.reviewed_at, true) }))} · ${escapeHtml(tr('profile.kyc.resubmit_hint', 'Correct the details below and submit again.'))}</small>
        </div>
      </div>`;
  }

  /* ---- Document type ---- */
  const typeField = singleType
    ? `<p class="kyc-fixed-type"><span class="kyc-fixed-label">${escapeHtml(tr('profile.kyc.document_label', 'Document'))}</span><strong>${escapeHtml(docLabel(step.types[0]))}</strong></p>`
    : `
      <div class="field">
        <label for="kyc-doc-type">${escapeHtml(tr('profile.kyc.type_label', 'Document type'))}</label>
        <select id="kyc-doc-type" name="document_type">
          <option value="">${escapeHtml(tr('profile.upload.type_select_placeholder', 'Select document type'))}</option>
          ${step.types.map((type) => `<option value="${type}"${type === selectedType ? ' selected' : ''}>${escapeHtml(docLabel(type))}</option>`).join('')}
        </select>
        <p class="field-error" data-error-for="type" role="alert"></p>
      </div>`;

  /* ---- Details (BVN + identity) ---- */
  const idValue = rule && prev?.id_number ? sanitizeIdInput(prev.id_number, rule) : '';
  const genderOptions = [
    ['female', tr('profile.personal.gender.female', 'Female')],
    ['male', tr('profile.personal.gender.male', 'Male')],
    ['nonbinary', tr('profile.personal.gender.nonbinary', 'Non-binary')],
  ];

  const detailsHtml = step.needsDetails
    ? `
      <div class="field">
        <div class="kyc-label-row">
          <label for="kyc-id-number" id="kyc-id-label">${escapeHtml(rule ? rule.label : tr('profile.kyc.id_number_label', 'ID number'))}</label>
          <span class="kyc-counter" id="kyc-id-counter" aria-hidden="true"></span>
        </div>
        <input type="text" id="kyc-id-number" name="id_number" autocomplete="off" autocapitalize="characters" spellcheck="false" aria-describedby="kyc-id-hint" value="${escapeHtml(idValue)}"${rule ? '' : ' disabled'}>
        <p class="field-hint" id="kyc-id-hint">${escapeHtml(rule ? rule.hint : tr('profile.kyc.choose_type_first', 'Choose a document type first.'))}</p>
        <p class="field-error" data-error-for="id-number" role="alert"></p>
      </div>

      <div class="field">
        <label for="kyc-full-name">${escapeHtml(tr('profile.upload.full_name_label', 'Full name'))}</label>
        <input type="text" id="kyc-full-name" name="full_name" autocomplete="name" value="${escapeHtml(prev?.full_name || '')}">
        <p class="field-hint">${escapeHtml(tr('profile.kyc.name_hint', 'Exactly as it appears on the document.'))}</p>
        <p class="field-error" data-error-for="full-name" role="alert"></p>
      </div>

      <div class="form-row-2">
        <div class="field">
          <label for="kyc-dob">${escapeHtml(tr('profile.upload.dob_label', 'Date of birth'))}</label>
          <input type="date" id="kyc-dob" name="date_of_birth" min="1900-01-01" max="${today}" value="${escapeHtml(prev?.date_of_birth ? String(prev.date_of_birth).slice(0, 10) : '')}">
          <p class="field-error" data-error-for="dob" role="alert"></p>
        </div>
        <div class="field">
          <label for="kyc-gender">${escapeHtml(tr('profile.upload.gender_label', 'Gender'))}</label>
          <select id="kyc-gender" name="gender">
            <option value="">${escapeHtml(tr('profile.upload.gender_select', 'Select'))}</option>
            ${genderOptions.map(([value, label]) => `<option value="${value}"${prev?.gender === value ? ' selected' : ''}>${escapeHtml(label)}</option>`).join('')}
          </select>
          <p class="field-error" data-error-for="gender" role="alert"></p>
        </div>
      </div>`
    : '';

  /* ---- File ---- */
  const fileHtml = step.needsFile
    ? `
      <div class="field">
        <label id="kyc-file-label">${escapeHtml(tr('profile.upload.file_label', 'Upload document'))}</label>
        <div class="document-dropzone" id="kyc-dropzone" role="button" tabindex="0" aria-labelledby="kyc-file-label">
          ${kycIcon('upload')}
          <p><span>${escapeHtml(tr('profile.upload.dropzone_pre', 'Drag & drop a file here, or '))}</span><span class="document-dropzone-browse">${escapeHtml(tr('profile.upload.dropzone_browse', 'browse files'))}</span></p>
          <small>${escapeHtml(tr('profile.kyc.file_formats', 'PDF, JPG or PNG — up to 10MB'))}</small>
          <input type="file" id="kyc-file-input" accept=".pdf,.jpg,.jpeg,.png" hidden>
        </div>
        <div class="document-upload-preview" id="kyc-file-preview" hidden>
          <span class="document-upload-preview-name" id="kyc-file-name">—</span>
          <button type="button" class="link-arrow-sm" id="kyc-file-remove">${escapeHtml(tr('profile.upload.remove_button', 'Remove'))}</button>
        </div>
        <p class="field-error" data-error-for="file" role="alert"></p>
      </div>`
    : '';

  return `
    <div class="profile-card kyc-card kyc-step kyc-step--form">
      <div class="profile-card-head">
        <h3>${escapeHtml(stepTitle(step))}</h3>
        <span class="status-pill ${step.status === 'available' ? 'status-pill--neutral' : 'status-pill--blocked'}">${escapeHtml(
          step.status === 'rejected'
            ? tr('profile.kyc.status.rejected', 'Rejected')
            : step.status === 'action_required'
            ? tr('profile.kyc.status.action_required', 'Action required')
            : tr('profile.kyc.status.not_started', 'Not started')
        )}</span>
      </div>
      <p class="profile-card-desc">${escapeHtml(stepDescription(step))}</p>
      ${alertHtml}

      <form id="kyc-form" class="profile-form" novalidate>
        ${typeField}
        ${detailsHtml}
        ${fileHtml}

        <p class="field-error kyc-form-error" id="kyc-error" role="alert"></p>
        <p class="field-hint kyc-legal">${escapeHtml(tr('profile.kyc.legal', 'By submitting, you confirm the details are accurate and match your document. You can only have one application under review at a time.'))}</p>

        <div class="profile-form-actions">
          <button type="submit" class="btn btn-primary" id="kyc-submit" disabled>${escapeHtml(resubmit ? tr('profile.kyc.resubmit', 'Resubmit for verification') : tr('profile.upload.submit', 'Submit for verification'))}</button>
        </div>
      </form>
    </div>`;
}

/* -----------------------------------------------------------
   Form behaviour
   ----------------------------------------------------------- */
function currentKycType(step) {
  return step.types.length === 1 ? step.types[0] : $('#kyc-doc-type')?.value || '';
}

function setKycFieldError(name, message) {
  const holder = document.querySelector(`[data-error-for="${name}"]`);
  if (holder) holder.textContent = message || '';
  const control = document.getElementById(KYC_CONTROL_IDS[name]);
  if (control) {
    if (message) control.setAttribute('aria-invalid', 'true');
    else control.removeAttribute('aria-invalid');
  }
}

/** Returns { ok, errors, values }. With report: true, every error is written to the form. */
function validateKycForm(step, { report = false } = {}) {
  const errors = {};
  const type = currentKycType(step);
  if (!type) errors.type = tr('profile.kyc.error.type_required', 'Choose a document type.');

  const values = { documentType: type };

  if (step.needsDetails) {
    const rule = idRule(type);
    const idValue = $('#kyc-id-number')?.value || '';
    if (rule) {
      const idError = validateIdNumber(idValue, rule);
      if (idError) errors['id-number'] = idError;
    } else if (type) {
      errors['id-number'] = tr('profile.kyc.error.id_required', 'Enter your {label}.', { label: tr('profile.kyc.id_number_label', 'ID number') });
    } else {
      errors['id-number'] = tr('profile.kyc.choose_type_first', 'Choose a document type first.');
    }

    const nameError = validateFullName($('#kyc-full-name')?.value);
    if (nameError) errors['full-name'] = nameError;

    const dobError = validateDob($('#kyc-dob')?.value);
    if (dobError) errors.dob = dobError;

    if (!$('#kyc-gender')?.value) errors.gender = tr('profile.kyc.error.gender_required', 'Select your gender.');

    values.idNumber = idValue;
    values.fullName = ($('#kyc-full-name')?.value || '').trim().replace(/\s+/g, ' ');
    values.dateOfBirth = $('#kyc-dob')?.value || '';
    values.gender = $('#kyc-gender')?.value || '';
  }

  if (step.needsFile) {
    const fileError = validateKycFile(kyc.file);
    if (fileError) errors.file = fileError;
  }

  if (report) {
    Object.keys(KYC_CONTROL_IDS).forEach((name) => setKycFieldError(name, errors[name] || ''));
  }

  return { ok: Object.keys(errors).length === 0, errors, values };
}

function updateKycIdField(step) {
  if (!step.needsDetails) return;
  const type = currentKycType(step);
  const rule = idRule(type);
  const input = $('#kyc-id-number');
  const label = $('#kyc-id-label');
  const hint = $('#kyc-id-hint');
  const counter = $('#kyc-id-counter');
  if (!input) return;

  if (!rule) {
    input.disabled = true;
    input.value = '';
    if (label) label.textContent = tr('profile.kyc.id_number_label', 'ID number');
    if (hint) hint.textContent = tr('profile.kyc.choose_type_first', 'Choose a document type first.');
    if (counter) counter.textContent = '';
    return;
  }

  input.disabled = false;
  input.maxLength = rule.max;
  input.inputMode = rule.mode === 'digits' ? 'numeric' : 'text';
  input.value = sanitizeIdInput(input.value, rule);
  if (label) label.textContent = rule.label;
  if (hint) hint.textContent = rule.hint;
  if (counter) counter.textContent = `${input.value.length}/${rule.max}`;
}

function wireKycForm(step) {
  const form = $('#kyc-form');
  if (!form) return;

  kyc.file = null;
  const submitBtn = $('#kyc-submit');

  const refreshSubmit = () => {
    const { ok } = validateKycForm(step);
    if (submitBtn) submitBtn.disabled = !ok || kyc.submitting;
  };

  const reportField = (name) => {
    const { errors } = validateKycForm(step);
    setKycFieldError(name, errors[name] || '');
  };

  /* ---- Document type ---- */
  $('#kyc-doc-type')?.addEventListener('change', () => {
    updateKycIdField(step);
    setKycFieldError('type', '');
    setKycFieldError('id-number', '');
    refreshSubmit();
  });

  /* ---- ID number: sanitised live, validated on blur ---- */
  const idInput = $('#kyc-id-number');
  idInput?.addEventListener('input', () => {
    const rule = idRule(currentKycType(step));
    if (rule) {
      idInput.value = sanitizeIdInput(idInput.value, rule);
      const counter = $('#kyc-id-counter');
      if (counter) counter.textContent = `${idInput.value.length}/${rule.max}`;
    }
    setKycFieldError('id-number', '');
    refreshSubmit();
  });
  idInput?.addEventListener('blur', () => {
    if (idInput.value) reportField('id-number');
  });

  /* ---- Name / DOB / gender ---- */
  [['kyc-full-name', 'full-name'], ['kyc-dob', 'dob'], ['kyc-gender', 'gender']].forEach(([id, name]) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('input', () => {
      setKycFieldError(name, '');
      refreshSubmit();
    });
    el.addEventListener('change', refreshSubmit);
    el.addEventListener('blur', () => {
      if (el.value) reportField(name);
    });
  });

  /* ---- File ---- */
  const dropzone = $('#kyc-dropzone');
  const fileInput = $('#kyc-file-input');
  const preview = $('#kyc-file-preview');
  const previewName = $('#kyc-file-name');

  const setFile = (file) => {
    if (file) {
      const fileError = validateKycFile(file);
      if (fileError) {
        kyc.file = null;
        if (preview) preview.hidden = true;
        if (fileInput) fileInput.value = '';
        setKycFieldError('file', fileError);
        refreshSubmit();
        return;
      }
      kyc.file = file;
      if (previewName) previewName.textContent = file.name;
      if (preview) preview.hidden = false;
      setKycFieldError('file', '');
    } else {
      kyc.file = null;
      if (preview) preview.hidden = true;
      if (fileInput) fileInput.value = '';
    }
    refreshSubmit();
  };

  if (dropzone && fileInput) {
    dropzone.addEventListener('click', () => fileInput.click());
    dropzone.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        fileInput.click();
      }
    });
    ['dragenter', 'dragover'].forEach((name) => {
      dropzone.addEventListener(name, (event) => {
        event.preventDefault();
        dropzone.classList.add('is-dragover');
      });
    });
    ['dragleave', 'drop'].forEach((name) => {
      dropzone.addEventListener(name, (event) => {
        event.preventDefault();
        dropzone.classList.remove('is-dragover');
      });
    });
    dropzone.addEventListener('drop', (event) => {
      const file = event.dataTransfer?.files?.[0];
      if (file) setFile(file);
    });
    fileInput.addEventListener('change', () => setFile(fileInput.files?.[0] || null));
    $('#kyc-file-remove')?.addEventListener('click', () => setFile(null));
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    handleKycSubmit(step);
  });

  updateKycIdField(step);
  refreshSubmit();
}

function showKycFormError(message) {
  const el = $('#kyc-error');
  if (el) el.textContent = message || '';
}

function friendlySubmitError(message) {
  if (/duplicate|unique|already/i.test(String(message))) {
    return tr('profile.kyc.error.already_open', 'You already have an application under review for this step.');
  }
  return message || tr('profile.upload.error_failed', 'Something went wrong. Please try again.');
}

async function handleKycSubmit(step) {
  if (kyc.submitting || !currentUser) return;

  const { ok, errors, values } = validateKycForm(step, { report: true });
  if (!ok) {
    const firstInvalid = Object.keys(KYC_CONTROL_IDS).find((name) => errors[name]);
    document.getElementById(KYC_CONTROL_IDS[firstInvalid])?.focus();
    return;
  }

  const submitBtn = $('#kyc-submit');
  showKycFormError('');
  kyc.submitting = true;
  submitBtn?.classList.add('is-loading');
  if (submitBtn) submitBtn.disabled = true;

  try {
    // Re-read the server state first: another tab, or a decision that
    // landed while this form was open, must not let a second
    // application through.
    const { data: fresh, error: freshError } = await getMyIdentityDocumentHistory(currentUser.id);
    if (freshError) {
      showKycFormError(tr('profile.kyc.error.status_check', "We couldn't check your application status. Please try again."));
      return;
    }
    kyc.docs = fresh || [];
    kyc.signature = kycSignature(kyc.docs);

    const steps = computeKycSteps(kyc.docs);
    const index = steps.findIndex((s) => s.key === step.key);

    if (steps.slice(0, index).some((s) => s.status !== 'verified')) {
      toast(tr('profile.kyc.error.previous_step', 'Complete the previous verification step first.'), 'error');
      renderKyc();
      return;
    }
    if (steps[index].status === 'pending' || steps[index].status === 'verified') {
      toast(tr('profile.kyc.error.already_open', 'You already have an application under review for this step.'), 'error');
      renderKyc();
      return;
    }

    const { error } = await submitIdentityDocument({
      file: step.needsFile ? kyc.file : null,
      documentType: values.documentType,
      documentCategory: step.category,
      fullName: values.fullName,
      idNumber: values.idNumber,
      dateOfBirth: values.dateOfBirth,
      gender: values.gender,
    });

    if (error) {
      const message = friendlySubmitError(error);
      showKycFormError(message);
      toast(message, 'error');
      return;
    }

    toast(tr('profile.kyc.toast_submitted', 'Application submitted. We’ll notify you once it has been reviewed.'));
    await reloadKyc({ silent: true });
  } catch (err) {
    showKycFormError(tr('profile.upload.error_failed', 'Something went wrong. Please try again.'));
  } finally {
    kyc.submitting = false;
    if (submitBtn && document.body.contains(submitBtn)) {
      submitBtn.classList.remove('is-loading');
      const { ok: stillOk } = validateKycForm(step);
      submitBtn.disabled = !stillOk;
    }
  }
}

/* -----------------------------------------------------------
   Loading, live updates
   ----------------------------------------------------------- */
async function reloadKyc({ silent = false } = {}) {
  if (!currentUser) return;
  const token = ++kycLoadToken;

  if (!silent) {
    kyc.loaded = false;
    kyc.error = null;
    renderKyc();
  }

  const { data, error } = await getMyIdentityDocumentHistory(currentUser.id);
  if (token !== kycLoadToken) return; // a newer request superseded this one

  if (error) {
    if (!silent || !kyc.loaded) {
      kyc.error = error;
      kyc.loaded = true;
      renderKyc();
    }
    return;
  }

  const nextSignature = kycSignature(data);
  const unchanged = silent && kyc.loaded && !kyc.error && nextSignature === kyc.signature;

  kyc.docs = data || [];
  kyc.signature = nextSignature;
  kyc.error = null;
  kyc.loaded = true;

  // A silent refresh with nothing new must not re-render — that would
  // wipe whatever the user is typing into the form.
  if (!unchanged) renderKyc();
}

/** A decision may have changed the tier, account status and Linked ID slots — pull all of it. */
async function refreshAfterDecision() {
  if (!currentUser) return;
  try {
    const { data: profile } = await getMyProfile(currentUser.id);
    if (profile) {
      currentProfile = profile;
      populateBanner(currentUser, profile);
      renderTierBadges();
    }
    const before = kyc.signature;
    await reloadKyc({ silent: true });
    if (kyc.signature !== before) await refreshOverviewAfterDecision();
    renderKyc(); // tier badge inside the overview card may have changed even if the signature didn't
  } catch (err) {
    console.warn('[Meridian] Could not refresh verification state:', err);
  }
}

let decisionRefreshTimer = null;
function scheduleDecisionRefresh() {
  window.clearTimeout(decisionRefreshTimer);
  decisionRefreshTimer = window.setTimeout(refreshAfterDecision, 600);
}

/**
 * Listens for new rows in `notifications` — the same feed the header
 * bell subscribes to (which also shows the toast). Its own channel
 * name is used so it can't collide with the bell's subscription.
 * Any new notification triggers a cheap re-read; the signature check
 * in reloadKyc() keeps that invisible unless something changed.
 */
function subscribeToKycUpdates(userId) {
  try {
    const channel = supabase
      .channel(`profile-kyc:${userId}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'notifications', filter: `user_id=eq.${userId}` },
        scheduleDecisionRefresh
      )
      .subscribe();
    window.addEventListener('pagehide', () => supabase.removeChannel(channel));
  } catch (err) {
    console.warn('[Meridian] Live verification updates unavailable:', err);
  }

  // Fallback if realtime is off or the connection dropped: when the
  // tab regains focus while an application is under review, re-check.
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && kycHasPending()) scheduleDecisionRefresh();
  });
}

function initKyc() {
  if (!ensureKycContainer()) return;
  renderKyc();
  reloadKyc();
  subscribeToKycUpdates(currentUser.id);
}
