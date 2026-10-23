import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { pathToFileURL, fileURLToPath } from "node:url";
import { getConfig, DATA_DIR } from "./config.js";
import { currentConversationContext } from "./conversation-context.js";
import {
  capturePaidAuthority,
  assertPaidAuthority,
} from "./paid-call-guard.js";
import { detectImageType } from "./image-type.js";
import { formatStickerList } from "./stickers.js";
import { downloadStickerImage } from "./sticker-download.js";
import { stickerImageParts } from "./sticker-image.js";
export const STICKER_LIMITS = Object.freeze({
  maxImageBytes: 3 * 1024 * 1024,
  maxImages: 200,
  maxBytes: 200 * 1024 * 1024,
  maxScopeImages: 60,
  maxScopeBytes: 60 * 1024 * 1024,
  maxPerHour: 30,
  maxScopePerHour: 10,
  maxPending: 4,
});
const hash = (x) => crypto.createHash("sha256").update(x).digest("hex");
const key = (x) =>
  typeof x === "string" &&
  /^(group|private):[1-9]\d*$/.test(x) &&
  Number.isSafeInteger(Number(x.split(":")[1]));
const fail = (code) =>
  Object.assign(Error(code), {
    code,
  });
const plain = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
const label = (x, max) =>
  typeof x === "string" &&
  x.length <= max &&
  !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(x);
export const scopedStickerDirectory = (
  chatKey,
  { dataDir = DATA_DIR, botId = "primary" } = {},
) => {
  if (!key(chatKey) || !/^[A-Za-z0-9_-]{1,64}$/.test(botId))
    throw fail("STICKER_SCOPE_INVALID");
  return path.join(dataDir, "sticker-images", "scoped-" + botId, hash(chatKey));
};
const inside = (root, file) => {
  const relative = path.relative(root, file);
  return (
    relative !== "" &&
    !relative.startsWith(".." + path.sep) &&
    relative !== ".." &&
    !path.isAbsolute(relative)
  );
};
async function withSignal(promise, signal) {
  let cancel;
  const stopped = new Promise((_, reject) => {
    cancel = () => reject(fail("STICKER_DOWNLOAD_CANCELLED"));
  });
  signal.addEventListener("abort", cancel, {
    once: true,
  });
  try {
    if (signal.aborted) cancel();
    return await Promise.race([promise, stopped]);
  } finally {
    signal.removeEventListener("abort", cancel);
  }
}
function regular(file, maxBytes) {
  const stat = fs.lstatSync(file);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.size < 12 ||
    stat.size > maxBytes
  )
    throw fail("STICKER_IMAGE_INVALID");
  return stat;
}
export function scopedStickerPath(raw, chatKey, options = {}) {
  try {
    if (typeof raw !== "string" || !raw.startsWith("file:///")) return null;
    const url = new URL(raw);
    if (url.host) return null;
    const root = path.resolve(scopedStickerDirectory(chatKey, options));
    let file;
    try {
      file = path.resolve(fileURLToPath(url));
    } catch {
      file = path.join(
        root,
        path.posix.basename(
          decodeURIComponent(url.pathname).replaceAll("\\", "/"),
        ),
      );
    }
    if (!/^[a-f0-9]{64}\.(png|jpg|gif|webp)$/.test(path.basename(file)))
      return null;
    // A moved data directory may relocate the same content only within its
    // original typed chat. Never search other chats or legacy global media.
    if (!inside(root, file) || path.dirname(file) !== root)
      file = path.join(root, path.basename(file));
    if (fs.realpathSync(root) !== root || fs.realpathSync(file) !== file)
      return null;
    regular(file, STICKER_LIMITS.maxImageBytes);
    return file;
  } catch {
    return null;
  }
}
export class ScopedStickerLibrary {
  constructor({
    onebot,
    canUse = () => true,
    dataDir = DATA_DIR,
    botId = "primary",
    download = downloadStickerImage,
    now = Date.now,
  } = {}) {
    this.onebot = onebot;
    this.canUse = canUse;
    this.dataDir = path.resolve(dataDir);
    this.botId = botId;
    this.download = download;
    this.now = now;
    this.file = path.join(this.dataDir, "scoped-stickers.json");
    this.pending = 0;
    this.tail = Promise.resolve();
    this.controller = new AbortController();
    this.closed = false;
    this.jobs = new Map();
  }
  check(chatKey, authority) {
    const cfg = getConfig(),
      ctx = currentConversationContext();
    if (
      this.closed ||
      !key(chatKey) ||
      this.canUse(chatKey) !== true ||
      cfg.sticker?.enabled === false ||
      (ctx && ctx.conversationKey !== chatKey)
    )
      throw fail("STICKER_SCOPE_DENIED");
    if (authority !== undefined) assertPaidAuthority(chatKey, authority);
    else return capturePaidAuthority(chatKey);
  }
  load() {
    if (!fs.existsSync(this.file))
      return {
        version: 1,
        botId: this.botId,
        entries: [],
        collected: [],
      };
    try {
      const stat = fs.lstatSync(this.file);
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.size > 2 * 1024 * 1024
      )
        throw Error();
      const state = JSON.parse(fs.readFileSync(this.file, "utf8"));
      if (
        !plain(state) ||
        state.version !== 1 ||
        state.botId !== this.botId ||
        !Array.isArray(state.entries) ||
        state.entries.length > STICKER_LIMITS.maxImages ||
        !Array.isArray(state.collected) ||
        state.collected.length > STICKER_LIMITS.maxPerHour
      )
        throw Error();
      const ids = new Set();
      for (const e of state.entries) {
        if (
          !plain(e) ||
          !key(e.chatKey) ||
          e.botId !== this.botId ||
          !/^sc_[a-f0-9]{32}$/.test(e.id) ||
          ids.has(e.id) ||
          !/^[a-f0-9]{64}$/.test(e.sha256) ||
          e.id !==
            "sc_" +
              hash(this.botId + "\0" + e.chatKey + "\0" + e.sha256).slice(
                0,
                32,
              ) ||
          !Number.isSafeInteger(e.sizeBytes) ||
          e.sizeBytes < 12 ||
          e.sizeBytes > STICKER_LIMITS.maxImageBytes ||
          !label(e.localNote, 1000) ||
          !Array.isArray(e.tags) ||
          e.tags.length > 20 ||
          e.tags.some((t) => !label(t, 80)) ||
          !label(e.usage, 500) ||
          !label(e.sourceMessageId, 200) ||
          !label(e.sourceFile, 256) ||
          !Number.isSafeInteger(e.useCount) ||
          e.useCount < 0 ||
          !Number.isSafeInteger(e.createdAt) ||
          !Number.isSafeInteger(e.lastUsedAt) ||
          !label(e.url, 4096) ||
          !label(e.desc, 160) ||
          !label(e.lastContext, 200)
        )
          throw Error();
        ids.add(e.id);
      }
      if (
        state.collected.some(
          (e) =>
            !plain(e) ||
            !key(e.chatKey) ||
            !Number.isSafeInteger(e.at) ||
            e.at < 0,
        )
      )
        throw Error();
      return state;
    } catch {
      throw fail("STICKER_STORAGE_INVALID");
    }
  }
  save(state) {
    fs.mkdirSync(this.dataDir, {
      recursive: true,
    });
    const body = JSON.stringify(state);
    if (Buffer.byteLength(body) > 2 * 1024 * 1024)
      throw fail("STICKER_LIBRARY_FULL");
    const temp = this.file + "." + crypto.randomUUID() + ".tmp";
    try {
      fs.writeFileSync(temp, body, {
        flag: "wx",
        mode: 0o600,
      });
      fs.renameSync(temp, this.file);
    } finally {
      try {
        fs.unlinkSync(temp);
      } catch {}
    }
  }
  entries(chatKey) {
    this.check(chatKey);
    return this.load()
      .entries.filter((e) => e.chatKey === chatKey)
      .map((e) => structuredClone(e));
  }
  find(chatKey, ref) {
    return this.entries(chatKey).find((e) => e.id === ref) || null;
  }
  view(chatKey) {
    // Binding metadata is harmless even while stickers are disabled. Operations
    // recheck availability; constructing the Agent context must keep text working.
    if (!key(chatKey)) throw fail("STICKER_SCOPE_INVALID");
    const owner = this;
    return Object.freeze({
      get entries() {
        return owner.entries(chatKey);
      },
      sync: async () => ({
        entries: owner.entries(chatKey),
        fromCache: true,
        scoped: true,
      }),
      list: async (query = "", limit = 48) =>
        formatStickerList(owner.entries(chatKey), query, limit),
      find: async (ref) => owner.find(chatKey, ref),
      note: (id, patch) => owner.note(chatKey, id, patch),
      markUsed: (id, context) => owner.markUsed(chatKey, id, context),
      collect: (mid, options) => owner.collect(chatKey, mid, options),
      ensureSendable: async (entry) => owner.ensureSendable(chatKey, entry),
      image: async (ref) => owner.image(chatKey, ref),
    });
  }
  ensureSendable(chatKey, entry) {
    const current = this.find(chatKey, entry?.id);
    const file =
      current &&
      scopedStickerPath(current.url, chatKey, {
        dataDir: this.dataDir,
        botId: this.botId,
      });
    if (!file) throw fail("STICKER_IMAGE_UNAVAILABLE");
    return {
      ...current,
      url: pathToFileURL(file).href,
    };
  }
  async image(chatKey, ref) {
    const authority = this.check(chatKey),
      entry = this.find(chatKey, ref);
    const file =
      entry &&
      scopedStickerPath(entry.url, chatKey, {
        dataDir: this.dataDir,
        botId: this.botId,
      });
    if (!file) throw fail("STICKER_IMAGE_UNAVAILABLE");
    const data = fs.readFileSync(file);
    if (!detectImageType(data) || hash(data) !== entry.sha256)
      throw fail("STICKER_IMAGE_INVALID");
    const result = await stickerImageParts(data);
    this.check(chatKey, authority);
    return result;
  }
  note(chatKey, id, patch = {}) {
    this.check(chatKey);
    const state = this.load(),
      entry = state.entries.find((e) => e.chatKey === chatKey && e.id === id);
    if (!entry) return null;
    if (
      !plain(patch) ||
      Object.keys(patch).some((k) => !["note", "tags", "usage"].includes(k))
    )
      throw fail("STICKER_NOTE_INVALID");
    if (patch.note !== undefined) {
      if (!label(patch.note, 1000)) throw fail("STICKER_NOTE_INVALID");
      entry.localNote = patch.note;
    }
    if (patch.usage !== undefined) {
      if (!label(patch.usage, 500)) throw fail("STICKER_NOTE_INVALID");
      entry.usage = patch.usage;
    }
    if (patch.tags !== undefined) {
      if (
        !Array.isArray(patch.tags) ||
        patch.tags.length > 20 ||
        patch.tags.some((t) => !label(t, 80))
      )
        throw fail("STICKER_NOTE_INVALID");
      entry.tags = [...patch.tags];
    }
    this.save(state);
    return structuredClone(entry);
  }
  markUsed(chatKey, id, context = "") {
    this.check(chatKey);
    const state = this.load(),
      entry = state.entries.find((e) => e.chatKey === chatKey && e.id === id);
    if (!entry) return null;
    entry.useCount++;
    entry.lastUsedAt = this.now();
    entry.lastContext = String(context).slice(0, 200);
    this.save(state);
    return structuredClone(entry);
  }
  enqueue(job) {
    if (this.closed || this.pending >= STICKER_LIMITS.maxPending)
      return Promise.reject(fail("STICKER_BUSY"));
    this.pending++;
    const result = this.tail.then(job);
    this.tail = result
      .catch(() => {})
      .finally(() => {
        this.pending--;
      });
    return result;
  }
  collect(
    chatKey,
    messageId,
    { url = "", file = "", note = "" } = {},
    automatic = false,
  ) {
    if (
      !["string", "number"].includes(typeof messageId) ||
      !String(messageId) ||
      !label(String(messageId), 200) ||
      (typeof messageId === "number" && !Number.isSafeInteger(messageId)) ||
      !label(url, 8192) ||
      !label(file, 256) ||
      !label(note, 1000)
    )
      return Promise.reject(fail("STICKER_SOURCE_INVALID"));
    const identity = chatKey + "\0" + String(messageId);
    if (this.jobs.has(identity)) return this.jobs.get(identity);
    let authority;
    try {
      authority = this.check(chatKey);
      if (getConfig().sticker?.collectEnabled === false)
        throw fail("STICKER_COLLECTION_DISABLED");
    } catch (error) {
      return Promise.reject(error);
    }
    const result = this.enqueue(async () => {
      const signal = AbortSignal.any([
          this.controller.signal,
          AbortSignal.timeout(8000),
        ]),
        checkCurrent = () => {
          this.check(chatKey, authority);
          if (
            getConfig().sticker?.collectEnabled === false ||
            (automatic && getConfig().sticker?.autoCollectEnabled === false)
          )
            throw fail("STICKER_COLLECTION_DISABLED");
          if (signal.aborted) throw fail("STICKER_DOWNLOAD_CANCELLED");
        };
      checkCurrent();
      const before = this.load(),
        existing = before.entries.find(
          (e) =>
            e.chatKey === chatKey && e.sourceMessageId === String(messageId),
        );
      if (existing) return structuredClone(existing);
      this.assertCapacity(before, chatKey, 0);
      before.collected = before.collected.filter(
        (e) => this.now() - e.at < 3600000,
      );
      before.collected.push({
        chatKey,
        at: this.now(),
      });
      this.save(before);
      // Failed attempts also consume the persistent hourly allowance.
      let buffer = null;
      // A raw filesystem path from get_image is not a read capability. Fresh public
      // URLs (with shared DNS policy) are used instead; expired URL failures skip.
      if (url)
        try {
          buffer = await withSignal(
            this.download(url, {
              maxBytes: STICKER_LIMITS.maxImageBytes,
              signal,
            }),
            signal,
          );
        } catch {}
      checkCurrent();
      if (!buffer && /^[A-Za-z0-9_.=-]{1,256}$/.test(file)) {
        try {
          const ret = await withSignal(
            this.onebot.call("get_image", {
              file,
            }),
            signal,
          );
          checkCurrent();
          if (ret?.url && typeof ret.url === "string")
            buffer = await withSignal(
              this.download(ret.url, {
                maxBytes: STICKER_LIMITS.maxImageBytes,
                signal,
              }),
              signal,
            );
        } catch {}
      }
      checkCurrent();
      const type = Buffer.isBuffer(buffer) && detectImageType(buffer);
      if (!type || buffer.length > STICKER_LIMITS.maxImageBytes)
        throw fail("STICKER_IMAGE_UNAVAILABLE");
      const digest = hash(buffer),
        state = this.load(),
        duplicate = state.entries.find(
          (e) => e.chatKey === chatKey && e.sha256 === digest,
        );
      if (duplicate) return structuredClone(duplicate);
      this.assertCapacity(state, chatKey, buffer.length, false);
      const directory = scopedStickerDirectory(chatKey, {
        dataDir: this.dataDir,
        botId: this.botId,
      });
      this.ensureDirectory(directory);
      const target = path.join(directory, digest + type.ext);
      if (fs.existsSync(target)) {
        regular(target, STICKER_LIMITS.maxImageBytes);
        if (
          fs.realpathSync(target) !== target ||
          hash(fs.readFileSync(target)) !== digest
        )
          throw fail("STICKER_IMAGE_INVALID");
      } else
        fs.writeFileSync(target, buffer, {
          flag: "wx",
          mode: 0o600,
        });
      const entry = {
        id:
          "sc_" +
          hash(this.botId + "\0" + chatKey + "\0" + digest).slice(0, 32),
        botId: this.botId,
        chatKey,
        sha256: digest,
        sizeBytes: buffer.length,
        url: pathToFileURL(target).href,
        source: "scoped",
        sourceMessageId: String(messageId),
        sourceFile: file,
        desc: note.slice(0, 160),
        localNote: note,
        tags: [],
        usage: "",
        useCount: 0,
        lastUsedAt: 0,
        lastContext: "",
        createdAt: this.now(),
      };
      state.entries.push(entry);
      this.save(state);
      return structuredClone(entry);
    });
    this.jobs.set(identity, result);
    result.finally(() => this.jobs.delete(identity)).catch(() => {});
    return result;
  }
  assertCapacity(state, chatKey, extra, checkRate = true) {
    const scoped = state.entries.filter((e) => e.chatKey === chatKey),
      recent = state.collected.filter((e) => this.now() - e.at < 3600000),
      configured = Number(getConfig().sticker?.maxCollectPerHour),
      limit =
        Number.isSafeInteger(configured) && configured >= 1
          ? Math.min(10, configured)
          : 10;
    if (
      scoped.length >= STICKER_LIMITS.maxScopeImages ||
      state.entries.length >= STICKER_LIMITS.maxImages ||
      scoped.reduce((a, e) => a + e.sizeBytes, 0) + extra >
        STICKER_LIMITS.maxScopeBytes
    )
      throw fail("STICKER_LIBRARY_FULL");
    if (
      checkRate &&
      (recent.length >= STICKER_LIMITS.maxPerHour ||
        recent.filter((e) => e.chatKey === chatKey).length >= limit)
    )
      throw fail("STICKER_RATE_LIMIT");
    let count = 0,
      bytes = 0,
      nodes = 0;
    const walk = (directory, depth = 0) => {
      if (!fs.existsSync(directory)) return;
      if (depth > 4 || fs.lstatSync(directory).isSymbolicLink())
        throw fail("STICKER_STORAGE_INVALID");
      for (const name of fs.readdirSync(directory)) {
        if (++nodes > 1000) throw fail("STICKER_LIBRARY_FULL");
        const full = path.join(directory, name),
          st = fs.lstatSync(full);
        if (st.isSymbolicLink()) throw fail("STICKER_STORAGE_INVALID");
        if (st.isDirectory()) walk(full, depth + 1);
        else if (st.isFile()) {
          count++;
          bytes += st.size;
          if (
            count >= STICKER_LIMITS.maxImages ||
            bytes + extra > STICKER_LIMITS.maxBytes
          )
            throw fail("STICKER_LIBRARY_FULL");
        }
      }
    };
    walk(path.join(this.dataDir, "sticker-images"));
  }
  ensureDirectory(directory) {
    const base = path.resolve(this.dataDir);
    fs.mkdirSync(base, {
      recursive: true,
    });
    if (fs.realpathSync(base) !== base) throw fail("STICKER_STORAGE_INVALID");
    let current = base;
    for (const part of path.relative(base, directory).split(path.sep)) {
      current = path.join(current, part);
      if (!fs.existsSync(current)) fs.mkdirSync(current);
      if (
        !fs.lstatSync(current).isDirectory() ||
        fs.lstatSync(current).isSymbolicLink() ||
        fs.realpathSync(current) !== current
      )
        throw fail("STICKER_STORAGE_INVALID");
    }
  }
  autoCollect(chatKey, { entry, segments } = {}) {
    if (
      getConfig().sticker?.autoCollectEnabled === false ||
      entry?.self !== false ||
      entry?.mid === null ||
      entry?.mid === undefined ||
      !Array.isArray(segments) ||
      segments.length > 100
    )
      return Promise.resolve({
        collected: 0,
        reason: "not_sticker",
      });
    const image = segments.find(
      (s) =>
        s?.type === "image" &&
        [1, "1"].includes(s.data?.sub_type) &&
        Array.isArray(entry.media) &&
        entry.media.some(
          (m) =>
            m.kind === "image" &&
            ((m.file && m.file === s.data.file) ||
              (m.url && m.url === s.data.url)),
        ),
    );
    if (!image)
      return Promise.resolve({
        collected: 0,
        reason: "not_sticker",
      });
    return this.collect(
      chatKey,
      entry.mid,
      {
        url: String(image.data.url || ""),
        file: String(image.data.file || ""),
      },
      true,
    ).then((saved) => ({
      collected: 1,
      id: saved.id,
    }));
  }
  whenIdle() {
    return this.tail;
  }
  async close() {
    this.closed = true;
    this.controller.abort();
    await this.whenIdle();
  }
}
