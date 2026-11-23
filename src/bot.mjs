// Gap bot platform (https://developer.gap.im/doc/botplatform).
// Token goes in a `token` header; bodies are form fields. Files are uploaded
// to /upload first, and the JSON string it returns is sent as `data`.
// Gap delivers incoming messages only by webhook, so there is no polling here.
import { callApi, formFrom } from '@nabuxai/iranian-messaging-core';

const API_BASE = process.env.GAP_API_BASE || 'https://api.gap.im';
const FILE_TYPE = { photo: 'image', video: 'video', audio: 'audio', voice: 'voice', document: 'file' };

const post = (ctx, method, fields) => {
  const form = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) if (value != null) form.append(key, String(value));
  return callApi(`${API_BASE}/${method}`, { form, headers: { token: ctx.token } }, ctx.fetcher);
};

export const gap = {
  id: 'gap',
  label: 'Gap (گپ)',
  tokenEnv: 'GAP_BOT_TOKEN',
  docs: 'https://developer.gap.im/doc/botplatform',
  capabilities: ['send_text', 'send_file', 'edit_text', 'delete'],

  async sendText(ctx, { chatId, text }) {
    const sent = await post(ctx, 'sendMessage', { chat_id: chatId, type: 'text', data: text });
    return { messageId: sent?.id != null ? String(sent.id) : null };
  },

  async sendFile(ctx, { chatId, file, kind, caption }) {
    const type = FILE_TYPE[kind] || 'file';
    const form = formFrom({ chat_id: chatId, desc: caption }, { field: type, ...file });
    const uploaded = await callApi(`${API_BASE}/upload`, { form, headers: { token: ctx.token } }, ctx.fetcher);
    const data = typeof uploaded === 'string' ? uploaded : JSON.stringify(uploaded);
    const sent = await post(ctx, 'sendMessage', { chat_id: chatId, type, data });
    return { messageId: sent?.id != null ? String(sent.id) : null };
  },

  async editText(ctx, { chatId, messageId, text }) {
    await post(ctx, 'editMessage', { chat_id: chatId, message_id: messageId, data: text });
    return { edited: true };
  },

  async deleteMessage(ctx, { chatId, messageId }) {
    await post(ctx, 'deleteMessage', { chat_id: chatId, message_id: messageId });
    return { deleted: true };
  }
};
