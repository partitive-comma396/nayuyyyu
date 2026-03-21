"""
Multi-account authentication with round-robin rotation.
Reads all JSON files from the accounts directory and cycles through them.
"""

import json
import os
import re
import threading
import base64
import time
from pathlib import Path
from typing import Any, Optional


class AccountInfo:
    def __init__(self, filepath: str, data: dict):
        self.filepath = filepath
        self.access_token: str = data.get("tokens", {}).get("access_token", "")
        self.account_id: str = data.get("tokens", {}).get("account_id", "")
        self.refresh_token: str = data.get("tokens", {}).get("refresh_token", "")
        self.request_count = 0
        self.error_count = 0
        self.last_error: str = ""
        self.is_healthy = True
        self.quota_reset_at: Optional[float] = None  # Unix 时间戳：5h 额度恢复时间

        self.email = self._extract_email(data)
        self.label = Path(filepath).stem
        self.plan_type: str = self._extract_plan(data)

    def _extract_plan(self, data: dict) -> str:
        try:
            token = data.get("tokens", {}).get("access_token", "")
            if not token:
                return "free"
            parts = token.split(".")
            if len(parts) < 2:
                return "free"
            payload = parts[1]
            payload += "=" * (4 - len(payload) % 4)
            decoded = json.loads(base64.urlsafe_b64decode(payload))
            plan = decoded.get("https://api.openai.com/auth", {}).get("chatgpt_plan_type", "free")
            return (plan or "free").lower()
        except Exception:
            return "free"

    @property
    def is_team_tier(self) -> bool:
        return self.plan_type in (
            "team", "business", "enterprise", "pro", "plus", "gopro", "edu"
        )

    def _extract_email(self, data: dict) -> str:
        # Direct email field (from add_account.js)
        direct = data.get("email", "")
        if direct and direct != "unknown":
            return direct

        # Decode from id_token JWT
        id_token = data.get("tokens", {}).get("id_token", "")
        if id_token:
            try:
                parts = id_token.split(".")
                if len(parts) >= 2:
                    payload = parts[1]
                    payload += "=" * (4 - len(payload) % 4)
                    decoded = json.loads(base64.urlsafe_b64decode(payload))
                    return decoded.get("email", "unknown")
            except Exception:
                pass

        # Decode from access_token JWT
        access_token = data.get("tokens", {}).get("access_token", "")
        if access_token:
            try:
                parts = access_token.split(".")
                if len(parts) >= 2:
                    payload = parts[1]
                    payload += "=" * (4 - len(payload) % 4)
                    decoded = json.loads(base64.urlsafe_b64decode(payload))
                    email = decoded.get("email") or decoded.get("https://api.openai.com/auth", {}).get("email")
                    if email:
                        return email
            except Exception:
                pass

        return "unknown"

    @property
    def is_valid(self) -> bool:
        return bool(self.access_token and self.account_id)


class MultiAccountManager:
    def __init__(self):
        self._accounts: list[AccountInfo] = []
        self._index = 0
        self._lock = threading.Lock()
        self._load_accounts()

    def _load_accounts(self):
        accounts_dir = os.environ.get(
            "ACCOUNTS_DIR",
            os.path.join(os.path.dirname(__file__), "..", "..", "accounts"),
        )
        accounts_dir = os.path.abspath(accounts_dir)

        if os.path.isdir(accounts_dir):
            for f in sorted(os.listdir(accounts_dir)):
                if f.endswith(".json"):
                    fp = os.path.join(accounts_dir, f)
                    try:
                        with open(fp, "r", encoding="utf-8") as fh:
                            data = json.load(fh)
                        acct = AccountInfo(fp, data)
                        if acct.is_valid:
                            self._accounts.append(acct)
                            print(f"  ✅ Loaded account: {acct.label} ({acct.email})")
                        else:
                            print(f"  ❌ Invalid account file: {f}")
                    except Exception as e:
                        print(f"  ❌ Error loading {f}: {e}")

        if not self._accounts:
            from .request import read_auth_file
            fallback = read_auth_file()
            if fallback:
                acct = AccountInfo("~/.codex/auth.json", fallback)
                if acct.is_valid:
                    self._accounts.append(acct)
                    print(f"  ✅ Fallback account: {acct.email}")

        print(f"📋 Total accounts loaded: {len(self._accounts)}")

    def get_account_by_email(self, email: str) -> Optional[AccountInfo]:
        """Get account by email (for admin/check-drop)."""
        for a in self._accounts:
            if (a.email or "").strip().lower() == (email or "").strip().lower():
                return a
        return None

    def get_next_account(self) -> Optional[AccountInfo]:
        if not self._accounts:
            return None

        with self._lock:
            healthy = [a for a in self._accounts if a.is_healthy]
            if not healthy:
                for a in self._accounts:
                    a.is_healthy = True
                healthy = self._accounts

            now = time.time()
            def not_quota_exhausted(a: AccountInfo) -> bool:
                return a.quota_reset_at is None or a.quota_reset_at <= now

            # Team + Free 额度全部加入轮换，优先用有额度的
            ready = [a for a in healthy if not_quota_exhausted(a)]
            pool = ready if ready else healthy
            acct = pool[self._index % len(pool)]
            self._index += 1
            acct.request_count += 1
            return acct

    @staticmethod
    def _extract_resets_at(error_str: str) -> Optional[float]:
        """从 429 错误体中提取 ChatGPT 返回的真实 resets_at 时间戳。"""
        m = re.search(r'"resets_at"\s*:\s*(\d{10,})', error_str)
        if m:
            return float(m.group(1))
        m2 = re.search(r'"resets_in_seconds"\s*:\s*(\d+)', error_str)
        if m2:
            return time.time() + float(m2.group(1))
        return None

    def report_error(self, account: AccountInfo, error: str):
        error_str = str(error).lower()
        is_429 = (
            "429" in error_str
            or "rate limit" in error_str
            or "too many requests" in error_str
            or "usage limit" in error_str
            or "quota" in error_str
        )
        if is_429:
            # 429 = 5h 额度暂时耗尽，不是账号故障；仅记录恢复时间，不计入错误次数
            real_reset = self._extract_resets_at(str(error))
            if real_reset and real_reset > time.time():
                account.quota_reset_at = real_reset
            elif account.quota_reset_at is None or time.time() >= account.quota_reset_at:
                account.quota_reset_at = time.time() + 5 * 3600
            account.last_error = str(error)
            return
        account.error_count += 1
        account.last_error = str(error)
        if account.error_count >= 3:
            account.is_healthy = False

    def report_success(self, account: AccountInfo):
        account.error_count = max(0, account.error_count - 1)
        account.quota_reset_at = None  # 请求成功说明额度已恢复

    def get_status(self) -> list[dict]:
        now = time.time()
        return [
            {
                "label": a.label,
                "email": a.email,
                "healthy": a.is_healthy,
                "plan": a.plan_type,
                "requests": a.request_count,
                "errors": a.error_count,
                "quota_reset_at": a.quota_reset_at if (a.quota_reset_at and a.quota_reset_at > now) else None,
            }
            for a in self._accounts
        ]

    @property
    def count(self) -> int:
        return len(self._accounts)


account_manager = MultiAccountManager()
