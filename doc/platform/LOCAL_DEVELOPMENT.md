# 本地开发与上游基线

本仓库在 QQ Agent 上开发通用群/私聊管理能力。开发安装不需要真实 QQ、SnowLuma、API Key、旧项目资料或服务器连接。

## Windows 一键准备

先安装 Git，在希望存放项目的目录执行：

```powershell
git clone --branch codex/group-management https://github.com/joodty/QQ-agent.git
if ($LASTEXITCODE -ne 0) { throw 'Clone failed' }
Set-Location QQ-agent
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\local\Setup-Dev.ps1
if ($LASTEXITCODE -ne 0) { throw 'Development setup failed' }
```

脚本优先使用本仓库 `.tools/node/node.exe`；缺少时从 Node 官方站下载固定的 Node 24.22.0，并校验固定 SHA256 后才解压和执行。运行时、下载与 npm 缓存位于本仓库的忽略目录，不改变全局 Node、系统 PATH 或其他项目。已有不完整工具目录会报错，脚本不会自行删除或覆盖它。

已有 Node 24 时可以显式传入可执行文件：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\local\Setup-Dev.ps1 -NodePath 'D:\tools\node\node.exe'
```

该 Node 目录需带有配套 npm。`-SkipTests` 只跳过平台核心测试，依赖安装和公开检查仍执行。脚本使用 `npm ci --ignore-scripts`，不会运行 Electron 安装钩子、下载便携 QQ 或启动应用；随后启用仓库 pre-push 检查，默认运行平台核心隔离测试与公开检查。

## 日常命令

准备完成后，在当前 PowerShell 临时使用仓库 Node：

```powershell
$env:PATH = (Join-Path (Get-Location) '.tools\node') + ';' + $env:PATH
node --version
npm run test:platform
npm run check:public
git diff --check
```

如果准备时使用了 `-NodePath`，本仓库不一定存在 `.tools/node`。此时应把那个 Node 可执行文件所在目录加入当前终端的临时 PATH，例如：

```powershell
$qqAgentNodeDir = 'D:\tools\node'
$env:PATH = $qqAgentNodeDir + ';' + $env:PATH
node --version
npm run test:platform
```

本 fork 的开发与服务端档案功能要求 Node 24；上游原来的 Node 20 底线不包含新增 SQLite 档案功能。macOS/Linux 或已有 Node 24 的机器可直接执行：

```bash
npm ci --ignore-scripts --no-audit --no-fund
npm run test:platform
npm run check:public
```

## 验证分层

| 命令 | 证明的范围 |
| --- | --- |
| `npm run test:platform` | 新增通用上下文、预算内核和发布检查的隔离测试；不代表 QQ 主链路已接通 |
| `npm test` | 上游原有模拟 QQ/模型、工具、消息、用量和安装器测试集合 |
| `npm run test:coverage` | 上游模块、HTTP、端到端与界面检查；界面接线依赖 lockfile 中的 jsdom |
| `npm run test:all` | 顺序运行上游测试、覆盖测试和平台核心测试；前项失败会阻止后项 |
| `npm run check:public` | 本次扩展的公开资料与私密标识检查，不替代人工审阅 |

上游测试主要使用本机 HTTP/WebSocket 夹具与临时数据目录。运行结果必须分别记录 pass、fail、known、skip；退出码为 0 也不代表全部项目都实际运行或所有已知缺陷已修复。初次基线的具体结果见 [工作记录](WORK_LOG.md)。

## 首次上游基线：2026-10-22

基线为上游提交 `fdfd325e148d91845a0aeea3dfdff4cf92fc61a1`，使用 Node 24.22.0。`npm ci --ignore-scripts` 最终正常完成，安装 363 个包，包含 jsdom；没有修改依赖或 lockfile。

开发脚本已用显式已有 Node 24.22.0 的 `-NodePath` 加 `-SkipTests` 实跑，退出码为 0：依赖安装、Git hook 配置和公开检查成功。固定版本的官方 SHA256 已在线核对；首次自动下载/解压 Node 的分支尚未在这轮执行，不能把此结果当作全新电脑一键准备的实测。

- `npm test`：26 个脚本中，25 个退出为 0，`setup-qq-version.mjs` 退出为 1。命令原本因 `&&` 在第 17 个脚本停止，后续九个脚本已单独补跑，全部退出为 0。
- `npm run test:coverage`：五个脚本中，四个退出为 0，`coverage-ui.mjs` 退出为 1。被 `&&` 阻断的 `coverage-wiring.mjs` 已单独补跑，jsdom 实际启用。
- 合计 31 个上游脚本，29 个退出为 0、两个退出为 1；没有将基线改成全绿。覆盖测试报告的 `known` 数均为 0，但下面仍有按条件跳过或未覆盖的行为。

| 覆盖套件 | 上游报告的断言结果 |
| --- | --- |
| 离线模块 | 148 通过、0 失败、0 known |
| HTTP 接口 | 116 通过、0 失败、0 known；路由实际覆盖 85/90 |
| 端到端与插件 | 44 通过、0 失败、0 known |
| 静态界面 | 20 通过、1 失败、0 known |
| jsdom 界面接线 | 5 通过、0 失败、0 known；扫描 739 个交互元素 |

两处失败保持原状，原因分别为：

1. `test/setup-qq-version.mjs`：干净开发环境没有 SnowLuma/便携 QQ，实际 `setup --check` 正确报告缺失并退出 1，但测试仍要求输出可读取协议栈时才存在的 `CLIENT_BUILD`。没有为通过该测试下载真实运行组件。
2. `test/coverage-ui.mjs`：安装包链接正则只匹配小写、不带 Preview 的文件名，而上游落地页使用 `QQ-Agent-V0.4-Preview-Setup.exe`。没有改官网落地页或弱化断言来消除这个基线差异。

跳过与证据边界也需要保留：

- QQ 安装器检查打印的 84 项成功中，有三项实测实际未执行：没有缓存安装包时的哈希实测、未安装 SnowLuma 时的版本对齐、协议栈 build 比对，不能把它们算作真实运行验证。
- 工具审计因没有用户后装且注册工具的技能，未实际检查该类技能的开关联动；用量模拟 UI 因没有按天数据，跳过一次下钻行为。
- HTTP 覆盖未覆盖五条声明路由；输出的“跳过四条”不等于剩下全部覆盖。
- jsdom 遍历了 16 个弹窗入口，其中 14 个实际生成弹窗，另外两个因无可用模型数据未生成；这不是实体浏览器、手机或 Electron 验收。
- 全程未运行真实 QQ/模型会话，仓库根目录没有生成 `data/`。本机原始日志只保存在被忽略的 `.local/`，不提交运行输出。

## 当前开发边界

这一阶段只建立迁移约定、开发基线和独立通用内核。预算核心通过不等于已接入聊天调用、记忆整理、重试、工具调用、网页控件或线上环境。已有上游机器人不应被描述成已经获得新预算限制；按 [交接说明](HANDOFF.md) 查看每项真实进度。

真实机器人运行另有依赖：上游 `npm run setup` 会准备真实 QQ/SnowLuma，`npm start` 与 `npm run server` 会启动应用，不能把它们当作普通开发安装步骤。`--ignore-scripts` 不安装 Electron 二进制，因此本开发流程也不声称已验证 Electron 桌面启动。

不复制旧项目的数据库、Key、QQ 登录态、DSH home 或服务器配置。生产迁移需要独立的备份、转换、兼容与回滚验证，详情见 [迁移清单](MIGRATION.md)。
