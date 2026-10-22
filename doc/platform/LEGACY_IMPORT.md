# 旧人设、会话档案与历史导入

本功能在 Node 24 的新系统中保留旧应用数据，支持按群/私聊切换档案后继续使用对应人设和历史。生产导入与服务切换未在本轮执行；旧系统继续保存原数据。

## 通常用一次，但工具保留

正式切换时一般执行一次最终导入。此前可以反复预览、演练、修复缺失资料后重试；以后也可能补导遗漏的档案。相同来源重复导入不重复创建数据，不覆盖新系统已经产生的消息和当前选择。

同一档案支持源消息、原始事件的严格前缀追加：只补进原快照之后的新条目，重新分配本地消息序号，不覆盖新系统消息。源记录被改写、截短、ID 冲突或人设正文发生不兼容变化时拒绝整笔写入，不猜测合并。旧来源的当前选择变化也不会自动覆盖新系统选择，应在页面明确切换。

## 保留的内容与来源边界

| 数据 | 处理 |
| --- | --- |
| 人设 ID、名称、正文、版本和历史 | 保留原身份及版本资料；平台内置角色正文以旧 SQLite 权威内容为准 |
| 档案 ID、群/私聊、人设关联、原 DSH ID、当前选择 | 保留关系；原 DSH ID 是来源标识，不是新 Agent 的运行 ID |
| 能读取到的实际 QQ 收发记录 | 转为新 ChatStore 结构，全部标为已读；不会重放为待处理消息 |
| DSH 完整原始事件 | 通过事先取得的离线导出读取，惰性保存在 transcript；不会执行旧工具或审批 |
| 可可靠提取的旧输入/输出文本 | 以明确标记的历史资料加入后续上下文；一次请求只携带有限窗口 |
| 导入后的新消息和记忆 | 按所选档案分别保存，A → B → A 可恢复 A 的记录 |

旧管理 SQLite 的人设/档案索引不含 DSH 全文。social-v2 仅保留有界消息窗口，且旧正文已截断；BYOK 历史也有条数和字节限制。完整 DSH 会话与完整 QQ 群聊天是不同范围：没有被旧系统长期保存的内容无法恢复。导出结果的 `coverage` 分项说明已取得、部分取得和缺失的来源，不以“读取成功”冒充“历史完整”。

账号密码、Cookie、API Key、QQ 登录态、供应商价格、旧账本和授权关系不在这个导入器的范围内，不会随人设档案自动迁入。导入文本不授予平台或工具权限。

## 操作顺序

1. 对旧系统做一致性备份或准备离线副本；保留原件。SQLite 数据以数据库为权威，不能拿陈旧 JSON 镜像覆盖。旧数据库与必要 WAL 的一致性由备份过程保证。
2. 准备需要保留的 DSH 会话离线导出。不要把 follow 的最近 200 条快照当成全部历史；本工具不连接 DSH、不调用会 flush 的在线 export、不启动 QQ。
3. 在维护者的私有目录生成导入包，检查 coverage 与数量。导出包含真实聊天内容，不能进入公共 Git。
4. 对新系统独立数据目录预览。首次正式导入时停止新系统；旧服务保持原状。导入后以 Node 24 重启新服务，验证人设与档案选择。
5. 验证通过后，再安排单独的生产切换；不能同时让两个系统重复回复同一批消息。

导出参数和离线 DSH 文件布局以导出工具帮助和下面的约定为准。

`--dsh-exports-dir` 接受事先解压的官方导出目录，递归读取其中的 `session.jsonl` 等原始 `.jsonl`，也接受保存为 `*.artifact.json` 的官方 `SessionRawArtifact` 对象（包含 `meta`、`filename`、`content`）。不猜测 DSH 运行目录的私有存储格式。子会话原事件一并保留，默认不会作为主会话的群聊天上下文；媒体保留原始事件中的引用，当前不复制媒体二进制。

旧默认人设若继承 DSH preset、正文未出现在已提供的角色或成员卡资料中，会明确报告人设正文缺失，并保留为不可续聊档案。允许部分导入不会把缺失正文、封存或已删除的人设自动启用；需先补齐来源或完成单独的修复适配。

```powershell
node scripts/export-legacy-archives.mjs --bridge-root 'D:\private\old-bridge-copy' --source-id old-primary --dsh-exports-dir 'D:\private\dsh-exports' --output 'D:\private\old-archives.json'
node scripts/import-legacy-archives.mjs --bundle 'D:\private\old-archives.json' --data-dir 'D:\private\new-agent-data' --dry-run
```

确认预览后才正式写入：

```powershell
node scripts/import-legacy-archives.mjs --bundle 'D:\private\old-archives.json' --data-dir 'D:\private\new-agent-data' --apply
```

coverage 不完整时默认拒绝正式导入。维护者核对报告并接受缺口后，可在 `--apply` 上增加 `--allow-partial`；此选项接受来源缺口，不绕过数据格式、引用、版本或冲突检查。

预览默认不写库，也不创建不存在的目标数据目录。正式写入使用 SQLite 事务，失败回滚。两端运行数据不通过公共仓库传递。

启动时使用相同的数据目录：

```powershell
$env:QQ_AGENT_DATA_DIR = 'D:\private\new-agent-data'
npm run server
```

导入档案目前使用 Node 24 的服务端入口。上游 Electron 33 内嵌的 Node 20 不支持本扩展的 SQLite 档案，不能把本次服务端验证算成桌面打包验收；未导入档案的上游桌面路径保留。

## 在页面继续聊天

控制台顶部选择“人设档案”，进入 `/archives.html`。选择群聊或私聊，查看可用档案与当前档案最近消息，点击“切换并继续这个档案”。同一聊天的人设、消息和后续记忆共同切换；不同聊天即使号码相同也分别保存。

切换会增加选择版本，取消旧等待任务、中止旧模型运行，并清理该聊天的临时提示词锚点和话题。发送队列在延迟后、真正发送前复核版本；A → B → A 不会复活第一次 A 的旧任务。已经被 QQ 接受的发送仍归档到它原先的档案。

本页沿用上游本机控制台的访问校验与来源校验，尚不是公网普通账号的群授权后台。导入和选择不改变 QQ 白名单、模型供应商或平台预算；此前开发的预算内核仍未接入所有付费出口。

## 文件与验证

- `src/legacy-archive-export.js`：只读提取旧来源并生成带覆盖报告的中间包。
- `scripts/export-legacy-archives.mjs`、`scripts/import-legacy-archives.mjs`：维护者导出、预览与正式导入。
- `src/conversation-archives.js`：SQLite 原身份、来源指纹、事务、增量补导与选择版本。
- `src/store.js`、`src/archive-runtime.js`：档案消息、记忆范围与旧文本上下文。
- `src/orchestrator.js`、`src/sender.js`：真实聊天主链与切换后的在途任务保护。

开发验证使用虚构旧 SQLite、离线 DSH 样本、本机 HTTP/OneBot 模拟和隔离新数据；不读取生产账号，不向真实 QQ 发消息，不调用付费模型。当前测试结果与未完成项记录在 [工作记录](WORK_LOG.md)。

```powershell
npm run test:archives
npm run test:platform
npm run check:public
```

输入限制会明确报错，不静默截断：CLI JSON 文件最多 256 MiB，内核 canonical JSON 最多 64 MiB，单条原生消息文本最多 1 MiB；离线源单文件最多 128 MiB。大于当前限制的真实历史需另做分批或流式适配，不能靠删除聊天内容绕过。导入和写入仍做完整一致性校验，大历史库的写入成本需要按真实规模评估。
