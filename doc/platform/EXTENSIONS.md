# 官方市场扩展：选择、锁定与安装

本页针对 QQ Agent 的插件与 Skill，不是 Codex 技能。来源为 [官网](https://kondius.cn/qq-agent/index.html)、[Skill 市场](https://www.kondius.cn/qq-agent/skill-market/) 和 [插件市场](https://www.kondius.cn/qq-agent/plugin-market/)。2026-10-23 只读获取的市场列表包含 430 个 Skill、555 个插件；列表会变化，不能据此承诺所有扩展都已审查。

## 本次选择

| 扩展 | 市场版本 | 用途、依赖与费用 | 处理 |
| --- | --- | --- | --- |
| `meal-picker` / 今天吃什么 | 1.0.0 | 本地菜品随机工具，无网络、额外 Key 或外部依赖；原版跨聊天共享同 QQ 的剩余次数，次数仅存内存，重启清零 | 已安装启用，应用按完整聊天键和真实触发 QQ 隔离计数的修订 |
| `my-weather` / 天气查询 | 1.0.0 | 固定查询 wttr.in，需要访问该公开服务，无新增 Key；只传城市，不传 QQ、聊天或模型凭据 | 已安装启用，应用本地 HTTP 边界修订 |
| `ban-state` / 群禁言状态 | 1.0.0 | 根据载入后的 QQ 禁言通知在内存保存完整群聊天键和到期时间，接入现有唤醒判断；无网络、文件、定时器或模型请求，重启不恢复该 Map | 已安装启用 |
| `token-usage` / 用量统计 | 1.2.0 | 遍历全局运行记录并按任意聊天筛选，没有平台资源权限过滤，另依赖本机原生接口 | 不安装；保留新工作台按授权范围的费用统计 |
| `read-document` / 文档阅读 | 1.0.0 | 附带 PDF.js，另可解析 Word/PPT；允许按绝对路径读取服务账号可访问的文档，没有按账号隔离 | 不安装；需先设计受限上传和资源授权 |
| `reply-safety` / 回复安全网 | 2.0.0 | 无外部 API；使用全局草稿数组，多群/私聊并发会互相清空或干扰，下载包还含双层模块目录 | 不安装该版本；并发问题需先修复 |
| `safety-guard` / 保护词守护 | 1.0.4 | 默认启用额外 AI 判断，但调用签名与当前模型接口不兼容，使用全局模型参数的方式也未适配按资源出资 | 不安装该版本；不能把词表功能当作 AI 判断已工作 |
| `ui-cache-rate` / 缓存命中率显示 | 1.0.0 | setup 修改原生页面文件、复制脚本并定时检查，禁用也会先执行 setup；不适配新工作台和只读部署目录 | 不安装该版本 |

市场托管的是社区上传内容，市场地址不能代替作者身份或完整代码审计。上述包没有为扩展自身声明许可证或源仓库；文档阅读包内的 PDF.js Apache-2.0 许可仅覆盖其对应组件。公共仓库只记录来源、版本、摘要及自写兼容补丁，不复制未声明许可的第三方包源码。

“无额外 API 费用”不代表聊天免费：启用 Skill 后，其提示词和工具 schema 可能在没有调用该工具时也随正常模型请求发送，模型理解结果和生成回复还会使用 token；这些开销统一按当前群/私聊和付款来源经过生产预算守卫。天气服务可用性和外部接口规则也不由本项目保证。

## 锁定与本地修订

[extensions.lock.json](../../extensions.lock.json) 保存下载来源、原 ZIP 的 SHA256 和大小、完整模块文件摘要、默认配置与本地修订信息。实际安装须固定该文件的 Git 提交；市场同版本 ZIP 若发生变化，应拒绝并重新审查，不能自动接受新摘要。

两个包的原市场版本仍为 1.0.0。`meal-picker-chat-scope-v1` 仅将计数身份改为完整聊天键与可信触发 QQ 的组合，避免剩余次数泄露其它群/私聊中的使用，保留菜品和午/晚餐次数策略。

菜品次数是娱乐功能的内存计数，不是费用额度；重载/重启清零不会重置 SQLite 中持久化的消费账本。

天气包修订标记为 `my-weather-body-bound-v1`。兼容工具只针对已审过的原文件：城市最多 100 个字符并拒绝控制字符，固定 HTTPS 主机、拒绝重定向，限制响应为 256 KiB，总超时覆盖响应体读取。它没有新增供应商、收费源、QQ 数据访问或模型 Key。

`sourceFiles` 是官方 ZIP 中模块的原文件摘要，`files` 是最终安装文件摘要；上述两个 index.js 在应用补丁后会有不同摘要。补丁脚本和原始/安装后入口摘要另列于 `adaptation`，不能把修改后的文件冒称为官方原版。默认预览：

```text
node scripts/extensions/weather-compat.mjs --zip ABSOLUTE_REVIEWED_ARCHIVE.zip --entry ABSOLUTE_STAGED_MODULE/index.js
node scripts/extensions/meal-compat.mjs --zip ABSOLUTE_REVIEWED_ARCHIVE.zip --entry ABSOLUTE_STAGED_MODULE/index.js
```

只有明确加 `--apply` 才写暂存模块。具体导出接口、限制与测试以兼容脚本为准；不对未知源码做猜测替换。

## 安装与每次发版

QQ Agent 扩展在主进程中 import/setup，没有代码沙箱；即使配置 disabled，也可能先执行模块初始化。所以先下载到运行目录外审查，不能通过“先装进去再禁用”来隔离未知代码。

本轮沿用 `APP_ROOT/skills/<id>` 与 `APP_ROOT/plugins/<id>`，不改底座查找根，不指向旧项目或创建跨项目链接。每次新 release 都须按锁定清单重放安装，不能仅复制主程序后假定插件仍在。

1. 验证原 ZIP 大小与 SHA、条目路径、软链、展开大小及完整 `sourceFiles`；剥除明确的 `moduleRoot`，拒绝额外文件或不符的 manifest ID/类型/版本。
2. 在隔离暂存目录应用已锁定补丁，核对最终 `files` 的路径、大小和 SHA，再准备私有备份与独立配置变更。
3. 已有同名目标不能直接覆盖。逐包放入经过审查的模块，显式重载、启用，再检查真实 manager 的 active/broken 状态、工具和能力。保留其他插件和账号/人设/费用配置。
4. 失败时只移出本次对应模块、重载并选择性清理其配置；不清空整个扩展目录、用户数据或预算。新 release 回退时也保留切换后的聊天与账本。

使用 [离线安装器](../../scripts/install-reviewed-extensions.mjs) 预览或重放，原 ZIP 以锁文件中的 `<source.zipSha256>.zip` 命名放在私有目录：

```text
node scripts/install-reviewed-extensions.mjs --lock ABSOLUTE_RELEASE/extensions.lock.json --packages-dir ABSOLUTE_PRIVATE_ARCHIVES --release-root ABSOLUTE_RELEASE --state-dir ABSOLUTE_PRIVATE_RECEIPTS
```

默认预览不创建目录、缓存或 receipt，也不执行扩展代码。明确加 `--apply` 才安装；可用 `--id meal-picker` 选择单包。安装器不改应用配置或调用运行接口，启用/重载仍由部署者在校验后执行。精确回退使用 `--rollback ABSOLUTE_RECEIPT` 预览，再明确加 `--apply`；包文件已有变化时拒绝删除。

本轮保持关闭热重载，使用显式重载。锁文件的 `defaults.settings` 是元数据分组；真实配置在 `config.skills[id]` 下平铺设置项和 `enabled`，不能另嵌一层 `settings`。外网仍不能安装任意包、运行系统命令或查看密钥；这些扩展没有扩大普通账号权限。禁言插件的两个设置字段在当前内核没有分别被读取，实际效果是已知群禁言时跳过唤醒并标已读，不能宣称两个开关都已有独立效果。

## 验证与生产状态

`npm run test:extensions` 覆盖锁定来源、两项安装期修订、真实 loader/工具与隔离 HTTP，以及安装器校验、幂等、批量失败清理和精确回退。本轮缓存固定原包后实际为 23/23，零失败/跳过；没有外网、付费模型或 QQ 发送。另有五项私有审包场景，包含禁言能力的真实 Orchestrator 消费，以及复现未选回复安全网的并发草稿问题。

公共测试不附带未声明许可的原包，不会自行联网下载。包集成测试使用 `QQ_AGENT_EXTENSION_CACHE` 指向私有缓存，其中须有哈希匹配的 `skills-meal-picker.zip` 和 `skills-my-weather.zip`；缺少时明确标记 skip，不应将其算作已实测通过。`test:all` 已串联此入口，但仍有本地开发文档列出的既有上游失败，应按实际结果逐项报告。

三个固定官方包已完成隔离预览三包、应用三包、重复应用零新增、精确回退三包，最终修订文件摘要全部匹配；又从真实 Git archive 重放一遍，验证 Git 字节与补丁摘要没有行尾差异。

2026-10-23 生产启用完成，部署扩展来源为 [837ce00](https://github.com/joodty/QQ-agent/commit/837ce0016dcc7e93c6c54feb700913797ed82097)，聊天核心继续沿用已验收版本。三个模块均为 loaded/enabled/active，两个工具和禁言能力在真实 manager 中可用。逐包执行三次本机显式重载，没有重启聊天服务，QQ、OneBot 和代理保护进程保持。

管理员公网读取扩展和能力均成功，匿名请求拒绝；临时管理员会话精确清理后，原七条会话保持。八个账号、三个 QQ 绑定、四个人设、八个档案、六个选择和安装前二十六条已结算记录逐值保留，未知费用仍为零，预算策略与初始 seed 未变；仅三个扩展的配置项发生预期变化。

天气在服务器隔离暂存中作了一次公开城市查询，真实免费 HTTP 200、约 774 ms；本次验证未发起模型探测或 QQ 测试消息。禁言/解禁消费和天气异常响应边界由隔离夹具验证，没有为验证插件而实际禁言机器人或群友。原包私有缓存、安装 receipt 和锁文件保留，每次 release 按同一流程重放。

语音暂未纳入首批。市场描述中的 `free-tts` 2.0.0、`voice-send` 1.5.0 声称提供免 Key 在线路径，但其代码、服务规则和平台发送边界尚未审验；Windows 离线语音及需本机模型服务的其他项也不能直接当成当前节点可用的能力。
