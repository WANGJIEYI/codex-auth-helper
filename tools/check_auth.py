#!/usr/bin/env python3
"""auth.json 体检：判断这份 Codex 凭证还能用多久、什么时候会炸。

用法：
    python tools/check_auth.py                 # 默认读 ~/.codex/auth.json
    python tools/check_auth.py D:/path/auth.json

只读取，不修改任何文件，不打印任何 token 值。
"""
from __future__ import annotations

import base64
import datetime as dt
import json
import os
import sys

REFRESH_INTERVAL_DAYS = 8        # codex-rs: TOKEN_REFRESH_INTERVAL
PROACTIVE_WINDOW_MIN = 5         # codex-rs: CHATGPT_ACCESS_TOKEN_REFRESH_WINDOW_MINUTES


def b64d(seg: str) -> bytes:
    seg += "=" * (-len(seg) % 4)
    return base64.urlsafe_b64decode(seg)


def jwt_claims(tok: str) -> dict:
    try:
        parts = tok.split(".")
        if len(parts) != 3:
            return {}
        return json.loads(b64d(parts[1]))
    except Exception:
        return {}


def fmt(ts: float) -> str:
    return dt.datetime.fromtimestamp(ts).strftime("%Y-%m-%d %H:%M")


def human(delta: float) -> str:
    """秒 -> 人话"""
    sign = "-" if delta < 0 else ""
    d = abs(delta)
    if d >= 86400:
        return f"{sign}{d / 86400:.1f} 天"
    if d >= 3600:
        return f"{sign}{d / 3600:.1f} 小时"
    return f"{sign}{d / 60:.0f} 分钟"


def main() -> int:
    path = sys.argv[1] if len(sys.argv) > 1 else os.path.expanduser("~/.codex/auth.json")
    if not os.path.exists(path):
        print(f"找不到文件：{path}")
        return 2

    with open(path, encoding="utf-8") as f:
        data = json.load(f)

    tokens = data.get("tokens") or {}
    access = tokens.get("access_token") or ""
    refresh = tokens.get("refresh_token") or ""
    idt = tokens.get("id_token") or ""

    if not access:
        print("✗ 没有 access_token，这份文件不可用。")
        return 1

    ac = jwt_claims(access)
    claims = ac.get("https://api.openai.com/auth") or {}
    now = dt.datetime.now().timestamp()
    exp = ac.get("exp")

    print(f"文件：{path}")
    print(f"账号：{jwt_claims(idt).get('email') or '?'}"
          f"  plan={claims.get('chatgpt_plan_type') or '?'}"
          f"  acct={(tokens.get('account_id') or '')[:13]}")
    print(f"auth_mode={data.get('auth_mode')}  文件大小={os.path.getsize(path)} bytes")

    if not exp:
        print("✗ access_token 解析不出 exp，无法判断寿命。")
        return 1

    remain = exp - now
    print(f"access_token 过期：{fmt(exp)}（剩余 {human(remain)}）")

    last_refresh_raw = data.get("last_refresh")
    lr = None
    if last_refresh_raw:
        try:
            lr = dt.datetime.fromisoformat(last_refresh_raw.replace("Z", "+00:00")).timestamp()
            print(f"last_refresh：{fmt(lr)}（{human(now - lr)} 前）")
        except Exception:
            print(f"last_refresh：{last_refresh_raw}（解析失败）")
    else:
        print("last_refresh：缺失")

    print(f"refresh_token：{'空（无法自动续期）' if not refresh else f'非空（{len(refresh)} 字符）'}")

    print("-" * 52)
    if remain <= 0:
        print("✗ 已过期。Codex 会要求重新登录，只能重新导出。")
        return 1

    problems = []
    if not refresh:
        # 只要触发刷新就必败，所以两个触发条件都要盯住
        if lr and (now - lr) > REFRESH_INTERVAL_DAYS * 86400:
            problems.append(
                f"last_refresh 已超过 {REFRESH_INTERVAL_DAYS} 天 → Codex 下次启动会尝试刷新并失败"
            )
        if remain <= PROACTIVE_WINDOW_MIN * 60:
            problems.append(f"access_token 剩余不足 {PROACTIVE_WINDOW_MIN} 分钟 → 会触发刷新并失败")

    if problems:
        print("⚠ 预计会失败：")
        for p in problems:
            print(f"   - {p}")
        print("   建议立刻重新导出（或重新登录）。")
        return 1

    if remain < 86400:
        print(f"⚠ 还能用 {human(remain)}，今天之内会失效，建议尽快重新导出。")
        return 0

    print(f"✓ 可用。约 {human(remain)} 后失效。")
    if not refresh:
        print(f"  到期前请重新导出；期间只要 last_refresh 不超过 "
              f"{REFRESH_INTERVAL_DAYS} 天，就不会触发刷新。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
