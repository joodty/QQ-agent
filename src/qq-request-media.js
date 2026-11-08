import { detectImageType } from './image-type.js';
import { extractMediaFromSegments } from './onebot.js';
import { safeFetchBinary } from './safe-fetch.js';

export function selectTriggerEntry(entries, messageId) {
  const candidates = (entries ?? []).filter(entry => !entry.self && /^[1-9]\d*$/.test(String(entry.senderId)));
  if (messageId != null) return candidates.find(entry => String(entry.mid) === String(messageId));
  if (candidates.length === 1) return candidates[0];
}

function messageInChat(ctx, mid, message) {
  const [kind, id] = ctx.chatKey.split(':');
  if (message.message_type && message.message_type !== kind) return false;
  if (kind === 'group' && message.group_id != null) return String(message.group_id) === id;
  if (kind === 'private') {
    const sender = String(message.sender?.user_id ?? message.user_id ?? '');
    if (sender === id) return true;
    if (sender && sender !== String(ctx.selfId)) return false;
    if (message.target_id != null) return String(message.target_id) === id;
  }
  return Boolean(ctx.store.findByMid(ctx.chatKey, mid));
}

export async function loadReferenceImage(ctx, entry, download = safeFetchBinary) {
  const images = media => (media ?? []).filter(item => item.kind === 'image');
  const attached = images(entry.media);
  const mid = attached.length ? entry.mid : entry.reply?.mid;
  let selected = attached;
  if (!selected.length || !selected[0].url) {
    if (!/^-?[1-9]\d*$/.test(String(mid)) || !Number.isSafeInteger(Number(mid))) throw Error('请发一张图，或引用那张图再说要怎么改。');
    const message = await ctx.onebot.getMsg(mid);
    if (!message || !messageInChat(ctx, mid, message) || !Array.isArray(message.message)) throw Error('找不到原图，请在当前聊天重发。');
    selected = images(extractMediaFromSegments(message.message));
  }
  if (selected.length !== 1 || !selected[0].url) throw Error('请单独发一张参考图，或引用只有一张图的消息。');
  const { buffer } = await download(selected[0].url, 8 * 1024 * 1024);
  const mime = detectImageType(buffer)?.mime;
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(mime)) throw Error('请发送 PNG、JPG 或 WebP 静态参考图。');
  return 'data:' + mime + ';base64,' + buffer.toString('base64');
}
