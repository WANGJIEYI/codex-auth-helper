# Codex 认证助手 · Fork 说明

基于 `zhishile/codex-auth-helper`（v1.1.0，main 分支 2026-06-07 快照）的本地修改版。
目的只有一个：**把「网页会话 → auth.json」这条路修到它应有的上限**，并且不再对外宣称它做不到的事。

---

## 一、改了什么

| # | 位置 | 原版 | Fork 版 | 为什么 |
|---|---|---|---|---|
| 1 | `popup.js` `generateCodexAuthJson` | `refresh_token: session.sessionToken \|\| "placeholder"` | `refresh_token: ""` | 任何伪造值都会被 `auth.openai.com/oauth/token` 判 400；空串语义诚实，且不会让日志被 `invalid_grant` 刷屏 |
| 2 | 同上 | `exp = session.expires ? ... : iat + 30 天` | 只认 `session.expires`，拿不到就抛 `SESSION_EXPIRY_UNKNOWN` | 「编一个 30 天」会让文件看起来还有效，实际请求立刻 401，是最坑的一种失败 |
| 3 | 同上 | id_token `exp` 取 `session.expires` | 与 access_token 的 `exp` **严格对齐** | 原商店版 id_token 写到 +90 天，UI 会骗你说「还有效」 |
| 4 | `renderAuthorizedState` | 无 `expires` 时显示「长期有效 / 无限」 | 显示「未知（无法导出）」 | 同上，阻止导出注定失效的文件 |
| 5 | 新增 `#ttl-warning` 警告条 | — | 剩余 < 24h 或读不到过期时间时飘红 | 到期前主动提醒，而不是等 Codex 报错 |
| 6 | 导出按钮 | 直接导出 | 剩余 < 10 分钟拒绝导出 | 少走一轮「导出了但秒死」 |
| 7 | `popup.js` 尾部 | — | `module.exports`（仅 Node 生效） | 让转换函数可以脱离浏览器做单元测试 |
| 8 | `manifest.json` | 1.1.0 | 1.2.0，名称带 `(Fork)` | 避免和商店版混淆 |
| 9 | `tools/` | — | `test_payload.js`、`check_auth.py` | 11 项断言 + 一份凭证体检脚本 |

**没有改**：`background.js`（只做 `fetch /api/auth/session` 和 `downloads.download`，本身没问题）、任何网络请求、任何权限声明。

---

## 二、它能做到 / 做不到

| 目标 | 结论 |
|---|---|
| 跳过 Codex 登录的设备/短信验证，把已登录的网页会话变成 `auth.json` | ✅ 可以（前提：网页端本身能登录） |
| 让 Codex 桌面端进入已登录状态、能看本地历史会话、能读额度 | ✅ 实测可以 |
| **跑真正的 Codex 推理** | ❌ 实测 **401**（见下节），与 GitHub issue 区「能登录但用不了」一致 |
| 一次导出长期有效、自动续期 | ❌ 原理上不可能，refresh_token 只由授权码+PKCE 流程签发 |
| 期限内的稳定使用（重导周期 5–6 天） | ✅ 只要 `last_refresh` 不超过 8 天且 token 未过期，Codex 不会尝试刷新 |

### 寿命是怎么算出来的

`codex-rs/login/src/auth/manager.rs`：

- `TOKEN_REFRESH_INTERVAL = 8`（天）：`last_refresh` 超过 8 天才触发定时刷新
- 另一条触发条件：`access_token.exp` 进入 5 分钟窗口

所以「不炸」的条件很明确：**`last_refresh` = 导出时刻，且 access_token 未过期**。
网页 session 换来的 access_token 实测寿命约 **5.8 天**，这就是重导周期。

---

## 三、已知边界（实测，2026-11-03）

用本仓库导出的 auth.json 实测：

```
GET  /backend-api/codex/models     -> 400 缺少 client_version 参数  ⇒ 认证已通过
POST /backend-api/codex/responses  -> 401 {"detail":"Unauthorized"}
codex exec "..."                   -> Failed to refresh token: 400 Invalid 'refresh_token': empty string
```

结论：**这套凭证在认证层通过，在推理层被拒**。`/codex/responses` 需要真实 Codex 客户端的 attestation（`x-oai-attestation`，见 `codex-rs/core/src/attestation.rs`）与客户端绑定，网页 token 拿不到这一层。

另外该机器上 `codex doctor` 报：

```
⚠ websocket  Responses WebSocket closed immediately after handshake
```

这是代理/网络层的问题，与凭证无关，但会让 Codex 先走 WebSocket 重连再回落 HTTPS。

**所以本 fork 的定位是：登录 + 查看 + 体检，不是「白嫖推理」。**

---

## 四、安装

1. Chrome 打开 `chrome://extensions/`，开启「开发者模式」
2. 「加载已解压的扩展程序」→ 选本仓库的 `extension` 目录
3. 先确保已登录 `chatgpt.com`，点扩展图标，看到「剩余期限」后导出

导出的 `auth.json` 覆盖到：

- Windows：`%USERPROFILE%\.codex\auth.json`
- macOS / Linux：`~/.codex/auth.json`

覆盖前先备份：`cp ~/.codex/auth.json ~/.codex/auth.json.bak-$(date +%Y%m%d-%H%M%S)`

---

## 五、自测

```bash
# 输出契约（11 项断言，不需要浏览器）
node tools/test_payload.js

# 当前凭证还能活多久、会不会炸
python tools/check_auth.py
python tools/check_auth.py /path/to/auth.json
```

`check_auth.py` 的判定规则：

- 已过期 → ✗
- `refresh_token` 为空且 `last_refresh` > 8 天 → ⚠ 会失败
- 剩余 < 5 分钟 → ⚠ 会失败
- 剩余 < 24h → ⚠ 尽快重导
- 其余 → ✓ 可用，并给出剩余天数

---

## 六、请不要做的事

- 不要把这个 `auth.json` 发给任何人：它等价于账号额度
- 不要在共享/合租账号里放未发表的论文、基金本子原文（会话会同步到账号云端）
- 不要期待它自动续期，也不要去改代码「伪造 refresh_token」——服务端只认授权码流程签发的那一种
