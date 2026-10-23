# 语音输出调研：现成插件、费用与接入边界

核验日期：2026-10-23。本轮仅研究文字转语音（TTS），没有安装语音包、运行下载代码、建立消费级语音握手、注册云服务、发送合成文本或 QQ 消息，也没有修改生产配置。语音输入识别（STT）是另一项能力。

本文件保留调研时点的现状与建议。同日后续已按用户选择开发腾讯正式 TTS 共用能力，状态见 [工作记录](WORK_LOG.md)，专用凭据准备见 [接入说明](TENCENT_SPEECH_CREDENTIAL.md)；尚无真实凭据，未验证云端余额、实际合成或 QQ 播放，不将后续代码等同于已启用。以下“当前缺口”指调研时点，不能用来覆盖后续实现记录。

## 官方市场里有什么

来源为 [QQ Agent Skill 市场](https://www.kondius.cn/qq-agent/skill-market/) 及其 [公开目录](https://www.kondius.cn/api/community/skills)。市场托管社区上传作品，不等于全部由官方开发或已适配本平台。

| 包 | 当前目录/源码事实 | 对当前 Linux 小型节点的判断 |
| --- | --- | --- |
| `free-tts` 2.0.0 | approved；纯 Node，依赖宿主已有 `ws`；默认 Edge 在线朗读，失败转百度；使用当前聊天的 `sender.sendMedia`；包内无 LICENSE | 应用侧无需 GPU、Python 或本地大模型，可作轻量适配参考；不宜原样装 |
| `voice-send` 1.5.0 | approved；本机 OpenAI 兼容 TTS、Python edge-tts、GPT-SoVITS、百度/Google 在线兜底；代码附 MIT，模型/音频素材另有许可；使用当前聊天的发送队列 | 后端选择较多，但带同步子进程、全局配置暴露与不校验证书重试，不宜原样装 |
| `voice` 1.0.0 / 会说话 | 目录描述 edge-tts；状态 pending、没有下载链接，直接下载端点返回 403 | 未取得源码，无 ZIP 摘要，不能列为当前可安装或已审过的简化包 |

本轮只静态下载前两包，原始来源与摘要：

- [free-tts 原 ZIP](https://www.kondius.cn/api/community/skills/free-tts/download)，16,073 字节，SHA256 `8326becc0ec109b598a7528bfcb3f08135460e813eddcc301fe8ca8eb6db99f4`。
- [voice-send 原 ZIP](https://www.kondius.cn/api/community/skills/voice-send/download)，18,194 字节，SHA256 `8ef6c7e4ec7dad7bc3d77a58cbc5d260467061112e410de882faa1b8682da992`。

没有把第三方原源码复制进公共仓库，也未改变已安装三个扩展的锁定清单。

## “免 Key”实际连接哪里

`free-tts` 默认连接 `speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1` 的 WebSocket，使用包内公共客户端标记、计算 Sec-MS-GEC，并提供浏览器式握手头。备用是 `tts.baidu.com/text2audio`。这些是包代码中的消费级朗读路径，不是使用本人 Speech 资源 Key 的 Azure 正式 TTS API。

`voice-send` 的在线兜底连接 `fanyi.baidu.com/gettts`，再尝试 `translate.google.com/translate_tts`；本机模式另可连接配置的 `/v1/audio/speech` 或 GPT-SoVITS `/tts`。在线模式会把要朗读的文本发到对应第三方，自动更换供应商需要明确的产品策略，不能只因没有 API Key 就默认所有用户接受。

微软将 Read Aloud 介绍为 [Edge 浏览器朗读功能](https://learn.microsoft.com/en-us/deployedge/microsoft-edge-browser-policies/readaloudenabled)。[edge-tts 作者项目](https://github.com/rany2/edge-tts) 是第三方在线兼容客户端，其文档也记录过服务限制带来的功能变化。本轮没有查到将上述免 Key 端点承诺为第三方后台 API 的正式配额、长期免费政策或 SLA；开源客户端许可也不等于云端服务授权。因此不把市场的“完全免费、总能说话”当作可交付承诺。

## 正式云服务费用

以下是当前公开报价与试用条件，不是已开通的服务，也不是供应商账单承诺。不同厂商对“字符”的定义不同，不能把每万计费字符直接换成每万汉字。

| 选择 | 公开费用/试用条件 | 100 个纯汉字示例 |
| --- | --- | --- |
| 腾讯云通用 TTS 精品音色 | 中国站当前首档 0.3 元/万字符；汉字、字母、空白各按一个字符。精品免费 800 万字符、大模型 10 万、超自然 2 万，分别为单账号一次领取、三个月有效，通用 TTS 与长文本不同 | 精品约 0.003 元；大模型 1.2 元/万字符、超自然首档 6.5 元/万字符，分别约 0.012/0.065 元 |
| Azure Speech | F0 每月 50 万计费字符；中文每字按两个计费字符，约 25 万纯汉字。付费价格按区域和音色查询，不写成全球统一价 | 免费额度内不另计合成费；付费按所选区域报价 |
| 阿里云百炼 `qwen3-tts-flash` | 北京地域 0.8 元/万计费字符，汉字按两个计费字符；北京免费 1 万计费字符，约 5000 纯汉字，有效期 90 天，不是每月刷新，其他地域没有这项免费包 | 约 0.016 元，不含额外标点等计费字符；不是 0.008 元 |

腾讯的价格、字符口径及试用包见 [计费说明](https://cloud.tencent.com/document/product/1073/34112)，API 须开通服务并使用对应 [SecretId/SecretKey](https://cloud.tencent.com/document/product/1073/56640)。计费文档同时存在不同后付费说明，免费耗尽后的实际行为应以账号控制台开关为准，不能保证自动停止。

Azure 的免费额度见 [Speech 定价](https://azure.microsoft.com/en-us/pricing/details/speech/)，计费字符规则见 [TTS 文档](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/text-to-speech)，正式接口使用 [Speech Key 和匹配区域](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/rest-text-to-speech)。

阿里的价格与“一个汉字按两个计费字符”规则见 [模型价格的语音合成一节](https://help.aliyun.com/zh/model-studio/model-pricing)，开通和地域匹配的 API Key 见 [非实时 TTS 指南](https://help.aliyun.com/zh/model-studio/non-realtime-tts-user-guide)。以上服务都不要求本节点增加 GPU 或另开 QQ 客户端，聊天模型的 Key 不等于这些 TTS 服务的授权。

## 原包仍缺哪些适配

- `free-tts` 没有按群/私聊的语音开关或配额。百度请求在收到响应头后清除定时器，随后读取整段音频没有完整超时/体积约束；WebSocket 也会累计音频而没有总字节上限。合成时没有接入当前会话取消，失败只把错误交给模型，不保证文字已经补发。
- `voice-send` 使用同步 Python/ffmpeg 调用，可能阻塞聊天主进程；在线请求 TLS 失败后会尝试关闭证书校验。其状态工具没有资源过滤，会返回全局后端地址、路径和群白名单；空白名单判断也先于私聊放行，与文案不一致。它的内存冷却不等于持久预算，任意兼容端点也没有进入生产费用守卫。
- 两包都走已有 `SendQueue.sendMedia`，有复用价值，不应再建另一套管理员或用户机器人。不过发送队列的档案/出资/退群复核，不替代 TTS 执行前和合成后对当前语音开关、取消状态的检查。当前工具上下文没有向合成器传递 AbortSignal，全局禁用插件也不保证在途合成立刻停止。
- `sendMedia` 目前不消费语音包传入的 `replyToMessageId`，不能声称已有语音引用回复。MP3/base64 record 可避免应用与 QQ 容器的路径不共享；协议端能否在现网 Linux 正确转码并让手机实际播放，仍需后续授权灰度，包内注释不代替实测。

当前持久费用守卫保护文本模型调用，没有按 TTS 字符计价的准入与结算。付费 TTS 需要批准的供应商、凭据归属、准确字符口径、调用前预留、结算/未知状态以及并发限制；不能直接调用一个收费地址后仅在页面显示金额。模型组织语言和工具后续回复的 token 仍由原群/私聊预算承担。

## 建议的实施方向

当前节点优先正规云端按需语音：腾讯精品作为低价候选，Azure F0 作为有月免费额度的候选；阿里作为另一种音色选择，按双字符汉字口径估算。先确定供应商和音色，再实现一条共用 TTS 能力，复用现有群/私聊资源、授权和安全发送队列，平台或用户付款不另分聊天引擎。

初版建议只在明确要求时发短语音，平台统一设置供应商，每个完整聊天资源单独开关/限额；普通账号仅管理自己有权限的群和本人私聊。资源开关、字数/大小/总超时、并发、取消及发送前复核都须真正生效；合成确定失败且尚未发 QQ 时可用已生成文字回退，QQ 交付未知时不盲目重复发送。

本地 CPU 方案不能笼统说跑不了，但本轮不选作现成能力：[Kokoro 中文模型](https://huggingface.co/hexgrad/Kokoro-82M-v1.1-zh) 还需要推理运行时，权重大小不等于总内存；[Piper 中文模型](https://huggingface.co/rhasspy/piper-voices/tree/main/zh/zh_CN/huayan/medium) 需要逐模型核对许可。未在本服务器测过 RSS、延迟或音质，不承诺其容量或效果。

本轮完成的是资料审阅与建议。下一步开发、注册、付费或生产语音灰度均未执行，后续应按明确选择与授权继续。
