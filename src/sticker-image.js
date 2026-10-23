// Reuse the native vision/GIF representation for bounded local sticker bytes.
import { getConfig } from "./config.js";
import { detectImageType } from "./image-type.js";
import { compressImage } from "./image-compress.js";
import {
  isGifBuffer,
  gifToVideoDataUrl,
  resolveGifRoute,
} from "./gif-to-video.js";
export async function stickerImageParts(buffer) {
  const type = Buffer.isBuffer(buffer) && detectImageType(buffer);
  if (!type || buffer.length > 3 * 1024 * 1024)
    throw Object.assign(Error("STICKER_IMAGE_INVALID"), {
      code: "STICKER_IMAGE_INVALID",
    });
  const cfg = getConfig();
  if (
    isGifBuffer(buffer) &&
    resolveGifRoute({
      vision: cfg.api?.vision !== false,
      video: cfg.api?.video === true,
    }) === "video"
  ) {
    const converted = await gifToVideoDataUrl(buffer);
    if (converted)
      return {
        dataUrl: "",
        gifVideo: {
          dataUrl: converted.dataUrl,
          frames: converted.frames,
          width: converted.width,
          height: converted.height,
        },
      };
  }
  const compressed = await compressImage(buffer),
    mime = compressed.compressed ? compressed.mime : type.mime;
  return {
    dataUrl: "data:" + mime + ";base64," + compressed.buffer.toString("base64"),
    isGif: mime === "image/gif",
    gifBuffer: isGifBuffer(buffer) ? buffer : null,
  };
}
