/* =============================================================
   MERIDIAN — assets/js/email.js

   Thin wrapper around the EmailJS browser SDK so every admin page
   sends notification email through ONE place instead of calling
   emailjs.send() directly wherever it's needed. If the provider or
   template shape ever changes, this is the only file to touch.

   Requires the EmailJS SDK script tag loaded BEFORE this file:
     <script src="https://cdn.jsdelivr.net/npm/@emailjs/browser@4/dist/email.min.js"></script>

   Uses the transaction-notification template (meridian-transaction-
   email-template.html) — one template shape for reversals,
   transfers (in/out), failures, and pending states, distinguished
   by the params passed in.

   NOTE FALLBACK (added): the template's Note row (note_label/
   note_value) always renders — EmailJS templates can't drop a
   table row conditionally. Reversed/failed/pending sends always
   pass a real note, so this never mattered for them. Plain
   transfer_sent/transfer_received sends have nothing to put there,
   which used to leave a blank row with no border under Status.
   sendTransactionEmail() now fills in a neutral default whenever
   the caller doesn't supply note_label/note_value, and derives
   note_border from whether a real note was given — see
   withNoteFallback() below.
   ============================================================= */

const EMAILJS_SERVICE_ID = 'service_nbcwufa';
const EMAILJS_TEMPLATE_ID = 'template_km7o2uk';
const EMAILJS_PUBLIC_KEY = 'YCDm4zRCDfEgZ9rq9';

let initialized = false;

function ensureInit() {
  if (initialized) return;
  if (typeof emailjs === 'undefined') {
    throw new Error('EmailJS SDK not loaded — add the <script> tag before this module runs.');
  }
  emailjs.init({ publicKey: EMAILJS_PUBLIC_KEY });
  initialized = true;
}

/**
 * Status presets for the transaction-notification template — keeps
 * the banner color / label / amount color consistent with the
 * admin table's own status chip conventions (see
 * admin-transactions.css's .admin-tx-status-chip--* rules) instead
 * of every call site picking hex values by hand.
 */
const STATUS_PRESETS = {
  reversed: {
    status_label: 'Transaction Reversed',
    status_color: '#c0453b',
    status_bg: 'rgba(192,69,59,0.1)',
    amount_color: '#0a1628',
  },
  transfer_sent: {
    status_label: 'Transfer Sent',
    status_color: '#0a1628',
    status_bg: 'rgba(10,22,40,0.06)',
    amount_color: '#0a1628',
  },
  transfer_received: {
    status_label: 'Money Received',
    status_color: '#1f8a5f',
    status_bg: 'rgba(31,138,95,0.1)',
    amount_color: '#1f8a5f',
  },
  failed: {
    status_label: 'Transaction Failed',
    status_color: '#c0453b',
    status_bg: 'rgba(192,69,59,0.1)',
    amount_color: '#0a1628',
  },
  pending: {
    status_label: 'Transaction Pending',
    status_color: '#b3771d',
    status_bg: 'rgba(179,119,29,0.1)',
    amount_color: '#0a1628',
  },
};

/**
 * Fills in a neutral Note row when the caller didn't supply one,
 * and sets note_border to match — a real note keeps the divider
 * under Status (note_border set), a fallback drops it so the row
 * reads as a deliberate closing line rather than a gap.
 */
function withNoteFallback(fields) {
  const hasNote = Boolean(fields.note_value);
  return {
    note_label: fields.note_label || 'Note',
    note_value: fields.note_value || '—',
    note_border: hasNote ? 'border-bottom:1px solid #e3e0d8;' : '',
    ...fields,
    // re-apply after the spread so an explicit empty string from the
    // caller can't accidentally win over the computed fallback above
    note_label: fields.note_label || 'Note',
    note_value: fields.note_value || '—',
    note_border: hasNote ? 'border-bottom:1px solid #e3e0d8;' : '',
  };
}

/**
 * Sends a transaction-related notification email.
 *
 * @param {'reversed'|'transfer_sent'|'transfer_received'|'failed'|'pending'} type
 * @param {object} fields
 * @param {string} fields.to_email
 * @param {string} fields.customer_name
 * @param {string} fields.email_title        - e.g. "A transaction on your account was reversed"
 * @param {string} fields.email_message       - one or two sentence explanation
 * @param {string} fields.preheader_text      - short inbox preview line
 * @param {string} fields.amount_label        - e.g. "Amount reversed" / "Amount received"
 * @param {string} fields.amount              - formatted, e.g. "$10.00"
 * @param {string} fields.from_label
 * @param {string} fields.from_value
 * @param {string} fields.to_label
 * @param {string} fields.to_value
 * @param {string} fields.reference
 * @param {string} fields.transaction_type
 * @param {string} fields.date
 * @param {string} [fields.note_label]        - e.g. "Reason" / "Memo" — omit for plain transfers
 * @param {string} [fields.note_value]        - omit for plain transfers; a neutral default fills in
 * @param {string} [fields.account_url]
 * @returns {Promise<{ok: true} | {ok: false, error: string}>}
 */
export async function sendTransactionEmail(type, fields) {
  try {
    ensureInit();

    const preset = STATUS_PRESETS[type];
    if (!preset) {
      return { ok: false, error: `Unknown transaction email type: ${type}` };
    }

    const params = {
      ...preset,
      year: new Date().getFullYear(),
      account_url: fields.account_url || 'https://meridian.example.com/dashboard.html',
      ...withNoteFallback(fields),
    };

    await emailjs.send(EMAILJS_SERVICE_ID, EMAILJS_TEMPLATE_ID, params);
    return { ok: true };
  } catch (err) {
    console.error('[Meridian] Failed to send notification email:', err);
    return { ok: false, error: err?.text || err?.message || 'Failed to send email.' };
  }
}
