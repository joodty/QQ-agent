// Small, bounded image downloads with the shared DNS/IP policy. No private-host exception.
import http from "node:http";
import https from "node:https";
import { validateFetchUrl } from "./safe-fetch.js";
const error = (code) =>
  Object.assign(Error(code), {
    code,
  });
export function createStickerDownloader({ resolve = validateFetchUrl } = {}) {
  return async function download(
    raw,
    { maxBytes = 3 * 1024 * 1024, timeoutMs = 8000, signal } = {},
  ) {
    if (
      typeof raw !== "string" ||
      raw.length > 8192 ||
      !Number.isSafeInteger(maxBytes) ||
      maxBytes < 1 ||
      maxBytes > 3 * 1024 * 1024
    )
      throw error("STICKER_IMAGE_INVALID");
    const abort = new AbortController(),
      relay = () => abort.abort();
    signal?.addEventListener("abort", relay, {
      once: true,
    });
    const timer = setTimeout(relay, Math.max(1, Math.min(8000, timeoutMs)));
    let rejectAbort;
    const cancelled = new Promise((_, reject) => {
      rejectAbort = () => reject(error("STICKER_DOWNLOAD_CANCELLED"));
    });
    abort.signal.addEventListener("abort", rejectAbort, {
      once: true,
    });
    try {
      if (signal?.aborted) relay();
      let current = raw;
      for (let hop = 0; hop < 3; hop++) {
        if (abort.signal.aborted) throw error("STICKER_DOWNLOAD_CANCELLED");
        const { url, ip } = await Promise.race([
          resolve(current, {
            allowPrivate: false,
          }),
          cancelled,
        ]);
        if (abort.signal.aborted) throw error("STICKER_DOWNLOAD_CANCELLED");
        const result = await new Promise((resolveResponse, reject) => {
          const transport = url.protocol === "https:" ? https : http;
          const request = transport.request(
            {
              hostname: ip,
              port: url.port || (url.protocol === "https:" ? 443 : 80),
              path: url.pathname + url.search,
              method: "GET",
              headers: {
                host: url.host,
                accept: "image/*",
              },
              servername: url.protocol === "https:" ? url.hostname : undefined,
              rejectUnauthorized: true,
              signal: abort.signal,
            },
            (response) => {
              if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
                response.destroy();
                resolveResponse({
                  redirect: response.headers.location,
                });
                return;
              }
              if (
                response.statusCode !== 200 ||
                Number(response.headers["content-length"]) > maxBytes
              ) {
                response.destroy();
                reject(error("STICKER_DOWNLOAD_REJECTED"));
                return;
              }
              const chunks = [];
              let bytes = 0;
              response.on("data", (chunk) => {
                bytes += chunk.length;
                if (bytes > maxBytes) {
                  response.destroy();
                  reject(error("STICKER_IMAGE_TOO_LARGE"));
                } else chunks.push(chunk);
              });
              response.on("end", () =>
                resolveResponse({
                  buffer: Buffer.concat(chunks),
                }),
              );
              response.on("error", () =>
                reject(error("STICKER_DOWNLOAD_FAILED")),
              );
            },
          );
          request.on("error", () =>
            reject(
              error(
                abort.signal.aborted
                  ? "STICKER_DOWNLOAD_CANCELLED"
                  : "STICKER_DOWNLOAD_FAILED",
              ),
            ),
          );
          request.end();
        });
        if (result.buffer) return result.buffer;
        if (typeof result.redirect !== "string" || !result.redirect)
          throw error("STICKER_DOWNLOAD_REJECTED");
        current = new URL(result.redirect, url).href;
        // Every redirect resolves and validates again.
      }
      throw error("STICKER_REDIRECT_LIMIT");
    } catch (caught) {
      throw error(
        /^STICKER_/.test(caught?.code || "")
          ? caught.code
          : "STICKER_DOWNLOAD_REJECTED",
      );
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", relay);
      abort.signal.removeEventListener("abort", rejectAbort);
    }
  };
}
export const downloadStickerImage = createStickerDownloader();
