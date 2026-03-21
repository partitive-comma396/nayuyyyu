"""Account pool management — standalone version.

Manages pool.json in the accounts/ directory with file-level locking.
"""
from __future__ import annotations

import fcntl
import json
import logging
from pathlib import Path

log = logging.getLogger("account_pool")

POOL_FILE = Path(__file__).resolve().parent / "accounts" / "pool.json"


def _ensure_file():
    POOL_FILE.parent.mkdir(parents=True, exist_ok=True)
    if not POOL_FILE.exists():
        POOL_FILE.write_text("[]", encoding="utf-8")


def load_pool() -> list[dict]:
    _ensure_file()
    try:
        return json.loads(POOL_FILE.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return []


def add_accounts(accounts: list[dict]) -> list[dict]:
    _ensure_file()
    added = []
    with open(POOL_FILE, "r+", encoding="utf-8") as f:
        fcntl.flock(f, fcntl.LOCK_EX)
        try:
            pool = json.loads(f.read() or "[]")
            existing_emails = {r.get("email") for r in pool}
            for acct in accounts:
                email = acct.get("email", "")
                if not email or email in existing_emails:
                    continue
                rec = {
                    "email": email,
                    "password": acct.get("password", ""),
                    "status": "pending_invite",
                    "quota_5h": None,
                    "quota_weekly": None,
                    "note": "",
                }
                pool.append(rec)
                added.append(rec)
                existing_emails.add(email)
            f.seek(0)
            f.truncate()
            f.write(json.dumps(pool, indent=2, ensure_ascii=False))
        finally:
            fcntl.flock(f, fcntl.LOCK_UN)
    log.info(f"Added {len(added)} accounts to pool")
    return added


def update_account(email: str, **fields) -> bool:
    """当设置 card_key 时自动写入 card_bind_date。"""
    from datetime import date
    if "card_key" in fields and fields["card_key"]:
        fields = dict(fields)
        fields.setdefault("card_bind_date", date.today().isoformat())
    _ensure_file()
    with open(POOL_FILE, "r+", encoding="utf-8") as f:
        fcntl.flock(f, fcntl.LOCK_EX)
        try:
            pool = json.loads(f.read() or "[]")
            updated = False
            for rec in pool:
                if rec.get("email") == email:
                    rec.update(fields)
                    updated = True
                    break
            if updated:
                f.seek(0)
                f.truncate()
                f.write(json.dumps(pool, indent=2, ensure_ascii=False))
        finally:
            fcntl.flock(f, fcntl.LOCK_UN)
    return updated


def remove_account(email: str) -> bool:
    _ensure_file()
    with open(POOL_FILE, "r+", encoding="utf-8") as f:
        fcntl.flock(f, fcntl.LOCK_EX)
        try:
            pool = json.loads(f.read() or "[]")
            new_pool = [r for r in pool if r.get("email") != email]
            if len(new_pool) < len(pool):
                f.seek(0)
                f.truncate()
                f.write(json.dumps(new_pool, indent=2, ensure_ascii=False))
                return True
            return False
        finally:
            fcntl.flock(f, fcntl.LOCK_UN)


# 状态到中文/展示名
STATUS_DISPLAY = {
    "active": "已激活",
    "pending_invite": "代激活",
    "error": "掉车",
    "掉车": "掉车",
    "free": "free",
    "business": "business",
}


def _mask_password(pw: str) -> str:
    if not pw or len(pw) < 4:
        return "***"
    return pw[:2] + "***" + pw[-2:]


def list_pool_summary() -> str:
    pool = load_pool()
    if not pool:
        return "账户池为空"
    lines = []
    for i, acct in enumerate(pool, 1):
        s = acct.get("status", "")
        status_icon = {"active": "🟢", "pending_invite": "🟡", "error": "🔴", "掉车": "🔴"}.get(
            s, "⚪"
        )
        status_text = STATUS_DISPLAY.get(s, s or "?")
        pwd = _mask_password(acct.get("password", "") or "")
        quota_5h = acct.get("quota_5h")
        quota_weekly = acct.get("quota_weekly")
        quota_str = ""
        if quota_5h is not None or quota_weekly is not None:
            quota_str = f"  5h={quota_5h!s} 周={quota_weekly!s}"
        lines.append(
            f"  {i}. {status_icon} {acct.get('email', '?')}  "
            f"[{status_text}]  密码:{pwd}  "
            f"card_key={acct.get('card_key', 'N/A')}{quota_str}"
        )
    header = f"📋 账户池 ({len(pool)} 个账户):"
    return header + "\n" + "\n".join(lines)
