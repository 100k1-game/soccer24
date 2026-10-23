#!/usr/bin/env python3
"""SOCCER24 server: API proxy + Turso + captcha + hardened auth."""

from __future__ import annotations

import json
import os
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from http.cookies import SimpleCookie
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from dotenv import load_dotenv

import db

ROOT = Path(__file__).resolve().parent
load_dotenv(ROOT / ".env")

CACHE_DIR = ROOT / ".cache" / "api-football"

API_KEY = (os.getenv("API_FOOTBALL_KEY") or "").strip()
API_BASE = "https://v3.football.api-sports.io"
CACHE_TTL = 15 * 60
PORT = int(os.getenv("PORT") or 8080)
HOST = (os.getenv("HOST") or "0.0.0.0").strip()
SESSION_DAYS = 30
CHAT_MAX_LEN = 280
CHAT_RATE_SEC = 1.2
SUB_PRICE = 45
SUB_DAYS = 30
LOGIN_RE = re.compile(r"^[a-z0-9_]{3,24}$")
STANDINGS_SEASONS = (2024, 2023, 2022)
MAX_BODY = 64 * 1024
# Render / production HTTPS → Secure cookies
IS_PROD = (
    os.getenv("RENDER") == "true"
    or os.getenv("FORCE_HTTPS") == "1"
    or os.getenv("APP_ENV") == "production"
)
ALLOWED_HOSTS = {
    h.strip().lower().split(":")[0]
    for h in (os.getenv("ALLOWED_HOSTS") or "127.0.0.1,localhost").split(",")
    if h.strip()
}
APP_ORIGIN = (os.getenv("APP_ORIGIN") or "").strip().rstrip("/")
if APP_ORIGIN:
    try:
        oh = urllib.parse.urlparse(APP_ORIGIN).hostname
        if oh:
            ALLOWED_HOSTS.add(oh.lower())
    except Exception:
        pass
for o in (os.getenv("ALLOWED_ORIGINS") or "").split(","):
    o = o.strip().rstrip("/")
    if not o:
        continue
    try:
        oh = urllib.parse.urlparse(o if "://" in o else f"https://{o}").hostname
        if oh:
            ALLOWED_HOSTS.add(oh.lower())
    except Exception:
        pass

ALLOWED = {
    "fixtures",
    "fixtures/events",
    "fixtures/statistics",
    "fixtures/lineups",
    "standings",
    "teams",
    "leagues",
    "status",
    "countries",
}

SAFE_STATIC = re.compile(r"^/?(?:[\w./\-]+\.(?:html|css|js|svg|png|jpg|jpeg|webp|ico|woff2?)|)$")

_chat_last: dict[str, float] = {}


def has_sub(user: dict | None) -> bool:
    if not user:
        return False
    if user.get("role") == "admin":
        return True
    return int(user.get("subscriptionUntil") or 0) > time.time()


def public_user(user: dict) -> dict:
    until = int(user.get("subscriptionUntil") or 0)
    return {
        "id": user["id"],
        "login": user["login"],
        "email": user.get("email") or "",
        "name": user.get("name") or user["login"],
        "role": user.get("role", "user"),
        "banned": bool(user.get("banned")),
        "subscriptionUntil": until,
        "subscribed": has_sub(user),
        "created": user.get("created"),
    }


def cache_path(endpoint: str, query: str) -> Path:
    safe = urllib.parse.quote(f"{endpoint}?{query}", safe="")
    return CACHE_DIR / f"{safe}.json"


def fetch_api(endpoint: str, query: str) -> tuple[int, bytes, str]:
    if not API_KEY:
        return 503, json.dumps({"errors": {"config": "API key missing"}}).encode(), "ERROR"
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    path = cache_path(endpoint, query)
    if path.exists() and time.time() - path.stat().st_mtime < CACHE_TTL:
        return 200, path.read_bytes(), "HIT"
    url = f"{API_BASE}/{endpoint}"
    if query:
        url = f"{url}?{query}"
    req = urllib.request.Request(
        url,
        headers={"x-apisports-key": API_KEY, "User-Agent": "Soccer24/5.0"},
        method="GET",
    )
    try:
        with urllib.request.urlopen(req, timeout=25) as resp:
            data = resp.read()
            path.write_bytes(data)
            return 200, data, "MISS"
    except urllib.error.HTTPError as e:
        body = e.read() if hasattr(e, "read") else b""
        if path.exists():
            return 200, path.read_bytes(), f"STALE({e.code})"
        if not body:
            body = json.dumps({"errors": {"http": e.code}}).encode()
        return e.code, body, "ERROR"
    except Exception as e:  # noqa: BLE001
        if path.exists():
            return 200, path.read_bytes(), "STALE"
        return 502, json.dumps({"errors": {"network": str(e)}}).encode(), "ERROR"


def parse_api_json(raw: bytes) -> dict:
    try:
        return json.loads(raw.decode("utf-8"))
    except Exception:  # noqa: BLE001
        return {}


def load_standings_smart(league_id: str) -> dict:
    last_error = None
    for season in STANDINGS_SEASONS:
        code, raw, _ = fetch_api("standings", f"league={league_id}&season={season}")
        data = parse_api_json(raw)
        if code >= 400 or (data.get("errors") and not data.get("response")):
            last_error = data.get("errors") or {"http": code}
            continue
        resp = data.get("response") or []
        if not resp:
            continue
        league = resp[0].get("league") or {}
        groups = league.get("standings") or []
        if not groups or not groups[0]:
            continue
        return {
            "ok": True,
            "season": season,
            "seasonLabel": f"{season}/{str(season + 1)[2:]}",
            "league": {
                "id": league.get("id"),
                "name": league.get("name"),
                "country": league.get("country"),
                "logo": league.get("logo"),
            },
            "groups": groups,
        }
    return {"ok": False, "error": last_error or "Таблица недоступна", "groups": [], "season": None}


def validate_register(login: str, email: str, password: str, password2: str) -> str | None:
    if not LOGIN_RE.match(login):
        return "Логин: 3–24 символа, только a-z, 0-9 и _"
    if not db.valid_email(email):
        return "Укажите корректную почту"
    if len(password) < 8:
        return "Пароль не короче 8 символов"
    if len(password) > 64:
        return "Пароль слишком длинный"
    if password != password2:
        return "Пароли не совпадают"
    if password.lower() == login or password.lower() == email.lower():
        return "Пароль не должен совпадать с логином или почтой"
    return None


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "same-origin")
        self.send_header("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
        self.send_header(
            "Content-Security-Policy",
            "default-src 'self'; img-src 'self' data: https:; media-src 'self' https:; "
            "frame-src https://www.youtube.com https://player.twitch.tv https://www.twitch.tv; "
            "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; "
            "font-src 'self' https://fonts.gstatic.com data:; "
            "script-src 'self'; connect-src 'self'",
        )
        origin = self.headers.get("Origin")
        if origin and self._origin_ok(origin):
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Access-Control-Allow-Credentials", "true")
            self.send_header("Access-Control-Allow-Headers", "Content-Type")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
        elif not origin:
            self.send_header("Access-Control-Allow-Origin", "null")
        super().end_headers()

    def _host_allowed(self, host: str | None) -> bool:
        if not host:
            return False
        host = host.lower().split(":")[0]
        if host in ALLOWED_HOSTS:
            return True
        if host.endswith(".onrender.com"):
            return True
        return False

    def _origin_ok(self, origin: str) -> bool:
        try:
            # same-origin browser posts always have a valid Origin
            host = urllib.parse.urlparse(origin).hostname
            if self._host_allowed(host):
                return True
            # local dev without Origin list
            if not IS_PROD and host in ("127.0.0.1", "localhost"):
                return True
            return False
        except Exception:
            return False

    def _check_origin_mutating(self) -> bool:
        # Same-origin requests from the site itself: allow missing Origin
        # (some browsers omit it for same-site navigations / form posts via fetch with credentials)
        origin = self.headers.get("Origin")
        if not origin:
            return True
        if self._origin_ok(origin):
            return True
        self._json(403, {"error": "Недопустимый Origin"})
        return False

    def do_OPTIONS(self):
        self.send_response(204)
        self.end_headers()

    def _client_ip(self) -> str:
        forwarded = (self.headers.get("X-Forwarded-For") or "").split(",")[0].strip()
        if forwarded:
            return forwarded[:64]
        return self.client_address[0] if self.client_address else ""

    def _cookie_flags(self) -> str:
        # Secure on HTTPS (Render); Lax works better across navigations than Strict
        secure = "; Secure" if IS_PROD or self.headers.get("X-Forwarded-Proto") == "https" else ""
        return f"Path=/; HttpOnly; SameSite=Lax{secure}; Max-Age={SESSION_DAYS * 86400}"

    def _json(self, code: int, payload: dict, set_cookie: str | None = None, clear_cookie: bool = False):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        if set_cookie:
            self.send_header("Set-Cookie", f"s24={set_cookie}; {self._cookie_flags()}")
        if clear_cookie:
            secure = "; Secure" if IS_PROD or self.headers.get("X-Forwarded-Proto") == "https" else ""
            self.send_header("Set-Cookie", f"s24=; Path=/; HttpOnly; SameSite=Lax{secure}; Max-Age=0")
        self.end_headers()
        self.wfile.write(body)

    def _read_json(self) -> dict:
        length = int(self.headers.get("Content-Length") or 0)
        if length > MAX_BODY:
            return {}
        raw = self.rfile.read(length) if length else b"{}"
        try:
            data = json.loads(raw.decode("utf-8") or "{}")
            return data if isinstance(data, dict) else {}
        except json.JSONDecodeError:
            return {}

    def _token(self) -> str | None:
        cookie = SimpleCookie(self.headers.get("Cookie"))
        if "s24" in cookie:
            return cookie["s24"].value
        return None

    def _current_user(self) -> dict | None:
        return db.user_from_session(self._token())

    def _require_user(self) -> dict | None:
        user = self._current_user()
        if not user:
            self._json(401, {"error": "Нужна авторизация"})
            return None
        if user.get("banned"):
            self._json(403, {"error": "Аккаунт заблокирован"})
            return None
        return user

    def _require_admin(self) -> dict | None:
        user = self._require_user()
        if user is None:
            return None
        if user.get("role") != "admin":
            self._json(403, {"error": "Только для администратора"})
            return None
        return user

    def _require_captcha(self, body: dict) -> str | None:
        ok = db.verify_captcha(str(body.get("captchaId") or ""), str(body.get("captchaAnswer") or ""))
        if not ok:
            return "Неверная или просроченная капча"
        return None

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        qs = urllib.parse.parse_qs(parsed.query)

        if path == "/auth/captcha":
            ip = self._client_ip()
            if db.rate_limit(f"captcha:{ip}", 60, 600):
                return self._json(429, {"error": "Слишком много запросов капчи"})
            return self._json(200, db.create_captcha())

        if path == "/auth/me":
            user = self._current_user()
            return self._json(
                200,
                {
                    "user": public_user(user) if user else None,
                    "pricing": {"price": SUB_PRICE, "days": SUB_DAYS, "currency": "RUB"},
                    "security": {"captcha": True, "db": "turso", "gate": True},
                },
            )

        if path.startswith("/standings/"):
            return self._json(200, load_standings_smart(path[len("/standings/") :].strip("/")))

        if path.startswith("/streams/"):
            fixture_id = path[len("/streams/") :].strip("/")
            item = db.get_stream(fixture_id)
            user = self._current_user()
            if not item:
                return self._json(200, {"stream": None, "locked": False})
            if has_sub(user):
                return self._json(200, {"stream": item, "locked": False})
            return self._json(
                200,
                {
                    "stream": {
                        "title": item.get("title") or "Прямая трансляция",
                        "by": item.get("by"),
                        "hasStream": True,
                    },
                    "locked": True,
                    "price": SUB_PRICE,
                },
            )

        if path.startswith("/chat/"):
            fixture_id = path[len("/chat/") :].strip("/")
            since = 0.0
            try:
                since = float((qs.get("since") or ["0"])[0])
            except ValueError:
                since = 0.0
            return self._json(200, {"messages": db.read_chat(fixture_id, since)})

        if path == "/admin/stats":
            if not self._require_admin():
                return
            return self._json(200, db.stats())

        if path == "/admin/users":
            if not self._require_admin():
                return
            users = [public_user(u) for u in db.list_users() if u]
            return self._json(200, {"users": users})

        if path == "/admin/streams":
            if not self._require_admin():
                return
            return self._json(200, {"streams": db.list_streams()})

        if path == "/admin/chats":
            if not self._require_admin():
                return
            limit = 80
            try:
                limit = min(200, max(20, int((qs.get("limit") or ["80"])[0])))
            except ValueError:
                pass
            return self._json(200, {"messages": db.recent_chats(limit)})

        if path == "/admin/payments":
            if not self._require_admin():
                return
            return self._json(200, {"payments": db.list_payments()})

        if path.startswith("/api/"):
            endpoint = path[len("/api/") :].strip("/")
            if endpoint not in ALLOWED:
                return self._json(400, {"error": "Endpoint not allowed"})
            code, data, cache = fetch_api(endpoint, parsed.query)
            self.send_response(code)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("X-Cache", cache)
            self.end_headers()
            self.wfile.write(data)
            return

        # block path traversal / odd static paths
        if ".." in path or path.startswith("/data") or path.startswith("/."):
            self.send_error(404)
            return

        return super().do_GET()

    def do_POST(self):
        if not self._check_origin_mutating():
            return
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        body = self._read_json()
        ip = self._client_ip()

        if path == "/auth/register":
            if db.rate_limit(f"reg:{ip}", 5, 3600):
                return self._json(429, {"error": "Слишком много регистраций с этого IP"})
            cap_err = self._require_captcha(body)
            if cap_err:
                return self._json(400, {"error": cap_err})
            login = (body.get("login") or "").strip().lower()
            email = (body.get("email") or "").strip().lower()
            password = body.get("password") or ""
            password2 = body.get("password2") or password
            name = (body.get("name") or "").strip() or login
            err = validate_register(login, email, password, password2)
            if err:
                return self._json(400, {"error": err})
            if login == db.ADMIN_LOGIN:
                return self._json(409, {"error": "Этот логин занят"})
            if db.get_user_by_login(login):
                return self._json(409, {"error": "Такой логин уже занят"})
            if db.get_user_by_email(email):
                return self._json(409, {"error": "Эта почта уже зарегистрирована"})
            user = db.create_user(login, email, name, password)
            token = db.create_session(
                user["id"], SESSION_DAYS, ip, self.headers.get("User-Agent", "")
            )
            db.audit("register", login, ip)
            return self._json(
                201,
                {
                    "user": public_user(user),
                    "ok": True,
                    "offerSubscription": True,
                    "pricing": {"price": SUB_PRICE, "days": SUB_DAYS, "currency": "RUB"},
                },
                set_cookie=token,
            )

        if path == "/auth/login":
            if db.rate_limit(f"login:{ip}", 20, 600):
                return self._json(429, {"error": "Слишком много попыток входа. Подождите."})
            cap_err = self._require_captcha(body)
            if cap_err:
                return self._json(400, {"error": cap_err})
            login = (body.get("login") or "").strip().lower()
            password = body.get("password") or ""
            user = db.get_user_by_login(login)
            now = int(time.time())
            if user and int(user.get("lockedUntil") or 0) > now:
                left = int(user["lockedUntil"] - now)
                return self._json(423, {"error": f"Аккаунт временно заблокирован ({left} сек)"})
            if not user or not db.verify_password(password, user["salt"], user["password"]):
                if user:
                    fails = int(user.get("failedLogins") or 0) + 1
                    user["failedLogins"] = fails
                    if fails >= db.LOCK_AFTER:
                        user["lockedUntil"] = now + db.LOCK_MINUTES * 60
                        user["failedLogins"] = 0
                    db.save_user(user)
                db.audit("login_fail", login, ip)
                return self._json(401, {"error": "Неверный логин или пароль"})
            if user.get("banned"):
                return self._json(403, {"error": "Аккаунт заблокирован модерацией"})
            user["failedLogins"] = 0
            user["lockedUntil"] = 0
            db.save_user(user)
            token = db.create_session(
                user["id"], SESSION_DAYS, ip, self.headers.get("User-Agent", "")
            )
            db.audit("login_ok", login, ip)
            return self._json(200, {"user": public_user(user), "ok": True}, set_cookie=token)

        if path == "/auth/logout":
            db.delete_session(self._token())
            return self._json(200, {"ok": True}, clear_cookie=True)

        if path == "/billing/subscribe":
            user = self._require_user()
            if user is None:
                return
            method = (body.get("method") or "card").strip()[:32]
            now = int(time.time())
            base = max(now, int(user.get("subscriptionUntil") or 0))
            user["subscriptionUntil"] = base + SUB_DAYS * 86400
            db.save_user(user)
            pay = db.add_payment(user, SUB_PRICE, SUB_DAYS, method)
            return self._json(200, {"ok": True, "user": public_user(user), "payment": pay})

        if path.startswith("/chat/"):
            user = self._require_user()
            if user is None:
                return
            fixture_id = re.sub(r"[^0-9A-Za-z_-]", "", path[len("/chat/") :].strip("/"))[:32]
            text = re.sub(r"\s+", " ", (body.get("text") or "").strip())
            if not text:
                return self._json(400, {"error": "Пустое сообщение"})
            if len(text) > CHAT_MAX_LEN:
                return self._json(400, {"error": f"Максимум {CHAT_MAX_LEN} символов"})
            key = f"{user['id']}:{fixture_id}"
            now = time.time()
            if now - _chat_last.get(key, 0) < CHAT_RATE_SEC:
                return self._json(429, {"error": "Слишком часто, подождите"})
            _chat_last[key] = now
            msg = db.add_chat(fixture_id, user, text)
            return self._json(201, {"ok": True, "message": msg})

        return self._json(404, {"error": "Not found"})

    def do_PUT(self):
        if not self._check_origin_mutating():
            return
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        body = self._read_json()

        if path == "/auth/profile":
            user = self._require_user()
            if user is None:
                return
            name = (body.get("name") or "").strip()
            if len(name) < 2 or len(name) > 40:
                return self._json(400, {"error": "Имя: от 2 до 40 символов"})
            user["name"] = name
            db.save_user(user)
            return self._json(200, {"ok": True, "user": public_user(user)})

        if path.startswith("/streams/"):
            user = self._require_user()
            if user is None:
                return
            if user.get("role") != "admin":
                return self._json(403, {"error": "Трансляции подключает только админ"})
            fixture_id = re.sub(r"[^0-9A-Za-z_-]", "", path[len("/streams/") :].strip("/"))[:32]
            url = (body.get("url") or "").strip()
            title = (body.get("title") or "").strip() or "Прямая трансляция"
            if url and not (url.startswith("https://") or url.startswith("http://")):
                return self._json(400, {"error": "Ссылка должна начинаться с https://"})
            if not url:
                db.delete_stream(fixture_id)
                return self._json(200, {"ok": True, "stream": None})
            item = db.set_stream(fixture_id, url, title, user["login"])
            return self._json(200, {"ok": True, "stream": item})

        if path.startswith("/admin/users/"):
            admin = self._require_admin()
            if admin is None:
                return
            uid = path[len("/admin/users/") :].strip("/")
            target = db.get_user_by_id(uid)
            if not target:
                return self._json(404, {"error": "Пользователь не найден"})
            if target.get("login") == db.ADMIN_LOGIN and body.get("banned"):
                return self._json(400, {"error": "Нельзя забанить главного админа"})
            if "banned" in body:
                target["banned"] = bool(body["banned"])
            if "name" in body and str(body["name"]).strip():
                target["name"] = str(body["name"]).strip()[:40]
            if body.get("grantSub"):
                now = int(time.time())
                base = max(now, int(target.get("subscriptionUntil") or 0))
                target["subscriptionUntil"] = base + SUB_DAYS * 86400
            if body.get("revokeSub"):
                target["subscriptionUntil"] = 0
            if body.get("role") in ("user", "admin") and target.get("login") != db.ADMIN_LOGIN:
                target["role"] = body["role"]
            db.save_user(target)
            return self._json(200, {"ok": True, "user": public_user(target)})

        return self._json(404, {"error": "Not found"})

    def do_DELETE(self):
        if not self._check_origin_mutating():
            return
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path

        if path.startswith("/admin/chat/"):
            admin = self._require_admin()
            if admin is None:
                return
            parts = path[len("/admin/chat/") :].strip("/").split("/")
            if len(parts) != 2:
                return self._json(400, {"error": "Bad path"})
            fixture_id, msg_id = parts
            ok = db.soft_delete_chat(fixture_id, msg_id, admin["login"])
            if not ok:
                return self._json(404, {"error": "Сообщение не найдено"})
            return self._json(200, {"ok": True})

        if path.startswith("/streams/"):
            admin = self._require_admin()
            if admin is None:
                return
            fixture_id = path[len("/streams/") :].strip("/")
            db.delete_stream(fixture_id)
            return self._json(200, {"ok": True})

        return self._json(404, {"error": "Not found"})

    def log_message(self, fmt, *args):
        print("[%s] %s" % (self.log_date_time_string(), fmt % args))


if __name__ == "__main__":
    print("Connecting Turso…", flush=True)
    db.init_db()
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print("SOCCER24 -> http://%s:%s" % (HOST, PORT), flush=True)
    print("DB -> Turso (%s)" % db._http_url(db.TURSO_URL), flush=True)
    print("Admin: %s / (from env)" % db.ADMIN_LOGIN, flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.", flush=True)
