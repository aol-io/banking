/* =============================================================
   MERIDIAN — Admin panel
   pages/admin/admin-chat.js

   PURPOSE
   -------
   Powers admin-chat.html — the realtime live-chat inbox, separate
   from the ticket system on admin-support.html. Talks directly to
   chat_threads/chat_messages (supabase/chat_schema.sql) since there
   is no supabase/admin.js wrapper yet (still "planned" per the
   project's directory tree) — same direct-supabase-call pattern
   settings.js already uses for tables with no wrapper.

   FIX LOG (this revision)
   ------------------------
   - MOBILE KEYBOARD/LAYOUT FIX: added setViewportHeightVar(), driven
     by window.visualViewport, which writes a --app-vh custom
     property that admin-chat.css's mobile section (8) sizes the
     whole shell off. This is what actually keeps the shell's height
     fixed when the on-screen keyboard opens/closes on the reply
     textarea or the search input — see admin-chat.css's FIX LOG for
     the full explanation of why vh/dvh alone weren't enough.
   - ATTACHMENT VIEWER (NEW): renderAttachmentInto() no longer opens
     images/PDFs/files via window.open() or a bare <a>. Every
     attachment is now a <button> that calls openAttachmentViewer(),
     which fills in the new #attachment-viewer overlay (markup in
     admin-chat.html, styles in admin-chat.css section 9) with the
     right body for the attachment's type — inline <img>, inline
     <iframe> for PDFs, or a name/size/download card for anything
     else — so attachments open as an in-page "card" instead of
     leaving the admin panel or dropping the person into a bare new
     tab.
   - LINK AUTO-DETECTION (NEW): messageHtml()'s body text now runs
     through linkifyEscaped() after escaping, turning any
     http(s):// URL a visitor or admin types into a proper styled,
     clickable link (admin-chat.css's .admin-chat-link) instead of
     inert plain text.
   - Everything below this point (attachment SCHEME, KNOWN GAPS,
     etc.) is carried over unchanged from the previous revision.

   PRIOR FIX LOG
   -------------
   - ATTACHMENT SCHEME CORRECTED: this file previously read/wrote
     attachment_url/attachment_type/attachment_name and used
     getPublicUrl() against a public bucket. That never matched the
     live schema — information_schema confirms chat_messages has
     attachment_path/attachment_name/attachment_type/attachment_size
     (NOT attachment_url), and storage.buckets confirms
     'chat-attachments' is public: false. Every admin-side
     attachment insert was therefore failing (referencing a column
     that doesn't exist), and every read was checking a field that
     was always undefined. This revision now uses attachment_path
     with getAttachmentSignedUrl() from supabase/chat.js — the exact
     scheme chat.js/chat-widget.js (visitor side) already use, so
     both sides are finally on ONE canonical implementation.
   - Also required a NEW storage policy — see
     supabase/migrations/009_admin_chat_attachments_upload_policy.sql
     — since the only existing admin storage policy was SELECT;
     there was no INSERT policy letting an admin upload to a thread
     they don't own. Without that migration applied, uploads from
     this file will still fail with an RLS error.
   - Rendering attachments is now async (a signed URL has to be
     fetched per message), so messageHtml()/renderMessages()/
     appendMessage() no longer build attachment markup inline —
     they insert a placeholder container and fill it in afterward,
     the same pattern chat-widget.js's renderAttachment() already
     uses on the visitor side.

   KNOWN GAPS — flagging rather than silently faking:
   -----------------------------------------------------
   1. OPEN-TAB COUNT: the badge next to the "Open" tab
      (data-thread-filter-count="open") only updates while you're
      ON the Open tab, since it's just threads.length for whatever
      filter is currently loaded — getting a live open-count while
      viewing Closed/All would need a second, separate count query.
      Minor, but not a real unread-style badge across tabs.
   2. The PDF preview in the attachment viewer uses a plain <iframe>
      pointed at the signed URL. That renders natively in desktop
      browsers and in-app on recent mobile Safari/Chrome, but some
      embedded/in-app webviews (e.g. certain in-app browsers) don't
      render PDFs in an iframe at all — the header's "open in new
      tab" button is the fallback for that case, not just a nicety.

   ROLE: any of support/admin/superadmin can access this page (the
   requireAdmin() default), matching admin-support.html's own tier.
   ============================================================= */

import { requireAdmin } from '../../assets/js/admin/admin-guard.js';
import { initAdminLayout } from '../../assets/js/admin/admin-layout.js';
import { supabase } from '../../supabase/config.js';
import {
  getAttachmentSignedUrl,
  MAX_ATTACHMENT_BYTES,
  ALLOWED_ATTACHMENT_TYPES,
} from '../../supabase/chat.js';

const $ = (selector, scope) => (scope || document).querySelector(selector);
const $$ = (selector, scope) => Array.from((scope || document).querySelectorAll(selector));

const ONLINE_THRESHOLD_MS = 60 * 1000;
const CHAT_ATTACHMENTS_BUCKET = 'chat-attachments';

let admin = null;
let threads = [];              // threads for the CURRENT filter only
let activeThreadId = null;
let activeFilter = 'open';     // 'open' | 'closed' | 'all'
let searchTerm = '';
let realtimeChannel = null;
let presenceTickInterval = null;

/* -----------------------------------------------------------
   1. Boot
   ----------------------------------------------------------- */
async function init() {
  admin = await requireAdmin();
  if (!admin) return;
  await initAdminLayout(admin, { pageTitle: 'Live chat' });

  wireTabs();
  wireSearch();
  wireRetry();
  wireThreadListClicks();
  wireReplyForm();
  wireStatusToggle();
  wireAttach();
  wireBackToList();
  wireAttachmentViewer();
  wireViewportHeight();

  await loadThreads();
  subscribeToRealtime();

  presenceTickInterval = setInterval(refreshPresenceOnly, 15000);

  window.addEventListener('beforeunload', () => {
    if (realtimeChannel) supabase.removeChannel(realtimeChannel);
    if (presenceTickInterval) clearInterval(presenceTickInterval);
  });
}

/* -----------------------------------------------------------
   1b. Keyboard-safe viewport height (mobile)
   -----------------------------------------------------------
   `100vh`/`100dvh` in CSS is measured against the layout viewport,
   which on iOS/Android does NOT shrink when the on-screen keyboard
   opens — only window.visualViewport does. admin-chat.css's mobile
   section sizes .admin-chat-shell (and the attachment viewer) off
   the --app-vh custom property this sets, so the shell's actual
   pixel height tracks whatever space the keyboard has left, instead
   of overflowing/getting shoved around when an input is focused.
   Falls back gracefully: browsers without visualViewport just keep
   using the plain `100dvh` already baked into the CSS as a fallback
   value, so nothing breaks where this API is unavailable.
   ----------------------------------------------------------- */
function wireViewportHeight() {
  setViewportHeightVar();
  window.addEventListener('resize', setViewportHeightVar);
  window.addEventListener('orientationchange', setViewportHeightVar);
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', setViewportHeightVar);
    window.visualViewport.addEventListener('scroll', setViewportHeightVar);
  }
}

function setViewportHeightVar() {
  const h = window.visualViewport ? window.visualViewport.height : window.innerHeight;
  document.documentElement.style.setProperty('--app-vh', `${h}px`);
}

/* -----------------------------------------------------------
   2. Thread list — fetch
   ----------------------------------------------------------- */
async function loadThreads() {
  showListLoading();

  let query = supabase
    .from('chat_threads')
    .select('id, user_id, status, assigned_admin_id, last_seen_at, updated_at, created_at')
    .order('updated_at', { ascending: false });

  if (activeFilter !== 'all') query = query.eq('status', activeFilter);

  const { data: threadRows, error } = await query;
  if (error) {
    console.error('[Meridian Admin] Failed to load chat threads:', error.message);
    showListError();
    return;
  }

  if (!threadRows.length) {
    threads = [];
    applySearchAndRender();
    return;
  }

  const threadIds = threadRows.map((t) => t.id);
  const userIds = [...new Set(threadRows.map((t) => t.user_id))];

  const [{ data: profiles, error: profilesError }, { data: messages, error: messagesError }] = await Promise.all([
    supabase.from('user_profiles').select('id, first_name, last_name, email').in('id', userIds),
    supabase
      .from('chat_messages')
      .select('id, thread_id, sender_type, body, attachment_path, attachment_type, attachment_name, created_at, read_at')
      .in('thread_id', threadIds)
      .order('created_at', { ascending: true }),
  ]);

  if (profilesError) console.error('[Meridian Admin] Failed to load profiles for chat threads:', profilesError.message);
  if (messagesError) console.error('[Meridian Admin] Failed to load messages for chat threads:', messagesError.message);

  const profileMap = new Map((profiles || []).map((p) => [p.id, p]));
  const messagesByThread = new Map();
  (messages || []).forEach((m) => {
    if (!messagesByThread.has(m.thread_id)) messagesByThread.set(m.thread_id, []);
    messagesByThread.get(m.thread_id).push(m);
  });

  threads = threadRows.map((t) => {
    const msgs = messagesByThread.get(t.id) || [];
    const last = msgs[msgs.length - 1] || null;
    const unreadCount = msgs.filter((m) => m.sender_type === 'user' && !m.read_at).length;
    const profile = profileMap.get(t.user_id) || null;

    return {
      ...t,
      profile,
      isVisitor: !profile,
      displayName: profile
        ? [profile.first_name, profile.last_name].filter(Boolean).join(' ') || profile.email || 'Customer'
        : 'Visitor',
      lastMessage: last,
      unreadCount,
      isOnline: isRecentlySeen(t.last_seen_at),
    };
  });

  applySearchAndRender();
}

function isRecentlySeen(lastSeenAt) {
  if (!lastSeenAt) return false;
  return Date.now() - new Date(lastSeenAt).getTime() < ONLINE_THRESHOLD_MS;
}

/* -----------------------------------------------------------
   3. Thread list — filter/search/render
   ----------------------------------------------------------- */
function applySearchAndRender() {
  const term = searchTerm.trim().toLowerCase();
  const filtered = term
    ? threads.filter((t) => {
        const nameMatch = t.displayName.toLowerCase().includes(term);
        // A last message can be attachment-only (body is nullable —
        // see chat_schema.sql), so guard before calling .toLowerCase().
        const bodyMatch = Boolean(t.lastMessage && t.lastMessage.body && t.lastMessage.body.toLowerCase().includes(term));
        return nameMatch || bodyMatch;
      })
    : threads;

  renderThreadList(filtered);
  updateOpenTabCount();
}

function renderThreadList(list) {
  const ul = $('[data-thread-list]');
  const loading = $('[data-thread-list-loading]');
  const empty = $('[data-thread-list-empty]');
  const errorEl = $('[data-thread-list-error]');

  loading.hidden = true;
  errorEl.hidden = true;

  if (!list.length) {
    ul.hidden = true;
    ul.innerHTML = '';
    empty.hidden = false;
    return;
  }

  empty.hidden = true;
  ul.hidden = false;
  ul.innerHTML = list.map(threadItemHtml).join('');
}

function threadItemHtml(t) {
  const preview = threadPreviewText(t.lastMessage);
  const time = t.lastMessage ? formatRelativeTime(t.lastMessage.created_at) : '';

  return `
    <li class="admin-chat-thread-item${t.id === activeThreadId ? ' is-active' : ''}" data-thread-item data-thread-id="${t.id}">
      <button type="button" class="admin-chat-thread-btn">
        <span class="admin-chat-thread-avatar-wrap">
          <span class="avatar-initial avatar-initial--sm" data-thread-avatar>${getInitials(t.displayName)}</span>
          <span class="admin-chat-thread-presence" data-thread-presence data-state="${t.isOnline ? 'online' : 'offline'}"></span>
        </span>
        <span class="admin-chat-thread-info">
          <span class="admin-chat-thread-row">
            <span class="admin-chat-thread-name" data-thread-name>${escapeHtml(t.displayName)}</span>
            <span class="tag admin-chat-thread-visitor-tag" data-thread-visitor-tag${t.isVisitor ? '' : ' hidden'}>Visitor</span>
            <span class="admin-chat-thread-time" data-thread-time>${time}</span>
          </span>
          <span class="admin-chat-thread-preview" data-thread-preview>${preview}</span>
        </span>
        <span class="admin-nav-badge" data-thread-unread${t.unreadCount ? '' : ' hidden'}>${t.unreadCount}</span>
      </button>
    </li>`;
}

// A last message can have a body, an attachment, or both — pick
// the most useful one-line preview for the thread list.
function threadPreviewText(lastMessage) {
  if (!lastMessage) return 'No messages yet';
  if (lastMessage.body) return escapeHtml(lastMessage.body);
  if (lastMessage.attachment_path) {
    const isImage = (lastMessage.attachment_type || '').startsWith('image/');
    return isImage ? '📷 Photo' : `📎 ${escapeHtml(lastMessage.attachment_name || 'Attachment')}`;
  }
  return 'No messages yet';
}

function updateOpenTabCount() {
  // Only meaningful while viewing the Open tab itself — see gap #1
  // in the file header comment.
  const el = $('[data-thread-filter-count="open"]');
  if (!el || activeFilter !== 'open') return;
  el.textContent = String(threads.length);
  el.hidden = threads.length === 0;
}

function showListLoading() {
  $('[data-thread-list-loading]').hidden = false;
  $('[data-thread-list]').hidden = true;
  $('[data-thread-list-empty]').hidden = true;
  $('[data-thread-list-error]').hidden = true;
}

function showListError() {
  $('[data-thread-list-loading]').hidden = true;
  $('[data-thread-list]').hidden = true;
  $('[data-thread-list-empty]').hidden = true;
  $('[data-thread-list-error]').hidden = false;
}

/* -----------------------------------------------------------
   4. Tabs / search / retry wiring
   ----------------------------------------------------------- */
function wireTabs() {
  $$('.admin-chat-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      $$('.admin-chat-tab').forEach((t) => {
        t.classList.remove('is-active');
        t.setAttribute('aria-selected', 'false');
      });
      tab.classList.add('is-active');
      tab.setAttribute('aria-selected', 'true');
      activeFilter = tab.dataset.threadFilter;
      loadThreads();
    });
  });
}

function wireSearch() {
  const input = $('[data-thread-search]');
  if (!input) return;
  input.addEventListener('input', () => {
    searchTerm = input.value;
    applySearchAndRender();
  });
}

function wireRetry() {
  $('[data-thread-list-retry]')?.addEventListener('click', () => loadThreads());
}

function wireThreadListClicks() {
  $('[data-thread-list]')?.addEventListener('click', (event) => {
    const item = event.target.closest('[data-thread-item]');
    if (item) selectThread(item.dataset.threadId);
  });
}

/* -----------------------------------------------------------
   5. Selecting a thread
   ----------------------------------------------------------- */
async function selectThread(threadId) {
  activeThreadId = threadId;

  $$('.admin-chat-thread-item').forEach((li) => {
    li.classList.toggle('is-active', li.dataset.threadId === threadId);
  });

  const thread = threads.find((t) => t.id === threadId);
  if (!thread) return;

  $('[data-conversation-empty]').hidden = true;
  $('[data-conversation-active]').hidden = false;
  $('.admin-chat-shell')?.classList.add('is-conversation-open'); // mobile pane switch

  $('[data-conversation-avatar]').textContent = getInitials(thread.displayName);
  $('[data-conversation-name]').textContent = thread.displayName;
  $('[data-conversation-visitor-tag]').hidden = !thread.isVisitor;

  updatePresenceUI(thread);
  updateStatusUI(thread);

  await loadMessages(threadId);
  await markThreadMessagesRead(threadId);
}

/* -----------------------------------------------------------
   6. Messages — load / render / send
   ----------------------------------------------------------- */
async function loadMessages(threadId) {
  const container = $('[data-admin-messages]');
  container.innerHTML = '<p class="admin-chat-state">Loading messages…</p>';

  const { data, error } = await supabase
    .from('chat_messages')
    .select('id, sender_type, body, attachment_path, attachment_type, attachment_name, created_at, read_at')
    .eq('thread_id', threadId)
    .order('created_at', { ascending: true });

  if (error) {
    console.error('[Meridian Admin] Failed to load messages:', error.message);
    container.innerHTML = '<p class="admin-chat-state">Couldn\'t load this conversation.</p>';
    return;
  }

  renderMessages(data || []);
}

// Renders every message's text synchronously, then resolves each
// attachment's signed URL asynchronously and fills it in — a signed
// URL requires a network round-trip per message, so building the
// whole log can't wait on all of them before showing anything.
function renderMessages(msgs) {
  const container = $('[data-admin-messages]');
  container.innerHTML = msgs.map(messageHtml).join('');
  container.scrollTop = container.scrollHeight;

  msgs.forEach((m) => {
    if (!m.attachment_path) return;
    const bubble = container.querySelector(`[data-message-id="${m.id}"] .admin-chat-msg-attachment-slot`);
    if (bubble) renderAttachmentInto(bubble, m);
  });
}

function appendMessage(msg) {
  const container = $('[data-admin-messages]');
  if (!container) return;
  container.insertAdjacentHTML('beforeend', messageHtml(msg));
  container.scrollTop = container.scrollHeight;

  if (msg.attachment_path) {
    const bubble = container.querySelector(`[data-message-id="${msg.id}"] .admin-chat-msg-attachment-slot`);
    if (bubble) renderAttachmentInto(bubble, msg);
  }
}

function messageHtml(m) {
  const cls =
    m.sender_type === 'admin' ? 'admin-chat-msg admin-chat-msg--admin' :
    m.sender_type === 'system' ? 'admin-chat-msg admin-chat-msg--system' :
    'admin-chat-msg';

  const label = m.sender_type === 'admin' ? 'You' : m.sender_type === 'system' ? 'System' : 'Visitor';

  // escapeHtml() first (never trust message content), THEN linkify —
  // linkifyEscaped() only ever wraps text already safe to insert, it
  // never introduces raw user input into the DOM.
  const bodyHtml = m.body ? `<div class="admin-chat-msg-body">${linkifyEscaped(escapeHtml(m.body))}</div>` : '';
  // Empty slot now, filled asynchronously by renderAttachmentInto()
  // once its signed URL resolves — see renderMessages()/appendMessage().
  const attachmentSlotHtml = m.attachment_path ? `<div class="admin-chat-msg-attachment-slot"></div>` : '';

  return `
    <div class="${cls}" data-message-id="${m.id}">
      <div class="admin-chat-msg-meta"><span>${label}</span><span>${formatClockTime(m.created_at)}</span></div>
      ${bodyHtml}
      ${attachmentSlotHtml}
    </div>`;
}

// Resolves a signed URL for the attachment (private bucket — see
// getAttachmentSignedUrl() in supabase/chat.js, shared with the
// visitor-facing widget so both sides mint URLs the same way) and
// renders it as a clickable image thumbnail or a file chip. Both
// open the shared attachment viewer (section 6b) instead of
// navigating away, so "click the image" stays on this page.
async function renderAttachmentInto(slot, m) {
  const isImage = (m.attachment_type || '').startsWith('image/');
  const { data: url, error } = await getAttachmentSignedUrl(m.attachment_path);

  if (error || !url) {
    slot.innerHTML = `<div class="chat-attachment"><span class="admin-chat-state">Couldn't load attachment.</span></div>`;
    return;
  }

  if (isImage) {
    slot.innerHTML = `
      <div class="chat-attachment">
        <button type="button" class="chat-attachment-image-btn" aria-label="View image">
          <img class="chat-attachment-image" src="${escapeHtml(url)}" alt="${escapeHtml(m.attachment_name || 'Attachment')}" loading="lazy">
        </button>
      </div>`;
    slot.querySelector('.chat-attachment-image-btn')?.addEventListener('click', () => {
      openAttachmentViewer({ type: 'image', url, name: m.attachment_name || 'Photo' });
    });
    return;
  }

  const ext = fileExtension(m.attachment_name, m.attachment_type);

  slot.innerHTML = `
    <div class="chat-attachment">
      <button type="button" class="chat-attachment-file chat-attachment-file-btn">
        <span class="chat-attachment-file-ext">${escapeHtml(ext)}</span>
        <span class="chat-attachment-file-name">${escapeHtml(m.attachment_name || 'Document')}</span>
      </button>
    </div>`;

  slot.querySelector('.chat-attachment-file-btn')?.addEventListener('click', () => {
    const type = (m.attachment_type || '') === 'application/pdf' ? 'pdf' : 'file';
    openAttachmentViewer({ type, url, name: m.attachment_name || 'Document' });
  });
}

// Short (≤4-char) badge text for the file-chip: prefer the real
// filename extension, fall back to a guess from the mime type.
function fileExtension(name, mimeType) {
  const fromName = (name || '').split('.').pop();
  if (fromName && fromName.length <= 4 && fromName !== name) return fromName.toUpperCase();
  if ((mimeType || '').includes('/')) {
    const sub = mimeType.split('/').pop();
    return sub.slice(0, 4).toUpperCase();
  }
  return 'FILE';
}

async function markThreadMessagesRead(threadId) {
  const { error } = await supabase
    .from('chat_messages')
    .update({ read_at: new Date().toISOString() })
    .eq('thread_id', threadId)
    .eq('sender_type', 'user')
    .is('read_at', null);

  if (error) {
    console.error('[Meridian Admin] Failed to mark messages read:', error.message);
    return;
  }

  const thread = threads.find((t) => t.id === threadId);
  if (thread) thread.unreadCount = 0;

  const badge = $(`[data-thread-item][data-thread-id="${threadId}"] [data-thread-unread]`);
  if (badge) badge.setAttribute('hidden', '');
}

function wireReplyForm() {
  const form = $('[data-admin-reply-form]');
  const input = $('[data-admin-reply-input]');
  const sendBtn = $('[data-admin-reply-send]');
  if (!form || !input || !sendBtn) return;

  input.addEventListener('input', () => {
    sendBtn.disabled = !input.value.trim();
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 120)}px`;
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const body = input.value.trim();
    if (!body || !activeThreadId) return;

    sendBtn.disabled = true;

    const { error } = await supabase.from('chat_messages').insert({
      thread_id: activeThreadId,
      sender_type: 'admin',
      sender_id: admin.user.id,
      body,
    });

    if (error) {
      console.error('[Meridian Admin] Failed to send reply:', error.message);
      sendBtn.disabled = false;
      return;
    }

    // The realtime subscription (section 8) appends the message to
    // the log — no need to render it here too.
    input.value = '';
    input.style.height = 'auto';
  });
}

/* -----------------------------------------------------------
   6b. Attachment viewer (lightbox)
   -----------------------------------------------------------
   One shared full-screen overlay (markup in admin-chat.html,
   styles in admin-chat.css section 9). openAttachmentViewer()
   fills in the right body for the attachment's type and shows it;
   closeAttachmentViewer() tears it back down. Wired once in
   wireAttachmentViewer() at boot: backdrop click, the header's
   close button, and Escape all close it.
   ----------------------------------------------------------- */
function wireAttachmentViewer() {
  const viewer = $('[data-attachment-viewer]');
  if (!viewer) return;

  $$('[data-attachment-viewer-close]', viewer).forEach((el) => {
    el.addEventListener('click', closeAttachmentViewer);
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !viewer.hidden) closeAttachmentViewer();
  });
}

function openAttachmentViewer({ type, url, name }) {
  const viewer = $('[data-attachment-viewer]');
  const body = $('[data-attachment-viewer-body]');
  const nameEl = $('[data-attachment-viewer-name]');
  const downloadLink = $('[data-attachment-viewer-download]');
  const openTabLink = $('[data-attachment-viewer-open-tab]');
  if (!viewer || !body) return;

  nameEl.textContent = name || 'Attachment';
  downloadLink.href = url;
  downloadLink.setAttribute('download', name || '');

  if (type === 'image') {
    openTabLink.hidden = true;
    body.innerHTML = `<img class="attachment-viewer-image" src="${escapeHtml(url)}" alt="${escapeHtml(name || 'Attachment')}">`;
  } else if (type === 'pdf') {
    openTabLink.hidden = false;
    openTabLink.href = url;
    body.innerHTML = `<iframe class="attachment-viewer-frame" src="${escapeHtml(url)}" title="${escapeHtml(name || 'Document')}"></iframe>`;
  } else {
    openTabLink.hidden = false;
    openTabLink.href = url;
    body.innerHTML = `
      <div class="attachment-viewer-filecard">
        <span class="attachment-viewer-filecard-icon">
          <svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M4 3.5h9l3 3v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-12a1 1 0 0 1 1-1Z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>
        </span>
        <span class="attachment-viewer-filecard-name">${escapeHtml(name || 'Document')}</span>
        <span class="attachment-viewer-filecard-hint">Preview isn't available for this file type</span>
        <a class="attachment-viewer-filecard-download" href="${escapeHtml(url)}" download="${escapeHtml(name || '')}">Download</a>
      </div>`;
  }

  viewer.hidden = false;
  document.body.classList.add('attachment-viewer-open');
}

function closeAttachmentViewer() {
  const viewer = $('[data-attachment-viewer]');
  const body = $('[data-attachment-viewer-body]');
  if (!viewer) return;
  viewer.hidden = true;
  if (body) body.innerHTML = ''; // stop any playing/loading media (esp. the PDF iframe)
  document.body.classList.remove('attachment-viewer-open');
}

/* -----------------------------------------------------------
   7. Status toggle (open/closed) + presence display
   ----------------------------------------------------------- */
function wireStatusToggle() {
  $('[data-conversation-toggle-status]')?.addEventListener('click', async () => {
    const thread = threads.find((t) => t.id === activeThreadId);
    if (!thread) return;

    const newStatus = thread.status === 'open' ? 'closed' : 'open';
    const { error } = await supabase.from('chat_threads').update({ status: newStatus }).eq('id', thread.id);

    if (error) {
      console.error('[Meridian Admin] Failed to update thread status:', error.message);
      return;
    }

    thread.status = newStatus;
    updateStatusUI(thread);

    // If the current tab no longer includes this status, it should
    // drop out of the visible list.
    if (activeFilter !== 'all' && activeFilter !== newStatus) loadThreads();
  });
}

function updateStatusUI(thread) {
  const pill = $('[data-conversation-status-pill]');
  const btn = $('[data-conversation-toggle-status]');

  if (pill) {
    pill.textContent = thread.status === 'open' ? 'Open' : 'Closed';
    pill.classList.toggle('status-pill--verified', thread.status === 'open');
  }
  if (btn) {
    btn.textContent = thread.status === 'open' ? 'Mark as closed' : 'Reopen conversation';
  }
}

function updatePresenceUI(thread) {
  const wrap = $('[data-conversation-presence]');
  const text = $('[data-conversation-presence-text]');
  if (!wrap || !text) return;

  wrap.dataset.state = thread.isOnline ? 'online' : 'offline';
  text.textContent = thread.isOnline
    ? 'Online now'
    : thread.last_seen_at
      ? `Last seen ${formatRelativeTime(thread.last_seen_at)}`
      : 'Offline';
}

// Recomputes online/offline off data already in memory (no network
// call) every 15s, so a visitor going stale doesn't require a
// manual refresh to notice.
function refreshPresenceOnly() {
  let changed = false;
  threads.forEach((t) => {
    const nowOnline = isRecentlySeen(t.last_seen_at);
    if (nowOnline !== t.isOnline) {
      t.isOnline = nowOnline;
      changed = true;
    }
  });
  if (changed) applySearchAndRender();

  const active = threads.find((t) => t.id === activeThreadId);
  if (active) updatePresenceUI(active);
}

/* -----------------------------------------------------------
   8. Realtime — one shared channel for both tables
   ----------------------------------------------------------- */
function subscribeToRealtime() {
  if (realtimeChannel) supabase.removeChannel(realtimeChannel);

  realtimeChannel = supabase
    .channel('admin-chat-inbox')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'chat_threads' }, () => {
      // Simplest-correct approach: any thread row change (new
      // thread, status change, last_seen_at bump) just re-fetches
      // the current filter's list. Fine at this app's scale.
      loadThreads();
    })
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'chat_messages' }, (payload) => {
      handleIncomingMessage(payload.new);
    })
    .subscribe();
}

function handleIncomingMessage(message) {
  const thread = threads.find((t) => t.id === message.thread_id);

  if (!thread) {
    // Message belongs to a thread not in the current filtered view
    // (e.g. a new thread just opened) — let the chat_threads
    // listener's loadThreads() pick it up.
    return;
  }

  thread.lastMessage = message;
  if (message.sender_type === 'user' && message.thread_id !== activeThreadId) {
    thread.unreadCount = (thread.unreadCount || 0) + 1;
  }
  applySearchAndRender();

  if (message.thread_id === activeThreadId) {
    appendMessage(message);
    if (message.sender_type === 'user') markThreadMessagesRead(activeThreadId);
  }
}

/* -----------------------------------------------------------
   9. Attachments — real upload flow.
   -----------------------------------------------------------
   Matches chat.js's sendAttachment() exactly in shape (same path
   structure, same private bucket, same column names) but can't
   reuse that function directly — it hardcodes sender_type: 'user'
   and resolves the CUSTOMER's own id via resolveUserId(), neither
   of which is correct for an admin reply. Requires
   supabase/migrations/009_admin_chat_attachments_upload_policy.sql
   to have been run — without it, this upload will fail with an RLS
   error, since the only pre-existing admin storage policy was
   SELECT, not INSERT.
   ----------------------------------------------------------- */
function wireAttach() {
  const attachBtn = $('[data-admin-attach]');
  const fileInput = $('[data-admin-file-input]');
  if (!attachBtn || !fileInput) return;

  attachBtn.addEventListener('click', () => fileInput.click());

  fileInput.addEventListener('change', async () => {
    const file = fileInput.files[0];
    fileInput.value = ''; // allow picking the same file twice in a row
    if (!file || !activeThreadId) return;

    if (file.size > MAX_ATTACHMENT_BYTES) {
      window.alert('That file is too large — attachments must be 10MB or smaller.');
      return;
    }
    if (!ALLOWED_ATTACHMENT_TYPES.includes(file.type)) {
      window.alert("That file type isn't supported — try an image, PDF, or Word doc.");
      return;
    }

    const sendBtn = $('[data-admin-reply-send]');
    const replyInput = $('[data-admin-reply-input]');
    attachBtn.disabled = true;
    if (sendBtn) sendBtn.disabled = true;

    try {
      const safeName = file.name.replace(/[^a-zA-Z0-9.\-_]/g, '_');
      const path = `${activeThreadId}/${crypto.randomUUID()}-${safeName}`;

      const { error: uploadError } = await supabase.storage
        .from(CHAT_ATTACHMENTS_BUCKET)
        .upload(path, file, { cacheControl: '3600', upsert: false, contentType: file.type || undefined });

      if (uploadError) throw uploadError;

      const { error: insertError } = await supabase.from('chat_messages').insert({
        thread_id: activeThreadId,
        sender_type: 'admin',
        sender_id: admin.user.id,
        body: null,
        attachment_path: path,
        attachment_name: file.name,
        attachment_type: file.type,
        attachment_size: file.size,
      });

      if (insertError) throw insertError;
      // Realtime subscription (section 8) appends it to the log.
    } catch (err) {
      console.error('[Meridian Admin] Failed to send attachment:', err.message);
      window.alert("Couldn't send that file — please try again.");
    } finally {
      attachBtn.disabled = false;
      if (sendBtn) sendBtn.disabled = !(replyInput && replyInput.value.trim());
    }
  });
}

/* -----------------------------------------------------------
   10. Mobile: back-to-list button
   -----------------------------------------------------------
   admin-chat.html has a [data-conversation-back] button in the
   conversation header; wireBackToList() removes
   .is-conversation-open from .admin-chat-shell, which (per
   admin-chat.css sections 7-8) swaps the visible pane back to the
   thread list on phones.
   ----------------------------------------------------------- */
function wireBackToList() {
  $('[data-conversation-back]')?.addEventListener('click', () => {
    $('.admin-chat-shell')?.classList.remove('is-conversation-open');
  });
}

/* -----------------------------------------------------------
   11. Small helpers
   ----------------------------------------------------------- */
function getInitials(name) {
  return (
    (name || 'V')
      .split(' ')
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0].toUpperCase())
      .join('') || 'V'
  );
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str ?? '';
  return div.innerHTML;
}

// Turns bare http(s):// URLs inside already-escaped text into real
// links. MUST be called AFTER escapeHtml() — it only ever wraps text
// that's already safe to drop into innerHTML, never raw user input,
// so it can't be used to smuggle markup in.
const URL_PATTERN = /(https?:\/\/[^\s<]+)/g;

function linkifyEscaped(escapedText) {
  return escapedText.replace(URL_PATTERN, (match) => {
    // Keep trailing punctuation (a period ending the sentence, a
    // closing paren, etc.) OUTSIDE the link, same as most chat apps.
    const trailing = (match.match(/[).,!?;:'"]+$/) || [''])[0];
    const core = trailing ? match.slice(0, -trailing.length) : match;
    if (!core) return match;
    return `<a class="admin-chat-link" href="${core}" target="_blank" rel="noopener noreferrer">${core}</a>${trailing}`;
  });
}

function formatClockTime(iso) {
  return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function formatRelativeTime(iso) {
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.round(diffMs / 60000);
  if (mins < 1) return 'now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  return `${days}d ago`;
}

init();
