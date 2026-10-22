# 群聊与私聊通用预算核心

## 当前实现状态

`src/conversation-budget.js` 已实现独立预算内核，`test/conversation-budget-test.mjs` 使用隔离存储、SQLite 夹具与多进程验证。现在由可选的 `productionBudget` 生产调用守卫接入模型 HTTP 请求前后、主链上下文及额度页面，详见 [生产费用保护](PAID_CALL_GUARD.md)。**仅导入预算模块不会启用限额；生产还须显式启用保护、提供有效报价与出资授权，并完成部署验收。** 新独立工作台为平台出资、绑定本人私聊体验与用户 Key 注入同一可信解析服务，体验同时检查个人与平台总额；迁移与上线事实见 [工作记录](WORK_LOG.md)。

该能力只认识 `botId + group:群号/private:QQ号`。平台管理员、普通用户、群管理者、自带 Key 或平台 Key 不改变预算算法。同一个群的多个管理者共用一份账本；同号的群聊与私聊属于不同对象。权限验证必须由调用层完成，不能把网页自报的会话或付款人当成可信授权。

## 已有规则

- 北京时间自然日默认每个会话 ¥1，可按群或私聊覆盖；0 元阻止新调用。
- 已结算费用加未解决预留达到 80% 时返回 `degrade`，达到 100% 时拒绝新的预留。额度尚有余额但不足以覆盖当前预估上界时也拒绝。核心返回决策，缩短输出、降低主动参与等行为由统一聊天链路执行。
- 金额在存储中使用整数微元。配置支持六位小数；正的更小估算向上预留至少一微元。实际费用超过预留或限额时仍按完整金额入账，不截断成预算上限。
- 报价必须明确 `currency: 'CNY', complete: true`；不接受字符串金额、NaN、负数或未知币种。**这不是供应商限制**：统一报价层可以把已核实的外币模型价格换算为平台人民币估算，再申请准入。
- 每次真实供应商尝试须有独立 `operationId`；重试、工具引发的后续模型调用、记忆整理等不能借用已经消费的操作 ID。
- `operationId` 在全部状态中保持唯一。重复预留不会新建账目；同 ID 配置不同会话或金额报 409，已发送、结算或释放的操作不能再次消费。
- 调用前先 `reserve`，必须传入明确的数值 `estimatedMaxCost`，不能用固定默认值冒充完整报价上界。真实网络请求前再 `dispatch`，事务内复查最新额度和费用；若预留后额度降到零、降至无法覆盖已有支出及预留，或其他请求实际超额，未发送的调用暂停。恰好占满合法额度的原预留仍可发送。只有首次 `reserved → dispatched` 得到 `mayDispatch: true`，调用层只能在此时发送一次。
- 超时、断流、缺少可用 usage 等状态使用 `markUnknown`，保守保留原预留。进程重启、租约过期或跨日都不会自动释放未知支出；需要后续核对。
- `settle` 记录实际人民币估算并释放对应预留。同金额重复结算幂等，不同金额重复结算报 409。已确认没有计费才能对已发送/未知请求使用 `release(..., {confirmedNotCharged: true})`。
- 已结算费用归属请求创建日；午夜仍未解决的预留继续占用新日准入，解决后才退出占额。自然日恢复不会让旧的在途请求失去保护。
- 配置更新使用 `configVersion`；事务失败整体回滚，损坏或未来格式拒绝改写。账本审计上限为十万次操作，达到后拒绝新准入，不能偷偷丢掉旧操作 ID 以继续消费。归档策略尚未实现。

## 注入接口

```js
const budget = createConversationBudget({
  storage,               // 同步 transaction / readText / writeText
  file: 'conversation-budget',
  botId: 'primary',
  now: Date.now,
});

const hold = budget.reserve('group:123456', {
  operationId: 'fixture-provider-attempt-1',
  estimatedMaxCost: 0.05,
  quote: { currency: 'CNY', complete: true },
});
if (!hold.allowed) return;
if (!budget.dispatch(hold.id).mayDispatch) return;
// 在统一模型出口发送一次请求；例外与超时路径必须结算、标记未知或确认释放。
budget.settle(hold.id, { amount: 0.012, currency: 'CNY' });
```

以上为接口示例，不是已接通模型的运行程序。`estimatedMaxCost` 的可靠性属于统一报价层：图片、思考、缓存、备用模型及工具的额外计费都需要核实；核心不提供固定金额兜底。

存储必须同步、持久化、支持读改写整体回滚，并以 `writeText(file, newText, expectedOldText)` 实现 CAS。多进程使用时，`transaction` 必须在读取前取得跨进程写锁；普通 JS 内存锁或先读后写 JSON 无法满足要求。SQLite 的 `BEGIN IMMEDIATE` 可用于这样的适配，测试中的 SQLite 夹具并不是正式平台存储实现。

公开接口还包括 `config/status/overview/update/active/records`。`enabled:false` 表示明确关闭预算限制，**不是关闭机器人聊天**；当前核心仍要求完整报价并记录调用。`active` 和 `records` 可返回多个对象的资料，接到普通用户 HTTP 页面前必须按经过验证的资源权限筛选，不可直接透传全量。

## 后续接入验收

1. 所有角色与费用来源都使用相同上下文和模型出口，不能给 BYOK 另写纯文本路径。
2. 每一个真实付费尝试独立预留，报价与实际模型/端点一致，`dispatch` 位于网络请求之前。
3. 对确定拒绝、超时、断流、取消、重试和缺少 usage 分别结算；不以 `finally` 无条件退款。
4. 80% 节流同时限制输出和主动行为；100% 后无新的付费调用，已经发出的请求仍可能产生费用。
5. 持久化适配、成员授权、报价转换、日报展示与真实模型兼容经过隔离联调后，才能称为已启用限额。

平台金额是估算和预留，不是供应商账单硬上限；报价误差、未报告用量和独立工具收费不能靠本模块消除。旧项目的预算与会话账本尚未导入，新旧金额也不能简单相加。

## 测试

使用 Node 24：`node --test test/conversation-budget-test.mjs`。

当前 21 项测试覆盖群/私聊/实例隔离、阈值、共享预留、操作与发送幂等、出网前额度变更复核、真实超额完整记账、未知费用、重启/租约、午夜、零额度、CAS、报价与金额校验、微元精度、损坏拒绝、SQLite 持久化与外层回滚，以及四个独立进程竞争同一额度。全部使用虚构会话、本地临时存储；没有真实 QQ 或付费模型请求。
