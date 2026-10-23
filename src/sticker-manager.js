// Runtime sticker views are always bound to one physical conversation.
// Legacy stickers.json and QQ favourites are retained as unprovenanced cold data.
import { getConfig } from "./config.js";
import { currentConversationContext } from "./conversation-context.js";
import { loadStickerStore } from "./stickers.js";
import { ScopedStickerLibrary, scopedStickerPath } from "./scoped-stickers.js";
const fail = () =>
  Object.assign(Error("STICKER_SCOPE_REQUIRED"), {
    code: "STICKER_SCOPE_REQUIRED",
  });
export function stickerErrorMessage(value) {
  const code = String(value?.code || value?.message || value || "");
  return (
    {
      STICKER_SCOPE_REQUIRED: "需要指定当前聊天的表情库。",
      STICKER_SCOPE_DENIED: "这个聊天的表情库不可用或授权已变化。",
      STICKER_LIBRARY_FULL: "表情库已达到数量或磁盘上限，本次不再收录。",
      STICKER_RATE_LIMIT: "本聊天或平台本小时收录次数已达上限，请稍后再试。",
      STICKER_BUSY: "表情收录队列已满，请稍后再试。",
      STICKER_STORAGE_INVALID: "表情库资料异常，已停止改写，请联系管理员。",
      STICKER_IMAGE_UNAVAILABLE:
        "没有取得有效图片，未收录或发送；过期的图片可以重新发送。",
      STICKER_IMAGE_INVALID: "图片格式、路径或大小不符合表情库限制。",
      STICKER_COLLECTION_DISABLED: "当前已关闭表情收录。",
      STICKER_NOTE_INVALID: "表情备注或标签过长或格式不正确。",
      STICKER_DOWNLOAD_CANCELLED: "表情下载已取消或超过时间限制。",
      STICKER_SOURCE_INVALID: "没有有效的当前聊天图片来源。",
    }[code] || code
  );
}
export function localStickerPath(
  raw,
  chatKey = currentConversationContext()?.conversationKey,
) {
  return chatKey ? scopedStickerPath(raw, chatKey) : null;
}
export class StickerManager {
  constructor(onebot, options = {}) {
    this.library = new ScopedStickerLibrary({
      onebot,
      ...options,
    });
    this.legacyCount = loadStickerStore().length;
  }
  get enabled() {
    return getConfig().sticker?.enabled !== false;
  }
  get entries() {
    const key = currentConversationContext()?.conversationKey;
    return key ? this.library.entries(key) : [];
  }
  forChat(chatKey) {
    return this.library.view(chatKey);
  }
  current() {
    const key = currentConversationContext()?.conversationKey;
    if (!key) throw fail();
    return this.forChat(key);
  }
  async sync() {
    const key = currentConversationContext()?.conversationKey;
    return key
      ? this.forChat(key).sync()
      : {
          entries: [],
          fromCache: true,
          quarantined: true,
          legacyCount: this.legacyCount,
        };
  }
  list(...args) {
    return this.current().list(...args);
  }
  find(...args) {
    return this.current().find(...args);
  }
  note(...args) {
    return this.current().note(...args);
  }
  markUsed(...args) {
    return this.current().markUsed(...args);
  }
  collect(...args) {
    return this.current().collect(...args);
  }
  ensureSendable(...args) {
    return this.current().ensureSendable(...args);
  }
  autoCollect(chatKey, input) {
    return this.library.autoCollect(chatKey, input);
  }
  whenIdle() {
    return this.library.whenIdle();
  }
  close() {
    return this.library.close();
  }
}
