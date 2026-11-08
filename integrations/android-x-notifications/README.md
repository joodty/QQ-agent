# Android X 通知转发试点

Android 端监听已授权的 X App 通知，筛选一个配置好的公开账号，再通过 HTTPS 发送标题识别后的正文片段。通知里有可验证的帖子链接时附原帖链接，否则只附主页。服务端凭据固定账号和已验证的 QQ 私聊，设备请求无法指定 QQ 目标。

Android 源码使用 Java 8 语法，最低 API 26。使用 Android SDK 33 的 `android.jar` 编译，D8 转成 DEX，再用 Android build-tools 打包和签名。调试试点可通过 `run-as` 将下列 JSON 写入应用私有目录的 `files/relay.json`。不要将真实值写入 APK 或版本库。

```json
{
  "author": "example",
  "display": "Example",
  "url": "https://example.com/api/integrations/x-notification",
  "token": "<random 32-byte hex>"
}
```

主 QQ Agent 通过 systemd `LoadCredential` 接收名为 `x-notification-relay` 的凭据文件，其中包含相同的 `author`、`token`，以及唯一管理员的 `accountId`。HTTPS 代理只需把该精确路径转到引擎。通知 ID 去重记录保留七天。正常 QQ 消息发送链路负责权限复核和送达回执。

在平板上打开应用，允许通知访问。安装并登录 X 官方 App，在目标账号主页打开所有帖子通知。按钮「8 秒后发一条测试通知」用于单独验证平板通知监听和 QQ 投递，点完即可息屏。Android 13 及以后需要允许该试点应用发布自己的测试通知。确认收到真实 X 通知后，再用同样方式验证真实帖子的息屏送达。
