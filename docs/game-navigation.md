# 官方游戏的纯 JavaScript 启动导航

`src/browser/game-navigation.mjs` 只负责按下官方的“进入游戏”按钮。签到、查询和领取仍由
`src/game/official-session.mjs` 接入官方 WebSocket。启动导航不识别截图、不发送签到或领奖请求，
也不读取或复制 SDK 的 token。

## 核对的官方入口

2026-11-19 核对的公开页面：<https://webgl-hua.61.com/>。
页面加载 `Build/WebGL.loader.js?v=1.0.2.41` 和同版本的 framework。

- <https://webgl-hua.61.com/Build/WebGL.loader.js?v=1.0.2.41>
  定义全局函数 `createUnityInstance`，返回含 `Module` 和 `SendMessage` 的 Unity 实例。
  页面在 loader 脚本的 `onload` 中调用它，因此 document 上的 capture load listener
  可以在调用前包裹原函数，保存成功创建的实例。
- <https://webgl-hua.61.com/Build/WebGL.framework.js.gz?v=1.0.2.41>
  的 `SendMessage(gameObject, func, param)` 在未传第三个参数时调用无参 `_SendMessage`。
- 官方公开 DefaultPackage `2026-11-17-67077` 的
  `defaultpackage_assets_res_hotfixdll_dc035bff.bundle` 内 `HotFix.dll`：
  SHA256 `6a32ab4c5c4424f7dbdb72af213c1db5e839b039ebd8a9e8e8d4644279fc0d27`。
  `LoginPanel.InitLoginPanelView` 查找 `Root/EnterInfo/m_Btn_EnterGame` 上的 Button，
  并将它及 `m_Btn_EnterGame/Title_button` 的点击事件绑定到
  `LoginPanel.OnClickEnterGame`。后者检查服务器并触发原有进入游戏流程。
- Unity 官方 Button 实现：
  <https://github.com/Unity-Technologies/uGUI/blob/main/com.unity.ugui/Runtime/UGUI/UI/Core/Button.cs>。
  无参 `Press()` 先检查 `IsActive()`、`IsInteractable()`，再调用 `m_OnClick.Invoke()`；
  鼠标左键的 `OnPointerClick` 也调用这个方法。通过 Unity 的无参 SendMessage 调用
  已存在的 Button 方法，不绕过其禁用检查。
- Unity 浏览器通信接口：
  <https://docs.unity3d.com/cn/2022.2/Manual/webgl-interactingwithbrowserscripting.html>。

## 运行约束

桥接只安装在官方来源的顶层页面，只接受绑定到 `unity-canvas` 的 Unity 实例。
登录观察器确认 `signed_in` 且官方加载条隐藏后，只允许调用
`SendMessage('m_Btn_EnterGame', 'Press')`，不接受外部传入对象名、方法名或参数。
重复检查相隔至少四秒；按钮尚未启用时由 Unity 自己忽略调用。

已登录但尚未安装捕获 hook 的旧游戏窗口，会先注册新文档 hook，再最多重新加载一次。
登录失效返回 401；捕获失败不会无限重新加载。
`src/game/official-session.mjs` 在活动连接尚未就绪时按四秒间隔请求这项导航。
官方 socket 可能在登录面板就已连接，这不代表角色已经进入游戏，因此不能仅凭 socket
存在就停止导航。连接就绪后停止导航，并等待初始查询结束，再发送本次活动请求。

## 关闭窗口后的登录恢复

当前官方客户端启动时会同步调用首次 `logout`，紧接着调用 `login('userinfo', 'tm')`。
2026-11-19 的真实排查确认：官方刷新登录接口已返回成功，随后却因这次启动退出清除了
本地登录记录。这是关闭窗口后重新启动游戏时显示登录失效的原因。

`src/browser/login-session.mjs` 仅保留官方 SDK 已完成恢复的首次启动登录：将首次退出
暂缓到当前微任务结束，如果同一同步流程紧接着调用上述官方登录入口，就继续使用
已恢复的会话。独立退出、第二次退出、其他登录参数、授权回跳和未恢复的登录仍走
官方原有流程；不伪造登录结果，也不跳过官方登录校验。

Unity 的原生退出桥接有时会直接传入数字 `state` 指针。程序只在捕获的官方 Unity
实例中核对该位置是否恰好是 `tm\0` 三个字节；字符串 `state` 则须等于 `tm`。
检查只返回是否匹配，不读取任意字符串，也不把内存或登录凭据复制到 Node.js。

新文档预注入脚本属于注册它的 CDP 会话，断开后重新连接必须再次注册。
`src/browser/browser-page-hooks.mjs` 在每次连接游戏时注册登录和导航脚本，确保该连接
随后触发的重新加载仍有完整支持。同一页面重复安装时保留已有观察器，避免重复定义。
这些保护针对签到台控制的启动和重新加载；未保持 CDP 连接时，手动按 F5 不在保证范围内。

如果官方更改 loader、canvas、按钮名或 Unity 的 Button 行为，需重新核对公开资源。
单元测试验证捕获时序、来源和登录限制、固定调用参数、限频及失败处理；
它们不能代替使用当前官方客户端的实际启动验证。

2026-11-19 的隔离无账号浏览器验证确认了公开 loader 的实例捕获时序，
并通过活跃的同类型公告按钮验证了当前 Unity 的原生 `Press` 调用：

- 恢复仅用于测试页的 `console.log` 转发，确保 Unity 的错误不会被官方页面吞掉。
- 对明确不存在对象调用 `Press` 的负对照报告对象未找到，未触发公告处理器。
- `SendMessage('BtnNotice', 'Press')` 没有对象或接收方法错误。
  随后精确观察到官方 `WebLogger` 请求的 `item=点击公告按钮`，与 DLL 中的
  `LoginPanel.OnNoticeClick` 一致；同时收到公告资源请求，前后截图确认公告窗口出现。
  这证明私有 `Button.Press` 确实可被派发，并执行已有的 `onClick` 处理器。

未登录时真正的进入游戏按钮尚未激活，仍报告对象未找到。公告按钮验证只确认按钮调用
机制；隔离浏览器没有输入账号凭据或发送签到、领奖请求，临时配置在结束后清理。
验证脚本和截图仅在 `.local/` 中保留。

同日完成了已登录第二号的真实冷启动验证：旧游戏窗口已关闭、旧调试端点不可连接，
签到台在后台新启动游戏，官方刷新登录接口返回 HTTP 200，活动连接最终就绪。
`POST /api/activity/progress` 返回 HTTP 200、`source: live`，查询结果为累计 1 天、
本期共 56 天、当天尚未签到。已有连接的只读查询也取得了官方签到日期和礼盒状态。
全新无账号配置仍按预期返回 401。这些验证均未执行签到或领奖。
