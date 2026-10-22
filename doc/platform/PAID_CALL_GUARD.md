# 生产模型费用保护

## 当前范围

`src/paid-call-guard.js` 将原有预算内核接到 `src/llm.js` 的真实 HTTP POST 前后。聊天仍使用上游同一套工具调度；没有另建纯文本引擎。每次模型重试、参数兼容重发、备选模型尝试、工具之后的模型轮次和记忆整理都独立申请预留。`Orchestrator` 为正常唤醒、主动唤醒和记忆整理建立服务器验证的完整群聊/私聊上下文。

普通账号试用和 BYOK 尚未开放。只有配置白名单中明确列出、同时拥有 `mode: 'platform', enabled: true` 出资策略的物理会话可付费。群聊预算不包含管理者、角色、档案或模型调用轮次；切换人设不会刷新额度。同号群聊与私聊分开记账。缺少上下文、凭据不匹配、未知端点或模型均在出网前拒绝。

开发时没有 `productionBudget` 字段保持上游行为。生产必须设置 `QQ_AGENT_REQUIRE_BUDGET=1`：缺失配置也拒绝付费。只要配置了该字段，`enabled` 非 `true` 就停止付费，而不是取消预算限制。一个进程已建立生产账本后再删除该字段也不会退回无保护模式。

## 配置契约

以下全是虚构会话与测试端点，不含生产配置。生产构建脚本应先调用导出的 `validateProductionBudgetConfig(完整配置)`。

```js
{
  allow: { groups: ['123'], private: ['456'] },
  productionBudget: {
    enabled: true,
    endpoint: 'https://example.invalid/v1',
    model: 'fixture-model',
    prices: {
      inputCnyPerMillion: 2,
      cacheHitCnyPerMillion: 0.04,
      outputCnyPerMillion: 8,
      reasoningIncluded: true
    },
    defaultDailyLimitCny: 1,
    overrides: { 'group:123': 1 },
    initialSpent: { '2026-10-22': { 'group:123': 0.25 } },
    outputCap: 1024,
    imageTokensPerImage: 1024,
    verifiedResponseModels: ['fixture-model'],
    funding: {
      'group:123': { mode: 'platform', enabled: true },
      'private:456': { mode: 'platform', enabled: true }
    }
  }
}
```

`overrides`、`initialSpent` 和 `funding` 必须提供对象，允许空对象。额度和报价接受有限非负数，不接受数字字符串、NaN 或缺失字段。`reasoningIncluded: true` 声明所选供应商的 completion 用量已包括思考 token，因此不重复累加 reasoning。该声明需要在部署前核实。返回的 `model` 必须与请求模型一致，或在经过核实的同价 `verifiedResponseModels` 中；否则保留未知费用。

报价必须由部署者核实后明确提供；没有从费用展示里的零值或模糊模型前缀猜测报价。配置的价格快照用于这次调用的预留与结算，即使请求期间配置变化也不以新价格重算旧请求。当前最小版本使用固定的已确认 CNY 单价，没有实现峰谷动态结算。以已核实的较高档价进行保守估算时，页面和交接必须明确这一点。

2026-10-22 核验依据：[DeepSeek 官方计价](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/) 中 Flash 输入未命中为每百万 token ¥1/¥2，缓存命中 ¥0.02/¥0.04，输出 ¥4/¥8（闲时/高峰）。采用 ¥2/¥0.04/¥8 是高峰价估算，不能称为每笔供应商实付金额。价格会变化，部署时仍须复核。

## 预留、记账和恢复

独立 SQLite 文件 `paid-calls.sqlite` 以同步 `BEGIN IMMEDIATE` 保护账本读改写；跨进程共享同一群的已花费用与预留。文件身份、版本、账本文本或初始化标记不符合预期时拒绝改写。

`initialSpent` 是切换前按北京时间日期汇总的人民币已花估算。种子记录与初始化 marker 在一个事务内提交，只执行一次；重启不重复增加。初始费用即使高于新额度也完整保留。投入运行后必须保留这份快照，不能通过改写 `initialSpent` 重置账本；快照 hash 不一致会阻止重新初始化。迁移者还需保守处理旧系统没有确认结算的在途费用，不能只导入成功聊天的花费。

默认每个物理会话北京时间每日 ¥1。80% 时停止主动参与、随机/普通群聊插话和后台记忆整理；只继续明确请求，并把输出上限降到 256 token，追加正文不超过 120 汉字、只回复一条的提示。同一物理会话新的直接请求至少间隔 60 秒，同一请求中的工具轮次可继续，但每轮仍单独受预算限制。100% 或余额不足以预留该次调用时拒绝新请求。输出 token 上限在 Skill 修改请求之后重新强制执行，参数重发也重新检查。

实际出网前再次核验授权、报价配置、额度和首次 dispatch 状态。收到原始响应时在 Skill 结果转换之前，按有效原始 token 用量与该次价格快照记账；实际用量估算超过原预留也完整保留。响应缺少有效 usage、返回模型未获同价确认、超时、取消、断流或坏 JSON 时，保留原预留作为未知费用。HTTP 失败不自动当免费。重启、租约到期和跨日均不自动释放未知费用；需核对供应商证据后处理。

## 图片与估算边界

原生 `image_url` 支持远程 URL 和 data/base64 图片。[DeepSeek 官方视觉说明](https://api-docs.deepseek.com/zh-cn/guides/vision/#token用量) 给出每张图片最多 1024 个输入 token、与文本同价。显式设置 `imageTokensPerImage: 1024` 后按每图这一上界预留；图片 URL/base64 不作为巨量文本计费。未知视频、音频、文件、服务端付费工具类型拒绝调用。

文本与函数工具定义按最终请求 JSON 的 UTF-8 字节数，加协议余量保守预估；输出按强制 token 上限预留。它不是供应商官方 tokenizer，也不能保证供应商账单绝不超过预留。当前账本的“实际费用”仍是实际 token 用量乘选定价格得到的平台人民币估算，并非供应商对账结果。

仍须由生产 HTTP 网关阻断未纳入保护的付费边路，例如直接模型探测、视觉批量探测、付费搜索和扩展安装入口。普通 Bing 网页搜索不调用付费模型搜索 API。本模块不能约束另一个进程或任意第三方插件自行发出的网络请求。没有完成这部分部署验证前不能宣称所有外部费用都已受控。

## 测试与部署状态

运行 Node 24：

```text
node --test test/conversation-budget-test.mjs test/paid-call-guard-test.mjs
```

新增 14 项测试包括严格报价/权限校验、图片上界、输出限制、一次性旧余额导入、80% 节流、同群跨人设共享、群私聊隔离、跨日与重启未知费用、出网前撤权/降额、损坏拒写，以及真实本地 HTTP 的工具后续轮次、模型重试、参数重发、记忆请求、未知 fallback、零额度和取消。测试还通过真实 `Orchestrator.consolidateMemoryForChat` 核验记忆调用入账及节流阻断，并验证管理API禁止越权字段、版本冲突、默认额度继承和页面保存操作。预算内核另有 21 项并发、幂等与多进程测试。

管理入口为 `production-budgets.html`，人设档案页提供链接。GET `/api/production-budgets` 仅返回已授权会话的费用状态、额度与不透明配置版本，不暴露密钥、端点、原始报价或初始余额。PUT 同一路径只接受 `version`、`defaultDailyLimitCny` 与精确已授权聊天的 `overrides`，其中 `null` 表示恢复默认额度，0 表示暂停新付费调用。过期版本返回409，其他生产策略字段均不能通过此接口修改。HTTP鉴权、管理员身份和同源保护由管理网关负责，不能直接公开原生服务端口。

这些测试全部使用虚构身份、临时账本与本机 HTTP 模拟服务，不接真实 QQ 或收费供应商。部署、真实返回模型别名及线上行为仍由部署验收另行记录，本文不把本地通过当作已上线。
