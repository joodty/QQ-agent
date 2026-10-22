# 群管理扩展：从这里接手

更新日期：2026-10-23。开发仓库：[joodty/QQ-agent](https://github.com/joodty/QQ-agent/tree/codex/group-management)，分支 `codex/group-management`；上游 [K0nd1us/QQ-agent](https://github.com/K0nd1us/QQ-agent)。首次基线为 `fdfd325e148d91845a0aeea3dfdff4cf92fc61a1`，版本 0.4.0。保留上游 MIT 许可和 Kondius 署名。

## 产品目标与保留成果

公共 QQ 机器人由平台维护。每个群只有一份资源记录、当前人设、费用来源与共享额度，可以有多个经验证的管理者；同一个用户也可以管理多个群。本人私聊遵循相同能力体系。平台角色、群权限、模型能力、付款来源分别判断。

旧项目不是废弃数据：账号、授权、Key 加密、预算、版本化人设、会话档案、SQLite 与测试用例都是迁移依据。新聊天底座不继续复制 DSH 及平台完整 Agent/BYOK 纯文本两套链。详细清单见 [迁移说明](MIGRATION.md)，约定见 [开发经验](DEVELOPMENT_LESSONS.md) 与 [能力契约](CAPABILITY_CONTRACT.md)。

自助托管用户私人 QQ 和部署多个客户端暂不作为新产品主线。这个调整不改变第三方 QQ 接入的适用规则，也不能把一个小型节点承诺为无限量机器人托管平台。

## 当前状态

| 部分 | 状态 |
| --- | --- |
| 上游 QQ Agent | 完整源码已拉取，保留原聊天与工具实现；基线测试见工作记录 |
| 统一执行上下文 | 独立模块与隔离测试；仅携带服务器解析的资源与稳定引用，不授予权限，不携带凭据 |
| 通用预算内核 | 模型请求前预留、结算、未知费用与平台体验双层额度；群/私聊与平台/用户 Key 共用出口 |
| 多账号、QQ 群管理身份验证 | 新增独立平台 SQLite；注册普通账号默认空授权，可信私聊绑定 QQ，OneBot 核验群主/管理员；精确授权与续证撤销 |
| 按群/私聊选择用户 Key | 新增所有者绑定的加密凭据、批准的端点/模型目录与明确出资；平台/用户 Key 共享原 Agent 工具和记忆主链，失败不回退平台 |
| 预算对真实调用生效 | 已接模型 HTTP 前后及主链上下文；生产启用强制准入与独立持久账本，重试/后续轮次/记忆使用隔离供应商验证；不宣称供应商账单硬封顶 |
| 人设版本与旧历史迁移 | 旧档案已在上一阶段导入；本轮新增不可变人设版本、显式应用与 A/B/A 复用。保存版本不会直接改写当前聊天 |
| 普通账号工作台 | 新增同站登录/注册、概览、聊天与人设、费用与额度、API 配置、账号设置；管理员另有平台设置、账号授权与高级控制台 |
| 本轮生产状态 | 独立平台已部署并完成验收，旧 Bridge / DSH 已停止并禁用；本地账号与原 Cookie 不再回查旧服务。匿名公网、角色页面、普通账号本人资源/跨群隔离、撤销和财务保留已验证，见生产交接 |

## 关键代码

| 路径 | 职责 |
| --- | --- |
| `src/orchestrator.js` | 原有 Agent 调度与工具循环，扩展保持一套引擎 |
| `src/llm.js` | 原有模型请求、重试与用量入口；生产守卫在每次真实 HTTP 尝试前后预留和结算 |
| `src/config.js` | 上游配置与群/私聊人设覆盖；当前不是多人权限和凭据隔离层 |
| `src/conversation-context.js` | 不含密钥的执行范围、引用版本与并发隔离 |
| `src/conversation-budget.js` | 群/私聊通用预算状态、在途金额与结算协议 |
| `src/paid-call-guard.js` | 真实模型请求前后预算、平台出资授权与持久账本；见生产费用文档 |
| `src/platform-auth.js`、`src/platform-auth-core.js`、`src/platform-store.js` | 新站本地账号、Cookie、精确授权、QQ 绑定与短期群身份证据；不访问旧认证服务 |
| `src/platform-business.js`、`src/platform-business-import.js` | 版本化人设、加密用户 Key、出资来源、平台体验与历史费用 |
| `src/admin-gateway.js`、`scripts/admin-gateway.mjs` | 同站公开壳、本地 SQLite 认证、普通账号资源 API 与管理员高级入口；内部令牌不交给浏览器 |
| `scripts/import-platform-accounts.mjs` | 旧 SQLite 一致性只读账号导出、默认预览与一次性原子导入 |
| `src/conversation-archives.js`、`src/legacy-archive-export.js` | 旧人设/档案/历史导入与来源追溯；不复制凭据或 QQ 登录态 |
| `src/archive-runtime.js`、`ui/workspace.html`、`ui/archives.html` | 按档案续聊与记忆隔离，普通资源工作台及管理员档案入口 |
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

独立平台部署、退役与回退见 [生产交接](PRODUCTION_HANDOFF.md)；数据表与逻辑 ER 见 [平台数据模型](PLATFORM_MODEL.md)，付费边界见 [生产费用保护](PAID_CALL_GUARD.md)。禁止重建旧 `authOrigin` 回查依赖。

1. 保持独立平台作为唯一运行入口，完成并维护生产迁移证据；下一次变更仍需隔离主链、页面和实际公开版本的相应核验，不能沿用旧结果代替验证。
2. 保持统一授权、档案与模型守卫；新增工具或提供商必须有可信权限、费用报价和失败策略，未受保护的付费搜索/系统入口继续拒绝。
3. 维护迁移 coverage 与回退资料，切换后新增账号、档案、用量和密钥配置不得被旧备份覆盖。
4. 语音合成插件仍待设计：按群/私聊开关、可换供应商、失败回文字；本轮不实现 TTS。
