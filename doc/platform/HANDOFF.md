# 群管理扩展：从这里接手

更新日期：2026-10-22。开发仓库：[joodty/QQ-agent](https://github.com/joodty/QQ-agent/tree/codex/group-management)，分支 `codex/group-management`；上游 [K0nd1us/QQ-agent](https://github.com/K0nd1us/QQ-agent)。首次基线为 `fdfd325e148d91845a0aeea3dfdff4cf92fc61a1`，版本 0.4.0。保留上游 MIT 许可和 Kondius 署名。

## 产品目标与保留成果

公共 QQ 机器人由平台维护。每个群只有一份资源记录、当前人设、费用来源与共享额度，可以有多个经验证的管理者；同一个用户也可以管理多个群。本人私聊遵循相同能力体系。平台角色、群权限、模型能力、付款来源分别判断。

旧项目不是废弃数据：账号、授权、Key 加密、预算、版本化人设、会话档案、SQLite 与测试用例都是迁移依据。新聊天底座不继续复制 DSH 及平台完整 Agent/BYOK 纯文本两套链。详细清单见 [迁移说明](MIGRATION.md)，约定见 [开发经验](DEVELOPMENT_LESSONS.md) 与 [能力契约](CAPABILITY_CONTRACT.md)。

自助托管用户私人 QQ 和部署多个客户端暂不作为新产品主线。这个调整不改变第三方 QQ 接入的适用规则，也不能把一个小型节点承诺为无限量机器人托管平台。

## 当前状态

| 部分 | 状态 |
| --- | --- |
| 上游 QQ Agent | 完整源码已拉取，保留原聊天与工具实现；基线测试见工作记录 |
| 统一执行上下文 | 独立模块与隔离测试；仅携带服务器解析的资源与稳定引用，不授予权限，不携带凭据 |
| 通用预算内核 | 已新增生产付费调用守卫和专用额度页面；仅显式平台出资范围，生产状态见工作记录 |
| 多账号、QQ 群管理身份验证 | 待适配；原上游控制台不能据此视为已具备公网多人后台 |
| 按群/私聊选择用户 Key | 待统一凭据解析；不能再为用户 Key 写功能不同的聊天分支 |
| 预算对真实调用生效 | 已接模型 HTTP 前后及主链上下文；生产启用强制准入与独立持久账本，重试/后续轮次/记忆使用隔离供应商验证；不宣称供应商账单硬封顶 |
| 人设版本与旧历史迁移 | 生产已导入四个人设、八个档案、六个当前选择；档案可查看和切换，正文保留导入版本，尚无在线编辑接口。覆盖范围见 [生产交接](PRODUCTION_HANDOFF.md) |
| 生产切换 | 已保留原账号并静默旧聊天，新服务复用原 QQ/OneBot；HTTPS 新控制台仅管理员，普通账号保留旧入口的账号能力与资料只读 |

## 关键代码

| 路径 | 职责 |
| --- | --- |
| `src/orchestrator.js` | 原有 Agent 调度与工具循环，扩展保持一套引擎 |
| `src/llm.js` | 原有模型请求、重试与用量入口；生产守卫在每次真实 HTTP 尝试前后预留和结算 |
| `src/config.js` | 上游配置与群/私聊人设覆盖；当前不是多人权限和凭据隔离层 |
| `src/conversation-context.js` | 不含密钥的执行范围、引用版本与并发隔离 |
| `src/conversation-budget.js` | 群/私聊通用预算状态、在途金额与结算协议 |
| `src/paid-call-guard.js` | 真实模型请求前后预算、平台出资授权与持久账本；见生产费用文档 |
| `src/admin-gateway.js`、`scripts/admin-gateway.mjs` | 复用旧账号鉴权的管理员 HTTPS 部署适配；见生产交接文档 |
| `src/conversation-archives.js`、`src/legacy-archive-export.js` | 旧人设/档案/历史导入与来源追溯；不复制凭据或 QQ 登录态 |
| `src/archive-runtime.js`、`ui/archives.html` | 按档案续聊、记忆范围和切换入口 |
| `test/conversation-*-test.mjs` | 新基础模块的独立边界测试 |
| `test/_harness.mjs` | 原有模拟 QQ/模型及隔离数据脚手架 |
| `scripts/local/Setup-Dev.ps1` | 准备本地 Node 与开发依赖，不运行 QQ 安装流程 |
| `scripts/check-platform-publication.mjs` | 检查本 fork 的新增/改动文件与新增历史，不把本机私有资料推上 Git |

## 拉取与继续开发

```powershell
git clone --branch codex/group-management https://github.com/joodty/QQ-agent.git
Set-Location QQ-agent
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\local\Setup-Dev.ps1
```

有合适 Node 24 时也可以使用 `npm ci --ignore-scripts --no-audit --no-fund`。开发与测试不需要真实 QQ、API Key 或服务器；不要把上游 `npm run setup` 当作安装测试依赖的步骤，它用于下载运行组件。完整命令和基线限制见 [本地开发](LOCAL_DEVELOPMENT.md) 与 [工作记录](WORK_LOG.md)。

交给其他 AI：

> 请先读 AGENTS.md、doc/platform/HANDOFF.md、MIGRATION.md、DEVELOPMENT_LESSONS.md 和 WORK_LOG.md，检查 Git 状态，在当前分支完成群管理扩展。平台/用户出资必须共享完整聊天引擎，权限和费用分开判断。使用模拟 QQ/供应商与隔离数据，保留旧数据；完成后更新记录、检查公开内容、提交并推送 origin 当前分支，不向 upstream 推送。

## 下一步顺序

当前生产兼容方案、限制与回退见 [生产交接](PRODUCTION_HANDOFF.md)；付费边界见 [生产费用保护](PAID_CALL_GUARD.md)。普通账号权限与用户 Key 尚未适配，不能将管理员网关当作多人平台。

1. 保持已接通的模型费用准入与档案主链，继续补覆盖；外部付费搜索、第三方自发请求和用户 Key 的统一解析仍须单独适配，不能因有预算内核就直接开放。
2. 适配账号与群身份，保证同群唯一、多管理者及权限撤销；选择费用来源必须由出资人授权。
3. 在同一引擎接入平台/用户凭据与能力策略，增加模型兼容、失败和不回退测试。
4. 在保留导入人设版本的基础上设计版本化正文编辑；当前原生正文设置仅影响未使用导入档案的聊天。普通账号网页须和实际授权及费用入口一起交付。
5. 维护已核对的迁移 coverage 与回退资料，后续变更继续在隔离副本验证，不用旧备份覆盖切换后新增的档案和账本。
