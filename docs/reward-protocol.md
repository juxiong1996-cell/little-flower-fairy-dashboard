# 双生签到累计领奖

协议来源是官方公开客户端 DefaultPackage `2026-11-17-67077` 的
`defaultpackage_assets_res_hotfixdll_dc035bff.bundle`，以及本期官方活动数据表。
HotFix.dll SHA256：`6a32ab4c5c4424f7dbdb72af213c1db5e839b039ebd8a9e8e8d4644279fc0d27`。
分析缓存与 IL 摘录保存在本机 `.local/protocol-evidence/`，不纳入版本控制。

所有下列表体数字均为大端 uint32，沿用 `src/game/official-protocol.mjs` 的加密与滚动序号。

| 命令 | 用途 | 请求体 | 成功回复体 |
| --- | --- | --- | --- |
| 9191 | 查询本期签到日期 | `[season]` | 现有签到查询结构 |
| 9192 | 今日签到 | `[season, day]` | 成功值、物品数量、物品对 |
| 2916 | 查询累计领取标记 | `[1, medalId]` | 记录数，随后每条 `[ID, Value, Time, Flag]` |
| 9195 | 领取累计礼盒 | `[season, rewardIndex]` | 物品数量，随后每项 `[itemId, count]` |

`Req_DoubleSignin.ReqAccReward` 确认命令为 9195。`rewardIndex` 来自配置的 `aId`；
本期是 1–7，不能使用表行 ID 57–63，也不能使用签到门槛 1、3、7、13、20、28、40。
`Res_DoubleSignin.ResAccReward` 的回复没有今日签到所用的 success 字段。
9194 是每日 VIP 补领奖，与这里的累计礼盒不同。

本期累计标记的 medalId 为 3000132796，来自活动配置，不能永久写死。
官方 `UIDoubleSigninMainPanel.SetAccumulateReward` 调用 `MedalCheckFlag.Get2Value(i + 1)`；
该方法实际取一个二进制位，不是每档两个 bit。
领取状态取记录的第二个字段 **Value**，不是第四个字段 Flag：
`((value >>> (rewardIndex - 1)) & 1) === 1` 表示已领取。
只有签到天数达到配置门槛且对应位为 0，才发送 9195。
当前实现要求档次连续且不超过 32，配置结构改变时停止操作。

每次领取后重新请求 9191、2916，确认相应位变成 1 后才报告成功。
超时或查询不一致时保留“待核实”说明，不自动重发领奖请求。
下一次点击会先查官方状态，跳过已经领取的档次。

开发时可用 `node scripts/capture-rewards.mjs 账号别名 90` 只读监听相关数据包，
其中 `账号别名` 替换为本机已登录的账号配置名，`90` 为监听秒数。
工具不点击页面、不发送游戏业务请求，隐藏角色号，结束后保留游戏窗口。
日志不会输出登录凭据、包头角色号或滚动序号。

验证范围：协议编解码、领取门槛和写后状态查询有自动化测试。
尚未完成礼盒从未领取到实际发奖的完整线上测试。
