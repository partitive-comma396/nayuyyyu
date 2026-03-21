#!/usr/bin/env python3
"""
Codex API Manager — 统一管理入口

一键流水线 (最常用):
  python manage.py go ZB-XXXXXXXX              # 注册→激活→提token→返回API key
  python manage.py go ZB-XXXXXXXX abc.xyz       # 自定义激活网址

其他命令:
  python manage.py proxy                        # 启动反代 (端口9000)
  python manage.py status                       # 查看状态
  python manage.py pool                         # 查看账户池
  python manage.py register                     # 仅注册1个号
  python manage.py add EMAIL PASS               # 仅登录提token
  python manage.py activate redeem KEY EMAIL    # 仅激活
  python manage.py activate warranty KEY        # 仅质保
  python manage.py check-drop [激活网址]         # 一键检测掉车并自动质保（需先启动反代）
  python manage.py warranty-dropped [激活网址]   # 掉车账号一键质保（不检测，直接用卡密质保）
  python manage.py batch-register 14 [--resume] [--no-proxy]  # 批量注册 Free 账号
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
AUTOMATION_DIR = ROOT / "automation"
PROXY_DIR = ROOT / "proxy"
ACCOUNTS_DIR = ROOT / "accounts"


def _load_api_key() -> str:
    try:
        text = (PROXY_DIR / ".env").read_text(encoding="utf-8")
        for line in text.splitlines():
            if line.startswith("KEY="):
                return line.split("=", 1)[1].strip()
    except Exception:
        pass
    return "sk-test"


PROXY_API_KEY = _load_api_key()


def run_node(script: str, args: list[str], env_extra: dict | None = None):
    cmd = ["node", str(AUTOMATION_DIR / script)] + args
    env = {**os.environ, **(env_extra or {})}
    env["NODE_NO_WARNINGS"] = "1"
    try:
        proc = subprocess.run(cmd, cwd=str(AUTOMATION_DIR), env=env)
        return proc.returncode
    except FileNotFoundError:
        print("❌ 需要 Node.js (v18+): brew install node")
        return 1
    except KeyboardInterrupt:
        print("\n⏹ 已中断")
        return 130


def run_node_capture(script: str, args: list[str], timeout_s: int = 300) -> tuple[int, str]:
    """Run node script, capture stdout, return (returncode, stdout)."""
    cmd = ["node", str(AUTOMATION_DIR / script)] + args
    env = {**os.environ, "NODE_NO_WARNINGS": "1"}
    try:
        proc = subprocess.run(
            cmd, cwd=str(AUTOMATION_DIR), env=env,
            capture_output=True, text=True, timeout=timeout_s,
        )
        return proc.returncode, proc.stdout
    except subprocess.TimeoutExpired:
        return 1, ""
    except FileNotFoundError:
        return 1, ""


def check_npm(directory: Path):
    if not (directory / "node_modules").exists():
        print("📦 首次运行，安装依赖...")
        subprocess.run(["npm", "install"], cwd=str(directory), check=True)
        print("📦 安装浏览器...")
        subprocess.run(["npx", "playwright", "install", "firefox"], cwd=str(directory), check=True)
        print()


# ─── Commands ─────────────────────────────────────────────────────────

def cmd_go(card_key: str, activation_url: str = "team.654301.xyz"):
    """一键全自动: 注册 → 激活 → 提token → 返回API key"""
    check_npm(AUTOMATION_DIR)
    rc = run_node("pipeline.js", [card_key, activation_url])
    if rc == 0:
        print()
        print("💡 提示: 运行 'python manage.py proxy' 启动反代后即可使用 API")
    return rc


def cmd_proxy():
    env_file = PROXY_DIR / ".env"
    if not env_file.exists():
        print("❌ 未找到 proxy/.env")
        return 1
    print("🚀 启动 Codex2API 反代 (Ctrl+C 停止)")
    print(f"   账户目录: {ACCOUNTS_DIR}")
    print()
    try:
        subprocess.run(
            [sys.executable, "-m", "codex2api"],
            cwd=str(PROXY_DIR),
            env={**os.environ, "ACCOUNTS_DIR": str(ACCOUNTS_DIR)},
        )
    except KeyboardInterrupt:
        print("\n⏹ 已停止")
    return 0


def cmd_register():
    print("🤖 注册 1 个 ChatGPT 账号...")
    check_npm(AUTOMATION_DIR)
    return run_node("run-register.js", ["1"], {"REGISTER_COUNT": "1", "OUTPUT_JSON": "1"})


def cmd_add(email: str, password: str, label: str | None = None):
    args = [email, password]
    if label:
        args.append(label)
    print(f"🔑 登录提取 token: {email}")
    check_npm(AUTOMATION_DIR)
    return run_node("add_account.js", args)


def cmd_activate(mode: str, card_key: str, email: str = "", activation_url: str | None = None):
    url = activation_url or "team.654301.xyz"
    args = [mode, card_key, email or "", url]
    check_npm(AUTOMATION_DIR)
    return run_node("activate_account.js", args)


def cmd_pool(action: str = "list", *args):
    from account_pool import load_pool, add_accounts, remove_account, list_pool_summary, update_account

    if action in ("list", ""):
        print(list_pool_summary())
    elif action == "add":
        if len(args) < 2:
            print("Usage: python manage.py pool add EMAIL PASSWORD [CARD_KEY]")
            return 1
        email, password = args[0], args[1]
        added = add_accounts([{"email": email, "password": password}])
        if added and len(args) > 2:
            update_account(email, card_key=args[2])
        print(f"{'✅ 已添加' if added else '⚠️ 已存在'}: {email}")
    elif action == "remove":
        if not args:
            print("Usage: python manage.py pool remove EMAIL")
            return 1
        ok = remove_account(args[0])
        print(f"{'✅ 已移除' if ok else '⚠️ 未找到'}: {args[0]}")
    else:
        print(f"未知: {action}")
        return 1
    return 0


def cmd_status():
    import urllib.request
    from account_pool import load_pool, STATUS_DISPLAY

    print("=" * 50)
    print("📊 Codex API Manager")
    print("=" * 50)

    pool = load_pool()
    active = sum(1 for a in pool if a.get("status") == "active")
    pending = sum(1 for a in pool if a.get("status") == "pending_invite")
    errored = sum(1 for a in pool if a.get("status") in ("error", "掉车"))
    print(f"\n📋 账户池: {len(pool)} (🟢{active} 已激活 / 🟡{pending} 代激活 / 🔴{errored} 掉车或异常)")

    # 5 小时 / 1 周 API 总额度（从 pool 汇总，若有）
    has_quota = any(a.get("quota_5h") is not None or a.get("quota_weekly") is not None for a in pool)
    if has_quota:
        print("📊 API 额度（来自账户池）:")
        for a in pool:
            q5, qw = a.get("quota_5h"), a.get("quota_weekly")
            if q5 is not None or qw is not None:
                print(f"   {a.get('email', '?')}  5小时={q5}  1周={qw}")

    auth_files = [f for f in (ROOT / "accounts").glob("*.json") if f.name != "pool.json"]
    print(f"\n🔐 Token: {len(auth_files)} 个 ({', '.join(f.stem for f in auth_files)})")

    print()
    try:
        req = urllib.request.Request("http://localhost:18923/health")
        with urllib.request.urlopen(req, timeout=3) as resp:
            print("🟢 反代: 运行中 (http://localhost:18923)")
    except Exception:
        print("🔴 反代: 未运行 → python manage.py proxy")

    try:
        req = urllib.request.Request(
            "http://localhost:18923/v1/accounts",
            headers={"Authorization": f"Bearer {PROXY_API_KEY}"},
        )
        with urllib.request.urlopen(req, timeout=3) as resp:
            data = json.loads(resp.read())
            for acct in data.get("accounts", []):
                h = "🟢" if acct.get("healthy") else "🔴"
                print(f"   {h} {acct.get('email', '?')} — {acct.get('requests', 0)}次请求")
    except Exception:
        pass

    print(f"\n🔑 API Key: {PROXY_API_KEY}")
    print(f"🌐 API URL: http://localhost:18923/v1")
    print()
    return 0


def _email_to_label(email: str) -> str:
    """与 add_account.js 一致：邮箱前缀，非字母数字替换为下划线。"""
    if not email or "@" not in email:
        return (email or "").replace(" ", "_")
    base = email.split("@")[0]
    return "".join(c if c.isalnum() else "_" for c in base)


def cmd_check_drop(activation_url: str | None = None):
    """实时检测所有有 Token 文件的账号状态（gpt-5.4 xhigh），更新 pool 状态，掉车则自动质保。"""
    import urllib.request
    from account_pool import load_pool, update_account

    if not activation_url:
        try:
            cfg = json.loads((ROOT / "config.json").read_text(encoding="utf-8"))
            activation_url = cfg.get("activation_url") or "team.654301.xyz"
        except Exception:
            activation_url = "team.654301.xyz"

    pool = load_pool()
    # 检测「已激活」「掉车」「封号」「error」的账号
    # pending_invite / free 账号不具备 Business 权限，必然失败，不纳入检测
    to_check = []
    for acct in pool:
        if acct.get("status") not in ("active", "掉车", "封号", "error"):
            continue
        email = acct.get("email", "")
        if not email:
            continue
        label = _email_to_label(email)
        auth_file = ACCOUNTS_DIR / f"{label}.json"
        if not auth_file.exists():
            continue
        to_check.append(email)

    if not to_check:
        print("没有可检测账号（仅对「已激活」或「掉车」且有 Token 文件的账号检测）")
        return 0

    print(f"🔍 实时检测 {len(to_check)} 个账号（gpt-5.4 xhigh）...")
    print(f"   激活网址: {activation_url}")
    req = urllib.request.Request(
        "http://localhost:18923/v1/admin/check-drop",
        data=json.dumps({"emails": to_check}).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {PROXY_API_KEY}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            data = json.loads(resp.read())
    except urllib.error.URLError:
        print("❌ 反代未运行或请求失败，请先启动反代")
        return 1
    except Exception as e:
        print(f"❌ 请求失败: {e}")
        return 1

    results = data.get("results", [])
    ok_list       = [r for r in results if r.get("ok") is True]
    quota_list    = [r for r in results if r.get("ok") == "quota_exhausted"]
    banned_list   = [r for r in results if r.get("ok") is False and r.get("reason") == "banned"]
    dropped_list  = [r for r in results if r.get("ok") is False and r.get("reason") != "banned"]

    # ── 正常账号 ─────────────────────────────────────────────
    pool_by_email = {a.get("email"): a for a in pool}
    for r in ok_list:
        email = r.get("email", "")
        acct = pool_by_email.get(email)
        if acct and acct.get("status") not in ("active",):
            update_account(email, status="active")
            print(f"   ✅ {email}: 正常（已恢复，状态更新为已激活）")
        else:
            print(f"   ✅ {email}: 正常")

    # ── 5h 额度耗尽（不是掉车，不要动状态）────────────────────
    from datetime import datetime
    for r in quota_list:
        email = r.get("email", "")
        reset_at = r.get("quota_reset_at")
        if reset_at:
            reset_str = datetime.fromtimestamp(reset_at).strftime("%H:%M")
            print(f"   ⏰ {email}: 5h 额度耗尽（≠ 掉车），预计 {reset_str} 恢复，跳过质保")
        else:
            print(f"   ⏰ {email}: 5h 额度耗尽（≠ 掉车），跳过质保")

    # ── 封号：登录失败，标记封号，不触发质保 ────────────────────
    for r in banned_list:
        email = r.get("email", "")
        err   = r.get("error", "")
        print(f"   🚫 {email}: 封号（登录失败），已标记")
        update_account(email, status="封号", note=f"登录失败: {err[:120]}")

    if not dropped_list:
        extra = len(quota_list) + len(banned_list)
        note  = f"（另有 {extra} 个账号额度耗尽/封号）" if extra else ""
        print(f"\n✅ 全部 {len(ok_list)} 个账号无掉车{note}")
        return 0

    # ── 掉车：plan 降级（business→free），触发质保 ───────────────
    # 区分"真掉车"和"从未激活过 Business"两种情况
    NOT_BUSINESS_KEYWORDS = [
        "not supported when using Codex with a ChatGPT account",
        "plan does not support",
        "upgrade",
    ]

    def is_not_business_error(err_str: str) -> bool:
        s = (err_str or "").lower()
        return any(k.lower() in s for k in NOT_BUSINESS_KEYWORDS)

    print(f"\n⚠️ 检测到 {len(dropped_list)} 个账号掉车（plan 降级），处理中...")
    for r in dropped_list:
        email = r.get("email", "")
        err   = r.get("error", "")
        acct  = pool_by_email.get(email)
        card_key = (acct or {}).get("card_key") if acct else None

        # model not supported = 从未激活 Business，不是掉车
        if is_not_business_error(err):
            if card_key:
                print(f"   🔧 {email}: 未激活 Business（有卡密），尝试质保激活...")
            else:
                print(f"   ⚠️ {email}: 账号未激活 Business 且无卡密 → 重置为代激活状态")
                update_account(email, status="pending_invite", note="检测到未激活 Business")
                continue

        if not card_key:
            print(f"   ⚠️ {email}: 掉车但无绑定卡密，无法自动质保，跳过（账号继续保留）")
            update_account(email, status="掉车", note=err[:200] if err else "检测掉车")
            continue

        # 先查平台状态，已激活则跳过质保
        need_warranty = True
        try:
            rc_q, out_q = run_node_capture(
                "activate_account.js", ["query", card_key, "", activation_url], timeout_s=45
            )
            if rc_q == 0 and out_q:
                for line in out_q.strip().split("\n"):
                    if line.strip().startswith("{"):
                        try:
                            q = json.loads(line)
                            if q.get("status") == "已激活":
                                print(f"   ⏭ {email}: 平台显示已激活，跳过质保")
                                need_warranty = False
                        except json.JSONDecodeError:
                            pass
                        break
        except Exception:
            pass
        if not need_warranty:
            continue
        print(f"   🔧 {email}: 使用卡密 {card_key[:12]}... 质保中...")
        update_account(email, status="掉车", note=err[:200] if err else "检测掉车")
        rc = run_node("activate_account.js", ["warranty", card_key, "", activation_url])
        if rc == 0:
            print(f"      ✅ 质保提交成功，请稍后重新提取 Token: python manage.py add {email} <密码>")
        else:
            print(f"      ❌ 质保操作失败，账号保留，请手动到激活站质保")

    return 0


def cmd_warranty_dropped(activation_url: str | None = None):
    """掉车账号一键质保：对池中已标记为掉车且绑定了卡密的账号，直接用卡密质保（不做 API 检测）。"""
    from account_pool import load_pool, update_account

    if not activation_url:
        try:
            cfg = json.loads((ROOT / "config.json").read_text(encoding="utf-8"))
            activation_url = cfg.get("activation_url") or "team.654301.xyz"
        except Exception:
            activation_url = "team.654301.xyz"

    pool = load_pool()
    dropped_with_key = [
        a for a in pool
        if a.get("status") in ("掉车", "error") and a.get("card_key")
    ]
    if not dropped_with_key:
        print("没有需要质保的账号（仅对「掉车」且已绑定卡密的账号执行）")
        return 0

    print(f"🔧 对 {len(dropped_with_key)} 个掉车账号执行质保...")
    print(f"   激活网址: {activation_url}")
    for acct in dropped_with_key:
        email = acct.get("email", "")
        card_key = acct.get("card_key", "")
        print(f"   🔧 {email}: 使用卡密 {card_key[:12]}... 质保中...")
        rc = run_node("activate_account.js", ["warranty", card_key, "", activation_url])
        if rc == 0:
            print(f"      ✅ 质保提交成功")
        else:
            print(f"      ❌ 质保失败")
    return 0


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        return 0

    cmd = sys.argv[1].lower()
    args = sys.argv[2:]

    if cmd in ("-h", "--help", "help"):
        print(__doc__)
    elif cmd == "go":
        if not args:
            print("Usage: python manage.py go <卡密> [激活网址]")
            print("  例: python manage.py go ZB-MMHBNA7TKWYU")
            return 1
        return cmd_go(args[0], args[1] if len(args) > 1 else "team.654301.xyz")
    elif cmd == "proxy":
        return cmd_proxy()
    elif cmd == "register":
        return cmd_register()
    elif cmd == "add":
        if len(args) < 2:
            print("Usage: python manage.py add EMAIL PASSWORD [LABEL]")
            return 1
        return cmd_add(args[0], args[1], args[2] if len(args) > 2 else None)
    elif cmd == "activate":
        if len(args) < 2:
            print("Usage: python manage.py activate redeem|warranty CARD_KEY [EMAIL] [激活网址]")
            print("  例: warranty ZB-XXX team.654301.xyz  /  redeem ZB-XXX user@mail.com")
            return 1
        mode, card_key = args[0], args[1]
        if mode == "warranty":
            email_act = ""
            url_act = args[2] if len(args) > 2 else None
        else:
            email_act = args[2] if len(args) > 2 else ""
            url_act = args[3] if len(args) > 3 else None
        return cmd_activate(mode, card_key, email_act, url_act)
    elif cmd == "pool":
        return cmd_pool(args[0] if args else "list", *args[1:])
    elif cmd == "status":
        return cmd_status()
    elif cmd in ("check-drop", "check_drop", "detect-drop"):
        return cmd_check_drop(args[0] if args else None)
    elif cmd in ("warranty-dropped", "warranty_dropped"):
        return cmd_warranty_dropped(args[0] if args else None)
    elif cmd in ("batch-register", "batch_register"):
        if not args:
            print("Usage: python manage.py batch-register <数量> [--resume] [--no-proxy]")
            print("  例: python manage.py batch-register 14")
            print("      python manage.py batch-register 14 --no-proxy  # 直连，间隔 3–5 分钟")
            return 1
        count = args[0]
        resume = "--resume" if "--resume" in args else ""
        no_proxy = "--no-proxy" if "--no-proxy" in args else ""
        check_npm(AUTOMATION_DIR)
        cmd_args = [count]
        if resume:
            cmd_args.append("--resume")
        if no_proxy:
            cmd_args.append("--no-proxy")
        return run_node("batch_register.js", cmd_args)
    else:
        print(f"未知命令: {cmd}")
        print(__doc__)
        return 1


if __name__ == "__main__":
    sys.exit(main() or 0)
