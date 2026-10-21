"""Local Claude.ai login and isolated ClewdR bridges. No credentials in URLs or output."""
import argparse
from contextlib import closing
import fcntl
import hashlib
import importlib.util
import json
import os
import re
from pathlib import Path
import secrets
import shutil
import socket
import sqlite3
import subprocess
import sys
import tempfile
import time

# Reuse the working private-file, URL and status-page code without modifying its module on disk.
_spec = importlib.util.spec_from_file_location("claude_login_ui", Path(__file__).parents[1] / "chatgpt-app/browser_login.py")
ui = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(ui)
ROOT = Path("~/.config/lyod-rotator/claude-app").expanduser()
RELEASE_BINARY = Path("~/.local/share/lyod-rotator/claude-app/clewdr-v0.13.5/clewdr").expanduser()
BINARY = RELEASE_BINARY.parent / "clewdr-lyod"
ui.SCHEME = "lyod-claude"
ui.PAGE = ui.PAGE.replace("ChatGPT", "Claude")
LoginError = ui.LoginError


def read_cookies(profile):
    with (profile / ".parentlock").open("a") as lock:
        try:
            fcntl.lockf(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except (BlockingIOError, PermissionError):
            raise LoginError("Сначала закройте отдельное окно Firefox для Claude.") from None
        with closing(sqlite3.connect((profile / "cookies.sqlite").resolve().as_uri() + "?mode=ro", uri=True)) as db:
            rows = db.execute("SELECT host,path,name,value FROM moz_cookies WHERE host IN ('claude.ai','.claude.ai') AND originAttributes='' AND isSecure=1 AND (expiry=0 OR expiry>?)", (int(time.time()),)).fetchall()
    if not any(row[2] == "sessionKey" for row in rows):
        raise LoginError("В сохранённом профиле нет сессии Claude. Завершите вход на сайте.")
    return rows


def firefox_login(profile, fresh):
    executable = shutil.which("firefox")
    if not executable:
        raise LoginError("Для входа нужен Firefox.")
    profile.mkdir(parents=True, exist_ok=True, mode=0o700)
    with (profile / ".parentlock").open("a") as lock:
        try:
            fcntl.lockf(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except (BlockingIOError, PermissionError):
            raise LoginError("Окно Claude уже открыто; сначала закройте его.") from None
        if fresh and (profile / "cookies.sqlite").exists():
            with closing(sqlite3.connect(profile / "cookies.sqlite")) as db, db:
                db.execute("DELETE FROM moz_cookies WHERE host IN ('claude.ai','.claude.ai','google.com','.google.com','accounts.google.com','.accounts.google.com')")
    (profile / "user.js").write_text('user_pref("browser.shell.checkDefaultBrowser",false);\nuser_pref("browser.aboutwelcome.enabled",false);\n')
    ui.install_bitwarden(profile)
    process = subprocess.Popen([executable, "--new-instance", "--profile", str(profile), "https://claude.ai/"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        if process.wait(timeout=1800) != 0:
            raise LoginError("Firefox завершился с ошибкой. Сохранённые аккаунты не изменены.")
    finally:
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()


def identity(cookies, proxy=None):
    from curl_cffi import requests
    try:
        with requests.Session(impersonate="firefox", proxy=proxy, trust_env=False) as client:
            for host, path, name, value in cookies:
                client.cookies.set(name, value, domain=host, path=path)
            r = client.get("https://claude.ai/api/bootstrap", timeout=45, allow_redirects=False)
            if r.status_code != 200:
                raise LoginError("Claude не подтвердил сессию. Проверьте доступ к сайту в сохранённом Firefox.")
            account = r.json()["account"]
            email = ui.email_value(account["email_address"])
            org = next(m["organization"] for m in account["memberships"] if "chat" in m["organization"].get("capabilities", []))
            catalog = client.get(f'https://claude.ai/api/organizations/{org["uuid"]}/model_selector/chat',
                                 timeout=45, allow_redirects=False)
            if catalog.status_code != 200:
                raise LoginError("Claude не подтвердил список моделей аккаунта. Сохранённые подключения не изменены.")
            models = available_models(catalog.json())
            if not models:
                raise LoginError("Claude не предоставил доступных моделей для этого аккаунта.")
            return {"email": email, "modelSelection": "explicit", "availableModels": models}
    except LoginError:
        raise
    except Exception:
        raise LoginError("Не удалось проверить аккаунт Claude. Профиль сохранён; повторите позже.") from None


def available_models(catalog):
    """Use the account's website selector, never infer entitlement from its plan."""
    surface = next((entry for entry in catalog.get("model_selector_config", []) if entry.get("id") == "chat"), {})
    result = []
    for model in surface.get("models", []):
        name = model.get("id", "")
        if (model.get("disabled") or model.get("disabled_reason") or
                not isinstance(name, str) or not re.fullmatch(r"[a-z0-9-]{1,128}", name)):
            continue
        efforts = [entry["id"] for entry in model.get("thinking", {}).get("effort_options", [])
                   if entry.get("id") in ("low", "medium", "high", "xhigh", "max") and
                   not entry.get("disabled") and not entry.get("disabled_reason")]
        result.append({"id": name, "efforts": efforts})
    return result


def config_text(connection, cookie, proxy=None):
    # All credentials live in the private TOML, never in argv, systemd or environment.
    values = dict(ip="127.0.0.1", port=int(connection["baseUrl"].split(":")[-1].split("/")[0]),
                  password=connection["apiKey"], admin_password=connection["adminApiKey"],
                  rproxy="https://claude.ai/", no_fs=True, log_to_file=False,
                  check_update=False, auto_update=False, max_retries=0,
                  preserve_chats=False, web_search=False, use_real_roles=False,
                  skip_non_pro=False)
    if proxy:
        values["proxy"] = proxy
    return "\n".join(key + " = " + json.dumps(value) for key, value in values.items()) + "\n\n[[cookie_array]]\ncookie = " + json.dumps(cookie) + "\n"


def write_text_private(path, text):
    fd, temporary = tempfile.mkstemp(prefix=".claude-", dir=path.parent)
    try:
        with os.fdopen(fd, "w") as stream:
            stream.write(text)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        Path(temporary).unlink(missing_ok=True)


def start_bridge(directory):
    service = "rotator-claude-app-" + directory.name[:12] + ".service"
    units = Path.home() / ".config/systemd/user"
    units.mkdir(parents=True, exist_ok=True)
    # Logs are disabled: the upstream prints a cookie prefix and its static model catalog is not proof of access.
    text = ("[Unit]\nDescription=Claude App local bridge\nAfter=network-online.target\n\n[Service]\nType=simple\n"
            f'ExecStart="{sys.executable}" "{Path(__file__).with_name("transport.py")}" --binary "{BINARY}" --config "{directory / "clewdr.toml"}"\n'
            "Restart=on-failure\nRestartSec=5\nStandardOutput=null\nStandardError=null\nUMask=0077\n\n[Install]\nWantedBy=default.target\n")
    write_text_private(units / service, text)
    subprocess.run(["systemctl", "--user", "daemon-reload"], check=True, capture_output=True, timeout=15)
    subprocess.run(["systemctl", "--user", "enable", "--now", service], check=True, capture_output=True, timeout=30)
    subprocess.run(["systemctl", "--user", "restart", service], check=True, capture_output=True, timeout=30)
    return service


def allocate(root, email):
    directory = root / "accounts" / hashlib.sha256(email.encode()).hexdigest()[:24]
    if (directory / "session.json").exists():
        previous = ui.read_private(directory / "session.json")
        if previous["email"] != email:
            raise LoginError("Сохранённое подключение Claude не соответствует аккаунту.")
        return directory, previous
    reserved = {int(ui.read_private(p)["baseUrl"].split(":")[-1].split("/")[0]) for p in (root / "accounts").glob("*/session.json")}
    for port in range(3140, 3240):
        if port in reserved:
            continue
        with socket.socket() as sock:
            try:
                sock.bind(("127.0.0.1", port))
            except OSError:
                continue
        return directory, {"email": email, "baseUrl": f"http://127.0.0.1:{port}/v1", "apiKey": secrets.token_urlsafe(32)}
    raise LoginError("Нет свободного локального порта для Claude App.")


def register_remote(settings, connection):
    if not settings.get("remote"):
        return False
    try:
        script = Path(__file__).parents[1] / "chatgpt-app/remote_registration.py"
        result = subprocess.run([sys.executable, str(script)],
                                input=json.dumps({"provider": "claude-app", "remote": settings["remote"], "connection": connection}),
                                text=True, capture_output=True, check=True, timeout=240)
        response = json.loads(result.stdout)
        if response.get("registered") is not True or response.get("email") != connection["email"]:
            raise ValueError()
        return True
    except Exception:
        raise LoginError("Локальный мост Claude сохранён, но сервер не подтвердил подключение. Повторите "
                         "rotator-claude-login --register-only --account " + connection["email"] +
                         ". Повторный вход в Firefox не нужен.") from None


def save_registration(settings, connection, descriptor):
    status = {"email": connection["email"], "sessionFile": str(descriptor), "registered": False}
    root = Path(settings["configDir"])
    ui.save_private(root / "login-status.json", status)
    status["registered"] = register_remote(settings, connection)
    ui.save_private(root / "login-status.json", status)
    return status["registered"]


def connect(settings, expected=None, progress=lambda text: None):
    root = Path(settings["configDir"])
    if not BINARY.is_file():
        raise LoginError("Не установлен ClewdR с исправлением Retry-After: запустите scripts/claude-app/build-bridge.py.")
    with (root / "login.lock").open("a") as lock:
        os.chmod(lock.name, 0o600)
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise LoginError("Вход Claude уже открыт.") from None
        profile = root / "firefox-profiles" / (hashlib.sha256(expected.encode()).hexdigest()[:24] if expected else "add-account")
        if expected:
            saved_profile = root / "accounts" / hashlib.sha256(expected.encode()).hexdigest()[:24] / "browser-profile.json"
            if saved_profile.exists():
                candidate = Path(ui.read_private(saved_profile)["path"])
                if candidate.parent.resolve() != (root / "firefox-profiles").resolve():
                    raise LoginError("Недопустимый путь сохранённого профиля Claude.")
                profile = candidate
        progress("Войдите в Claude и закройте именно отдельное окно Firefox.")
        firefox_login(profile, fresh=expected is None)
        progress("Проверяем аккаунт Claude…")
        cookies = read_cookies(profile)
        session = identity(cookies, settings.get("proxy") or None)
        if expected and expected != session["email"]:
            raise LoginError("Ожидался " + expected + ", выполнен вход в " + session["email"] + ". Другие аккаунты не изменены.")
        directory, connection = allocate(root, session["email"])
        directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        connection.update(modelSelection=session["modelSelection"], availableModels=session.get("availableModels", []))
        connection.setdefault("adminApiKey", secrets.token_urlsafe(32))
        config, descriptor = directory / "clewdr.toml", directory / "session.json"
        old_config = config.read_bytes() if config.exists() else None
        old_descriptor = descriptor.read_bytes() if descriptor.exists() else None
        try:
            write_text_private(config, config_text(connection, next(c[3] for c in cookies if c[2] == "sessionKey"), settings.get("proxy")))
            ui.save_private(descriptor, connection)
            start_bridge(directory)
            ui.check_bridge(connection)
        except Exception:
            if old_config is not None:
                write_text_private(config, old_config.decode())
                write_text_private(descriptor, old_descriptor.decode())
                start_bridge(directory)
            else:
                service = "rotator-claude-app-" + directory.name[:12] + ".service"
                subprocess.run(["systemctl", "--user", "disable", "--now", service], capture_output=True, timeout=30)
                config.unlink(missing_ok=True)
                descriptor.unlink(missing_ok=True)
            raise LoginError("Локальный мост Claude не прошёл проверку; прежнее подключение восстановлено.") from None
        if expected is None:
            saved = root / "firefox-profiles" / (directory.name + "-" + secrets.token_hex(4))
            profile.rename(saved)
            profile = saved
        ui.save_private(directory / "browser-profile.json", {"path": str(profile)})
        progress("Подключаем Claude к ротатору…")
        registered = save_registration(settings, connection, descriptor)
        progress("Аккаунт Claude подключён к ротатору." if registered else "Локальный мост готов; серверная регистрация не настроена.")
        return session["email"]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--account")
    parser.add_argument("--open")
    parser.add_argument("--register-only", action="store_true")
    parser.add_argument("--no-page", action="store_true")
    args = parser.parse_args()
    try:
        settings = ui.read_private(ROOT / "browser-login.json")
        expected = ui.parse_link(args.open, settings["origin"]) if args.open else ui.email_value(args.account) if args.account else None
        if args.register_only:
            if not expected:
                raise LoginError("Укажите --account для регистрации сохранённого подключения.")
            descriptor = Path(settings["configDir"]) / "accounts" / hashlib.sha256(expected.encode()).hexdigest()[:24] / "session.json"
            connection = ui.read_private(descriptor)
            if connection["email"].casefold() != expected.casefold():
                raise LoginError("Сохранённый аккаунт не совпадает с запрошенным.")
            ui.check_bridge(connection)
            if not save_registration(settings, connection, descriptor):
                raise LoginError("Серверная регистрация не настроена.")
            print("Аккаунт Claude подключён к ротатору: " + connection["email"])
            return 0
        return ui.run_login(settings, expected, open_page=not args.no_page)
    except Exception as error:
        print(str(error) if isinstance(error, LoginError) else "Не удалось завершить вход Claude App; сохранённые аккаунты не изменены.", file=sys.stderr)
        return 1


ui.connect = connect
if __name__ == "__main__":
    raise SystemExit(main())
