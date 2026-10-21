"""Firefox login for isolated Qwen / DeepSeek accounts; all registration is automatic."""
import argparse
from contextlib import closing
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import socket
import sqlite3
import subprocess
import sys
import time

_spec = importlib.util.spec_from_file_location("web_app_ui", Path(__file__).parents[1] / "chatgpt-app/browser_login.py")
ui = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(ui)
from transport import SOURCE, verify_identity
LoginError = ui.LoginError
_remote_spec = importlib.util.spec_from_file_location("web_app_registration", Path(__file__).parents[1] / "chatgpt-app/remote_registration.py")
remote_registration = importlib.util.module_from_spec(_remote_spec)
_remote_spec.loader.exec_module(remote_registration)



def firefox_login(profile, domain):
    if not shutil.which("firefox"):
        raise LoginError("Для входа нужен Firefox.")
    profile.mkdir(parents=True, exist_ok=True, mode=0o700)
    (profile / "user.js").write_text('user_pref("browser.shell.checkDefaultBrowser",false);\nuser_pref("browser.aboutwelcome.enabled",false);\n')
    ui.install_bitwarden(profile)
    process = subprocess.Popen(["firefox", "--new-instance", "--profile", str(profile), "https://" + domain + "/"],
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        if process.wait(timeout=1800):
            raise LoginError("Firefox завершился с ошибкой. Другие аккаунты не изменены.")
    finally:
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()


def decode_storage(value, conversion, compression):
    if isinstance(value, str):
        return value
    if compression == 1:
        import cramjam
        value = bytes(cramjam.snappy.decompress_raw(value))
    elif compression != 0:
        raise ValueError("Unsupported Firefox storage compression")
    if conversion not in (0, 1):
        raise ValueError("Unsupported Firefox storage encoding")
    return bytes(value).decode("utf-8" if conversion == 1 else "utf-16-le")


def frontend_version(profile):
    """Use the actual site bundle cached by this login, never a guessed API version."""
    matches = []
    for entry in (profile / "cache2/entries").glob("*"):
        stat = entry.stat()
        if not entry.is_file() or stat.st_size > 10_000_000:
            continue
        versions = set(re.findall(rb"/qwen-chat-fe/([0-9][0-9A-Za-z._-]{1,40})/", entry.read_bytes()))
        if len(versions) == 1:
            matches.append((stat.st_mtime_ns, versions.pop().decode("ascii")))
    if not matches:
        raise LoginError("Не удалось определить версию Qwen. Откройте чат в сохранённом профиле и дождитесь загрузки страницы.")
    return max(matches)[1]


def extract_token(profile, provider):
    domain = "chat.qwen.ai" if provider == "qwen-app" else "chat.deepseek.com"
    with (profile / ".parentlock").open("a") as lock:
        try:
            fcntl.lockf(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise LoginError("Сначала закройте отдельное окно Firefox.") from None
        cookie_path = profile / "cookies.sqlite"
        if provider == "qwen-app" and cookie_path.exists():
            with closing(sqlite3.connect(cookie_path.resolve().as_uri() + "?mode=ro", uri=True)) as db:
                rows = db.execute("SELECT value FROM moz_cookies WHERE host IN (?,?) AND name='token' AND originAttributes='' AND (expiry=0 OR expiry>?) ORDER BY lastAccessed DESC", (domain, "." + domain, int(time.time()))).fetchall()
            if rows:
                return rows[0][0]
        path = profile / "storage/default" / ("https+++" + domain) / "ls/data.sqlite"
        if path.exists():
            with closing(sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True)) as db:
                # Decode only documented authentication entries, not arbitrary site storage.
                rows = db.execute("SELECT key,value,conversion_type,compression_type FROM data WHERE key IN ('userToken','token','accessToken','access_token')").fetchall()
            values = {key: decode_storage(value, conversion, compression) for key, value, conversion, compression in rows}
            for key in ("userToken", "token", "accessToken", "access_token"):
                value = values.get(key)
                if not value:
                    continue
                try:
                    parsed = json.loads(value)
                except (ValueError, TypeError):
                    parsed = value
                if isinstance(parsed, dict):
                    parsed = parsed.get("value") or parsed.get("token") or parsed.get("accessToken")
                if isinstance(parsed, str) and parsed.strip():
                    return parsed.strip()
    raise LoginError("В профиле не найдена активная сессия. Завершите вход на сайте и закройте окно.")


def refresh_credentials(profile):
    """Only Qwen auth/clearance cookies, never unrelated browser cookies."""
    with (profile / ".parentlock").open("a") as lock:
        try:
            fcntl.lockf(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise LoginError("Сначала закройте отдельное окно Firefox.") from None
        with closing(sqlite3.connect((profile / "cookies.sqlite").resolve().as_uri() + "?mode=ro", uri=True)) as db:
            rows = db.execute("SELECT name,value FROM moz_cookies WHERE ((host='.qwen.ai' AND name='refresh_token') OR (host='auth.qwen.ai' AND name IN ('auth-session','acw_tc'))) AND originAttributes='' AND (expiry=0 OR expiry>?) ORDER BY lastAccessed", (int(time.time()),)).fetchall()
    fields = {"refresh_token": "refreshToken", "auth-session": "authSession", "acw_tc": "authClearance"}
    result = {fields[key]: value for key, value in rows}
    if not result.get("refreshToken"):
        raise LoginError("В профиле не найдена сессия обновления Qwen. Завершите вход на сайте.")
    return result


def allocate(root, provider, email, account_id):
    directory = root / "accounts" / hashlib.sha256(email.encode()).hexdigest()[:24]
    descriptor = directory / "session.json"
    if descriptor.exists():
        previous = ui.read_private(descriptor)
        if previous["provider"] != provider or previous["accountId"] != account_id or previous["email"] != email:
            raise LoginError("Сохранённое подключение принадлежит другому аккаунту; оно не изменено.")
        return directory, previous
    reserved = {int(ui.read_private(p)["baseUrl"].split(":")[-1].split("/")[0]) for p in (root / "accounts").glob("*/session.json")}
    start = 3240 if provider == "qwen-app" else 3340
    for port in range(start, start + 100):
        if port in reserved:
            continue
        with socket.socket() as sock:
            try:
                sock.bind(("127.0.0.1", port))
            except OSError:
                continue
        return directory, dict(provider=provider, email=email, accountId=account_id,
                               baseUrl=f"http://127.0.0.1:{port}/v1", apiKey=secrets.token_urlsafe(32))
    raise LoginError("Нет свободного локального порта.")


def start_bridge(directory, provider):
    service = "rotator-" + provider + "-" + directory.name[:12] + ".service"
    units = Path.home() / ".config/systemd/user"
    units.mkdir(parents=True, exist_ok=True)
    paths = (sys.executable, str(Path(__file__).with_name("transport.py")), str(directory / "transport.json"))
    if any('"' in p or "\n" in p or "%" in p for p in paths):
        raise LoginError("Недопустимый путь моста.")
    content = ('[Unit]\nDescription=Lyod private ' + provider + '\nAfter=network-online.target\n\n[Service]\nType=simple\n'
               f'ExecStart="{paths[0]}" "{paths[1]}" --config "{paths[2]}"\n'
               'Restart=on-failure\nRestartSec=5\nStandardOutput=null\nStandardError=null\nUMask=0077\n\n[Install]\nWantedBy=default.target\n')
    (units / service).write_text(content)
    remote_registration.systemctl_user("daemon-reload", timeout=15)
    remote_registration.systemctl_user("enable", service, timeout=20)
    remote_registration.systemctl_user("restart", service, timeout=20)
    return service


def check_bridge(connection):
    import urllib.request
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    for attempt in range(30):
        try:
            req = urllib.request.Request(connection["baseUrl"] + "/models", headers={"Authorization": "Bearer " + connection["apiKey"]})
            with opener.open(req, timeout=3) as response:
                result = json.load(response)
            if result.get("accountId") != connection["accountId"] or not isinstance(result.get("data"), list):
                raise ValueError()
            return result["data"]
        except Exception:
            if attempt == 29:
                raise LoginError("Локальный мост не прошёл проверку. Профиль сохранён, другие аккаунты не изменены.") from None
            time.sleep(1)


def register(settings, connection, descriptor):
    status = dict(email=connection["email"], sessionFile=str(descriptor), registered=False)
    root = Path(settings["configDir"])
    ui.save_private(root / "login-status.json", status)
    if settings.get("remote"):
        script = Path(__file__).parents[1] / "chatgpt-app/remote_registration.py"
        try:
            result = subprocess.run([sys.executable, str(script)], input=json.dumps(dict(provider=settings["provider"],
                remote=settings["remote"], connection=connection)), text=True, check=True, capture_output=True, timeout=240)
            status["registered"] = json.loads(result.stdout).get("registered") is True
            if not status["registered"]:
                raise ValueError()
        except Exception:
            raise LoginError("Локальная сессия сохранена. Регистрация на сервере не прошла; повторите rotator-" +
                             settings["provider"].removesuffix("-app") + "-login --register-only --account " + connection["email"]) from None
    ui.save_private(root / "login-status.json", status)


def connect(settings, expected=None, progress=lambda _text: None):
    import asyncio
    provider = settings["provider"]
    root = Path(settings["configDir"])
    with (root / "login.lock").open("a") as lock:
        os.chmod(lock.name, 0o600)
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise LoginError("Вход уже открыт.") from None
        profiles = root / "firefox-profiles"
        profiles.mkdir(parents=True, exist_ok=True, mode=0o700)
        # New account gets a fresh profile: Google cannot silently choose the previous account.
        profile = profiles / (hashlib.sha256(expected.encode()).hexdigest()[:24] if expected else "new-" + secrets.token_hex(8))
        if expected:
            record = root / "accounts" / hashlib.sha256(expected.encode()).hexdigest()[:24] / "browser-profile.json"
            if record.exists():
                candidate = Path(ui.read_private(record)["path"])
                if candidate.parent.resolve() != profiles.resolve():
                    raise LoginError("Недопустимый сохранённый профиль.")
                profile = candidate
        domain = "chat.qwen.ai" if provider == "qwen-app" else "chat.deepseek.com"
        progress("Войдите на сайт и закройте отдельное окно Firefox.")
        firefox_login(profile, domain)
        token = extract_token(profile, provider)
        version = frontend_version(profile) if provider == "qwen-app" else None
        refresh = refresh_credentials(profile) if provider == "qwen-app" else {}
        auth_config = dict(token=token, frontendVersion=version, **refresh)
        if settings.get("proxy"):
            for key in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"):
                os.environ[key] = settings["proxy"]
        sys.path.insert(0, str(SOURCE))
        async def identity():
            if provider == "qwen-app":
                from freetokenapi.qwen.client import QwenClient
                client = QwenClient(token=token, timeout=30)
            else:
                from freetokenapi.deepseek.client import DeepSeekClient
                client = DeepSeekClient(token=token, timeout=30)
            try:
                if provider == "qwen-app":
                    from qwen_auth import QwenAuth
                    await QwenAuth(auth_config).ensure(client)
                return await verify_identity(client, provider)
            finally:
                await client.aclose()
        progress("Проверяем аккаунт и каталог моделей…")
        try:
            account_id, email = asyncio.run(identity())
        except Exception:
            raise LoginError("Сайт не подтвердил личность аккаунта. Профиль сохранён; другие подключения не изменены.") from None
        if expected and expected != email:
            raise LoginError("Вход выполнен в другой аккаунт; прежнее подключение не изменено.")
        directory, connection = allocate(root, provider, email, account_id)
        directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        path = directory / "transport.json"
        previous = ui.read_private(path) if path.exists() else None
        ui.save_private(path, dict(provider=provider, email=email, accountId=account_id, **auth_config,
                                  port=int(connection["baseUrl"].split(":")[-1].split("/")[0]), apiKey=connection["apiKey"], proxy=settings.get("proxy")))
        try:
            start_bridge(directory, provider)
            connection["availableModels"] = check_bridge(connection)
        except Exception:
            if previous:
                ui.save_private(path, previous)
                start_bridge(directory, provider)
            else:
                service = "rotator-" + provider + "-" + directory.name[:12] + ".service"
                remote_registration.systemctl_user("disable", "--now", service, timeout=20)
                path.unlink(missing_ok=True)
            raise
        descriptor = directory / "session.json"
        ui.save_private(descriptor, connection)
        ui.save_private(directory / "browser-profile.json", {"path": str(profile)})
        register(settings, connection, descriptor)
        return email


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--provider", choices=("qwen-app", "deepseek-app"), required=True)
    parser.add_argument("--account")
    parser.add_argument("--open")
    parser.add_argument("--register-only", action="store_true")
    parser.add_argument("--no-page", action="store_true")
    args = parser.parse_args()
    root = Path.home() / ".config/lyod-rotator" / args.provider
    ui.SCHEME = "lyod-" + args.provider.removesuffix("-app")
    ui.PAGE = ui.PAGE.replace("ChatGPT", "Qwen" if args.provider == "qwen-app" else "DeepSeek")
    ui.connect = connect
    try:
        settings = ui.read_private(root / "browser-login.json")
        expected = ui.parse_link(args.open, settings["origin"]) if args.open else ui.email_value(args.account) if args.account else None
        if args.register_only:
            if not expected:
                raise LoginError("Укажите --account для сохранённого подключения.")
            descriptor = root / "accounts" / hashlib.sha256(expected.encode()).hexdigest()[:24] / "session.json"
            connection = ui.read_private(descriptor)
            if connection["email"] != expected or connection["provider"] != args.provider:
                raise LoginError("Сохранённый аккаунт не совпадает.")
            connection["availableModels"] = check_bridge(connection)
            ui.save_private(descriptor, connection)
            register(settings, connection, descriptor)
            print("Подключение зарегистрировано: " + expected)
            return 0
        return ui.run_login(settings, expected, open_page=not args.no_page)
    except Exception as exc:
        print(str(exc) if isinstance(exc, LoginError) else "Вход не завершён. Профиль сохранён; другие аккаунты не изменены.", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
