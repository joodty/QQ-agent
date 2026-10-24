import crypto from 'node:crypto';

const fail = (statusCode, message) => Object.assign(new Error(message), { statusCode });
export const HOSTED_LOGIN_STATES = Object.freeze(['pending', 'starting', 'waiting_scan', 'connecting', 'ready', 'expired', 'stopped', 'failed', 'mismatch', 'cleanup_pending']);
const messages = { CAPACITY: '私人QQ托管名额已满', RESOURCE: '服务器暂时没有足够资源', BUSY: '接入正在处理中，请稍后刷新', CONFLICT: '接入身份或版本发生变化，请刷新', MISSING: '接入申请不存在', INVALID: '接入申请参数无效', DENIED: '私人QQ接入服务未授权' };

/** This is the only shape allowed across the browser boundary. Never spread a
 * broker response here: connection credentials belong to the server alone. */
export function publicHostedLoginState(value) {
  if (!value || !HOSTED_LOGIN_STATES.includes(value.state)) throw fail(502, '私人QQ接入服务返回了无效状态');
  const result = { state: value.state };
  if (value.state === 'waiting_scan' && typeof value.qrImage === 'string'
      && /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(value.qrImage) && value.qrImage.length < 2 * 1024 * 1024
      && Number.isSafeInteger(value.expiresAt) && value.expiresAt > 0) {
    result.qrImage = value.qrImage; result.expiresAt = value.expiresAt;
  }
  return result;
}

export function createHostedLoginClient({ baseUrl, secret, fetchImpl = fetch, timeoutMs = 60000 } = {}) {
  const origin = new URL(baseUrl);
  if (origin.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(origin.hostname) || origin.username || origin.password
      || origin.pathname !== '/' || origin.search || origin.hash || !/^[A-Za-z0-9_-]{32,128}$/.test(secret || '')) throw new Error('Private hosted login service requires a loopback URL and a random secret');
  async function operation(action, input) {
    let response;
    try {
      response = await fetchImpl(new URL('/v1/' + action, origin), { method: 'POST', headers: { 'content-type': 'application/json', 'x-hosted-service-secret': secret },
        body: JSON.stringify(input), redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
    } catch { throw fail(503, '私人QQ接入服务暂不可用，请稍后刷新'); }
    const length = Number(response.headers.get('content-length') || 0);
    if (length > 3 * 1024 * 1024) throw fail(502, '私人QQ接入服务返回过大');
    let text = '', bytes = 0;
    for await (const chunk of response.body || []) { bytes += chunk.length; if (bytes > 3 * 1024 * 1024) throw fail(502, '私人QQ接入服务返回过大'); text += Buffer.from(chunk).toString('utf8'); }
    let value; try { value = JSON.parse(text); } catch { throw fail(502, '私人QQ接入服务返回无效'); }
    if (!response.ok || value.ok !== true) throw fail([400, 404, 409, 429, 503].includes(response.status) ? response.status : 503, messages[value.code] || '私人QQ接入未完成，请稍后刷新');
    const login = publicHostedLoginState(value.login);
    let connection = null;
    if (value.connection) {
      const row = value.connection;
      if (row.botId !== 'hosted-' + input.requestId || row.expectedQQ !== input.expectedQQ || !Number.isInteger(row.port) || row.port < 1024 || row.port > 65535
          || !/^[A-Za-z0-9_-]{32,128}$/.test(row.machineToken || '')) throw fail(502, '私人QQ实例身份不匹配');
      connection = { botId: row.botId, expectedQQ: row.expectedQQ, port: row.port, machineToken: row.machineToken };
    }
    return { login, connection };
  }
  return Object.fromEntries(['start', 'status', 'refresh', 'reconnect', 'cancel'].map(action => [action, input => operation(action, input)]));
}

export const createHostedServiceSecret = () => crypto.randomBytes(32).toString('base64url');
