// Only the explicit, scoped preview POST synthesizes; no management route sends QQ.
import { speechErrorMessage } from './speech-runtime.js';
function publicProjection(value) {
  if (Array.isArray(value)) return value.map(publicProjection);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, key === 'reason' && typeof item === 'string' && item.startsWith('SPEECH_') ? speechErrorMessage(item) : publicProjection(item)]));
}
export function createSpeechRoutes({ service, usage, auth, readBody }) {
  const access = async (principal, chatKey, write = false) => {
    if (!chatKey) throw Object.assign(Error('请先选择群聊或私聊'), { statusCode: 400 });
    await auth.ensureAccess(principal, chatKey, { botId: 'primary', write });
  };
  const admin = principal => { if (principal.role !== 'admin') throw Object.assign(Error('只有管理员能设置平台语音资助'), { statusCode: 403 }); };
  const route = (method, name, work) => ({ method, pattern: '/api/platform/speech/' + name, handler: async ctx => {
    if (!service) return ctx.json(ctx.res, 503, { error: '语音设置尚未启用' });
    try { return ctx.json(ctx.res, 200, publicProjection(await work(auth.verifyPrincipal(ctx.principal), ctx))); }
    catch (error) {
      if (typeof error.code === 'string' && error.code.startsWith('SPEECH_')) throw Object.assign(Error(speechErrorMessage(error.code)), { statusCode: error.statusCode || 400 });
      throw error;
    }
  }});
  return [
    route('GET', 'usage', (principal, ctx) => {
      if (!usage) throw Object.assign(Error('语音用量统计尚未启用'), { statusCode: 503 });
      const fields = {};
      for (const [name, value] of ctx.url.searchParams) {
        if (!['chatKey','days','from','to'].includes(name) || Object.hasOwn(fields, name)) throw Object.assign(Error('语音用量查询参数无效'), { statusCode: 400 });
        fields[name] = name === 'days' && /^(1|7|30|90)$/.test(value) ? Number(value) : value;
      }
      return usage.usage(principal, fields);
    }),
    route('GET', 'overview', principal => service.overview(principal)),
    route('GET', 'settings', async (principal, ctx) => { const key = ctx.url.searchParams.get('chatKey'); await access(principal, key); return service.settings(principal, key); }),
    route('POST', 'preview', async (principal, ctx) => {
      const controller=new AbortController(),cancel=()=>controller.abort(),disconnected=()=>{if(!ctx.res.writableEnded)cancel();};
      ctx.req.once('aborted',cancel);ctx.res.once('close',disconnected);
      try {
        const input=await readBody(ctx.req);await access(principal,input?.chatKey,true);
        if(ctx.req.aborted||ctx.res.destroyed)cancel();
        return await service.preview(principal,input,{signal:controller.signal});
      } finally {ctx.req.off('aborted',cancel);ctx.res.off('close',disconnected);}
    }),
    route('PUT', 'settings', async (principal, ctx) => { const input = await readBody(ctx.req); await access(principal, input.chatKey, true); return service.updateSettings(principal, input); }),
    route('GET', 'platform', principal => { admin(principal); return service.platformOverview(principal); }),
    route('PUT', 'platform', async (principal, ctx) => { admin(principal); return service.updatePlatform(principal, await readBody(ctx.req)); }),
    route('PUT', 'subsidy', async (principal, ctx) => { admin(principal); const input = await readBody(ctx.req); await access(principal, input.chatKey, true); return service.updateSubsidy(principal, input); })
  ];
}
