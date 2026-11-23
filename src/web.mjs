// Gap Web is a compiled Svelte app with no global handle, so the original
// operations work the page the way a person does: it opens a chat by its
// address (?p=@username) or by clicking it in the list, types into the
// composer, and attaches files through the attach menu. Messages are read
// from the rendered chat; a sent message counts as delivered once Gap swaps
// its temporary negative id for a server id.
//
// The wider operation set goes through the page's own API layer instead (see
// gapBridge): Gap lazy-loads one module per API area and each exports its calls
// under stable names, so the bridge imports those modules into the page and
// calls them with the session the page already holds.
import { evaluate } from '@nabuxai/iranian-messaging-core';

const ATTACH = 'button[aria-label="Attachments and message tools"]';
const COMPOSER = 'div.composer[contenteditable=true]';
const MESSAGE = 'div.messageview[data-id]';

function menuItemFor(mime) {
  if (/^image\//.test(mime)) return 'Image';
  if (/^video\//.test(mime)) return 'Video';
  if (/^audio\//.test(mime)) return 'Audio';
  return 'File';
}

// The signed-in account's own username, for "me".
function ownUsername() {
  const stored = JSON.parse(localStorage.getItem('gap:account-storage:gap:production') || '{}');
  const account = stored.accounts?.[stored.activeAccountId]?.account;
  return account ? { userId: String(account.userId), username: account.username, nickname: account.nickname || null } : null;
}

async function openChat(page, chatId) {
  const raw = String(chatId).trim();
  if (/^\d+$/.test(raw)) {
    const row = page.locator(`[data-conversation-id="${raw}"]`);
    if (!(await row.count())) throw new Error('CHAT_NOT_IN_LIST_USE_@USERNAME');
    await row.first().click();
  } else {
    const username = /^(me|saved|self)$/i.test(raw) ? (await evaluate(page, ownUsername))?.username : raw.replace(/^@/, '');
    if (!username) throw new Error('WEB_APP_NOT_READY_OR_NOT_SIGNED_IN');
    const target = '?p=@' + username;
    if (new URL(page.url()).search !== target) {
      await page.goto('https://web.gap.im/' + target, { waitUntil: 'domcontentloaded', timeout: 60000 });
    }
  }
  await page.waitForFunction(sel => document.querySelector('.chatsession') !== null, MESSAGE, { timeout: 20000 })
    .catch(() => { throw new Error('WEB_APP_ERROR: chat did not open'); });
  await page.waitForTimeout(1500);
}

function readMessages() {
  // Text with emoji images turned back into their characters.
  const textOf = node => {
    if (!node) return null;
    let out = '';
    for (const child of node.childNodes) {
      if (child.nodeType === 3) out += child.textContent;
      else if (child.tagName === 'IMG') out += child.getAttribute('alt') || '';
      else out += textOf(child) || '';
    }
    return out.trim() || null;
  };
  return [...document.querySelectorAll('div.messageview[data-id]')].map(m => {
    const kind = [...m.classList].find(c => c.startsWith('msg'));
    const lines = m.innerText.split('\n').map(s => s.trim()).filter(Boolean);
    return {
      messageId: m.getAttribute('data-id'),
      date: null,
      time: lines.find(l => /^\d{1,2}:\d{2}$/.test(l)) || null,
      fromId: null,
      outgoing: m.classList.contains('primary'),
      text: textOf(m.querySelector('.messageview__content__body__content')),
      media: kind && kind !== 'msgText' ? kind.replace(/^msg/, '').toLowerCase() : null,
      views: null
    };
  });
}

async function awaitSent(page, beforeIds, timeoutMs) {
  const known = new Set(beforeIds);
  const deadline = Date.now() + timeoutMs;
  let pending = false;
  while (Date.now() < deadline) {
    const messages = await evaluate(page, readMessages);
    const fresh = messages.filter(m => m.outgoing && !known.has(m.messageId));
    const done = fresh.find(m => Number(m.messageId) > 0);
    if (done) return { messageId: done.messageId, pending: false };
    pending = pending || fresh.length > 0;
    await page.waitForTimeout(800);
  }
  return { messageId: null, pending: true };
}

async function typeMultiline(page, text) {
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (i) await page.keyboard.press('Shift+Enter');
    if (lines[i]) await page.keyboard.type(lines[i], { delay: 10 });
  }
}

async function chatIdOf(page) {
  return evaluate(page, () => {
    const selected = document.querySelector('[data-conversation-id].selected');
    return selected ? selected.getAttribute('data-conversation-id') : new URLSearchParams(location.search).get('p');
  });
}

// Runs in the page. Each API module is found by reading the app's own import
// sites (`{API_X:e}=await import(`./XAPI-<hash>.js`)`), so it survives Gap
// rebuilds that change the file hashes; importing it yields the very module
// instance the app uses. Requests go out with the page's session; the token
// is never read here. Writes use API_V2_5_Topic_SendCommand, the command
// channel the app itself uses for send, edit, delete, forward, pin, seen and
// group changes.
async function gapBridge({ op, args }) {
  const state = window.__nabuGap || (window.__nabuGap = { files: {}, scanned: [] });
  const plain = value => JSON.parse(JSON.stringify(value ?? null, (k, v) => typeof v === 'bigint' ? v.toString() : v));

  async function api(name) {
    if (!state.files[name]) {
      const urls = new Set(performance.getEntriesByType('resource').map(e => e.name.split('?')[0])
        .filter(u => u.startsWith(location.origin + '/assets/') && u.endsWith('.js')));
      for (const s of document.querySelectorAll('script[src]')) urls.add(new URL(s.src, location.href).href.split('?')[0]);
      for (const url of urls) {
        if (state.scanned.includes(url)) continue;
        state.scanned.push(url);
        let text = '';
        try { text = await (await fetch(url)).text(); } catch { continue; }
        for (const m of text.matchAll(/\{(API_\w+):[\w$]+\}=await import\(`\.\/([\w.-]+\.js)`\)/g)) {
          state.files[m[1]] = state.files[m[1]] || new URL(m[2], url).href;
        }
        if (state.files[name]) break;
      }
    }
    const mod = state.files[name] ? await import(state.files[name]) : {};
    if (typeof mod[name] !== 'function') throw new Error('GAP_INTERNAL_API_NOT_FOUND: ' + name);
    return mod[name];
  }

  // Gap rejects with its response object rather than an Error.
  async function call(name, ...params) {
    try {
      return await (await api(name))(...params);
    } catch (e) {
      if (e instanceof Error) throw e;
      const reason = e?.error?.description || e?.error?.message || e?.message || e?.data?.message || e?.error || e?.status;
      throw new Error('GAP_REFUSED: ' + String(typeof reason === 'object' ? JSON.stringify(reason) : reason).slice(0, 200));
    }
  }

  function own() {
    const stored = JSON.parse(localStorage.getItem('gap:account-storage:gap:production') || '{}');
    const account = stored.accounts?.[stored.activeAccountId]?.account;
    if (!account?.userId) throw new Error('WEB_APP_NOT_READY_OR_NOT_SIGNED_IN');
    return { userId: Number(account.userId), username: account.username || null };
  }

  const groups = async () => (await call('API_V2_5_Group_List', {})).data?.data?.groups || [];
  const detail = async groupId => (await call('API_V2_5_Group_GetDetail', { groupId: Number(groupId) })).data?.data;

  function summary(g, me) {
    const isPrivate = g.type === 'private';
    const opposite = isPrivate ? Number(g.opposite_id) : null;
    return {
      chatId: g.groupId != null ? String(g.groupId) : null,
      groupId: g.groupId != null ? Number(g.groupId) : null,
      kind: isPrivate ? (g.kind === 'bot' || g.service_id ? 'bot' : 'user') : g.type === 'channel' ? 'channel' : 'group',
      title: g.name || g.nickname || null,
      username: g.identifier || g.username || (opposite === me.userId ? me.username : null),
      oppositeId: opposite,
      topic: isPrivate ? (opposite === me.userId ? `u/${me.userId}` : `u/${opposite}/${me.userId}`) : `g/${g.groupId}`,
      description: g.description || null,
      memberCount: !isPrivate && typeof g.member_count === 'number' ? g.member_count : null,
      role: isPrivate || g.is_member === false ? null : g.is_owner ? 'creator' : g.is_admin ? 'admin' : 'member',
      unread: Number(g.badge) || 0,
      lastId: Number(g.lastMessage?.id) || 0,
      inviteLink: g.join_link || (g.hash ? `https://gap.im/join/${g.hash}` : null)
    };
  }

  // "me", a numeric chatId (Gap's conversation id), @username or a gap.im link.
  async function resolve(chatId) {
    const me = own();
    const raw = String(chatId ?? '').trim();
    const list = await groups();
    let g;
    if (/^(me|saved|self)$/i.test(raw)) {
      g = list.find(x => x.type === 'private' && Number(x.opposite_id) === me.userId);
    } else if (/^\d+$/.test(raw)) {
      g = list.find(x => String(x.groupId) === raw) || await detail(raw).catch(() => null);
    } else {
      const name = raw.replace(/^https?:\/\/(www\.)?gap\.im\//i, '').replace(/^@/, '').toLowerCase();
      g = list.find(x => String(x.identifier || '').toLowerCase() === name);
      if (!g && name) {
        const found = (await call('API_V1_Identifier_Detect', { identifier: name })).data?.data;
        if (found?.type === 'user' || found?.type === 'bot') {
          const info = (await call('API_V1_PrivateInfo_Get', { userId: found.data.id })).data?.data;
          g = { ...found.data, kind: found.type, type: 'private', opposite_id: found.data.id, groupId: info?.groupId,
            name: info?.name || found.data.nickname, identifier: found.data.username };
        } else if (found?.data) {
          g = { ...found.data, type: found.data.type || found.type };
        }
      }
    }
    if (!g) throw new Error('CHAT_NOT_FOUND');
    return { me, chat: summary(g, me) };
  }

  const clock = at => isNaN(at) ? null : `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;

  function message(m, me) {
    const at = new Date(Number(m.time));
    const from = m.from && typeof m.from === 'object' ? m.from.id : m.from;
    let text = null;
    if (typeof m.data === 'string' && m.data) {
      if (m.type === 'msgText' || !/^[[{]/.test(m.data.trim())) text = m.data;
      else { try { const d = JSON.parse(m.data); text = d.desc || d.caption || d.question || null; } catch { text = null; } }
    }
    return {
      messageId: String(m.id),
      date: isNaN(at) ? null : at.toISOString().slice(0, 10),
      time: clock(at),
      fromId: from != null ? String(from) : null,
      outgoing: from != null && Number(from) === me.userId,
      text,
      media: m.type && m.type !== 'msgText' ? m.type.replace(/^msg/, '').toLowerCase() : null,
      views: typeof m.view === 'number' ? m.view : null
    };
  }

  // Up to `count` messages ending at `anchor` (inclusive), newest first.
  // Reading history does not mark anything read; only the `seen` command does.
  async function history(groupId, count, anchor) {
    const r = await call('API_V2_5_Message_List', { groupId: Number(groupId), count: -Math.abs(count),
      messageId: Number(anchor) || Number.MAX_SAFE_INTEGER });
    return (r.data?.data?.messages || []).sort((a, b) => b.id - a.id);
  }

  async function command(topic, body, timeout = 0) {
    const ack = await call('API_V2_5_Topic_SendCommand', topic, body, timeout);
    return plain({ id: ack?.id ?? null, type: ack?.type ?? null, to: ack?.to ?? null,
      data: ack?.data && typeof ack.data === 'object' ? ack.data : null });
  }

  switch (op) {
    case 'chat': {
      const { me, chat } = await resolve(args.chatId);
      if (!args.full || !chat.groupId || chat.kind === 'user' || chat.kind === 'bot') return chat;
      const d = await detail(chat.groupId).catch(() => null);
      return d ? { ...summary({ ...d, groupId: chat.groupId }, me), username: chat.username || d.identifier || null } : chat;
    }
    case 'command': {
      const { chat } = await resolve(args.chatId);
      return { chat, ack: await command(chat.topic, args.body, args.timeout) };
    }
    case 'globalCommand': return command(args.topic, args.body, args.timeout);
    case 'history': {
      const { me, chat } = await resolve(args.chatId);
      const list = chat.groupId ? await history(chat.groupId, args.limit, args.anchor) : [];
      return { chat, messages: list.map(m => message(m, me)) };
    }
    case 'media': {
      const { chat } = await resolve(args.chatId);
      const [m] = chat.groupId ? await history(chat.groupId, 1, args.messageId) : [];
      if (!m || String(m.id) !== String(args.messageId)) throw new Error('MESSAGE_NOT_FOUND');
      const file = m.file && typeof m.file === 'object' ? m.file : null;
      if (!file || !(file.path || file.SID)) throw new Error('MESSAGE_HAS_NO_MEDIA');
      if (Number(file.filesize) > args.maxBytes) throw new Error('FILE_TOO_LARGE');
      const url = new URL(file.path || `https://cdn.gaplication.com/${file.SID}`, location.href);
      if (url.protocol !== 'https:' || !/(^|\.)(gaplication\.com|gap\.im)$/.test(url.hostname)) throw new Error('MEDIA_HOST_NOT_ALLOWED');
      const res = await fetch(url.href);
      if (!res.ok) throw new Error('MEDIA_DOWNLOAD_FAILED: HTTP ' + res.status);
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (bytes.length > args.maxBytes) throw new Error('FILE_TOO_LARGE');
      let binary = '';
      for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      return { name: file.filename || `gap-${chat.groupId}-${m.id}${file.extension ? '.' + file.extension : ''}`,
        mime: (res.headers.get('content-type') || '').split(';')[0] || null, base64: btoa(binary) };
    }
    case 'members': {
      const { chat } = await resolve(args.chatId);
      const d = chat.groupId ? await detail(chat.groupId) : null;
      const owner = typeof d?.owner === 'number' ? d.owner : d?.owner?.id;
      const users = (d?.users || []).map(u => ({ userId: String(u.id), name: u.nickname || u.contact_nickname || null,
        username: u.username || null, role: Number(u.id) === Number(owner) ? 'creator' : u.admin ? 'admin' : 'member' }));
      return { total: typeof d?.member_count === 'number' ? d.member_count : users.length, members: users };
    }
    case 'search': {
      const me = own();
      const groupID = args.chatId ? (await resolve(args.chatId)).chat.groupId : undefined;
      const r = await call('API_V1_Search_Message', { text: args.query, groupID });
      if (r.response?.status !== 200 || r.response?.data?.status === 'error') throw new Error('GAP_REFUSED: search');
      return plain((r.response.data.result || []).map(x => {
        const at = new Date(Number(x.time));
        return { chatId: String(x.groupID), messageId: String(x.msgID), date: isNaN(at) ? null : at.toISOString().slice(0, 10),
          time: clock(at), fromId: x.senderUser != null ? String(x.senderUser) : null, outgoing: Number(x.senderUser) === me.userId,
          text: x.text || null, media: x.messageType && x.messageType !== 'msgText' ? x.messageType.replace(/^msg/, '').toLowerCase() : null,
          views: null };
      }));
    }
    case 'unread': {
      const me = own();
      const chats = (await groups()).filter(g => Number(g.badge) > 0)
        .sort((a, b) => Number(b.last_message_time) - Number(a.last_message_time)).slice(0, args.limit);
      const out = [];
      for (const g of chats) {
        const c = summary(g, me);
        const list = await history(c.groupId, Math.min(c.unread, args.perChat), c.lastId);
        out.push({ chatId: c.chatId, title: c.title, unread: c.unread, messages: list.map(m => message(m, me)) });
      }
      return out;
    }
    case 'contacts': {
      const list = await call('API_V2_8_Contact_ListAll', { search: args.query || undefined, sort: 0, contactType: 'gapMember' });
      return plain((list || []).filter(c => Number(c.contactUserID) > 0).map(c => ({
        userId: String(c.contactUserID), name: `${c.firstName || ''} ${c.lastName || ''}`.trim() || null, username: null })));
    }
    case 'poll': {
      const { me, chat } = await resolve(args.chatId);
      const r = await call('API_V1_Poll_Create', { question: args.question, options: args.options, groupId: chat.groupId });
      if (r?.response?.status && r.response.status !== 200) throw new Error('GAP_REFUSED: ' + (r.getErrorMessage?.() || r.response.status));
      for (let i = 0; i < 10; i++) {
        const [m] = await history(chat.groupId, 1);
        const from = m?.from && typeof m.from === 'object' ? m.from.id : m?.from;
        if (m && m.type === 'msgPoll' && Number(from) === me.userId && m.id > chat.lastId) {
          return { chatId: chat.chatId, messageId: String(m.id), pending: false };
        }
        await new Promise(done => setTimeout(done, 700));
      }
      return { chatId: chat.chatId, messageId: null, pending: true };
    }
    case 'updateInfo': {
      const { chat } = await resolve(args.chatId);
      if (chat.kind !== 'group' && chat.kind !== 'channel') throw new Error('NOT_A_GROUP_OR_CHANNEL');
      await call('API_V1_Group_Update', { groupId: chat.groupId, name: args.title, description: args.about });
      return { updated: true };
    }
    default: throw new Error('UNKNOWN_BRIDGE_OP');
  }
}

const MAX_DOWNLOAD_BYTES = 50 * 1024 * 1024;

async function bridge(page, op, args = {}) {
  await page.locator('[data-conversation-id], .chatsession').first().waitFor({ timeout: 20000 })
    .catch(() => { throw new Error('WEB_APP_NOT_READY_OR_NOT_SIGNED_IN'); });
  return evaluate(page, gapBridge, { op, args });
}

// A command on one chat's topic; the ack carries the server message id.
async function chatCommand(page, chatId, body, timeout = 0) {
  const { chat, ack } = await bridge(page, 'command', { chatId, body, timeout });
  if (!ack?.type) throw new Error('WEB_APP_ERROR: Gap did not acknowledge the command');
  return { chat, ack };
}

async function postCommand(page, chatId, body) {
  const { chat, ack } = await chatCommand(page, chatId, body);
  const id = Number(ack.id);
  return { chatId: chat.chatId, messageId: id > 0 ? String(id) : null, pending: !(id > 0) };
}

const seq = id => {
  const n = Number(id);
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error('INVALID_MESSAGE_ID');
  return n;
};
const userNumber = id => {
  const n = Number(String(id).replace(/^@/, ''));
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error('GAP_NEEDS_NUMERIC_USER_ID');
  return n;
};

async function groupChat(page, chatId, error = 'NOT_A_GROUP_OR_CHANNEL') {
  const chat = await bridge(page, 'chat', { chatId });
  if (chat.kind !== 'group' && chat.kind !== 'channel') throw new Error(error);
  return chat;
}

// gap.im/join/<hash> joins by invite; @name, gap.im/<name> or a bare name by identifier.
function joinTarget(link) {
  const raw = String(link).trim();
  const hash = raw.match(/gap\.im\/join\/([\w-]+)/i);
  if (hash) return { hash: hash[1] };
  const name = raw.replace(/^https?:\/\/(www\.)?gap\.im\//i, '').replace(/^@/, '').replace(/[/?#].*$/, '');
  if (!/^\w{3,64}$/.test(name)) throw new Error('INVALID_LINK');
  return { identifier: name };
}

export const gap = {
  id: 'gap',
  label: 'Gap Web',
  url: 'https://web.gap.im/',
  host: 'web.gap.im',
  chatIdHint: '"me" for your own chat (My Gap), @username, or a numeric chatId from messaging_web_list_chats',
  notes: 'Polls and pins work only in groups/channels (pins need admin); polls are single-answer with no anonymity ' +
    'option; removeMember cannot ban; member lists are ' +
    'what Gap shows this account (often empty for channels you do not run); user ids for member ops are numeric.',

  async loginState(page) {
    const signedIn = await page.locator('[data-conversation-id], .chatsession').count();
    if (signedIn) {
      const own = await evaluate(page, ownUsername);
      return { signedIn: true, userId: own?.userId ?? null, name: own?.nickname ?? null };
    }
    const step = await page.evaluate(() => {
      const text = document.body?.innerText || '';
      if (/Activation Code|کد فعال/.test(text) || document.querySelector('input[placeholder="Activation Code"]')) return 'waiting_for_code';
      if (/password|رمز/i.test(text)) return 'waiting_for_password';
      return document.querySelector('input.form-control') ? 'waiting_for_phone' : 'loading';
    });
    return { signedIn: false, step };
  },

  async loginStart(page, digits) {
    const field = page.locator('input.form-control').first();
    await field.waitFor({ timeout: 20000 });
    await field.click();
    await field.fill('');
    await page.keyboard.type(digits, { delay: 40 });
    await page.waitForTimeout(600);
    await page.getByRole('button', { name: /^(login|ورود)$/i }).first().click();
  },

  async listChats(page, { limit }) {
    await page.locator('[data-conversation-id]').first().waitFor({ timeout: 20000 })
      .catch(() => { throw new Error('WEB_APP_NOT_READY_OR_NOT_SIGNED_IN'); });
    const rows = await evaluate(page, () => [...document.querySelectorAll('[data-conversation-id]')].map(row => {
      const lines = row.innerText.split('\n').map(s => s.trim()).filter(Boolean);
      const badge = lines.find(l => /^\d+$/.test(l));
      return { chatId: row.getAttribute('data-conversation-id'), title: lines[0] || null, username: null,
        type: null, unread: badge ? Number(badge) : 0, canPost: null };
    }));
    // Only chats the list has rendered are visible to the page.
    return { total: rows.length, chats: rows.slice(0, limit) };
  },

  async readChat(page, { chatId, limit, before }) {
    await openChat(page, chatId);
    const all = (await evaluate(page, readMessages)).filter(m => Number(m.messageId) > 0)
      .sort((a, b) => Number(b.messageId) - Number(a.messageId));
    const older = before ? all.filter(m => Number(m.messageId) < Number(before)) : all;
    const list = older.slice(0, limit);
    return { chatId: await chatIdOf(page), messages: list,
      nextBeforeMessageId: older.length > list.length ? list.at(-1).messageId : null };
  },

  async sendText(page, { chatId, text, replyToMessageId }) {
    // A reply goes through the command channel, which takes the replied-to id directly.
    if (replyToMessageId) return postCommand(page, chatId, { type: 'msgText', data: text, reply: seq(replyToMessageId) });
    await openChat(page, chatId);
    const composer = page.locator(COMPOSER);
    if (!(await composer.count())) throw new Error('CANNOT_POST_IN_THIS_CHAT');
    const before = (await evaluate(page, readMessages)).map(m => m.messageId);
    await composer.click();
    await typeMultiline(page, text);
    await page.waitForTimeout(400);
    await page.keyboard.press('Enter');
    return { chatId: await chatIdOf(page), ...(await awaitSent(page, before, 20000)) };
  },

  async sendFile(page, { chatId, file, caption }) {
    await openChat(page, chatId);
    if (!(await page.locator(ATTACH).count())) throw new Error('CANNOT_POST_IN_THIS_CHAT');
    const before = (await evaluate(page, readMessages)).map(m => m.messageId);
    await page.locator(ATTACH).click();
    const chooser = page.waitForEvent('filechooser', { timeout: 10000 });
    await page.getByText(menuItemFor(file.mime), { exact: true }).first().click();
    await (await chooser).setFiles({ name: file.name, mimeType: file.mime, buffer: file.bytes });
    const send = page.getByText('Send', { exact: true });
    const modal = page.locator('.modal').filter({ has: send }).last();
    await modal.waitFor({ timeout: 15000 });
    if (caption) {
      const field = modal.locator('[contenteditable=true]').first();
      await field.click();
      await typeMultiline(page, caption);
      await page.waitForTimeout(400);
    }
    await modal.getByText('Send', { exact: true }).click();
    return { chatId: await chatIdOf(page), ...(await awaitSent(page, before, 120000)) };
  },

  // ---- message operations ----

  async editText(page, { chatId, messageId, text }) {
    await chatCommand(page, chatId, { type: 'edit', data: text, id: seq(messageId) });
    return { edited: true };
  },

  async deleteMessages(page, { chatId, messageIds, forEveryone }) {
    // Always a list: Gap answers HTTP 400 to a bare id here.
    const list = messageIds.map(seq);
    await chatCommand(page, chatId, { type: 'delete', id: list, data: { both: forEveryone } });
    return { deleted: list.length };
  },

  async forwardMessages(page, { fromChatId, messageIds, toChatId }) {
    const source = await bridge(page, 'chat', { chatId: fromChatId });
    if (!source.groupId) throw new Error('CHAT_NOT_FOUND');
    const out = [];
    for (const id of messageIds.map(seq)) {
      const { ack } = await chatCommand(page, toChatId, { type: 'forward', data: { id, group_id: source.groupId } });
      if (Number(ack.id) > 0) out.push(String(ack.id));
    }
    return { messageIds: out };
  },

  // Gap pins only in groups and channels, and only for their admins.
  async pinMessage(page, { chatId, messageId, unpin }) {
    await groupChat(page, chatId, 'GAP_PINS_ONLY_IN_GROUPS_AND_CHANNELS');
    await chatCommand(page, chatId, { type: unpin ? 'unpinMessage' : 'pinMessage', data: seq(messageId) });
    return { pinned: !unpin };
  },

  async markRead(page, { chatId }) {
    const chat = await bridge(page, 'chat', { chatId });
    if (!chat.lastId) return { read: true };
    await chatCommand(page, chatId, { type: 'seen', id: chat.lastId, to: chat.groupId }, 30000);
    return { read: true };
  },

  sendLocation: (page, { chatId, latitude, longitude }) =>
    postCommand(page, chatId, { type: 'msgLocation', data: JSON.stringify({ lat: latitude, long: longitude }) }),

  sendContact: (page, { chatId, phone, firstName, lastName }) =>
    postCommand(page, chatId, { type: 'msgContact', data: JSON.stringify({ name: `${firstName} ${lastName || ''}`.trim(), phone }) }),

  async sendPoll(page, { chatId, question, options, multipleAnswers }) {
    if (multipleAnswers) throw new Error('GAP_POLLS_ARE_SINGLE_ANSWER');
    await groupChat(page, chatId, 'GAP_POLLS_ONLY_IN_GROUPS_AND_CHANNELS');
    return bridge(page, 'poll', { chatId, question, options });
  },

  // ---- reading (none of these marks anything read) ----

  async getChatInfo(page, { chatId }) {
    const c = await bridge(page, 'chat', { chatId, full: true });
    return { chatId: c.chatId, title: c.title, username: c.username, type: c.kind, description: c.description,
      memberCount: c.memberCount, role: c.role };
  },

  async getMembers(page, { chatId, limit, query }) {
    const { total, members } = await bridge(page, 'members', { chatId });
    const q = query.trim().toLowerCase();
    const hits = q ? members.filter(m => `${m.name || ''} ${m.username || ''}`.toLowerCase().includes(q)) : members;
    return { total: q ? hits.length : total, members: hits.slice(0, limit) };
  },

  async searchMessages(page, { chatId, query, limit }) {
    return { messages: (await bridge(page, 'search', { chatId, query })).slice(0, limit) };
  },

  downloadMedia: (page, { chatId, messageId }) =>
    bridge(page, 'media', { chatId, messageId: String(seq(messageId)), maxBytes: MAX_DOWNLOAD_BYTES }),

  async getUnread(page, { limit }) {
    return { chats: await bridge(page, 'unread', { limit, perChat: 10 }) };
  },

  async getContacts(page, { limit, query }) {
    const contacts = await bridge(page, 'contacts', { query: query.trim() });
    return { total: contacts.length, contacts: contacts.slice(0, limit) };
  },

  // ---- chat management ----

  async createChat(page, { type, title, about }) {
    const ack = await bridge(page, 'globalCommand', { topic: 'g/0', timeout: 30000,
      body: { type: 'groupCreate', data: { name: title, type, access: 'private', users: [], description: about || undefined } } });
    if (!(Number(ack.to) > 0)) throw new Error('WEB_APP_ERROR: Gap did not return the new chat');
    return { chatId: String(ack.to), title, type };
  },

  async updateChat(page, { chatId, title, about }) {
    return bridge(page, 'updateInfo', { chatId, title, about });
  },

  async getInviteLink(page, { chatId }) {
    const chat = await bridge(page, 'chat', { chatId, full: true });
    if (chat.kind !== 'group' && chat.kind !== 'channel') throw new Error('NOT_A_GROUP_OR_CHANNEL');
    const link = chat.inviteLink || (chat.username ? `https://gap.im/${chat.username}` : null);
    if (!link) throw new Error('NO_INVITE_LINK_VISIBLE_TO_THIS_ACCOUNT');
    return { link };
  },

  async joinChat(page, { link }) {
    const ack = await bridge(page, 'globalCommand', { topic: 'g/0', timeout: 30000, body: { type: 'groupJoin', data: joinTarget(link) } });
    if (!(Number(ack.to) > 0)) throw new Error('WEB_APP_ERROR: Gap did not return the joined chat');
    return { chatId: String(ack.to), title: ack.data?.name ?? null };
  },

  async leaveChat(page, { chatId }) {
    await groupChat(page, chatId);
    await chatCommand(page, chatId, { type: 'groupLeave' });
    return { left: true };
  },

  async addMembers(page, { chatId, userIds }) {
    await groupChat(page, chatId);
    const users = userIds.map(userNumber);
    await chatCommand(page, chatId, { type: 'groupJoin', data: { users } }, 30000);
    return { added: users.length };
  },

  // Gap has no separate ban: a removed member can be added again or rejoin by link.
  async removeMember(page, { chatId, userId }) {
    await groupChat(page, chatId);
    await chatCommand(page, chatId, { type: 'groupKick', data: { users: [userNumber(userId)] } });
    return { removed: true };
  },

  async setAdmin(page, { chatId, userId, isAdmin }) {
    await groupChat(page, chatId);
    await chatCommand(page, chatId, { type: 'groupAdmin', data: { users: [userNumber(userId)], admin: isAdmin } });
    return { updated: true };
  }
};
