import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { detectImageType } from './image-type.js';

export const IMAGE_MODEL = 'gpt-image-2.6-flare';
const endpoint = 'https://api.openai.com/v1/images/generations';
const maxBytes = 8 * 1024 * 1024;
// Use an accounting conversion, rather than claiming the invoice FX rate.
const cnyPerUsd = 7.5;

export function estimateImageCost(format, usage) {
  // The Images endpoint can omit separate SVG author usage.
  if (format === 'svg') return null;
  const { text_tokens: text, image_tokens: image } = usage?.input_tokens_details ?? {};
  const output = usage?.output_tokens_details?.image_tokens;
  if (![text, image, output].every(x => Number.isSafeInteger(x) && x >= 0) ||
      text + image !== usage.input_tokens || output !== usage.output_tokens || !output) return null;
  const amount = (text * 5 + image * 8 + output * 30) * cnyPerUsd;
  return Math.ceil(amount) / 1_000_000;
}

export function normalizeImageRequest(args) {
  const prompt = typeof args?.prompt === 'string' ? args.prompt.trim() : '';
  const format = args?.format ?? 'png';
  if (!prompt || prompt.length > 1000) throw Error('请提供 1–1000 字的绘图描述');
  if (!['png', 'gif', 'svg'].includes(format)) throw Error('图片格式请选择 PNG、GIF 或 SVG');
  const size = args?.size ?? (format === 'gif' ? '512x512' : '1024x1024');
  const sizes = format === 'gif' ? ['256x256', '384x384', '512x512'] : ['1024x1024', '1536x1024', '1024x1536'];
  if (!sizes.includes(size)) throw Error('这个格式不支持所选尺寸');
  const frames = args?.frames ?? 9;
  const frameMs = args?.frameMs ?? 200;
  if (format === 'gif' && (!Number.isInteger(frames) || frames < 2 || frames > 16 || !Number.isInteger(frameMs) || frameMs < 20 || frameMs > 2000)) {
    throw Error('GIF 支持 2–16 帧，每帧 20–2000 毫秒');
  }
  return { prompt, format, size, frames, frameMs };
}

export function createOpenAiImageProvider({ apiKey, fetchImpl = fetch, sanitize = sanitizeSvg }) {
  return async ({ prompt, format, size, frames, frameMs, actor, signal }) => {
    const response = await fetchImpl(endpoint, {
      method: 'POST', redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(150_000)].filter(Boolean)),
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: IMAGE_MODEL, prompt, n: 1, output_format: format, quality: 'low', complexity: 'low',
        size,
        ...(format === 'gif' ? { frame_count: frames, frame_duration_ms: frameMs } : {}),
        ...(format === 'svg' ? { svg: { model: 'gpt-5.4-mini' } } : {}),
        safety_identifier: createHash('sha256').update(actor).digest('hex'),
      }),
    });
    const result = await response.json();
    if (!response.ok) {
      const refusal = [400, 401, 403, 429].includes(response.status) && !!result?.error && !result.usage;
      const providerCode = result?.error?.code;
      throw Object.assign(Error(`图像服务拒绝了请求（HTTP ${response.status}）`), {
        refusal, usage: result?.usage, status: response.status,
        providerCode: typeof providerCode === 'string' && /^[a-z0-9_]{1,64}$/.test(providerCode) ? providerCode : null,
      });
    }
    try {
      const encoded = result?.data?.[0]?.b64_json;
      if (typeof encoded !== 'string' || encoded.length > Math.ceil(maxBytes / 3) * 4) throw Error('生成结果为空或超出图片大小限制');
      const bytes = Buffer.from(encoded, 'base64');
      if (format === 'svg') return { bytes: await sanitize(bytes), format, usage: result.usage };
      if (detectImageType(bytes)?.ext !== '.' + format) throw Error('图像服务返回的文件格式不符');
      return { bytes, format, usage: result.usage };
    } catch (error) {
      error.usage = result?.usage;
      throw error;
    }
  };
}

function sanitizeSvg(bytes) {
  return new Promise((resolve, reject) => {
    const script = fileURLToPath(new URL('./image-svg.py', import.meta.url));
    const child = spawn(process.env.QQ_AGENT_IMAGE_PYTHON || 'python3', [script], { stdio: ['pipe', 'pipe', 'ignore'], signal: AbortSignal.timeout(5000) });
    const chunks = [];
    child.stdout.on('data', chunk => chunks.push(chunk));
    child.on('error', reject);
    child.stdin.on('error', reject);
    child.on('close', code => code === 0 ? resolve(Buffer.concat(chunks)) : reject(Error('SVG 未通过安全校验')));
    child.stdin.end(bytes);
  });
}
