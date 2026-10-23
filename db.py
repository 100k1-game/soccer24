#!/usr/bin/env python3
"""SOCCER24 storage — Turso (libSQL) with secure auth helpers."""

from __future__ import annotations

import hashlib
import hmac
import os
import re
import secrets
import threading
import time
from pathlib import Path

from dotenv import load_dotenv
from libsql_client import create_client_sync

ROOT = Path(__file__).resolve().parent
load_dotenv(ROOT / ".env")

TURSO_URL = (os.getenv("TURSO_DATABASE_URL") or "").strip().rstrip("/")
TURSO_TOKEN = (os.getenv("TURSO_AUTH_TOKEN") or "").strip()
ADMIN_LOGIN = (os.getenv("ADMIN_LOGIN") or "admin").strip().lower()
ADMIN_PASSWORD = os.getenv("ADMIN_PASSWORD") or "Soccer24Admin!"
ADMIN_EMAIL = (os.getenv("ADMIN_EMAIL") or "admin@soccer24.local").strip().lower()
ADMIN_NAME = "Administrator"
SESSION_SECRET = os.getenv("SESSION_SECRET") or secrets.token_hex(32)

PBKDF2_ROUNDS = 310_000
CAPTCHA_TTL = 5 * 60
LOCK_AFTER = 5
LOCK_MINUTES = 15
EMAIL_RE = re.compile(r"^[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}$", re.I)

_client = None
_client_lock = threading.RLock()
_ready = False


def _http_url(url: str) -> str:
    if url.startswith("libsql://"):
        return "https://" + url[len("libsql://") :]
    return url


def client():
    global _client
    with _client_lock:
        if _client is None:
            if not TURSO_URL or not TURSO_TOKEN:
                raise RuntimeError("Задайте TURSO_DATABASE_URL и TURSO_AUTH_TOKEN в .env")
            _client = create_client_sync(_http_url(TURSO_URL), auth_token=TURSO_TOKEN)
        return _client


def execute(sql: str, args: list | tuple | None = None):
    with _client_lock:
        c = client()
        try:
            return c.execute(sql, list(args or []))
        except Exception:
            # reconnect once
            global _client
            try:
                _client.close()
            except Exception:
                pass
            _client = None
            c = client()
            return c.execute(sql, list(args or []))


def fetchone(sql: str, args: list | tuple | None = None) -> dict | None:
    rs = execute(sql, args)
    if not rs.rows:
        return None
    return rs.rows[0].asdict()


def fetchall(sql: str, args: list | tuple | None = None) -> list[dict]:
    rs = execute(sql, args)
    return [r.asdict() for r in rs.rows]


def hash_password(password: str, salt: str | None = None) -> tuple[str, str]:
    salt = salt or secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac(
        "sha256", password.encode("utf-8"), salt.encode("utf-8"), PBKDF2_ROUNDS
    )
    return salt, digest.hex()


def verify_password(password: str, salt: str, hashed: str) -> bool:
    _, check = hash_password(password, salt)
    return hmac.compare_digest(check, hashed)


def hash_session(token: str) -> str:
    return hmac.new(SESSION_SECRET.encode(), token.encode(), hashlib.sha256).hexdigest()


def hash_captcha_answer(captcha_id: str, answer: int) -> str:
    return hmac.new(
        SESSION_SECRET.encode(), f"{captcha_id}:{answer}".encode(), hashlib.sha256
    ).hexdigest()


def init_db() -> None:
    global _ready
    statements = [
        """
        CREATE TABLE IF NOT EXISTS users (
          id TEXT PRIMARY KEY,
          login TEXT NOT NULL UNIQUE,
          email TEXT NOT NULL UNIQUE,
          name TEXT NOT NULL,
          salt TEXT NOT NULL,
          password TEXT NOT NULL,
          role TEXT NOT NULL DEFAULT 'user',
          banned INTEGER NOT NULL DEFAULT 0,
          subscription_until INTEGER NOT NULL DEFAULT 0,
          created INTEGER NOT NULL,
          failed_logins INTEGER NOT NULL DEFAULT 0,
          locked_until INTEGER NOT NULL DEFAULT 0
        )
        """,
        """
        CREATE TABLE IF NOT EXISTS sessions (
          token_hash TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          exp INTEGER NOT NULL,
          created INTEGER NOT NULL,
          ip TEXT,
          user_agent TEXT
        )
        """,
        """
        CREATE TABLE IF NOT EXISTS streams (
          fixture_id TEXT PRIMARY KEY,
          url TEXT NOT NULL,
          title TEXT NOT NULL,
          by_login TEXT,
          updated INTEGER NOT NULL
        )
        """,
        """
        CREATE TABLE IF NOT EXISTS chat_messages (
          id TEXT PRIMARY KEY,
          fixture_id TEXT NOT NULL,
          user_id TEXT NOT NULL,
          login TEXT NOT NULL,
          name TEXT NOT NULL,
          text TEXT NOT NULL,
          ts REAL NOT NULL,
          deleted INTEGER NOT NULL DEFAULT 0,
          deleted_by TEXT
        )
        """,
        "CREATE INDEX IF NOT EXISTS idx_chat_fixture_ts ON chat_messages(fixture_id, ts)",
        """
        CREATE TABLE IF NOT EXISTS payments (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          login TEXT NOT NULL,
          amount INTEGER NOT NULL,
          currency TEXT NOT NULL,
          method TEXT NOT NULL,
          days INTEGER NOT NULL,
          ts INTEGER NOT NULL,
          status TEXT NOT NULL
        )
        """,
        """
        CREATE TABLE IF NOT EXISTS captchas (
          id TEXT PRIMARY KEY,
          answer_hash TEXT NOT NULL,
          exp INTEGER NOT NULL,
          used INTEGER NOT NULL DEFAULT 0
        )
        """,
        """
        CREATE TABLE IF NOT EXISTS rate_limits (
          key TEXT PRIMARY KEY,
          count INTEGER NOT NULL,
          window_start INTEGER NOT NULL
        )
        """,
        """
        CREATE TABLE IF NOT EXISTS audit_log (
          id TEXT PRIMARY KEY,
          kind TEXT NOT NULL,
          detail TEXT,
          ip TEXT,
          ts INTEGER NOT NULL
        )
        """,
    ]
    for sql in statements:
        execute(sql)
    seed_admin()
    _ready = True


def seed_admin() -> None:
    salt, hashed = hash_password(ADMIN_PASSWORD)
    until = int(time.time()) + 3650 * 86400
    row = fetchone("SELECT id FROM users WHERE login = ?", (ADMIN_LOGIN,))
    if row:
        execute(
            """
            UPDATE users SET email=?, salt=?, password=?, role='admin', name=?, banned=0,
              subscription_until=?, failed_logins=0, locked_until=0
            WHERE login=?
            """,
            (ADMIN_EMAIL, salt, hashed, ADMIN_NAME, until, ADMIN_LOGIN),
        )
    else:
        execute(
            """
            INSERT INTO users
            (id, login, email, name, salt, password, role, banned, subscription_until, created)
            VALUES (?, ?, ?, ?, ?, ?, 'admin', 0, ?, ?)
            """,
            (
                "admin001",
                ADMIN_LOGIN,
                ADMIN_EMAIL,
                ADMIN_NAME,
                salt,
                hashed,
                until,
                int(time.time()),
            ),
        )


def row_user(row: dict | None) -> dict | None:
    if not row:
        return None
    return {
        "id": row["id"],
        "login": row["login"],
        "email": row.get("email") or "",
        "name": row["name"],
        "salt": row["salt"],
        "password": row["password"],
        "role": row["role"],
        "banned": bool(row["banned"]),
        "subscriptionUntil": int(row["subscription_until"] or 0),
        "created": int(row["created"] or 0),
        "failedLogins": int(row.get("failed_logins") or 0),
        "lockedUntil": int(row.get("locked_until") or 0),
    }


def get_user_by_login(login: str) -> dict | None:
    return row_user(fetchone("SELECT * FROM users WHERE login = ?", (login,)))


def get_user_by_email(email: str) -> dict | None:
    return row_user(fetchone("SELECT * FROM users WHERE email = ?", (email.lower(),)))


def get_user_by_id(uid: str) -> dict | None:
    return row_user(fetchone("SELECT * FROM users WHERE id = ?", (uid,)))


def create_user(login: str, email: str, name: str, password: str, role: str = "user") -> dict:
    salt, hashed = hash_password(password)
    user = {
        "id": secrets.token_hex(8),
        "login": login,
        "email": email.lower(),
        "name": name,
        "salt": salt,
        "password": hashed,
        "role": role,
        "banned": False,
        "subscriptionUntil": 0,
        "created": int(time.time()),
        "failedLogins": 0,
        "lockedUntil": 0,
    }
    execute(
        """
        INSERT INTO users
        (id, login, email, name, salt, password, role, banned, subscription_until, created)
        VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, ?)
        """,
        (user["id"], login, user["email"], name, salt, hashed, role, user["created"]),
    )
    return user


def save_user(user: dict) -> None:
    execute(
        """
        UPDATE users SET name=?, email=?, role=?, banned=?, subscription_until=?,
          failed_logins=?, locked_until=?
        WHERE id=?
        """,
        (
            user["name"],
            (user.get("email") or "").lower(),
            user.get("role", "user"),
            1 if user.get("banned") else 0,
            int(user.get("subscriptionUntil") or 0),
            int(user.get("failedLogins") or 0),
            int(user.get("lockedUntil") or 0),
            user["id"],
        ),
    )


def list_users() -> list[dict]:
    return [u for u in (row_user(r) for r in fetchall("SELECT * FROM users ORDER BY created DESC")) if u]


def create_session(user_id: str, days: int = 30, ip: str = "", ua: str = "") -> str:
    token = secrets.token_urlsafe(32)
    token_hash = hash_session(token)
    now = int(time.time())
    execute("DELETE FROM sessions WHERE exp < ?", (now,))
    execute(
        """
        INSERT INTO sessions (token_hash, user_id, exp, created, ip, user_agent)
        VALUES (?, ?, ?, ?, ?, ?)
        """,
        (token_hash, user_id, now + days * 86400, now, ip[:64], ua[:200]),
    )
    return token


def delete_session(token: str | None) -> None:
    if not token:
        return
    execute("DELETE FROM sessions WHERE token_hash = ?", (hash_session(token),))


def user_from_session(token: str | None) -> dict | None:
    if not token or len(token) > 128:
        return None
    now = int(time.time())
    row = fetchone(
        """
        SELECT u.* FROM sessions s
        JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = ? AND s.exp > ?
        """,
        (hash_session(token), now),
    )
    return row_user(row)


def get_stream(fixture_id: str) -> dict | None:
    row = fetchone("SELECT * FROM streams WHERE fixture_id = ?", (fixture_id,))
    if not row:
        return None
    return {
        "url": row["url"],
        "title": row["title"],
        "by": row["by_login"],
        "updated": row["updated"],
    }


def set_stream(fixture_id: str, url: str, title: str, by_login: str) -> dict:
    item = {"url": url, "title": title, "by": by_login, "updated": int(time.time())}
    execute(
        """
        INSERT INTO streams (fixture_id, url, title, by_login, updated)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(fixture_id) DO UPDATE SET
          url=excluded.url, title=excluded.title,
          by_login=excluded.by_login, updated=excluded.updated
        """,
        (fixture_id, url, title, by_login, item["updated"]),
    )
    return item


def delete_stream(fixture_id: str) -> None:
    execute("DELETE FROM streams WHERE fixture_id = ?", (fixture_id,))


def list_streams() -> list[dict]:
    rows = fetchall("SELECT * FROM streams ORDER BY updated DESC")
    return [
        {
            "fixtureId": r["fixture_id"],
            "url": r["url"],
            "title": r["title"],
            "by": r["by_login"],
            "updated": r["updated"],
        }
        for r in rows
    ]


def read_chat(fixture_id: str, since: float = 0) -> list[dict]:
    rows = fetchall(
        """
        SELECT * FROM chat_messages
        WHERE fixture_id = ? AND deleted = 0 AND ts > ?
        ORDER BY ts ASC
        """,
        (fixture_id, since),
    )
    return [
        {
            "id": r["id"],
            "ts": r["ts"],
            "userId": r["user_id"],
            "login": r["login"],
            "name": r["name"],
            "text": r["text"],
        }
        for r in rows
    ]


def add_chat(fixture_id: str, user: dict, text: str) -> dict:
    msg = {
        "id": secrets.token_hex(6),
        "ts": time.time(),
        "userId": user["id"],
        "login": user["login"],
        "name": user.get("name") or user["login"],
        "text": text,
    }
    execute(
        """
        INSERT INTO chat_messages
        (id, fixture_id, user_id, login, name, text, ts, deleted)
        VALUES (?, ?, ?, ?, ?, ?, ?, 0)
        """,
        (msg["id"], fixture_id, msg["userId"], msg["login"], msg["name"], msg["text"], msg["ts"]),
    )
    return msg


def soft_delete_chat(fixture_id: str, msg_id: str, by_login: str) -> bool:
    before = fetchone(
        "SELECT id FROM chat_messages WHERE fixture_id=? AND id=? AND deleted=0",
        (fixture_id, msg_id),
    )
    if not before:
        return False
    execute(
        "UPDATE chat_messages SET deleted=1, deleted_by=? WHERE fixture_id=? AND id=?",
        (by_login, fixture_id, msg_id),
    )
    return True


def recent_chats(limit: int = 80) -> list[dict]:
    rows = fetchall(
        "SELECT * FROM chat_messages WHERE deleted=0 ORDER BY ts DESC LIMIT ?",
        (limit,),
    )
    return [
        {
            "id": r["id"],
            "fixtureId": r["fixture_id"],
            "ts": r["ts"],
            "userId": r["user_id"],
            "login": r["login"],
            "name": r["name"],
            "text": r["text"],
        }
        for r in rows
    ]


def add_payment(user: dict, amount: int, days: int, method: str) -> dict:
    pay = {
        "id": secrets.token_hex(6),
        "userId": user["id"],
        "login": user["login"],
        "amount": amount,
        "currency": "RUB",
        "method": method,
        "days": days,
        "ts": int(time.time()),
        "status": "paid",
    }
    execute(
        """
        INSERT INTO payments
        (id, user_id, login, amount, currency, method, days, ts, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            pay["id"],
            pay["userId"],
            pay["login"],
            pay["amount"],
            pay["currency"],
            pay["method"],
            pay["days"],
            pay["ts"],
            pay["status"],
        ),
    )
    return pay


def list_payments(limit: int = 100) -> list[dict]:
    rows = fetchall("SELECT * FROM payments ORDER BY ts DESC LIMIT ?", (limit,))
    return [
        {
            "id": r["id"],
            "userId": r["user_id"],
            "login": r["login"],
            "amount": r["amount"],
            "currency": r["currency"],
            "method": r["method"],
            "days": r["days"],
            "ts": r["ts"],
            "status": r["status"],
        }
        for r in rows
    ]


def stats() -> dict:
    users = fetchone("SELECT COUNT(*) AS c FROM users")["c"]
    banned = fetchone("SELECT COUNT(*) AS c FROM users WHERE banned=1")["c"]
    now = int(time.time())
    subscribers = fetchone(
        "SELECT COUNT(*) AS c FROM users WHERE role != 'admin' AND subscription_until > ?",
        (now,),
    )["c"]
    streams = fetchone("SELECT COUNT(*) AS c FROM streams")["c"]
    messages = fetchone("SELECT COUNT(*) AS c FROM chat_messages WHERE deleted=0")["c"]
    revenue = fetchone("SELECT COALESCE(SUM(amount),0) AS s FROM payments WHERE status='paid'")["s"]
    payments = fetchone("SELECT COUNT(*) AS c FROM payments")["c"]
    return {
        "users": users,
        "banned": banned,
        "subscribers": subscribers,
        "streams": streams,
        "messages": messages,
        "revenue": revenue,
        "payments": payments,
        "db": "turso",
    }


def create_captcha() -> dict:
    a = secrets.randbelow(9) + 1
    b = secrets.randbelow(9) + 1
    op = secrets.choice(["+", "-"])
    if op == "+":
        answer = a + b
        question = f"{a} + {b}"
    else:
        if a < b:
            a, b = b, a
        answer = a - b
        question = f"{a} - {b}"

    captcha_id = secrets.token_urlsafe(16)
    answer_hash = hash_captcha_answer(captcha_id, answer)
    exp = int(time.time()) + CAPTCHA_TTL
    execute("DELETE FROM captchas WHERE exp < ?", (int(time.time()),))
    execute(
        "INSERT INTO captchas (id, answer_hash, exp, used) VALUES (?, ?, ?, 0)",
        (captcha_id, answer_hash, exp),
    )

    svg = f"""<svg xmlns="http://www.w3.org/2000/svg" width="180" height="56" viewBox="0 0 180 56">
  <rect width="180" height="56" rx="10" fill="#0e0e12"/>
  <text x="90" y="36" text-anchor="middle" font-family="Segoe UI, Arial" font-size="24" font-weight="700" fill="#b8f200">{question} = ?</text>
  <line x1="12" y1="14" x2="168" y2="42" stroke="#2a2a32" stroke-width="2"/>
  <line x1="20" y1="44" x2="160" y2="18" stroke="#22222a" stroke-width="2"/>
</svg>"""
    return {"id": captcha_id, "question": question, "svg": svg, "expiresIn": CAPTCHA_TTL}


def verify_captcha(captcha_id: str, answer: str) -> bool:
    if not captcha_id or answer is None or str(answer).strip() == "":
        return False
    try:
        num = int(re.sub(r"[^\d-]", "", str(answer).strip()))
    except ValueError:
        return False
    now = int(time.time())
    expect = hash_captcha_answer(captcha_id, num)
    row = fetchone("SELECT answer_hash, exp, used FROM captchas WHERE id = ?", (captcha_id,))
    if not row:
        return False
    if row["used"] or row["exp"] < now:
        return False
    if not hmac.compare_digest(row["answer_hash"], expect):
        return False
    execute("UPDATE captchas SET used=1 WHERE id=?", (captcha_id,))
    return True


def rate_limit(key: str, limit: int, window_sec: int) -> bool:
    """True если лимит превышен."""
    now = int(time.time())
    row = fetchone("SELECT count, window_start FROM rate_limits WHERE key=?", (key,))
    if not row or now - int(row["window_start"]) >= window_sec:
        execute(
            """
            INSERT INTO rate_limits (key, count, window_start) VALUES (?, 1, ?)
            ON CONFLICT(key) DO UPDATE SET count=1, window_start=excluded.window_start
            """,
            (key, now),
        )
        return False
    count = int(row["count"]) + 1
    execute("UPDATE rate_limits SET count=? WHERE key=?", (count, key))
    return count > limit


def audit(kind: str, detail: str = "", ip: str = "") -> None:
    execute(
        "INSERT INTO audit_log (id, kind, detail, ip, ts) VALUES (?, ?, ?, ?, ?)",
        (secrets.token_hex(8), kind[:40], detail[:200], ip[:64], int(time.time())),
    )


def valid_email(email: str) -> bool:
    return bool(EMAIL_RE.match(email or "")) and len(email) <= 120
