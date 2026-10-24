# Command Code Go 模型接入

## 入口与边界

Go 的官方 Provider API 不开放：`/provider/v1/chat/completions` 返回 `403 upgrade_required`。本实现参考 MIT 社区适配器和官方 CLI 的请求结构，使用同一账号 Key 访问 CLI 的 `/alpha/generate` 通道，不启动旧 DSH 或另建聊天引擎。它是非官方协议兼容层，供应商调整可能使其失效，不代表获得通用 Provider API 权限。

只允许精确的官方 HTTPS 端点，使用真实账号凭据和 `qq-agent` 客户端身份。协议版本头用于选择已核对的数据格式；不伪造官方客户端身份、工作目录或套餐，不轮换账号、绕过模型权限或额度拒绝。原生通道的 HTTP 拒绝、额度、协议及计费异常直接停止当前候选链，不回退旧平台 Key。

参考来源：[官方 Go 说明](https://commandcode.ai/docs/plans/go)、[Provider API](https://commandcode.ai/docs/provider)、[官方 headless](https://commandcode.ai/docs/headless)、[社区适配器一](https://github.com/eibednejo/dsh-llm-commandcode)、[社区适配器二](https://github.com/Victor-770/dsh-commandcode-provider)。源文件保留 MIT 署名。官方 CLI 只做只读协议核对，没有执行第三方安装脚本。

## 统一调用与设置

- `src/llm.js` 在最终出资解析后按精确端点选择协议；平台和本人 Key 沿用同一工具、上下文、记忆与费用流程。普通 OpenAI 端点不会继承平台的原生协议。
- 每次真实请求依次报价／预留、转换、再次授权／派发、限量读取、规范化真实 usage、结算；转换前失败释放，已发送但截断或计费不明保留 unknown。适配器内部没有联网、重试或凭据查找。
- 工具调用 ID、函数名、结果与 reasoning 历史保留。只剔除本地回执和界面标记，不将完整原响应再次发送给模型。无法保留的强制工具选择、远程图像或未知参数明确拒绝，不静默降级。
- 输出 `max_tokens` 采用官方 CLI 已使用的字段，保留费用守卫限制。网络读取与协议解析都有体积限制，缺失 usage 不补零，缓存输入不重复累加；矛盾统计、未报价的缓存写入和未批准模型拒绝结算为成功。
- 管理员在平台管理选择已批准且报价完整的模型，同一服务切换模型保留 Key；平台默认仅影响平台出资。思考档位以模型实际支持的目录为准，不把“默认”假装成关闭思考。上下文消息条数在“我的机器人”的更多设置中调整，消息条数与模型最大 token 窗口不同。

## 本轮实际验证

DeepSeek V4.1 Flash 与 GLM 5.3 Flash 使用用户授权的自有 Go 账号，各完成一次合成工具调用和一次工具结果后的文本回复，共四次 HTTP 200。两种模型均返回实际 usage 并结算；DeepSeek 第二轮返回 256 个缓存命中 token。测试没有使用真实 QQ 消息或发送 QQ 回复。

代码测试另覆盖真实编排器的工具循环、reasoning 重放、模型切换、本人出资、预算拒绝、403／429 停止、截断、超大响应和缺失／矛盾 usage。生产部署与当前开关状态见[工作记录](WORK_LOG.md)及[生产交接](PRODUCTION_HANDOFF.md)，不能把适配器测试当成所有套餐、模型与手机端已经验收。
