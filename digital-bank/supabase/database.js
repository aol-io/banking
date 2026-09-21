/* =============================================================
   MERIDIAN — International Digital Banking
   Database module: supabase/database.js

   Thin, typed-in-spirit wrappers around the tables defined in the
   project's schema.sql (accounts, transactions, beneficiaries,
   cards, savings_goals, notifications, support_tickets,
   exchange_rates, user_profiles, investments, investment_orders,
   watchlist, market_prices_cache, identity_documents,
   webauthn_credentials). Same contract as auth.js: every
   exported function returns a plain { data, error } object, so
   callers never need try/catch for expected failures.

     import { getMyAccounts, createTransfer } from '../supabase/database.js';

   Row Level Security is assumed to scope every table to
   `auth.uid()` server-side — the `userId` params below are for
   convenience and readability, not for access control. Never treat
   client-supplied IDs as a security boundary; RLS is what actually
   enforces "you can only see your own rows."
   ============================================================= */

import { supabase } from './config.js';
import { getCurrentUser } from './auth.js';

/* -----------------------------------------------------------
   Helpers
   ----------------------------------------------------------- */

async function resolveUserId(userId) {
  if (userId) return userId;
  const { data: user } = await getCurrentUser();
  return user?.id ?? null;
}

function wrap(promise) {
  return promise.then(({ data, error }) => ({ data: data ?? null, error: error ? error.message : null }));
}

/* -----------------------------------------------------------
   User profile
   ----------------------------------------------------------- */

/** The signed-in (or given) user's profile row. */
export async function getMyProfile(userId) {
  const uid = await resolveUserId(userId);
  if (!uid) return { data: null, error: 'Not signed in.' };
  return wrap(supabase.from('user_profiles').select('*').eq('id', uid).single());
}

/**
 * Updates arbitrary fields on the signed-in (or given) user's profile.
 * Used right after signUpUser() to save fields it doesn't collect
 * (date_of_birth, nationality, country, two_factor_method,
 * marketing_opt_in), and later by profile.html / settings.html.
 */
export async function updateMyProfile(updates, userId) {
  const uid = await resolveUserId(userId);
  if (!uid) return { data: null, error: 'Not signed in.' };
  return wrap(
    supabase
      .from('user_profiles')
      .update({ ...updates, updated_at: new Date().toISOString() })
      .eq('id', uid)
      .select()
      .single()
  );
}

/* -----------------------------------------------------------
   Accounts
   ----------------------------------------------------------- */

/** All currency accounts belonging to a user (defaults to the signed-in user). */
export async function getMyAccounts(userId) {
  const uid = await resolveUserId(userId);
  if (!uid) return { data: [], error: 'Not signed in.' };
  return wrap(
    supabase.from('accounts').select('*').eq('user_id', uid).order('created_at', { ascending: true })
  );
}

export async function getAccountById(accountId) {
  return wrap(supabase.from('accounts').select('*').eq('id', accountId).single());
}

/** Sum of every account balance, converted to a target currency using exchange_rates. */
export async function getTotalBalance(userId, displayCurrency = 'USD') {
  const { data: accounts, error } = await getMyAccounts(userId);
  if (error) return { data: null, error };

  let total = 0;
  for (const account of accounts) {
    if (account.currency === displayCurrency) {
      total += Number(account.balance);
      continue;
    }
    const { data: rate } = await getExchangeRate(account.currency, displayCurrency);
    total += Number(account.balance) * (rate?.exchange_rate ?? 1);
  }
  return { data: { total, currency: displayCurrency }, error: null };
}

/* -----------------------------------------------------------
   Opening a new account
   ----------------------------------------------------------- */

const SUPPORTED_CURRENCIES = ['USD', 'EUR', 'GBP', 'SGD', 'JPY', 'NGN', 'CAD', 'AUD', 'CHF'];

/**
 * Demo-friendly, client-side detail generator. Real banking details
 * (IBAN, SWIFT/BIC, routing numbers, sort codes) must come from your
 * banking-as-a-service partner or ledger provider in production —
 * never mint them in the browser. This exists so the "Add currency
 * account" flow on accounts.html has something plausible to show.
 */
function generateAccountDetails(currency) {
  const digits = (n) => String(Math.floor(Math.random() * 10 ** n)).padStart(n, '0');
  const swift = `MRDN${currency.slice(0, 2)}${currency === 'GBP' ? 'LN' : currency.slice(0, 2)}`;

  if (currency === 'EUR') {
    return { account_number: null, iban: `DE89 3704 ${digits(4)} ${digits(4)} ${digits(2)}`, swift_code: swift, sort_code: null };
  }
  if (currency === 'GBP') {
    return { account_number: digits(8), iban: null, swift_code: null, sort_code: `${digits(2)}-${digits(2)}-${digits(2)}` };
  }
  return { account_number: digits(10), iban: null, swift_code: swift, sort_code: null };
}

/**
 * Opens a new currency account for the signed-in (or given) user.
 * Rejects duplicates (same currency + account type already open)
 * and requires a business name for business accounts.
 */
export async function createAccount({ currency, accountType = 'personal', businessName, userId }) {
  const uid = await resolveUserId(userId);
  if (!uid) return { data: null, error: 'Not signed in.' };
  if (!SUPPORTED_CURRENCIES.includes(currency)) return { data: null, error: 'Unsupported currency.' };
  if (accountType === 'business' && !businessName?.trim()) {
    return { data: null, error: 'Business name is required for a business account.' };
  }

  const { data: existing } = await getMyAccounts(uid);
  if (existing.some((a) => a.currency === currency && (a.account_type || 'personal') === accountType)) {
    return { data: null, error: `You already have a ${accountType} ${currency} account.` };
  }

  const details = generateAccountDetails(currency);

  return wrap(
    supabase
      .from('accounts')
      .insert({
        user_id: uid,
        currency,
        balance: 0,
        available_balance: 0,
        account_type: accountType,
        business_name: accountType === 'business' ? businessName.trim() : null,
        ...details,
      })
      .select()
      .single()
  );
}

/* -----------------------------------------------------------
   Beneficiaries
   ----------------------------------------------------------- */

export async function getMyBeneficiaries(userId) {
  const uid = await resolveUserId(userId);
  if (!uid) return { data: [], error: 'Not signed in.' };
  return wrap(
    supabase.from('beneficiaries').select('*').eq('user_id', uid).order('beneficiary_name', { ascending: true })
  );
}

export async function addBeneficiary({ beneficiaryName, bankName, accountNumber, swiftCode, country, currency = 'USD', userId }) {
  const uid = await resolveUserId(userId);
  if (!uid) return { data: null, error: 'Not signed in.' };
  return wrap(
    supabase
      .from('beneficiaries')
      .insert({
        user_id: uid,
        beneficiary_name: beneficiaryName,
        bank_name: bankName,
        account_number: accountNumber,
        swift_code: swiftCode,
        country,
        currency,
      })
      .select()
      .single()
  );
}

export async function removeBeneficiary(beneficiaryId) {
  return wrap(supabase.from('beneficiaries').delete().eq('id', beneficiaryId));
}

/* -----------------------------------------------------------
   Recipient lookup (used by transfer.js's new-recipient flow)
   -----------------------------------------------------------
   Tries to auto-identify who an account number/IBAN belongs to,
   without ever exposing another user's full account row:
     1. Check the caller's own saved beneficiaries for a match.
     2. Otherwise check if it belongs to another Meridian user via
        a SECURITY DEFINER RPC (find_account_holder) that returns
        only display_name/bank_name/currency — never an account id.
        (This RPC must exist in your Supabase project — see the
        SQL definition kept alongside this file's setup notes.)
   Returns { data: null } (not an error) when nothing matches, so
   the UI can fall back to manual entry.
   ----------------------------------------------------------- */
export async function findRecipient(identifier, { beneficiaries = [] } = {}) {
  const clean = String(identifier || '').replace(/\s+/g, '').toUpperCase();
  if (!clean) return { data: null, error: null };

  const savedMatch = beneficiaries.find(
    (b) => b.account_number && String(b.account_number).replace(/\s+/g, '').toUpperCase() === clean
  );
  if (savedMatch) {
    return { data: { source: 'beneficiary', beneficiary: savedMatch }, error: null };
  }

  const { data, error } = await supabase.rpc('find_account_holder', { p_identifier: clean });

  // PGRST202 = "function not found" in PostgREST — treat that like
  // "no match" rather than a hard error, so a not-yet-deployed RPC
  // just falls back to manual entry instead of showing a scary red
  // toast for something that isn't the user's fault.
  if (error && error.code !== 'PGRST202') return { data: null, error: error.message };
  if (error || !data) return { data: null, error: null };

  // A Postgres function declared `returns table(...)` comes back
  // through PostgREST as an array of rows, not a single object —
  // unwrap it before reading fields off it.
  const row = Array.isArray(data) ? data[0] : data;
  if (!row) return { data: null, error: null };

  return {
    data: {
      source: 'internal',
      display_name: row.display_name,
      bank_name: row.bank_name || 'Meridian',
      currency: row.currency,
    },
    error: null,
  };
}

/* -----------------------------------------------------------
   Transactions
   ----------------------------------------------------------- */

/**
 * Paginated, filterable transaction history for a single account —
 * mirrors the filter bar on transactions.html (type / status / date range).
 */
export async function getTransactions(accountId, { type, status, from, to, limit = 25, offset = 0 } = {}) {
  let query = supabase
    .from('transactions')
    .select('*', { count: 'exact' })
    .or(`sender_account.eq.${accountId},receiver_account.eq.${accountId}`)
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (type && type !== 'all') query = query.eq('transaction_type', type);
  if (status && status !== 'all') query = query.eq('status', status);
  if (from) query = query.gte('created_at', from);
  if (to) query = query.lte('created_at', to);

  const { data, error, count } = await query;
  return { data: data ?? [], error: error ? error.message : null, count: count ?? 0 };
}

export async function getTransactionByReference(reference) {
  return wrap(supabase.from('transactions').select('*').eq('transaction_reference', reference).single());
}

/**
 * Creates an international/internal transfer via the process_transfer
 * Postgres function (see 007_process_transfer_by_identifier.sql).
 * That function runs as SECURITY DEFINER — it checks you own the
 * sender account itself (RLS is bypassed inside it, so it enforces
 * that manually), then resolves the receiver one of two ways:
 *
 *   - receiverAccountId: pass this only when the caller already
 *     legitimately knows the id (e.g. transferring between two of
 *     YOUR OWN accounts, both returned by getMyAccounts()).
 *   - receiverIdentifier: an account number or IBAN string — used
 *     for the "send to a beneficiary/typed identifier" flow, where
 *     the client never has (and never should have) another user's
 *     real account id. The RPC looks up a match itself, server-side.
 *
 * If neither resolves to a real Meridian account, the transfer still
 * goes through as an external, debit-only transfer (status
 * 'Processing', no receiver_account) — exactly like a real
 * international wire to a non-Meridian bank.
 */
export async function createTransfer({ senderAccountId, receiverAccountId, receiverIdentifier, amount, fee = 0, currency, description }) {
  const { data, error } = await supabase.rpc('process_transfer', {
    p_sender_account_id: senderAccountId,
    p_receiver_account_id: receiverAccountId || null,
    p_receiver_identifier: receiverIdentifier || null,
    p_amount: amount,
    p_fee: fee,
    p_currency: currency,
    p_description: description,
  });

  if (error) return { data: null, error: error.message };
  return { data, error: null };
}

/* -----------------------------------------------------------
   Cards
   ----------------------------------------------------------- */

export async function getCardsForAccount(accountId) {
  return wrap(supabase.from('cards').select('*').eq('account_id', accountId).order('created_at', { ascending: true }));
}

export async function setCardStatus(cardId, status) {
  return wrap(supabase.from('cards').update({ card_status: status }).eq('id', cardId).select().single());
}

export async function setCardDailyLimit(cardId, dailyLimit) {
  return wrap(supabase.from('cards').update({ daily_limit: dailyLimit }).eq('id', cardId).select().single());
}

/* -----------------------------------------------------------
   Card issuance (demo-friendly, client-side — see the note on
   generateAccountDetails() above createAccount() for why this
   isn't how you'd do it in production)
   ----------------------------------------------------------- */
function generateCardNumber(cardType) {
  const prefix = cardType === 'credit' ? '5' : '4'; // Mastercard-ish vs Visa-ish, cosmetic only
  const digits = (n) => String(Math.floor(Math.random() * 10 ** n)).padStart(n, '0');
  return `${prefix}${digits(15)}`;
}

/**
 * Issues a new card against one of the user's accounts. Cards are
 * created as 'Pending' — matching the same pending-until-confirmed
 * pattern user_profiles.account_status already uses — so cards.html
 * can offer an explicit "Activate card" step via setCardStatus().
 * Expiry is set 4 years out from issuance.
 */
export async function createCard({ accountId, cardType = 'debit', cardHolder, dailyLimit = 1000 }) {
  if (!accountId) return { data: null, error: 'Choose an account for this card.' };
  if (!cardHolder?.trim()) return { data: null, error: 'Cardholder name is required.' };

  const { data: account, error: accountError } = await getAccountById(accountId);
  if (accountError || !account) return { data: null, error: accountError || 'Account not found.' };

  const now = new Date();
  const expiry = new Date(now.getFullYear() + 4, now.getMonth());

  return wrap(
    supabase
      .from('cards')
      .insert({
        account_id: accountId,
        card_number: generateCardNumber(cardType),
        card_type: cardType,
        card_holder: cardHolder.trim(),
        expiry_month: expiry.getMonth() + 1,
        expiry_year: expiry.getFullYear(),
        card_status: 'Pending',
        daily_limit: dailyLimit,
      })
      .select()
      .single()
  );
}

/* -----------------------------------------------------------
   Savings goals
   ----------------------------------------------------------- */

export async function getSavingsGoals(accountId) {
  return wrap(supabase.from('savings_goals').select('*').eq('account_id', accountId).order('created_at', { ascending: true }));
}

export async function createSavingsGoal({ accountId, goalName, targetAmount, targetDate }) {
  return wrap(
    supabase
      .from('savings_goals')
      .insert({ account_id: accountId, goal_name: goalName, target_amount: targetAmount, current_amount: 0, target_date: targetDate })
      .select()
      .single()
  );
}

/** Adds to (or, with a negative amount, withdraws from) a goal's saved total. */
export async function contributeToGoal(goalId, amount) {
  const { data: goal, error } = await wrap(supabase.from('savings_goals').select('current_amount').eq('id', goalId).single());
  if (error || !goal) return { data: null, error: error || 'Goal not found.' };

  const newAmount = Math.max(0, Number(goal.current_amount) + Number(amount));
  return wrap(supabase.from('savings_goals').update({ current_amount: newAmount }).eq('id', goalId).select().single());
}

/* -----------------------------------------------------------
   Notifications
   ----------------------------------------------------------- */

export async function getNotifications(userId, { limit = 20 } = {}) {
  const uid = await resolveUserId(userId);
  if (!uid) return { data: [], error: 'Not signed in.' };
  return wrap(
    supabase
      .from('notifications')
      .select('*')
      .eq('user_id', uid)
      .order('created_at', { ascending: false })
      .limit(limit)
  );
}

export async function getUnreadNotificationCount(userId) {
  const uid = await resolveUserId(userId);
  if (!uid) return { data: 0, error: 'Not signed in.' };
  const { count, error } = await supabase
    .from('notifications')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', uid)
    .eq('is_read', false);
  return { data: count ?? 0, error: error ? error.message : null };
}

export async function markNotificationRead(notificationId) {
  return wrap(supabase.from('notifications').update({ is_read: true }).eq('id', notificationId).select().single());
}

export async function markAllNotificationsRead(userId) {
  const uid = await resolveUserId(userId);
  if (!uid) return { data: null, error: 'Not signed in.' };
  return wrap(supabase.from('notifications').update({ is_read: true }).eq('user_id', uid).eq('is_read', false));
}

/* -----------------------------------------------------------
   Support tickets
   ----------------------------------------------------------- */

export async function createSupportTicket({ subject, message, priority = 'Normal', userId }) {
  const uid = await resolveUserId(userId);
  if (!uid) return { data: null, error: 'Not signed in.' };
  return wrap(
    supabase
      .from('support_tickets')
      .insert({ user_id: uid, subject, message, priority, status: 'Open' })
      .select()
      .single()
  );
}

export async function getMySupportTickets(userId) {
  const uid = await resolveUserId(userId);
  if (!uid) return { data: [], error: 'Not signed in.' };
  return wrap(
    supabase.from('support_tickets').select('*').eq('user_id', uid).order('created_at', { ascending: false })
  );
}

/* -----------------------------------------------------------
   Exchange rates
   -----------------------------------------------------------
   Behavior:
     - baseCurrency === targetCurrency short-circuits to 1.
     - Reads the latest cached row for the pair.
     - If it's missing or older than FX_STALE_MS, invokes the
       refresh-exchange-rates Edge Function (which fetches live
       rates and rewrites the table), then re-reads the pair.
     - If the refresh fails for any reason (offline, function not
       deployed yet, provider down), falls back to whatever was
       cached — never silently returns a fabricated 1:1 rate when a
       real cached rate exists.
   ----------------------------------------------------------- */

// How long a cached rate is trusted before we bother refreshing.
// FX pairs don't move fast enough to need crypto's ~2min cadence,
// and this keeps calls to the free-tier provider well within limits.
const FX_STALE_MS = 60 * 60 * 1000; // 1 hour

export async function getExchangeRate(baseCurrency, targetCurrency) {
  if (baseCurrency === targetCurrency) return { data: { exchange_rate: 1 }, error: null };

  const fetchStored = () =>
    supabase
      .from('exchange_rates')
      .select('*')
      .eq('base_currency', baseCurrency)
      .eq('target_currency', targetCurrency)
      .order('updated_at', { ascending: false })
      .limit(1)
      .maybeSingle();

  const { data, error } = await fetchStored();
  if (error) return { data: { exchange_rate: 1 }, error: error.message };

  const isStale = !data || Date.now() - new Date(data.updated_at || 0).getTime() > FX_STALE_MS;
  if (!isStale) return { data, error: null };

  try {
    const { error: fnError } = await supabase.functions.invoke('refresh-exchange-rates');
    if (fnError) throw fnError;

    const { data: refreshed, error: refreshedError } = await fetchStored();
    if (refreshedError) throw new Error(refreshedError.message);

    return { data: refreshed || data || { exchange_rate: 1 }, error: null };
  } catch (fnErr) {
    // Refresh failed (rate-limited, offline, function not deployed
    // yet) — fall back to whatever's cached rather than pretending
    // the pair is 1:1. Only truly falls back to 1 if we've never
    // cached this pair at all.
    return { data: data || { exchange_rate: 1 }, error: null };
  }
}

/* -----------------------------------------------------------
   Investments — market prices (crypto, via market_prices_cache)
   -----------------------------------------------------------
   The browser never calls CoinGecko directly. It reads
   market_prices_cache, and if the cache looks stale (nothing
   updated in the last ~2 minutes) it invokes the
   refresh-crypto-prices Edge Function once, then re-reads the
   table. That Function runs with the service_role key and is the
   only thing allowed to write to this table — see the RLS policy
   in investments_schema.sql.
   ----------------------------------------------------------- */

const PRICE_STALE_MS = 2 * 60 * 1000;

export async function getMarketPrices() {
  const { data: rows, error } = await wrap(
    supabase.from('market_prices_cache').select('*').order('market_cap', { ascending: false, nullsFirst: false })
  );
  if (error) return { data: [], error };

  const newestUpdate = rows.reduce((max, r) => Math.max(max, new Date(r.updated_at || 0).getTime()), 0);
  const isStale = !rows.length || Date.now() - newestUpdate > PRICE_STALE_MS;
  if (!isStale) return { data: rows, error: null };

  try {
    const { error: fnError } = await supabase.functions.invoke('refresh-crypto-prices');
    if (fnError) throw fnError;
    return wrap(supabase.from('market_prices_cache').select('*').order('market_cap', { ascending: false, nullsFirst: false }));
  } catch (fnErr) {
    // Refresh failed (rate-limited, offline, function not deployed yet) —
    // show what we have rather than an empty market page.
    return { data: rows, error: rows.length ? null : (fnErr?.message || 'Could not load live prices.') };
  }
}

export async function getMarketPrice(symbol) {
  return wrap(supabase.from('market_prices_cache').select('*').eq('symbol', symbol).maybeSingle());
}

/* -----------------------------------------------------------
   Investments — holdings & order history
   ----------------------------------------------------------- */

/** Every open position (quantity > 0) across all of the user's accounts. */
export async function getMyInvestments(userId) {
  const { data: accounts, error: accError } = await getMyAccounts(userId);
  if (accError) return { data: [], error: accError };
  const accountIds = accounts.map((a) => a.id);
  if (!accountIds.length) return { data: [], error: null };

  return wrap(
    supabase
      .from('investments')
      .select('*')
      .in('account_id', accountIds)
      .gt('quantity', 0)
      .order('updated_at', { ascending: false })
  );
}

/** Buy/sell history across all of the user's accounts. */
export async function getInvestmentOrders(userId, { limit = 25 } = {}) {
  const { data: accounts, error: accError } = await getMyAccounts(userId);
  if (accError) return { data: [], error: accError };
  const accountIds = accounts.map((a) => a.id);
  if (!accountIds.length) return { data: [], error: null };

  return wrap(
    supabase
      .from('investment_orders')
      .select('*')
      .in('account_id', accountIds)
      .order('created_at', { ascending: false })
      .limit(limit)
  );
}

/* -----------------------------------------------------------
   Investments — watchlist
   ----------------------------------------------------------- */

export async function getWatchlist(userId) {
  const uid = await resolveUserId(userId);
  if (!uid) return { data: [], error: 'Not signed in.' };
  return wrap(supabase.from('watchlist').select('*').eq('user_id', uid).order('created_at', { ascending: false }));
}

export async function addToWatchlist({ symbol, name, assetType = 'crypto', userId }) {
  const uid = await resolveUserId(userId);
  if (!uid) return { data: null, error: 'Not signed in.' };
  return wrap(
    supabase
      .from('watchlist')
      .insert({ user_id: uid, symbol, name, asset_type: assetType })
      .select()
      .single()
  );
}

export async function removeFromWatchlist(watchlistId) {
  return wrap(supabase.from('watchlist').delete().eq('id', watchlistId));
}

/* -----------------------------------------------------------
   Permissions (read-only, customer side)
   -----------------------------------------------------------
   user_permissions has a SELECT policy for auth.uid() = user_id
   (009_admin_policy_engine.sql / 012_extend_customer_permissions.sql)
   alongside the admin-only one — same owner-scoped read pattern as
   everything else in this file. Deliberately NOT imported from
   admin.js — that file is for pages/admin/*.js only.
   ----------------------------------------------------------- */
export async function getMyPermissions(userId) {
  const uid = await resolveUserId(userId);
  if (!uid) return { data: null, error: 'Not signed in.' };
  return wrap(supabase.from('user_permissions').select('*').eq('user_id', uid).maybeSingle());
}

/* -----------------------------------------------------------
   Transfer limits (read-only, customer side)
   -----------------------------------------------------------
   Same tables admin-policy.js reads via admin.js's
   getPolicyGroup()/getCustomerLimitOverrides() — but those go
   through admin-only RPCs/RLS. These read the same two tables
   directly, scoped to what a customer should legitimately see:
     - bank_policies: bank-wide defaults, assumed readable to any
       authenticated user (it's "what everyone inherits", not
       secret).
     - user_limit_overrides: assumed to carry an owner-scoped
       SELECT policy (auth.uid() = user_id), the same shape
       user_permissions already has per 012_extend_customer_
       permissions.sql. If that policy doesn't exist yet on this
       table, add it — this function will just silently return
       null until then, not error.
   ----------------------------------------------------------- */
export async function getTransferPolicy() {
  return wrap(
    supabase.from('bank_policies').select('policy_values').eq('policy_group', 'transfer_controls').maybeSingle()
  );
}

export async function getMyTransferLimitOverrides(userId) {
  const uid = await resolveUserId(userId);
  if (!uid) return { data: null, error: 'Not signed in.' };
  return wrap(
    supabase.from('user_limit_overrides').select('override_values').eq('user_id', uid).maybeSingle()
  );
}

/* -----------------------------------------------------------
   Investments — buy / sell
   -----------------------------------------------------------
   DEMO-ONLY FEE MODEL, same shape as createTransfer()'s (well —
   this one's older sibling; createTransfer() has since moved to
   the process_transfer RPC above, and buy/sell should eventually
   follow the same pattern): a small percentage with a floor, not
   a real brokerage fee schedule.

   NOT ATOMIC, same caveat createTransfer() used to carry: each of
   these does an account balance update, an investments upsert, and
   an investment_orders insert as separate calls. For production,
   wrap all three in a single supabase.rpc(...) call the same way
   process_transfer() now does for transfers.

   Prices are always looked up in USD (that's what CoinGecko and
   this cache store) and converted into the funding account's own
   currency via getExchangeRate() before touching its balance.
   ----------------------------------------------------------- */

function computeTradeFee(amount) {
  return Math.max(0.99, +(Math.max(0, Number(amount)) * 0.0015).toFixed(2));
}

export async function buyInvestment({ accountId, symbol, name, assetType = 'crypto', quantity, pricePerUnit, userId }) {
  const uid = await resolveUserId(userId);
  if (!uid) return { data: null, error: 'Not signed in.' };

  const qty = Number(quantity);
  const price = Number(pricePerUnit);
  if (!qty || qty <= 0) return { data: null, error: 'Enter a quantity greater than zero.' };
  if (!price || price <= 0) return { data: null, error: 'Missing a live price for this asset — try again in a moment.' };

  const { data: account, error: accError } = await getAccountById(accountId);
  if (accError || !account) return { data: null, error: accError || 'Account not found.' };

  const usdAmount = qty * price;
  const { data: rateData } = await getExchangeRate('USD', account.currency);
  const rate = Number(rateData?.exchange_rate ?? 1);
  const settleAmount = usdAmount * rate;
  const fee = computeTradeFee(settleAmount);
  const totalDebit = settleAmount + fee;

  if (Number(account.available_balance) < totalDebit) {
    return { data: null, error: `Insufficient funds — this purchase needs ${account.currency} ${totalDebit.toFixed(2)}.` };
  }

  await supabase
    .from('accounts')
    .update({
      balance: Number(account.balance) - totalDebit,
      available_balance: Number(account.available_balance) - totalDebit,
    })
    .eq('id', accountId);

  const { data: existing } = await supabase
    .from('investments')
    .select('*')
    .eq('account_id', accountId)
    .eq('symbol', symbol)
    .maybeSingle();

  const newQuantity = Number(existing?.quantity || 0) + qty;
  const newInvested = Number(existing?.invested_amount || 0) + settleAmount;

  const { error: upsertError } = await supabase.from('investments').upsert(
    {
      account_id: accountId,
      symbol,
      name,
      asset_type: assetType,
      quantity: newQuantity,
      invested_amount: newInvested,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'account_id,symbol' }
  );
  if (upsertError) return { data: null, error: upsertError.message };

  return wrap(
    supabase
      .from('investment_orders')
      .insert({
        account_id: accountId,
        symbol,
        name,
        asset_type: assetType,
        side: 'buy',
        quantity: qty,
        price_per_unit: price,
        amount: settleAmount,
        fee,
        status: 'Completed',
      })
      .select()
      .single()
  );
}

export async function sellInvestment({ accountId, symbol, name, assetType = 'crypto', quantity, pricePerUnit, userId }) {
  const uid = await resolveUserId(userId);
  if (!uid) return { data: null, error: 'Not signed in.' };

  const qty = Number(quantity);
  const price = Number(pricePerUnit);
  if (!qty || qty <= 0) return { data: null, error: 'Enter a quantity greater than zero.' };
  if (!price || price <= 0) return { data: null, error: 'Missing a live price for this asset — try again in a moment.' };

  const { data: position, error: posError } = await supabase
    .from('investments')
    .select('*')
    .eq('account_id', accountId)
    .eq('symbol', symbol)
    .maybeSingle();
  if (posError) return { data: null, error: posError.message };
  if (!position || Number(position.quantity) < qty) {
    return { data: null, error: `You only hold ${Number(position?.quantity || 0)} ${symbol}.` };
  }

  const { data: account, error: accError } = await getAccountById(accountId);
  if (accError || !account) return { data: null, error: accError || 'Account not found.' };

  const usdAmount = qty * price;
  const { data: rateData } = await getExchangeRate('USD', account.currency);
  const rate = Number(rateData?.exchange_rate ?? 1);
  const grossProceeds = usdAmount * rate;
  const fee = computeTradeFee(grossProceeds);
  const netProceeds = grossProceeds - fee;

  await supabase
    .from('accounts')
    .update({
      balance: Number(account.balance) + netProceeds,
      available_balance: Number(account.available_balance) + netProceeds,
    })
    .eq('id', accountId);

  const remainingQuantity = Number(position.quantity) - qty;
  // Cost basis leaves the position proportionally to how much was sold,
  // so profit/loss on what's left keeps making sense after a partial sell.
  const remainingInvested = remainingQuantity > 0
    ? Number(position.invested_amount || 0) * (remainingQuantity / Number(position.quantity))
    : 0;

  if (remainingQuantity <= 0) {
    await supabase.from('investments').delete().eq('id', position.id);
  } else {
    await supabase
      .from('investments')
      .update({ quantity: remainingQuantity, invested_amount: remainingInvested, updated_at: new Date().toISOString() })
      .eq('id', position.id);
  }

  return wrap(
    supabase
      .from('investment_orders')
      .insert({
        account_id: accountId,
        symbol,
        name,
        asset_type: assetType,
        side: 'sell',
        quantity: qty,
        price_per_unit: price,
        amount: grossProceeds,
        fee,
        status: 'Completed',
      })
      .select()
      .single()
  );
}

/* -----------------------------------------------------------
   Account & Security — identity documents (Upload documents +
   Linked ID)
   -----------------------------------------------------------
   Backed by public.identity_documents + the private
   identity-documents storage bucket (016_account_security_tiers_
   linked_ids_sessions.sql, plus 017's id_type/full_name/id_number/
   date_of_birth/gender review-detail columns). A submission always
   starts as 'pending' with no slot — status, slot assignment, and
   those detail fields only ever get set through
   admin_review_identity_document(), so there's no client-side path
   to mark your own document verified or backfill its details.

   The file upload happens directly against the private
   identity-documents bucket here (rather than through storage.js)
   so a failed table insert can clean up the just-uploaded file
   instead of leaving an orphan with no row pointing to it.
   ----------------------------------------------------------- */

const IDENTITY_DOC_ALLOWED_TYPES = ['application/pdf', 'image/jpeg', 'image/png'];
const IDENTITY_DOC_MAX_BYTES = 10 * 1024 * 1024; // 10MB — matches the identity-documents bucket's file_size_limit (016, PART G)

/**
 * Verified, slotted identity documents for the Linked ID cards —
 * never pending/rejected/action-required ones. Enforced as a query
 * filter rather than left to callers to check doc.status/doc.slot
 * themselves, so this is safe to reuse anywhere a Linked ID card
 * reads from.
 */
export async function getMyIdentityDocuments(userId) {
  const uid = await resolveUserId(userId);
  if (!uid) return { data: null, error: 'Not signed in.' };
  return wrap(
    supabase
      .from('identity_documents')
      .select('slot, id_type, document_type, full_name, id_number, date_of_birth, gender')
      .eq('user_id', uid)
      .eq('status', 'verified')
      .not('slot', 'is', null)
      .order('slot', { ascending: true })
  );
}


/* =============================================================
   ADD to supabase/database.js, directly below getMyIdentityDocuments()
   -----------------------------------------------------------
   getMyIdentityDocuments() stays exactly as-is (verified + slotted
   only — safe for anything that must never see an unverified row).

   This new function is what profile.js's verification stepper
   actually needs: EVERY submission, any status, so a pending or
   rejected document can be shown as "this tier's current state"
   instead of just disappearing until an admin acts on it.
   ============================================================= */

export async function getMyIdentityDocumentHistory(userId) {
  const uid = await resolveUserId(userId);
  if (!uid) return { data: null, error: 'Not signed in.' };
  return wrap(
    supabase
      .from('identity_documents')
      .select(
        'id, document_category, document_type, status, slot, rejection_reason, submitted_at, reviewed_at, id_type, full_name, id_number, date_of_birth, gender'
      )
      .eq('user_id', uid)
      .order('submitted_at', { ascending: false })
  );
}



export async function submitIdentityDocument({
  file,
  documentType,
  documentCategory,
  fullName,
  idNumber,
  dateOfBirth,
  gender,
  userId,
}) {
  if (!documentType || !documentCategory) return { data: null, error: 'Choose a document type.' };

  // BVN (tier 1) is data-only — every other category still requires a file.
  const requiresFile = documentCategory !== 'bvn';
  if (requiresFile) {
    if (!file) return { data: null, error: 'Choose a file to upload.' };
    if (!IDENTITY_DOC_ALLOWED_TYPES.includes(file.type)) {
      return { data: null, error: 'Only PDF, JPG, or PNG files are accepted.' };
    }
    if (file.size > IDENTITY_DOC_MAX_BYTES) {
      return { data: null, error: 'File is larger than the 10MB limit.' };
    }
  }

  // BVN and identity docs (tier 1 & 2) collect these at submission time.
  // Proof of address (tier 3) does not.
  const requiresDetails = documentCategory === 'bvn' || documentCategory === 'identity';
  if (requiresDetails) {
    if (!fullName?.trim() || !idNumber?.trim() || !dateOfBirth || !gender) {
      return { data: null, error: 'Fill in full name, ID number, date of birth, and gender.' };
    }
  }

  const uid = await resolveUserId(userId);
  if (!uid) return { data: null, error: 'Not signed in.' };

  const documentId = crypto.randomUUID();
  let storagePath = null;

  if (requiresFile) {
    const extension = (file.name.split('.').pop() || 'bin').toLowerCase();
    storagePath = `${uid}/${documentId}/${documentId}.${extension}`;

    const { error: uploadError } = await supabase.storage
      .from('identity-documents')
      .upload(storagePath, file, { upsert: false, contentType: file.type });
    if (uploadError) return { data: null, error: 'Upload failed. Check your connection and try again.' };
  }

  const insertPayload = {
    id: documentId,
    user_id: uid,
    document_category: documentCategory,
    document_type: documentType,
    file_path: storagePath,
    file_name: file?.name || null,
  };

  if (requiresDetails) {
    insertPayload.id_type = documentType;
    insertPayload.full_name = fullName.trim();
    insertPayload.id_number = idNumber.trim();
    insertPayload.date_of_birth = dateOfBirth;
    insertPayload.gender = gender;
  }

  const { data, error } = await supabase
    .from('identity_documents')
    .insert(insertPayload)
    .select()
    .single();

  if (error) {
    if (storagePath) {
      await supabase.storage.from('identity-documents').remove([storagePath]);
    }
    return { data: null, error: error.message };
  }

  return { data, error: null };
}

/* -----------------------------------------------------------
   Account & Security — Face ID / device biometrics
   -----------------------------------------------------------
   Backed by public.webauthn_credentials. "Enabled" is derived from
   whether any row exists for the user (see that table's own
   comment in the migration) — there's no separate boolean flag to
   go out of sync.

   IMPORTANT: this only stores public-key credential material from
   navigator.credentials.create(); it does NOT implement the
   server-side attestation/challenge verification a production
   WebAuthn *login* would need (see the migration's "STILL OPEN"
   item 1). Treat "Face ID: Enabled" as "a credential is on file",
   not "assertions against it are being verified" until that
   follow-up exists.
   ----------------------------------------------------------- */

export async function getMyWebauthnCredentials(userId) {
  const uid = await resolveUserId(userId);
  if (!uid) return { data: null, error: 'Not signed in.' };
  return wrap(
    supabase
      .from('webauthn_credentials')
      .select('id, device_label, created_at, last_used_at')
      .eq('user_id', uid)
      .order('created_at', { ascending: false })
  );
}

export async function registerWebauthnCredential({ credentialId, publicKey, deviceLabel, userId }) {
  const uid = await resolveUserId(userId);
  if (!uid) return { data: null, error: 'Not signed in.' };
  return wrap(
    supabase
      .from('webauthn_credentials')
      .insert({ user_id: uid, credential_id: credentialId, public_key: publicKey, device_label: deviceLabel })
      .select()
      .single()
  );
}

/** Disables Face ID entirely for this user (removes every stored credential). */
export async function removeAllWebauthnCredentials(userId) {
  const uid = await resolveUserId(userId);
  if (!uid) return { data: null, error: 'Not signed in.' };
  return wrap(supabase.from('webauthn_credentials').delete().eq('user_id', uid));
}
