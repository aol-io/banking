/* =============================================================
   MERIDIAN — International Digital Banking
   assets/js/chat-widget.js

   Behavior for the merged floating support chat button + panel
   (components/chat-widget.html). Connects to a REAL human agent —
   no bot logic anywhere in this file. The welcome message is
   written server-side by chat_thread_welcome_message() the instant
   a thread is created (see chat_schema.sql) — this file only ever
   renders what getThreadMessages() / realtime hands it back.

   CHANGES FROM THE OLD (System B) VERSION OF THIS FILE
   -------------------------------------------------------
   - Selectors updated to match the merged components/chat-widget.html
     (chat-panel, chat-body, chat-input-row, chat-msg, chat-bubble...)
     instead of the old chat-widget-panel/chat-widget-messages/... names.
   - No more injectStylesheet() / chat-widget.css — that stylesheet is
     being deleted; all of this widget's CSS now lives in components.css
     (file 2, next), which every page already loads per style.css's
     documented load order.
   - Renders sender_type 'system' messages too (the DB-written welcome
     message), not just 'user'/'admin' — the old version only handled
     two sender types.
   - Presence: calls chat_heartbeat() on an interval while the panel is
     open (new — see TODO below), since last_seen_at otherwise only
     moves when the visitor actually sends a message.
   - Guest/visitor sessions: no more guest_id/localStorage — uses
     Supabase Anonymous Auth (signInAnonymously()) per chat_schema.sql,
     gated by an allowGuest flag the caller passes in.
   - The three-dot options menu (ported from System A's design) is now
     wired for real: sound plays on real incoming messages, transcript
     downloads the real thread, clear conversation closes the real
     thread via closeMyThread().
   - MOBILE FIX: openPanel()/closePanel() now toggle a
     `chat-panel-open` class on <body>. Below the 480px breakpoint,
     components.css turns .chat-panel into a full-screen sheet
     (inset:0, 100dvh) instead of a fixed-size box anchored to a
     corner — that fixed-size-plus-100vh combination broke as soon
     as the mobile keyboard opened, because 100vh doesn't shrink
     with the visual viewport. `chat-panel-open` sets
     `overflow: hidden` on <body> so the page behind the full-screen
     panel can't also scroll while the keyboard is up, which was the
     other half of the "disorganised" jump on input focus.

   BOOTING
   -------
   Not linked directly as a <script> on any page. Booted from
   components/components.js's bootChatWidget() — same pattern as the
   notification bell — which is responsible for (a) checking the
   current page against CHAT_WIDGET_EXCLUDED_PAGES and (b) deciding
   whether this page should pass allowGuest: true (index.html only).

     import { mountChatWidget } from '../assets/js/chat-widget.js';
     await mountChatWidget(componentsBase, { allowGuest: isIndexPage });

   `componentsBase` is the same base path components.js already
   computes for fetching partials (resolveComponentsBase()).
   ============================================================= */

import {
  getOrCreateMyThread,
  getThreadMessages,
  sendMessage,
  sendAttachment,
  getAttachmentSignedUrl,
  subscribeToThreadMessages,
  unsubscribeFromThread,
  markAdminMessagesRead,
  getUnreadAdminMessageCount,
  MAX_ATTACHMENT_BYTES,
  ALLOWED_ATTACHMENT_TYPES,
  // --- TODO(file 4): neither of these exists in chat.js yet.
  // closeMyThread(threadId) -> { data, error }, used by "Clear conversation".
  // sendHeartbeat(threadId) -> wraps supabase.rpc('chat_heartbeat', { p_thread_id: threadId }).
  // Both calls below are written against the shape chat.js's other
  // exports already use (a plain { data, error } object), so once
  // file 4 adds them, nothing here needs to change.
  closeMyThread,
  sendHeartbeat,
} from '../../supabase/chat.js';
import { getCurrentUser } from '../../supabase/auth.js';
import { supabase } from '../../supabase/config.js';
import { formatTimestamp } from './utils.js';

const SESSION_KEY = 'meridian-chat-open';
const HEARTBEAT_INTERVAL_MS = 30000;
/** <body> classes toggled while the panel is open — see FIX note above and components.css. */
const BODY_OPEN_CLASS = 'chat-panel-open';
const BODY_LOCKED_CLASS = 'chat-panel-locked'; // iOS-proof scroll lock (position:fixed body)
let lockedScrollY = 0; // saved so closePanel() can restore the page's scroll offset
const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

let state = {
  threadId: null,
  channel: null,
  panelOpen: false,
  mounted: false,
  allowGuest: false,
  pendingFile: null,
  previewObjectUrl: null,
  soundEnabled: true,
  audioCtx: null,
  heartbeatTimer: null,
  messages: [], // local cache, used for transcript download
};

/* -----------------------------------------------------------
   Mount
   ----------------------------------------------------------- */

/**
 * Fetches chat-widget.html, injects it at the end of <body>, and
 * wires up all interactivity. Safe to call once per page load —
 * a second call is a no-op if the widget is already in the DOM.
 */
export async function mountChatWidget(componentsBase, { allowGuest = false } = {}) {
  if (state.mounted || document.getElementById('chat-widget')) return;

  state.allowGuest = allowGuest;

  const response = await fetch(`${componentsBase}chat-widget.html`);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const html = await response.text();

  const wrapper = document.createElement('div');
  wrapper.innerHTML = html.trim();
  document.body.appendChild(wrapper.firstElementChild);

  state.mounted = true;
  wireEvents();

  if (sessionStorage.getItem(SESSION_KEY) === '1') {
    await openPanel();
  }
}

/* -----------------------------------------------------------
   Session handling (registered user OR anonymous guest)
   ----------------------------------------------------------- */

/**
 * Ensures there's a Supabase session before a thread can be
 * created. Registered users already have one on any authenticated
 * page. On pages where allowGuest is true (index.html), a visitor
 * with no session gets signed in anonymously — this is the only
 * place in the whole chat feature that calls signInAnonymously(),
 * matching chat_schema.sql's comment that this is a real
 * auth.uid(), not a hand-rolled identity.
 */
async function ensureSession() {
  const { data: user } = await getCurrentUser();
  if (user) return { ok: true };

  if (!state.allowGuest) {
    return { ok: false, error: 'Sign in to start a conversation with support.' };
  }

  const { error } = await supabase.auth.signInAnonymously();
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

/* -----------------------------------------------------------
   Event wiring
   ----------------------------------------------------------- */

function wireEvents() {
  const widget = document.getElementById('chat-widget');
  const launcher = document.getElementById('chat-launcher');
  const panel = document.getElementById('chat-panel');
  const closeBtn = document.querySelector('[data-chat-close]');
  const form = document.querySelector('[data-chat-form]');
  const input = document.querySelector('[data-chat-input]');
  const sendBtn = document.querySelector('[data-chat-send]');
  const attachBtn = document.querySelector('[data-chat-attach]');
  const fileInput = document.querySelector('[data-chat-file-input]');
  const fileRemoveBtn = document.querySelector('[data-chat-file-remove]');

  launcher.addEventListener('click', () => {
    state.panelOpen ? closePanel() : openPanel();
  });
  closeBtn.addEventListener('click', closePanel);

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    const menu = document.getElementById('chat-menu');
    if (menu && menu.classList.contains('is-open')) {
      closeMenu();
      return;
    }
    if (state.panelOpen) closePanel();
  });

  input.addEventListener('input', () => {
    sendBtn.disabled = !input.value.trim() && !state.pendingFile;
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 96)}px`;
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      form.requestSubmit();
    }
  });

  attachBtn.addEventListener('click', () => fileInput.click());

  fileInput.addEventListener('change', () => {
    const file = fileInput.files[0];
    fileInput.value = '';
    if (!file) return;

    if (file.size > MAX_ATTACHMENT_BYTES) {
      renderSystemNotice('That file is too large — attachments must be 10MB or smaller.');
      return;
    }
    if (!ALLOWED_ATTACHMENT_TYPES.includes(file.type)) {
      renderSystemNotice("That file type isn't supported — try an image, PDF, or Word doc.");
      return;
    }
    setPendingFile(file);
    sendBtn.disabled = false;
  });

  fileRemoveBtn.addEventListener('click', () => {
    clearPendingFile();
    sendBtn.disabled = !input.value.trim();
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = input.value.trim();
    const file = state.pendingFile;
    if (!body && !file) return;
    if (!state.threadId) return;

    input.value = '';
    input.style.height = 'auto';
    clearPendingFile();
    sendBtn.disabled = true;

    const { data: message, error } = file
      ? await sendAttachment(state.threadId, file, { body })
      : await sendMessage(state.threadId, body);

    if (error) {
      renderSystemNotice(`Couldn't send that — ${error}`);
      sendBtn.disabled = false;
      return;
    }
    renderMessage(message);
    scrollToBottom();
  });

  wireMenu();
}

/* -----------------------------------------------------------
   Pending attachment preview (before sending)
   ----------------------------------------------------------- */

function setPendingFile(file) {
  clearPendingFile();
  state.pendingFile = file;

  const preview = document.querySelector('[data-chat-file-preview]');
  const thumb = document.querySelector('[data-chat-file-preview-thumb]');
  const name = document.querySelector('[data-chat-file-preview-name]');

  name.textContent = file.name;
  preview.hidden = false;

  if (file.type.startsWith('image/')) {
    state.previewObjectUrl = URL.createObjectURL(file);
    thumb.style.backgroundImage = `url(${state.previewObjectUrl})`;
  } else {
    thumb.style.backgroundImage = '';
  }
}

function clearPendingFile() {
  if (state.previewObjectUrl) {
    URL.revokeObjectURL(state.previewObjectUrl);
    state.previewObjectUrl = null;
  }
  state.pendingFile = null;

  const preview = document.querySelector('[data-chat-file-preview]');
  const thumb = document.querySelector('[data-chat-file-preview-thumb]');
  if (preview) preview.hidden = true;
  if (thumb) thumb.style.backgroundImage = '';
}

/* -----------------------------------------------------------
   Open / close
   ----------------------------------------------------------- */

async function openPanel() {
  const widget = document.getElementById('chat-widget');
  const panel = document.getElementById('chat-panel');
  const launcher = document.getElementById('chat-launcher');

  widget.classList.add('is-open');
  panel.hidden = false;
  panel.setAttribute('aria-hidden', 'false');
  launcher.setAttribute('aria-expanded', 'true');
  launcher.setAttribute('aria-label', 'Close chat support');
  state.panelOpen = true;
  // Locks background scroll while the full-screen mobile panel is
  // open. chat-panel-open covers browsers that respect
  // overflow:hidden on body; chat-panel-locked additionally pins
  // body with position:fixed for iOS Safari, which ignores plain
  // overflow:hidden for touch-scrolling. Both are no-ops above the
  // 480px breakpoint, where the panel isn't full-screen.
  lockedScrollY = window.scrollY || window.pageYOffset || 0;
  document.body.classList.add(BODY_OPEN_CLASS);
  document.body.classList.add(BODY_LOCKED_CLASS);
  document.body.style.top = `-${lockedScrollY}px`;
  sessionStorage.setItem(SESSION_KEY, '1');

  if (!state.threadId) {
    await initThread();
  } else {
    await markAdminMessagesRead(state.threadId);
    updateUnreadBadge(0);
  }

  startHeartbeat();
  window.setTimeout(() => document.querySelector('[data-chat-input]')?.focus(), 150);
  scrollToBottom();
}

function closePanel() {
  const widget = document.getElementById('chat-widget');
  const panel = document.getElementById('chat-panel');
  const launcher = document.getElementById('chat-launcher');

  widget.classList.remove('is-open');
  panel.hidden = true;
  panel.setAttribute('aria-hidden', 'true');
  launcher.setAttribute('aria-expanded', 'false');
  launcher.setAttribute('aria-label', 'Open chat support');
  state.panelOpen = false;
  document.body.classList.remove(BODY_OPEN_CLASS);
  document.body.classList.remove(BODY_LOCKED_CLASS);
  document.body.style.top = '';
  window.scrollTo(0, lockedScrollY); // undo the position:fixed pin without losing the page's place
  sessionStorage.removeItem(SESSION_KEY);
  closeMenu();
  stopHeartbeat();
  launcher.focus();
}

/* -----------------------------------------------------------
   Presence heartbeat
   ----------------------------------------------------------- */

function startHeartbeat() {
  stopHeartbeat();
  if (!state.threadId) return;
  state.heartbeatTimer = window.setInterval(() => {
    if (state.threadId) sendHeartbeat(state.threadId);
  }, HEARTBEAT_INTERVAL_MS);
}

function stopHeartbeat() {
  if (state.heartbeatTimer) {
    window.clearInterval(state.heartbeatTimer);
    state.heartbeatTimer = null;
  }
}

/* -----------------------------------------------------------
   Thread lifecycle
   ----------------------------------------------------------- */

async function initThread() {
  const messagesEl = document.querySelector('[data-chat-messages]');

  const session = await ensureSession();
  if (!session.ok) {
    messagesEl.innerHTML = '';
    renderSystemNotice(session.error);
    return;
  }

  const { data: thread, error: threadError } = await getOrCreateMyThread();
  if (threadError || !thread) {
    messagesEl.innerHTML = '';
    renderSystemNotice(threadError || "Couldn't connect to support right now — please try again shortly.");
    return;
  }

  state.threadId = thread.id;
  startHeartbeat();

  const { data: messages, error: messagesError } = await getThreadMessages(thread.id);
  messagesEl.innerHTML = '';
  state.messages = [];
  if (messagesError) {
    renderSystemNotice(messagesError);
  } else {
    messages.forEach(renderMessage);
  }
  scrollToBottom();

  await markAdminMessagesRead(thread.id);
  updateUnreadBadge(0);

  state.channel = subscribeToThreadMessages(thread.id, (message) => {
    if (message.sender_type === 'user') return; // own message, already rendered optimistically
    renderMessage(message);
    scrollToBottom();
    playChime();

    if (state.panelOpen) {
      markAdminMessagesRead(thread.id);
    } else {
      refreshUnreadBadge();
    }
  });
}

async function refreshUnreadBadge() {
  if (!state.threadId) return;
  const { data: count } = await getUnreadAdminMessageCount(state.threadId);
  updateUnreadBadge(count);
}

/* -----------------------------------------------------------
   Rendering
   ----------------------------------------------------------- */

function timeLabel(iso) {
  return formatTimestamp ? formatTimestamp(iso) : new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

function renderMessage(message) {
  const body = document.querySelector('[data-chat-messages]');
  const loading = document.querySelector('[data-chat-loading]');
  if (loading) loading.remove();

  state.messages.push(message);

  const row = document.createElement('div');
  row.className = `chat-msg chat-msg--${message.sender_type}`;

  if (message.sender_type === 'system') {
    row.innerHTML = `<div class="chat-bubble chat-bubble--system"><p></p></div>`;
    row.querySelector('p').textContent = message.body;
    body.appendChild(row);
    return;
  }

  if (message.sender_type === 'admin') {
    row.innerHTML = `
      <span class="chat-msg-avatar">M</span>
      <div class="chat-bubble"><p></p><span class="chat-msg-time"></span></div>
    `;
  } else {
    row.innerHTML = `<div class="chat-bubble"><p></p><span class="chat-msg-time"></span></div>`;
  }

  if (message.body) row.querySelector('p').textContent = message.body;
  row.querySelector('.chat-msg-time').textContent = timeLabel(message.created_at);

  if (message.attachment_path) {
    renderAttachment(row.querySelector('.chat-bubble'), message);
  }

  body.appendChild(row);
}

async function renderAttachment(bubble, message) {
  const wrap = document.createElement('div');
  wrap.className = 'chat-attachment';
  bubble.appendChild(wrap);

  const isImage = (message.attachment_type || '').startsWith('image/');
  const { data: url } = await getAttachmentSignedUrl(message.attachment_path);

  if (isImage) {
    const img = document.createElement('img');
    img.className = 'chat-attachment-image';
    img.alt = message.attachment_name || 'Attachment';
    if (url) {
      img.src = url;
      img.addEventListener('click', () => window.open(url, '_blank', 'noopener'));
    }
    wrap.appendChild(img);
    return;
  }

  const link = document.createElement('a');
  link.className = 'chat-attachment-file';
  link.target = '_blank';
  link.rel = 'noopener';
  if (url) link.href = url;
  link.innerHTML =
    '<svg class="chat-attachment-file-icon" viewBox="0 0 20 20" fill="none" aria-hidden="true">' +
    '<path d="M5 2.5h7l4 4v10a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-13a1 1 0 0 1 1-1Z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>';
  const name = document.createElement('span');
  name.className = 'chat-attachment-file-name';
  name.textContent = message.attachment_name || 'Document';
  link.appendChild(name);
  wrap.appendChild(link);
}

function renderSystemNotice(text) {
  const messagesEl = document.querySelector('[data-chat-messages]');
  const loading = document.querySelector('[data-chat-loading]');
  if (loading) loading.remove();
  const notice = document.createElement('div');
  notice.className = 'chat-msg chat-msg--notice';
  notice.textContent = text;
  messagesEl.appendChild(notice);
  scrollToBottom();
}


function updateUnreadBadge(count) {
  const badge = document.querySelector('[data-chat-unread-badge]');
  if (!badge) return;
  if (count > 0) {
    badge.textContent = count > 9 ? '9+' : String(count);
    badge.classList.remove('is-hidden');
  } else {
    badge.classList.add('is-hidden');
  }
}


function scrollToBottom() {
  const messagesEl = document.querySelector('[data-chat-messages]');
  if (messagesEl) messagesEl.scrollTop = messagesEl.scrollHeight;
}

/* -----------------------------------------------------------
   Sound
   ----------------------------------------------------------- */

function playChime() {
  if (!state.soundEnabled || prefersReducedMotion) return;
  try {
    state.audioCtx = state.audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const ctx = state.audioCtx;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(880, ctx.currentTime);
    osc.frequency.setValueAtTime(1180, ctx.currentTime + 0.09);
    gain.gain.setValueAtTime(0.001, ctx.currentTime);
    gain.gain.linearRampToValueAtTime(0.06, ctx.currentTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.32);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.34);
  } catch (err) {
    /* Web Audio unavailable — sound is a nicety, fail silently */
  }
}

/* -----------------------------------------------------------
   Three-dot options menu
   ----------------------------------------------------------- */

function wireMenu() {
  const menuToggle = document.getElementById('chat-menu-toggle');
  const menu = document.getElementById('chat-menu');
  const soundToggle = document.getElementById('chat-sound-toggle');
  const downloadBtn = document.getElementById('chat-download-transcript');
  const a11yToggle = document.getElementById('chat-accessibility-toggle');
  const a11ySubmenu = document.getElementById('chat-accessibility-submenu');
  const largeTextCheck = document.getElementById('chat-large-text');
  const highContrastCheck = document.getElementById('chat-high-contrast');
  const reduceMotionCheck = document.getElementById('chat-reduce-motion');
  const privacyToggle = document.getElementById('chat-privacy-toggle');
  const privacySubmenu = document.getElementById('chat-privacy-submenu');
  const requestDataBtn = document.getElementById('chat-request-data');
  const deleteDataBtn = document.getElementById('chat-delete-data');
  const clearBtn = document.getElementById('chat-clear-conversation');

  function openMenu() {
    menu.classList.add('is-open');
    menu.setAttribute('aria-hidden', 'false');
    menuToggle.setAttribute('aria-expanded', 'true');
  }

  menuToggle.addEventListener('click', (event) => {
    event.stopPropagation();
    menu.classList.contains('is-open') ? closeMenu() : openMenu();
  });

  document.addEventListener('click', (event) => {
    if (!menu.classList.contains('is-open')) return;
    if (menu.contains(event.target) || menuToggle.contains(event.target)) return;
    closeMenu();
  });

  function toggleSubmenu(submenu, toggle) {
    const isOpen = submenu.classList.contains('is-open');
    closeSubmenu(a11ySubmenu, a11yToggle);
    closeSubmenu(privacySubmenu, privacyToggle);
    if (!isOpen) {
      submenu.classList.add('is-open');
      submenu.setAttribute('aria-hidden', 'false');
      toggle.setAttribute('aria-expanded', 'true');
    }
  }

  a11yToggle.addEventListener('click', (e) => { e.stopPropagation(); toggleSubmenu(a11ySubmenu, a11yToggle); });
  privacyToggle.addEventListener('click', (e) => { e.stopPropagation(); toggleSubmenu(privacySubmenu, privacyToggle); });

  soundToggle.addEventListener('click', () => {
    state.soundEnabled = !state.soundEnabled;
    soundToggle.setAttribute('aria-checked', String(state.soundEnabled));
    const stateEl = soundToggle.querySelector('.chat-menu-item-state');
    if (stateEl) {
      stateEl.textContent = state.soundEnabled ? 'On' : 'Off';
      stateEl.setAttribute('data-state', state.soundEnabled ? 'on' : 'off');
    }
    if (state.soundEnabled) playChime();
  });

  downloadBtn.addEventListener('click', () => {
    const lines = state.messages.length
      ? state.messages.map((m) => {
          const who = m.sender_type === 'admin' ? 'Meridian Support' : m.sender_type === 'system' ? 'System' : 'You';
          return `[${timeLabel(m.created_at)}] ${who}: ${m.body || (m.attachment_name ? `[attachment: ${m.attachment_name}]` : '')}`;
        })
      : ['[No messages yet]'];
    const header = `Meridian Support — chat transcript\nDownloaded ${new Date().toLocaleString()}\n${'-'.repeat(40)}\n`;
    const blob = new Blob([header + lines.join('\n')], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `meridian-chat-transcript-${Date.now()}.txt`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    closeMenu();
  });

  largeTextCheck.addEventListener('change', () => document.body.classList.toggle('a11y-large-text', largeTextCheck.checked));
  highContrastCheck.addEventListener('change', () => document.body.classList.toggle('a11y-high-contrast', highContrastCheck.checked));
  reduceMotionCheck.addEventListener('change', () => document.documentElement.classList.toggle('a11y-reduce-motion', reduceMotionCheck.checked));

  // No schema exists yet for a data-request/deletion queue (chat_schema.sql
  // has no such table). Rather than write to something that doesn't exist,
  // these acknowledge the request as a system message. Replace with a real
  // RPC call once that schema shows up.
  requestDataBtn.addEventListener('click', () => {
    closeMenu();
    renderSystemNotice("Your request for a copy of your chat data has been logged. We'll email a summary to the address on file within 30 days, per GDPR Article 15.");
  });

  deleteDataBtn.addEventListener('click', () => {
    closeMenu();
    renderSystemNotice("Your deletion request has been logged. This conversation's data will be permanently removed within 30 days, per GDPR Article 17.");
  });

  clearBtn.addEventListener('click', async () => {
    closeMenu();
    if (!state.threadId) return;
    const { error } = await closeMyThread(state.threadId);
    if (error) {
      renderSystemNotice(`Couldn't clear this conversation — ${error}`);
      return;
    }
    unsubscribeFromThread(state.channel);
    stopHeartbeat();
    state.threadId = null;
    state.channel = null;
    state.messages = [];
    document.querySelector('[data-chat-messages]').innerHTML = '';
    await initThread(); // spins up a fresh open thread + its own welcome message
  });
}

function closeMenu() {
  const menu = document.getElementById('chat-menu');
  const menuToggle = document.getElementById('chat-menu-toggle');
  if (!menu) return;
  menu.classList.remove('is-open');
  menu.setAttribute('aria-hidden', 'true');
  menuToggle.setAttribute('aria-expanded', 'false');
  closeSubmenu(document.getElementById('chat-accessibility-submenu'), document.getElementById('chat-accessibility-toggle'));
  closeSubmenu(document.getElementById('chat-privacy-submenu'), document.getElementById('chat-privacy-toggle'));
}

function closeSubmenu(submenu, toggle) {
  if (!submenu) return;
  submenu.classList.remove('is-open');
  submenu.setAttribute('aria-hidden', 'true');
  if (toggle) toggle.setAttribute('aria-expanded', 'false');
}

/* -----------------------------------------------------------
   Cleanup
   ----------------------------------------------------------- */
export function unmountChatWidget() {
  unsubscribeFromThread(state.channel);
  stopHeartbeat();
  clearPendingFile();
  document.body.classList.remove(BODY_OPEN_CLASS);
  document.body.classList.remove(BODY_LOCKED_CLASS);
  document.body.style.top = '';
  state = {
    threadId: null, channel: null, panelOpen: false, mounted: false, allowGuest: false,
    pendingFile: null, previewObjectUrl: null, soundEnabled: true, audioCtx: null,
    heartbeatTimer: null, messages: [],
  };
}
