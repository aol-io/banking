/* =============================================================
   MERIDIAN — Admin panel
   supabase/admin.js

   CHANGE LOG (this revision)
   ---------------------------
   - getUserDetail()'s cards query used `.eq('user_id', userId)` on
     the cards table, but cards has no user_id column — only
     account_id (confirmed against database.js's getCardsForAccount(),
     which correctly queries by account_id). Every call to this page
     for a customer with cards triggered a 400 from PostgREST.
     Restructured so cards (and the transactions fetch, which
     depended on the same account ids) are queried using the
     account ids already fetched in the same Promise.all, instead
     of guessing a user_id column that doesn't exist.
   - getCustomerRestrictionHistory()'s embedded select
     (`admin:performed_by(first_name,last_name)`) 400'd for the same
     reason listAdminAuditLog()'s admin_id embed used to:
     restriction_history.performed_by references auth.users(id), and
     auth.users has no first_name/last_name columns — those live on
     user_profiles, which PostgREST can't embed through a FK that
     doesn't point there. Replaced with the same two-step shim
     pattern already used in listAdminAuditLog(): fetch the rows
     plain, then resolve performed_by -> user_profiles in a second
     query and attach it as `admin` client-side.
   - Everything else is unchanged from the previous revision:
     merged policy/permission/limit-override/restriction/approval
     engine; every audit-log write uses the real admin_audit_logs
     columns (target_table/target_id/metadata); savePolicyGroup,
     saveCustomerPermissions, saveCustomerLimitOverrides call
     SECURITY DEFINER RPCs from 009_admin_policy_engine.sql.

   STILL OPEN — NOT FIXED HERE
   ---------------------------
   - admin_set_account_status()'s allow-list ('active' | 'restricted'
     | 'suspended' | 'closed' | 'Pending' | 'rejected') doesn't match
     the casing/values admin-policy.html's #customer-account-status
     dropdown actually sends ('Active' | 'Pending Verification' |
     'Restricted' | 'Suspended' | 'Frozen' | 'Closed') — every save
     from that dropdown currently 400s with 'Invalid account
     status.' Needs a decision on which side to change before fixing.
   - admin_restriction_action() (confirmed from its SQL) only ever
     writes an audit-trail row — it has no target column for the
     "Access & sessions" / "Disable services" chips to actually
     enforce or read back. Those chips remain write-only/audit-only
     until a real schema (table + columns) exists for them.

   PURPOSE
   -------
   The admin-side counterpart to supabase/database.js — every
   pages/admin/*.js page script imports from here instead of
   calling `supabase.from(...)` or `supabase.rpc(...)` directly.

   PATTERN
   -------
   Every export returns { data, error } — error is a friendly
   string or null, never a thrown exception. Mutating exports call
   SECURITY DEFINER RPCs from admin_schema.sql /
   009_admin_policy_engine.sql via wrap(supabase.rpc(...)) rather
   than `.update()`/`.delete()` directly — this file deliberately
   contains ZERO direct writes to accounts, transactions, cards,
   user_profiles.role, bank_policies, user_permissions, or
   user_limit_overrides. The one exception remains support ticket
   assignment/resolution (section 7), which admin_schema.sql calls
   out as a plain RLS-gated UPDATE rather than an RPC.

   ASSUMPTIONS FLAGGED BELOW (verify before relying on these in
   production):

     - support_tickets.status values assumed to be
       'open' | 'assigned' | 'resolved' | 'closed'.
     - KYC "pending" is read as user_profiles.account_status =
       'Pending'. admin_approve_kyc()/admin_reject_kyc() move it to
       'active'/'rejected'.
     - user_permissions' 13 boolean columns (in migration
       009_admin_policy_engine.sql, extended in
       012_extend_customer_permissions.sql) must match whatever
       field names admin-policy.js's checkboxes actually send —
       reconciled via PERMISSION_KEY_MAP in admin-policy.js.
     - approval_requests has no rows inserted anywhere yet — nothing
       currently requires maker-checker sign-off. decideApproval()
       below works once something starts creating requests.
     - admin-approvals.js's audit tab still renders columns
       (Affected customer, Previous → New, IP/browser, Approval
       status) that don't exist on admin_audit_logs — see the
       getAuditLog() shim note above. Those cells will show "—"
       until that page's rendering is reconciled against the real
       target_table/target_id/metadata columns.
   ============================================================= */

import { supabase } from './config.js';
import { getCurrentUser } from './auth.js';

/* -----------------------------------------------------------
   wrap() — normalizes a Supabase call into { data, error }.
   ----------------------------------------------------------- */
export async function wrap(promise) {
  try {
    const { data, error } = await promise;
    if (error) {
      return { data: null, error: friendlyAdminError(error) };
    }
    return { data, error: null };
  } catch (err) {
    return { data: null, error: friendlyAdminError(err) };
  }
}

function friendlyAdminError(error) {
  const message = error?.message || 'Something went wrong. Please try again.';
  if (message.toLowerCase().includes('failed to fetch')) {
    return 'Could not reach the server. Check your connection and try again.';
  }
  if (message.toLowerCase().includes('jwt')) {
    return 'Your admin session has expired. Please sign in again.';
  }
  return message;
}

export async function resolveUserId(userId) {
  if (userId) return userId;
  const { data: user } = await getCurrentUser();
  return user?.id ?? null;
}



async function getClientContext() {
  let ip = null;
  try {
    const res = await fetch('https://api.ipify.org?format=json');
    ip = (await res.json()).ip ?? null;
  } catch {
    // best-effort only — if this fails, ip stays null rather than blocking the action
  }
  return { browser: navigator.userAgent, ip };
}

/* -----------------------------------------------------------
   1. Dashboard KPIs
   ----------------------------------------------------------- */

/**
 * Every write function below that isn't already its own RPC
 * (support ticket assignment/resolution) should end up going
 * through log_admin_action() server-side. This client-side helper
 * exists only for the couple of plain-UPDATE paths (section 7)
 * that aren't RPC-wrapped; everything else logs inside its own
 * SECURITY DEFINER function and never calls this directly.
 */
async function logAdminAction({ adminId, action, targetTable, targetId = null, reason = null, metadata = {} }) {
  const { error } = await supabase.rpc('log_admin_action', {
    p_action: action,
    p_target_table: targetTable,
    p_target_id: targetId,
    p_reason: reason,
    p_metadata: metadata,
  });
  if (error) console.error('[Meridian Admin] Failed to write audit log:', error.message);
}

/* -----------------------------------------------------------
   1. Dashboard KPIs
   ----------------------------------------------------------- */

export async function getDashboardStats() {
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);

  const [totalUsers, balances, txToday, pendingKyc, openTickets, activeRiskFlags] = await Promise.all([
    supabase.from('user_profiles').select('id', { count: 'exact', head: true }),
    supabase.from('accounts').select('balance, currency'),
    supabase.from('transactions').select('id', { count: 'exact', head: true }).gte('created_at', startOfToday.toISOString()),
    supabase.from('user_profiles').select('id', { count: 'exact', head: true }).eq('account_status', 'Pending'),
    supabase.from('support_tickets').select('id', { count: 'exact', head: true }).in('status', ['open', 'assigned']),
    supabase.from('risk_flags').select('id', { count: 'exact', head: true }).eq('status', 'active'),
  ]);

  const firstError = [totalUsers, balances, txToday, pendingKyc, openTickets, activeRiskFlags].find((r) => r.error);
  if (firstError) {
    return { data: null, error: friendlyAdminError(firstError.error) };
  }

  const balanceByCurrency = (balances.data || []).reduce((acc, row) => {
    acc[row.currency] = (acc[row.currency] || 0) + Number(row.balance || 0);
    return acc;
  }, {});

  return {
    data: {
      totalUsers: totalUsers.count ?? 0,
      balanceByCurrency,
      transactionsToday: txToday.count ?? 0,
      pendingKyc: pendingKyc.count ?? 0,
      openTickets: openTickets.count ?? 0,
      activeRiskFlags: activeRiskFlags.count ?? 0,
    },
    error: null,
  };
}

/* -----------------------------------------------------------
   2. Users — admin-users.html / admin-user-detail.html
   ----------------------------------------------------------- */
export async function listUsers({ search, status, page = 1, pageSize = 25 } = {}) {
  let query = supabase.from('user_profiles').select('*', { count: 'exact' });

  if (status) query = query.eq('account_status', status);
  if (search) {
    query = query.or(`first_name.ilike.%${search}%,last_name.ilike.%${search}%,email.ilike.%${search}%`);
  }

  const from = (page - 1) * pageSize;
  query = query.order('created_at', { ascending: false }).range(from, from + pageSize - 1);

  const { data, error, count } = await query;
  if (error) return { data: null, error: friendlyAdminError(error) };
  return { data: { rows: data, total: count ?? 0, page, pageSize }, error: null };
}

/**
 * cards is queried by account_id (via the accounts already fetched
 * below), NOT by a user_id column — cards has no such column. See
 * this file's header note and database.js's getCardsForAccount()
 * for the confirmed schema shape. The transactions fetch depends on
 * the same account ids, so it's folded into the same second-stage
 * Promise.all rather than recomputed separately.
 */
export async function getUserDetail(userId) {
  const [profile, accounts, sessions] = await Promise.all([
    supabase.from('user_profiles').select('*').eq('id', userId).single(),
    supabase.from('accounts').select('*').eq('user_id', userId),
    supabase.from('login_sessions').select('*').eq('user_id', userId).order('login_time', { ascending: false }).limit(20),
  ]);

  if (profile.error) return { data: null, error: friendlyAdminError(profile.error) };

  const accountIds = (accounts.data || []).map((a) => a.id);

  const [cardsResult, txResult] = await Promise.all([
    accountIds.length
      ? supabase.from('cards').select('*').in('account_id', accountIds)
      : Promise.resolve({ data: [] }),
    accountIds.length
      ? supabase
          .from('transactions')
          .select('*')
          .or(accountIds.map((id) => `sender_account.eq.${id}`).concat(accountIds.map((id) => `receiver_account.eq.${id}`)).join(','))
          .order('created_at', { ascending: false })
          .limit(50)
      : Promise.resolve({ data: [] }),
  ]);

  return {
    data: {
      profile: profile.data,
      accounts: accounts.data || [],
      cards: cardsResult.data || [],
      recentTransactions: txResult.data || [],
      loginSessions: sessions.data || [],
      notes: [],
    },
    error: null,
  };
}

/**
 * Matches on name/email (user_profiles) or account number
 * (accounts) — for the customer picker on admin-user-detail.html
 * / admin-policy.html.
 */
export async function searchCustomers(query) {
  const clean = query.trim();
  if (!clean) return { data: [], error: null };

  const { data: byProfile, error: profileError } = await supabase
    .from('user_profiles')
    .select('id, first_name, last_name, email, account_status, avatar_url, created_at')
    .or(`first_name.ilike.%${clean}%,last_name.ilike.%${clean}%,email.ilike.%${clean}%`)
    .limit(10);

  if (profileError) return { data: [], error: friendlyAdminError(profileError) };

  const { data: byAccount } = await supabase
    .from('accounts')
    .select('user_id, account_number, user_profiles:user_id(id, first_name, last_name, email, account_status, avatar_url, created_at)')
    .ilike('account_number', `%${clean}%`)
    .limit(10);

  const merged = new Map();
  (byProfile || []).forEach((row) => merged.set(row.id, row));
  (byAccount || []).forEach((row) => {
    if (row.user_profiles) merged.set(row.user_profiles.id, row.user_profiles);
  });

  return { data: Array.from(merged.values()), error: null };
}

/* -----------------------------------------------------------
   3. Transactions — admin-transactions.html
   ----------------------------------------------------------- */

const TX_SORT_FIELDS = new Set(['amount', 'created_at']);

export async function listTransactions({
  status,
  currency,
  search,
  from: dateFrom,
  to: dateTo,
  sortField = 'created_at',
  sortDir = 'desc',
  page = 1,
  pageSize = 25,
} = {}) {
  let query = supabase.from('transactions').select('*', { count: 'exact' });

  if (status) query = query.eq('status', status);
  if (currency) query = query.eq('currency', currency);
  if (search) query = query.ilike('transaction_reference', `%${search}%`);
  if (dateFrom) query = query.gte('created_at', dateFrom);
  if (dateTo) query = query.lte('created_at', dateTo);

  const field = TX_SORT_FIELDS.has(sortField) ? sortField : 'created_at';
  query = query.order(field, { ascending: sortDir === 'asc' });

  const from = (page - 1) * pageSize;
  query = query.range(from, from + pageSize - 1);

  const { data, error, count } = await query;
  if (error) return { data: null, error: friendlyAdminError(error) };
  return { data: { rows: data, total: count ?? 0, page, pageSize }, error: null };
}

export async function getTransactionSummary({ status, currency, search, from: dateFrom, to: dateTo } = {}) {
  let query = supabase.from('transactions').select('amount, currency, status');

  if (status) query = query.eq('status', status);
  if (currency) query = query.eq('currency', currency);
  if (search) query = query.ilike('transaction_reference', `%${search}%`);
  if (dateFrom) query = query.gte('created_at', dateFrom);
  if (dateTo) query = query.lte('created_at', dateTo);

  const { data, error } = await query;
  if (error) return { data: null, error: friendlyAdminError(error) };

  const volumeByCurrency = {};
  let reversedCount = 0;
  let processingCount = 0;

  for (const tx of data) {
    if (tx.status === 'Reversed') {
      reversedCount += 1;
      continue;
    }
    if (tx.status === 'Processing') processingCount += 1;
    volumeByCurrency[tx.currency] = (volumeByCurrency[tx.currency] || 0) + Number(tx.amount || 0);
  }

  return {
    data: { volumeByCurrency, count: data.length, reversedCount, processingCount },
    error: null,
  };
}




export async function reverseTransaction(transactionId, reason) {
  return wrap(supabase.rpc('admin_reverse_transaction', {
    p_transaction_id: transactionId,
    p_reason: reason,
  }));
}

/* -----------------------------------------------------------
   4. KYC queue — admin-kyc.html
   ----------------------------------------------------------- */
export async function listKycQueue({ search, page = 1, pageSize = 25 } = {}) {
  let query = supabase
    .from('user_profiles')
    .select('*', { count: 'exact' })
    .eq('account_status', 'Pending');

  if (search) {
    query = query.or(`first_name.ilike.%${search}%,last_name.ilike.%${search}%,email.ilike.%${search}%`);
  }

  const from = (page - 1) * pageSize;
  query = query.order('created_at', { ascending: true }).range(from, from + pageSize - 1);

  const { data, error, count } = await query;
  if (error) return { data: null, error: friendlyAdminError(error) };
  return { data: { rows: data, total: count ?? 0, page, pageSize }, error: null };
}

export async function approveKyc(userId, reason) {
  return wrap(supabase.rpc('admin_approve_kyc', { p_user_id: userId, p_reason: reason ?? null }));
}

export async function rejectKyc(userId, reason) {
  return wrap(supabase.rpc('admin_reject_kyc', { p_user_id: userId, p_reason: reason }));
}




/* =============================================================
   MERIDIAN — supabase/admin.js  (ADDITIONS, revision 2)

   Paste this block into supabase/admin.js as a new section
   "4b. KYC documents", directly after rejectKyc() in section 4.

   Nothing to import: it uses `supabase`, `wrap()` and
   `friendlyAdminError()` that admin.js already defines, and
   follows the same { data, error } convention (error is a string
   or null).

   Reads need admin SELECT access to identity_documents and to the
   identity-documents storage bucket (see admin-kyc-setup.sql).
   The decision goes through the existing SECURITY DEFINER function
   admin_review_identity_document() — no direct table writes.

   Column note: rows are ordered by created_at (oldest first). If
   identity_documents names its submission timestamp something
   else, change SUBMITTED_COLUMN here and `created_at` in
   admin-kyc.js.
   ============================================================= */

/* -----------------------------------------------------------
   4b. KYC documents — admin-kyc.html
   ----------------------------------------------------------- */
const IDENTITY_BUCKET = 'identity-documents';
const SUBMITTED_COLUMN = 'submitted_at';

// user_id and reviewed_by both point at user_profiles, so the embed
// has to name the foreign key it follows.
const APPLICANT_EMBED =
  'applicant:user_profiles!identity_documents_user_id_fkey ( first_name, last_name, email, country )';

/**
 * Applicant ids whose name or email matches every word in `search`
 * (up to three words). Returns { ids: null } when there is nothing to
 * filter on.
 */
async function findUserIdsBySearch(search) {
  const tokens = String(search || '')
    .toLowerCase()
    .replace(/[%,()*\\]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 3);

  let ids = null;

  for (const token of tokens) {
    const { data, error } = await supabase
      .from('user_profiles')
      .select('id')
      .or(`first_name.ilike.%${token}%,last_name.ilike.%${token}%,email.ilike.%${token}%`)
      .limit(100);

    if (error) return { ids: null, error: friendlyAdminError(error) };

    const found = new Set((data || []).map((row) => row.id));
    ids = ids ? new Set([...ids].filter((id) => found.has(id))) : found;
    if (!ids.size) break;
  }

  return { ids: ids ? [...ids] : null, error: null };
}

/**
 * Pending documents, oldest first, with the applicant embedded.
 * → { data: { rows, total, page, pageSize }, error }
 */
export async function listPendingIdentityDocuments({ search, category, page = 1, pageSize = 25 } = {}) {
  let userIds = null;

  if (search) {
    const found = await findUserIdsBySearch(search);
    if (found.error) return { data: null, error: found.error };
    userIds = found.ids;
    if (userIds && !userIds.length) return { data: { rows: [], total: 0, page, pageSize }, error: null };
  }

  const from = (page - 1) * pageSize;

  let query = supabase
    .from('identity_documents')
    .select(`*, ${APPLICANT_EMBED}`, { count: 'exact' })
    .eq('status', 'pending')
    .order(SUBMITTED_COLUMN, { ascending: true })
    .range(from, from + pageSize - 1);

  if (category) query = query.eq('document_category', category);
  if (userIds) query = query.in('user_id', userIds);

  const { data, error, count } = await query;
  if (error) return { data: null, error: friendlyAdminError(error) };
  return { data: { rows: data || [], total: count ?? (data || []).length, page, pageSize }, error: null };
}

/**
 * Every submission from one applicant, newest first.
 * → { data: [rows], error }
 */
export async function getIdentityDocumentsForUser(userId) {
  const { data, error } = await supabase
    .from('identity_documents')
    .select('*')
    .eq('user_id', userId)
    .order(SUBMITTED_COLUMN, { ascending: false });

  if (error) return { data: [], error: friendlyAdminError(error) };
  return { data: data || [], error: null };
}

/**
 * Short-lived private link to a submitted file (5 minutes by default).
 * → { data: url, error }
 */
export async function getIdentityDocumentUrl(filePath, expiresIn = 300) {
  const { data, error } = await wrap(supabase.storage.from(IDENTITY_BUCKET).createSignedUrl(filePath, expiresIn));
  if (error) return { data: null, error };
  return { data: data?.signedUrl || null, error: null };
}

/**
 * Decide a document through admin_review_identity_document().
 *
 * `details` carries the optional review fields the database function
 * accepts: { slot, idType, fullName, idNumber, dateOfBirth, gender }.
 * Only the ones that are set are sent, so the function's own defaults
 * apply for the rest.
 *
 * `decision` must be a value the database function accepts — check it
 * against the function's definition before relying on the page's
 * 'verified' | 'rejected' | 'action_required'.
 */
export async function reviewIdentityDocument(documentId, decision, reason = null, details = {}) {
  const args = {
    p_document_id: documentId,
    p_decision: decision,
    p_reason: reason ?? null,
  };

  const optional = {
    p_slot: details.slot,
    p_id_type: details.idType,
    p_full_name: details.fullName,
    p_id_number: details.idNumber,
    p_date_of_birth: details.dateOfBirth,
    p_gender: details.gender,
  };
  Object.entries(optional).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') args[key] = value;
  });

  return wrap(supabase.rpc('admin_review_identity_document', args));
}
/* -----------------------------------------------------------
   5. Cards — admin-cards.html
   ----------------------------------------------------------- */
export async function listCards({ status, type, search, page = 1, pageSize = 25 } = {}) {
  let query = supabase.from('cards').select('*', { count: 'exact' });

  if (status) query = query.eq('card_status', status);
  if (type) query = query.eq('card_type', type);
  if (search) query = query.ilike('card_number', `%${search}%`);

  const from = (page - 1) * pageSize;
  query = query.order('created_at', { ascending: false }).range(from, from + pageSize - 1);

  const { data, error, count } = await query;
  if (error) return { data: null, error: friendlyAdminError(error) };
  return { data: { rows: data, total: count ?? 0, page, pageSize }, error: null };
}

export async function getCardDetail(cardId) {
  const { data: card, error: cardError } = await supabase.from('cards').select('*').eq('id', cardId).single();
  if (cardError) return { data: null, error: friendlyAdminError(cardError) };

  const { data: account, error: accountError } = await supabase
    .from('accounts')
    .select('*')
    .eq('id', card.account_id)
    .single();
  if (accountError) return { data: { card, account: null, holder: null }, error: null };

  const { data: holder } = await supabase
    .from('user_profiles')
    .select('id, first_name, last_name, email')
    .eq('id', account.user_id)
    .maybeSingle();

  return { data: { card, account, holder: holder || null }, error: null };
}

export async function getCardStatusSummary() {
  const [active, frozen, pending, cancelled] = await Promise.all([
    supabase.from('cards').select('id', { count: 'exact', head: true }).eq('card_status', 'Active'),
    supabase.from('cards').select('id', { count: 'exact', head: true }).eq('card_status', 'Frozen'),
    supabase.from('cards').select('id', { count: 'exact', head: true }).eq('card_status', 'Pending'),
    supabase.from('cards').select('id', { count: 'exact', head: true }).eq('card_status', 'Cancelled'),
  ]);

  const firstError = [active, frozen, pending, cancelled].find((r) => r.error);
  if (firstError) return { data: null, error: friendlyAdminError(firstError.error) };

  return {
    data: {
      active: active.count ?? 0,
      frozen: frozen.count ?? 0,
      pending: pending.count ?? 0,
      cancelled: cancelled.count ?? 0,
    },
    error: null,
  };
}

export async function setCardStatus(cardId, status, reason) {
  return wrap(supabase.rpc('admin_set_card_status', {
    p_card_id: cardId,
    p_status: status,
    p_reason: reason,
  }));
}

/* -----------------------------------------------------------
   6. Accounts — freeze/unfreeze, account status, restrictions
   ----------------------------------------------------------- */
export async function freezeAccount(accountId, reason) {
  return wrap(supabase.rpc('admin_freeze_account', { p_account_id: accountId, p_reason: reason }));
}

export async function unfreezeAccount(accountId, reason) {
  return wrap(supabase.rpc('admin_unfreeze_account', { p_account_id: accountId, p_reason: reason }));
}


export async function freezeCustomerAccounts(userId, reason) {
  return wrap(supabase.rpc('admin_freeze_customer_accounts', { p_user_id: userId, p_reason: reason }));
}

export async function unfreezeCustomerAccounts(userId, reason) {
  return wrap(supabase.rpc('admin_unfreeze_customer_accounts', { p_user_id: userId, p_reason: reason }));
}
/**
 * Customer-level status (active/restricted/suspended/closed) —
 * distinct from freezeAccount()/unfreezeAccount() above, which
 * operate on a single account row. Backs the Account Status
 * control on admin-user-detail.html / admin-policy.html.
 *
 * KNOWN ISSUE (not fixed here — flagging, not guessing): the RPC's
 * allow-list ('active' | 'restricted' | 'suspended' | 'closed' |
 * 'Pending' | 'rejected') doesn't match the values the
 * #customer-account-status dropdown actually sends ('Active' |
 * 'Pending Verification' | 'Restricted' | 'Suspended' | 'Frozen' |
 * 'Closed') — every call from that dropdown currently 400s.
 */
export async function updateAccountStatus(userId, status, reason) {
  return wrap(supabase.rpc('admin_set_account_status', {
    p_user_id: userId,
    p_status: status,
    p_reason: reason,
  }));
}

export async function performRestrictionAction(action, userId, reason) {
  return wrap(supabase.rpc('admin_restriction_action', {
    p_action: action,
    p_user_id: userId,
    p_reason: reason,
  }));
}

/**
 * restriction_history.performed_by references auth.users(id), which
 * has no first_name/last_name columns — those live on
 * user_profiles. PostgREST can't embed a join to columns that don't
 * exist on the referenced table (`admin:performed_by(first_name,
 * last_name)` used to 400 outright). Fetches the rows plain, then
 * resolves performed_by -> user_profiles in a second query, same
 * shim pattern as listAdminAuditLog()'s admin_id resolution below.
 */
export async function getCustomerRestrictionHistory(userId, { limit = 20 } = {}) {
  const { data, error } = await supabase
    .from('restriction_history')
    .select('*')
    .eq('user_id', userId)
    .order('performed_at', { ascending: false })
    .limit(limit);

  if (error) return { data: null, error: friendlyAdminError(error) };

  const adminIds = [...new Set((data || []).map((r) => r.performed_by).filter(Boolean))];
  let adminsById = {};
  if (adminIds.length) {
    const { data: admins } = await supabase
      .from('user_profiles')
      .select('id, first_name, last_name')
      .in('id', adminIds);
    adminsById = Object.fromEntries((admins || []).map((a) => [a.id, a]));
  }

  const rows = (data || []).map((r) => ({ ...r, admin: adminsById[r.performed_by] || null }));
  return { data: rows, error: null };
}

/* -----------------------------------------------------------
   7. Support tickets — admin-support.html
   ----------------------------------------------------------- */
export async function getSupportTicketSummary() {
  const [open, assigned, resolved, closed] = await Promise.all([
    supabase.from('support_tickets').select('id', { count: 'exact', head: true }).eq('status', 'open'),
    supabase.from('support_tickets').select('id', { count: 'exact', head: true }).eq('status', 'assigned'),
    supabase.from('support_tickets').select('id', { count: 'exact', head: true }).eq('status', 'resolved'),
    supabase.from('support_tickets').select('id', { count: 'exact', head: true }).eq('status', 'closed'),
  ]);
  const firstError = [open, assigned, resolved, closed].find((r) => r.error);
  if (firstError) return { data: null, error: friendlyAdminError(firstError.error) };
  return {
    data: {
      open: open.count ?? 0,
      assigned: assigned.count ?? 0,
      resolved: resolved.count ?? 0,
      closed: closed.count ?? 0,
    },
    error: null,
  };
}

export async function listSupportTickets({ status, priority, assignedTo, search, page = 1, pageSize = 25 } = {}) {
  let query = supabase.from('support_tickets').select('*', { count: 'exact' });

  if (status) query = query.eq('status', status);
  if (priority) query = query.eq('priority', priority);
  if (assignedTo) query = query.eq('assigned_admin_id', assignedTo);
  if (search) query = query.ilike('subject', `%${search}%`);

  const from = (page - 1) * pageSize;
  query = query.order('created_at', { ascending: false }).range(from, from + pageSize - 1);

  const { data, error, count } = await query;
  if (error) return { data: null, error: friendlyAdminError(error) };

  const userIds = [...new Set((data || []).map((t) => t.user_id).filter(Boolean))];
  let usersById = {};
  if (userIds.length) {
    const { data: users } = await supabase
      .from('user_profiles')
      .select('id, first_name, last_name, email')
      .in('id', userIds);
    usersById = Object.fromEntries((users || []).map((u) => [u.id, u]));
  }

  const rows = (data || []).map((t) => ({ ...t, customer: usersById[t.user_id] || null }));
  return { data: { rows, total: count ?? 0, page, pageSize }, error: null };
}

export async function getTicketDetail(ticketId) {
  const { data: ticket, error } = await supabase.from('support_tickets').select('*').eq('id', ticketId).single();
  if (error) return { data: null, error: friendlyAdminError(error) };

  const [{ data: customer }, { data: messages }] = await Promise.all([
    supabase.from('user_profiles').select('id, first_name, last_name, email').eq('id', ticket.user_id).maybeSingle(),
    supabase.from('support_ticket_messages').select('*').eq('ticket_id', ticketId).order('created_at', { ascending: true }),
  ]);

  return { data: { ticket, customer: customer || null, messages: messages || [] }, error: null };
}

export async function listAdminUsers() {
  const { data, error } = await supabase
    .from('user_profiles')
    .select('id, first_name, last_name, email, role')
    .in('role', ['support', 'admin', 'superadmin'])
    .order('first_name', { ascending: true });
  if (error) return { data: null, error: friendlyAdminError(error) };
  return { data, error: null };
}

export async function assignTicket(ticketId, adminId) {
  return wrap(
    supabase.from('support_tickets')
      .update({ assigned_admin_id: adminId, status: 'assigned', updated_at: new Date().toISOString() })
      .eq('id', ticketId)
  );
}

export async function replyToTicket(ticketId, adminId, body) {
  return wrap(
    supabase.from('support_ticket_messages')
      .insert({ ticket_id: ticketId, sender_id: adminId, is_admin: true, body })
  );
}

export async function resolveTicket(ticketId, resolutionNote) {
  return wrap(
    supabase.from('support_tickets')
      .update({ status: 'resolved', resolution_note: resolutionNote, updated_at: new Date().toISOString() })
      .eq('id', ticketId)
  );
}

export async function reopenTicket(ticketId) {
  return wrap(
    supabase.from('support_tickets')
      .update({ status: 'open', updated_at: new Date().toISOString() })
      .eq('id', ticketId)
  );
}

/* -----------------------------------------------------------
   8. Risk / fraud — admin-risk.html
   ----------------------------------------------------------- */
export async function getRiskFlagSummary() {
  const [active, escalated, resolved] = await Promise.all([
    supabase.from('risk_flags').select('id', { count: 'exact', head: true }).eq('status', 'active'),
    supabase.from('risk_flags').select('id', { count: 'exact', head: true }).eq('status', 'escalated'),
    supabase.from('risk_flags').select('id', { count: 'exact', head: true }).eq('status', 'resolved'),
  ]);
  const firstError = [active, escalated, resolved].find((r) => r.error);
  if (firstError) return { data: null, error: friendlyAdminError(firstError.error) };
  return {
    data: { active: active.count ?? 0, escalated: escalated.count ?? 0, resolved: resolved.count ?? 0 },
    error: null,
  };
}

export async function listRiskFlags({ status, severity, search, page = 1, pageSize = 25 } = {}) {
  let query = supabase.from('risk_flags').select('*', { count: 'exact' });

  if (status) query = query.eq('status', status);
  if (severity) query = query.eq('severity', severity);
  if (search) query = query.ilike('description', `%${search}%`);

  const from = (page - 1) * pageSize;
  query = query.order('created_at', { ascending: false }).range(from, from + pageSize - 1);

  const { data, error, count } = await query;
  if (error) return { data: null, error: friendlyAdminError(error) };

  const userIds = [...new Set((data || []).map((f) => f.user_id).filter(Boolean))];
  let usersById = {};
  if (userIds.length) {
    const { data: users } = await supabase
      .from('user_profiles')
      .select('id, first_name, last_name, email')
      .in('id', userIds);
    usersById = Object.fromEntries((users || []).map((u) => [u.id, u]));
  }

  const rows = (data || []).map((f) => ({ ...f, customer: usersById[f.user_id] || null }));
  return { data: { rows, total: count ?? 0, page, pageSize }, error: null };
}

export async function getRiskFlagDetail(flagId) {
  const { data: flag, error } = await supabase.from('risk_flags').select('*').eq('id', flagId).single();
  if (error) return { data: null, error: friendlyAdminError(error) };

  const { data: customer } = await supabase
    .from('user_profiles')
    .select('id, first_name, last_name, email')
    .eq('id', flag.user_id)
    .maybeSingle();

  let transaction = null;
  if (flag.transaction_id) {
    const { data: tx } = await supabase.from('transactions').select('*').eq('id', flag.transaction_id).maybeSingle();
    transaction = tx || null;
  }

  return { data: { flag, customer: customer || null, transaction }, error: null };
}

export async function dismissRiskFlag(flagId, reason) {
  return wrap(supabase.rpc('admin_dismiss_risk_flag', { p_flag_id: flagId, p_reason: reason }));
}

export async function escalateRiskFlag(flagId, reason) {
  return wrap(supabase.rpc('admin_escalate_risk_flag', { p_flag_id: flagId, p_reason: reason }));
}

export async function resolveRiskFlag(flagId, reason) {
  return wrap(supabase.rpc('admin_resolve_risk_flag', { p_flag_id: flagId, p_reason: reason }));
}

/* -----------------------------------------------------------
   9. Reports — admin-reports.html
   ----------------------------------------------------------- */
export async function getVolumeReport({ from, to }) {
  const { data, error } = await supabase
    .from('transactions')
    .select('amount, fee, currency, created_at, status')
    .gte('created_at', from)
    .lte('created_at', to);

  if (error) return { data: null, error: friendlyAdminError(error) };

  const byCurrency = {};
  for (const tx of data) {
    if (tx.status === 'Reversed') continue;
    const bucket = (byCurrency[tx.currency] ||= { volume: 0, fees: 0, count: 0 });
    bucket.volume += Number(tx.amount || 0);
    bucket.fees += Number(tx.fee || 0);
    bucket.count += 1;
  }

  return { data: { byCurrency, rangeFrom: from, rangeTo: to }, error: null };
}





/* -----------------------------------------------------------
   10. Audit log — admin-audit-log.html, admin-approvals.js
   ----------------------------------------------------------- */
export async function listAdminAuditLog({
  adminId,
  targetTable,
  action,
  from,
  to,
  search,
  page = 1,
  pageSize = 50,
} = {}) {
  let query = supabase.from('admin_audit_logs').select('*', { count: 'exact' });

  if (adminId) query = query.eq('admin_id', adminId);
  if (targetTable) query = query.eq('target_table', targetTable);
  if (action) query = query.eq('action', action);
  if (from) query = query.gte('created_at', from);
  if (to) query = query.lte('created_at', to);
  if (search) query = query.ilike('reason', `%${search}%`);

  const fromIdx = (page - 1) * pageSize;
  query = query.order('created_at', { ascending: false }).range(fromIdx, fromIdx + pageSize - 1);

  const { data, error, count } = await query;
  if (error) return { data: null, error: friendlyAdminError(error) };

  // admin_audit_logs.admin_id references auth.users, not
  // user_profiles, so it can't be embedded via Supabase's foreign-
  // table join syntax. Resolve admin names with a second lookup.
  const adminIds = [...new Set((data || []).map((r) => r.admin_id).filter(Boolean))];
  let adminsById = {};
  if (adminIds.length) {
    const { data: admins } = await supabase
      .from('user_profiles')
      .select('id, first_name, last_name')
      .in('id', adminIds);
    adminsById = Object.fromEntries((admins || []).map((a) => [a.id, a]));
  }

  const rows = (data || []).map((r) => ({ ...r, admin: adminsById[r.admin_id] || null }));
  return { data: { rows, total: count ?? 0, page, pageSize }, error: null };
}

/**
 * Thin shim over listAdminAuditLog() — admin-approvals.js imports a
 * `getAuditLog` that isn't otherwise defined here. Adapts
 * listAdminAuditLog()'s { data: { rows, total } } shape into the
 * flat { data: rows, error, count } shape admin-approvals.js
 * expects, without fabricating columns that don't exist on
 * admin_audit_logs (customer, previous_value/new_value,
 * ip_address/browser, approval_status).
 *
 * Known limitations: the `action` filter is applied client-side
 * after fetching a page, so pagination/count can be slightly off
 * when that filter is active; the `from`/`to` date filters aren't
 * applied at all (listAdminAuditLog doesn't support a date range).
 */
export async function getAuditLog({ action, ...rest } = {}) {
  const { data, error } = await listAdminAuditLog(rest);
  if (error) return { data: [], error, count: 0 };

  let rows = data.rows;
  if (action) rows = rows.filter((r) => r.action === action);

  return { data: rows, error: null, count: data.total };
}

export async function getAuditFilterOptions() {
  const [{ data: admins }, { data: actions }] = await Promise.all([
    supabase.from('user_profiles').select('id, first_name, last_name').in('role', ['support', 'admin', 'superadmin']),
    supabase.from('admin_audit_logs').select('action').limit(1000),
  ]);

  const uniqueActions = Array.from(new Set((actions || []).map((row) => row.action))).sort();
  return { data: { admins: admins || [], actions: uniqueActions }, error: null };
}




/* -----------------------------------------------------------
   11. Role management — admin-settings.html, superadmin only.
   ----------------------------------------------------------- */
export async function setUserRole(userId, role, reason) {
  return wrap(supabase.rpc('admin_set_user_role', {
    p_user_id: userId,
    p_role: role,
    p_reason: reason,
  }));
}

/* -----------------------------------------------------------
   12. Bank policies (global defaults) — admin-policy.html
   -----------------------------------------------------------
   Writes go through admin_save_policy_group() (SECURITY DEFINER)
   from 009_admin_policy_engine.sql — it does the upsert AND
   writes the field-level policy_change_history rows in one
   transaction, so the two can't desync the way two separate
   client calls could.
   ----------------------------------------------------------- */
export async function getPolicyGroup(group) {
  return wrap(supabase.from('bank_policies').select('*').eq('policy_group', group).maybeSingle());
}

export async function getAllPolicyGroups() {
  return wrap(supabase.from('bank_policies').select('*'));
}

export async function savePolicyGroup(group, values, reason) {
  return wrap(supabase.rpc('admin_save_policy_group', {
    p_policy_group: group,
    p_values: values,
    p_reason: reason ?? null,
  }));
}

export async function getPolicyChangeHistory({ limit = 50, offset = 0 } = {}) {
  return wrap(
    supabase
      .from('policy_change_history')
      .select('*, admin:changed_by(first_name,last_name)')
      .order('changed_at', { ascending: false })
      .range(offset, offset + limit - 1)
  );
}

/* -----------------------------------------------------------
   13. Customer permissions & limit overrides —
       admin-user-detail.html / admin-policy.html
   ----------------------------------------------------------- */
export async function getCustomerPermissions(userId) {
  return wrap(supabase.from('user_permissions').select('*').eq('user_id', userId).maybeSingle());
}


export async function saveCustomerPermissions(userId, permissions, reason) {
  const ctx = await getClientContext();
  return wrap(supabase.rpc('admin_save_customer_permissions', {
    p_user_id: userId,
    p_permissions: permissions,
    p_reason: reason ?? null,
    p_ip_address: ctx.ip,
    p_browser: ctx.browser,
  }));
}

export async function getCustomerLimitOverrides(userId) {
  return wrap(supabase.from('user_limit_overrides').select('*').eq('user_id', userId).maybeSingle());
}

export async function saveCustomerLimitOverrides(userId, overrides, reason) {
  return wrap(supabase.rpc('admin_save_customer_limit_overrides', {
    p_user_id: userId,
    p_overrides: overrides,
    p_reason: reason ?? null,
  }));
}

/* -----------------------------------------------------------
   14. Approval workflow (maker-checker) — admin-approvals.html
   ----------------------------------------------------------- */
export async function getApprovalStats() {
  return wrap(supabase.rpc('admin_get_approval_stats'));
}

export async function getApprovalQueue({ status = 'pending', type = 'all', limit = 25, offset = 0 } = {}) {
  let query = supabase
    .from('approval_requests')
    .select('*, requester:requested_by(first_name,last_name), customer:customer_id(first_name,last_name)', { count: 'exact' })
    .order('requested_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (status !== 'all') query = query.eq('status', status);
  if (type !== 'all') query = query.eq('type', type);

  const { data, error, count } = await query;
  if (error) return { data: [], error: friendlyAdminError(error), count: 0 };
  return { data: data ?? [], error: null, count: count ?? 0 };
}

export async function getApprovalRequest(requestId) {
  return wrap(
    supabase
      .from('approval_requests')
      .select('*, requester:requested_by(first_name,last_name), customer:customer_id(first_name,last_name)')
      .eq('id', requestId)
      .single()
  );
}

/**
 * Approves or rejects a request. The maker-checker rule ("no
 * administrator approves their own request") is enforced inside
 * admin_decide_approval() server-side — any disabled-button check
 * in admin-approvals.js is UX only, not the real guard.
 */
export async function decideApproval(requestId, decision, reason) {
  return wrap(supabase.rpc('admin_decide_approval', {
    p_request_id: requestId,
    p_decision: decision,
    p_reason: reason,
  }));
}
