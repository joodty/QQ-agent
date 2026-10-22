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
| 通用预算内核 | 独立开发与测试，支持群/私聊；尚未接到实际模型请求和网页 |
| 多账号、QQ 群管理身份验证 | 待适配；原上游控制台不能据此视为已具备公网多人后台 |
| 按群/私聊选择用户 Key | 待统一凭据解析；不能再为用户 Key 写功能不同的聊天分支 |
| 预算对真实调用生效 | 待所有付费入口、报价、重试及后台子任务接入验证 |
| 人设版本与旧历史迁移 | 待脱敏样本映射；上游分会话人设保留，不重复实现基础覆盖 |
| 生产切换 | 未执行；旧服务、数据库、QQ 与代理继续由原部署管理 |

## 关键代码

| 路径 | 职责 |
| --- | --- |
| `src/orchestrator.js` | 原有 Agent 调度与工具循环，扩展保持一套引擎 |
| `src/llm.js` | 原有模型请求、重试与用量入口；未来在真实请求前接预算与凭据核验 |
| `src/config.js` | 上游配置与群/私聊人设覆盖；当前不是多人权限和凭据隔离层 |
| `src/conversation-context.js` | 不含密钥的执行范围、引用版本与并发隔离 |
| `src/conversation-budget.js` | 群/私聊通用预算状态、在途金额与结算协议 |
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

1. 在隔离模型/QQ 环境验证带上下文的真实 Agent 主链，覆盖所有 LLM 子调用与重试；结合实际供应商报价接入预留和结算。
2. 适配账号与群身份，保证同群唯一、多管理者及权限撤销；选择费用来源必须由出资人授权。
3. 在同一引擎接入平台/用户凭据与能力策略，增加模型兼容、失败和不回退测试。
4. 接网页、角色卡版本及费用界面，让入口、实际调用和失败指引一同交付。
5. 使用脱敏旧数据演练迁移与回退，单独确认生产切换范围。没有完成演练前不覆盖旧数据库或清理会话。
