# 群管理扩展：从这里接手

2026-10-24：普通账户本人申请/扫码的独立 QQ Agent 接入、管理员平台默认偏好及个人业务覆盖已部署。运行源 c9d10c4 已上线 Go 目录57款、47款可选与搜索，两款完成真实工具调用和用量结算；平台模型已恢复，默认Go DeepSeek，不回退旧Key。随后按用户要求开发统一平台模型与腾讯语音资源，关闭个人Key和付款来源入口，保留人设、概率、上下文及语音偏好。第二QQ此前被保守内存门槛拦住，正在依据用户双开经验复查，尚未真实扫码。见[本人接入](HOSTED_BOTS.md)、[统一资源](PLATFORM_RESOURCES.md)和[生产交接](PRODUCTION_HANDOFF.md)。

更新日期：2026-10-24。开发仓库：[joodty/QQ-agent](https://github.com/joodty/QQ-agent/tree/codex/group-management)，分支 `codex/group-management`；上游 [K0nd1us/QQ-agent](https://github.com/K0nd1us/QQ-agent)。首次基线为 `fdfd325e148d91845a0aeea3dfdff4cf92fc61a1`，版本 0.4.0。保留上游 MIT 许可和 Kondius 署名。

## 产品目标与保留成果

公共 QQ 机器人由平台维护。每个群只有一份资源记录、当前人设、费用来源与共享额度，可以有多个经验证的管理者；同一个用户也可以管理多个群。本人私聊遵循相同能力体系。平台角色、群权限、模型能力、付款来源分别判断。

旧项目不是废弃数据：账号、授权、Key 加密、预算、版本化人设、会话档案、SQLite 与测试用例都是迁移依据。新聊天底座不继续复制 DSH 及平台完整 Agent/BYOK 纯文本两套链。详细清单见 [迁移说明](MIGRATION.md)，约定见 [开发经验](DEVELOPMENT_LESSONS.md) 与 [能力契约](CAPABILITY_CONTRACT.md)。

自助托管私人 QQ 已按 2026-10-24 用户新要求恢复，采用独立实例和容量准入。实例名额与主机内存分开核验，不将小型节点承诺为无限量托管平台。

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
| 全站导航与工作台 | 已部署运行源 `a6f2a03`：工作台先选群/私聊再进入5详情页，另有授权费用总览/我的API配置；管理员顶部另进平台管理，账号菜单在右上。新增安全平台模型与全平台汇总，284/284隔离回归通过；公网角色403/200、270源码/扩展摘要、缓存和最新数据保留通过，[结构与兼容路由](WORKSPACE_NAVIGATION.md) |
| 聊天名称与白名单管理 | 运行源 `368ef414` 已部署，284/284隔离回归通过；群名/私聊昵称独立保存到 `chat-identities.sqlite`，概览直接读持久索引，缺名异步补全；管理员列表包含尚未聊天的白名单群/私聊及已启用费用来源，普通账号仍按本人绑定和精确授权。公网12个聊天均有持久名称、10个配置对象全可管理，角色隔离和数据保留通过，详见[名称索引](CHAT_IDENTITIES.md)和工作记录 |
| 聊天回复概率与语音授权 | 回复概率运行源 `d4b483bf` 关键测试17/17；后续 `95f7076f` 已部署，22/22关键测试及公网权限/数据保留通过，修复新未出资聊天预设额度400，语音授权移到首面板并可定位。群/私聊概率、语音授权、模型付款分别管理，保存额度不自动开启付款。距上次大回归第2版，累计3～5版再做较大回归，见[操作与语义](REPLY_SETTINGS.md)与工作记录 |
| 通用消息任务与群发 | 运行源 `734128a4` 已部署，文字/指定音色语音共用单发与管理员群发任务，群/私聊复用；语音先免费核算再确认、逐目标费用保护，不改默认设置/概率。集中专项75/75通过；公网免费报价/权限拒绝、289源码与4扩展摘要及原5条回执/会话/费用保留通过，验收零真实合成/QQ发送。schema2分开合成与送达，未知不重试；图片未接入。较大回归基线 `1d300de8`，当前第1版，见[消息设计](MANUAL_MESSAGES.md) |
| 已审市场扩展 | `meal-picker`、`my-weather`、`ban-state` 1.0.0 与新增 `face-decode` 1.1.0 已部署，四项 active、文件摘要一致；扩展隔离测试 30/30。固定来源保留，不复制无许可原包源码 |
| 表情收录与隔离 | 原生补强已部署：按群/私聊保存独立表情与备注，只自动收可信入站表情段，持久限频/容量/下载边界；专项 19/19，生产已有一条自然收录。旧九条全局收藏原样隔离保留。当前纯文本模型不自动理解图片，未备注表情需用户说明；按需视觉另需授权模型与统一预算 |
| 语音用量 | 只读主账统计与工作台报表已部署：按群/私聊和北京时间日期查看记录、合成成功、待核对、字符及费用估算；辅助额度不重复计入，旧字符缺口明确提示。专项18/18、相关回归144/144，公网角色/范围及查询不改账核验通过；见[统计说明](SPEECH_USAGE.md) |
| 语音输出 | 腾讯正式 TTS、资源开关/补贴、语速/音量和自动概率已部署。曾临时50%的一小时恢复任务已完成；之后全局和群级概率已由用户自行调整，接手须读取实际API，禁止用历史10%或40%快照覆盖新设置。短合成和一条自然引用回复的QQ发送接口确认已验证，手机播放未确认。各聊天开关以当前API为准，旧unknown保留，云资源包余额未同步 |
| 引用回复与语音判断 | 修复普通引用回复直接跳过自动语音的分支，独立语音气泡与文字引用回退；运行档案保存不含正文的判断元数据。源 `caec691` 已部署，相关隔离回归73/73，线上设置/恢复任务/原数据保持；未将模拟发送当作手机播放验证 |
| 完整音色选择 | 官方公开基础接口目录60款（三类14/17/29）、分类/性别/场景/搜索、动态分类报价和受预算固定短句试听已部署，首轮源 `b21f373`、回归188/188，现已随性能版升级。公网角色/目录/设置及数据保留核验通过。原六ID兼容，历史账不重价；[目录及试听](SPEECH_VOICES.md) |
| 工作台性能 | 已部署运行源 `3d40bbd`：按需 summary/compact、公共目录与静态资源版本缓存、gzip、GET超时重试，语音设置不等待用量；252/252隔离回归通过。公网管理员概览394,071→11,484字节/gzip1,935，语音概览175,393→750字节；源码/扩展摘要、权限、304/no-store、原数据保留通过。详情见工作记录及[缓存边界](WORKSPACE_PERFORMANCE.md)，不得缓存权限为授权依据或恢复旧设置快照 |
| 本轮生产状态 | 运行源 `1171d63` 已提交/推送并部署，Go DeepSeek V4.1 Flash 与 GLM 5.3 Flash 均真实完成工具调用及 follow-up，共4次 HTTP 200 且 usage 结算；DeepSeek 第二轮 cached 256 tokens。管理员真实 model-service PUT 切换默认并保留空 Key，报价随模型更新；普通 GET/PUT 403、上下文条数80保持。平台 pause/pending 已清除，pause=false、skipBacklog=true，AI 恢复，默认 Go DeepSeek且不回退旧 Key。原23表、8账户/3绑定/7语音授权及费用数据保持，x-ui/Xray/nginx/SSH/dockerd/原 QQ 容器未改。容量仍不足，未启动第二 QQ、扫码或发送真实 QQ 测试消息。回归模型52/52、工作台127/127、托管80/80、原守卫14/14零失败跳过，公开检查198文件通过；严格TLS页面可达但显示401登录页、JS源码匹配。IAB不可用，未宣称截图验收。完整目录/搜索为第二增量开发中，尚未部署。详见当日[工作记录](WORK_LOG.md)及[生产交接](PRODUCTION_HANDOFF.md) |

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
| `src/speech-provider.js`、`speech-service.js`、`speech-runtime.js` | 腾讯正式语音、独立补贴/资源设置、费用准入与安全发送；不借用聊天模型 Key |
| `scripts/local/Set-TencentSpeechCredential.ps1` | 隐藏录入或指定 CSV 路径，将腾讯专用凭据保存为本机当前用户 DPAPI；不联网或输出明文 |
| `src/scoped-stickers.js`、`sticker-download.js`、`sticker-image.js`、`sticker-manager.js` | 表情按完整聊天键隔离、可信来源自动收录、受限下载/按需图像表示与兼容视图；旧全局资料保留 |
| `extensions.lock.json`、`scripts/install-reviewed-extensions.mjs` | 锁定已审市场包来源、原始/安装摘要和修订；默认只读预览、逐包安装与精确回退 |
| `scripts/extensions/` | 针对固定原包的安装期 HTTP/聊天范围兼容修订，不在公共仓库附带第三方包源码 |
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

独立平台部署、退役与回退见 [生产交接](PRODUCTION_HANDOFF.md)；数据表与逻辑 ER 见 [平台数据模型](PLATFORM_MODEL.md)，付费边界见 [生产费用保护](PAID_CALL_GUARD.md)，已审插件选择与重放见 [扩展说明](EXTENSIONS.md)。禁止重建旧 `authOrigin` 回查依赖。

1. 保持独立平台作为唯一运行入口，完成并维护生产迁移证据；下一次变更仍需隔离主链、页面和实际公开版本的相应核验，不能沿用旧结果代替验证。
2. 保持统一授权、档案与模型守卫；新增工具或提供商必须有可信权限、费用报价和失败策略，未受保护的付费搜索/系统入口继续拒绝。
3. 维护迁移 coverage 与回退资料，切换后新增账号、档案、用量和密钥配置不得被旧备份覆盖。
4. 腾讯语音三类目录与预算试听已上线，原临时概率任务已成功恢复全局10%，单群独立覆盖保留。后续先读取实际概率和任务结果，不据历史快照重建临时设置；继续区分合成音频、QQ接口确认与手机播放，不自动清理旧unknown、重价历史或把标价估算当作实收。
