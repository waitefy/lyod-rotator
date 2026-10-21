"""User-initiated Firefox sign-in with a separate local bridge per ChatGPT account."""
import argparse
from contextlib import closing
import fcntl
import hashlib
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
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from firefox_extensions import install_bitwarden, save_bitwarden

ROOT = Path("~/.config/lyod-rotator/chatgpt-app").expanduser()
SCHEME = "lyod-chatgpt"
DESKTOP_ID = "lyod-chatgpt-login.desktop"


class LoginError(ValueError):
    """An actionable message containing no upstream response or credentials."""


def email_value(value):
    if not isinstance(value, str) or len(value) > 254 or not re.fullmatch(
            r"[^\s@<>\x00-\x1f]+@[^\s@<>\x00-\x1f]+\.[^\s@<>\x00-\x1f]+", value):
        raise LoginError("Не удалось определить аккаунт ChatGPT.")
    return value.casefold()


def origin(value):
    p = urlsplit(value)
    if (p.username or p.password or p.path not in ("", "/") or p.query or p.fragment
            or not p.hostname or not (p.scheme == "https" or
            p.scheme == "http" and p.hostname in ("127.0.0.1", "localhost", "::1"))):
        raise LoginError("Нужен HTTPS-адрес ротатора или локальный HTTP-адрес.")
    return p.scheme + "://" + p.netloc.lower()


def parse_link(value, trusted_origin):
    if len(value) > 2048:
        raise LoginError("Некорректная ссылка входа.")
    p = urlsplit(value)
    if p.scheme != SCHEME or p.netloc != "login" or p.path not in ("", "/") or p.fragment:
        raise LoginError("Некорректная ссылка входа.")
    fields = parse_qs(p.query, keep_blank_values=True, strict_parsing=True)
    if set(fields) - {"origin", "account"} or any(len(v) != 1 for v in fields.values()):
        raise LoginError("Некорректные параметры входа.")
    if origin(fields.get("origin", [""])[0]) != origin(trusted_origin):
        raise LoginError("Этот сайт не совпадает с настроенным ротатором.")
    return email_value(fields["account"][0]) if fields.get("account", [""])[0] else None


def save_private(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd, temporary = tempfile.mkstemp(prefix=".chatgpt-login-", dir=path.parent)
    try:
        with os.fdopen(fd, "w") as stream:
            json.dump(value, stream)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        Path(temporary).unlink(missing_ok=True)


def read_private(path):
    path = Path(path)
    with path.open() as stream:
        stat = os.fstat(stream.fileno())
        if stat.st_mode & 0o077 or stat.st_size > 1_000_000:
            raise LoginError("Файл настройки должен быть приватным (0600).")
        return json.load(stream)


def read_cookies(profile):
    database = Path(profile) / "cookies.sqlite"
    if not database.is_file():
        raise LoginError("Вход не сохранён. Войдите в ChatGPT и закройте отдельное окно Firefox.")
    with closing(sqlite3.connect(database.resolve().as_uri() + "?mode=ro", uri=True)) as connection:
        rows = connection.execute("""SELECT host, path, name, value FROM moz_cookies
            WHERE host IN ('chatgpt.com', '.chatgpt.com') AND originAttributes = ''
            AND (expiry = 0 OR expiry > ?) AND isSecure = 1""", (int(time.time()),)).fetchall()
    if not any("session-token" in row[2] for row in rows):
        raise LoginError("Сессия ChatGPT не найдена. Завершите вход в отдельном окне Firefox.")
    return rows


def fetch_session(cookies, proxy=None):
    # The browser's saved cookies are sent only to ChatGPT, never to the rotator.
    from curl_cffi import requests
    try:
        with requests.Session(impersonate="firefox", proxy=proxy, trust_env=False) as client:
            for host, path, name, value in cookies:
                client.cookies.set(name, value, domain=host, path=path)
            response = client.get("https://chatgpt.com/api/auth/session", timeout=45, allow_redirects=False)
            if response.status_code != 200:
                raise LoginError("ChatGPT не подтвердил вход. Откройте сохранённый профиль и пройдите проверку сайта.")
            data = response.json()
            email = email_value(data.get("user", {}).get("email"))
            token = data.get("accessToken")
            if not isinstance(token, str) or not token or len(token) > 32000 or not token.isascii() or any(c.isspace() for c in token):
                raise LoginError("ChatGPT не выдал действующую сессию. Повторите вход.")
            response = client.get("https://chatgpt.com/backend-api/models", headers={"Authorization": "Bearer " + token},
                                  timeout=45, allow_redirects=False)
            if response.status_code != 200 or not isinstance(response.json().get("models"), list):
                raise LoginError("Вход сохранён браузером, но доступ к ChatGPT пока не подтверждён. Повторите позже.")
            return {"email": email, "accessToken": token}
    except LoginError:
        raise
    except Exception:
        raise LoginError("Не удалось проверить сессию ChatGPT. Профиль сохранён; попробуйте снова.") from None


def clear_browser_signin(profile):
    """Clear local ChatGPT/OpenAI and Google sign-in cookies in a closed profile.

    No upstream logout: existing sidecar tokens must not be revoked.
    Firefox's POSIX record lock prevents editing cookies while it is running.
    Extension data (including Bitwarden) and other sites are left untouched.
    """
    with (profile / ".parentlock").open("a") as lock:
        try:
            fcntl.lockf(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except (BlockingIOError, PermissionError):
            raise LoginError("Сначала закройте отдельное окно Firefox для ChatGPT и повторите вход.") from None
        database = profile / "cookies.sqlite"
        if database.exists():
            with closing(sqlite3.connect(database.resolve().as_uri() + "?mode=rw", uri=True)) as connection:
                with connection:
                    connection.execute("""DELETE FROM moz_cookies WHERE host IN
                        ('chatgpt.com', '.chatgpt.com', 'openai.com', '.openai.com',
                         'auth.openai.com', '.auth.openai.com',
                         'auth0.openai.com', '.auth0.openai.com',
                         'google.com', '.google.com',
                         'accounts.google.com', '.accounts.google.com')""")


def firefox_login(profile, fresh=False):
    executable = shutil.which("firefox")
    if not executable:
        raise LoginError("Для входа нужен Firefox на этом компьютере.")
    profile.mkdir(parents=True, exist_ok=True, mode=0o700)
    profile.chmod(0o700)
    if fresh:
        clear_browser_signin(profile)
    (profile / "user.js").write_text('user_pref("browser.shell.checkDefaultBrowser", false);\n'
                                   'user_pref("browser.aboutwelcome.enabled", false);\n')
    install_bitwarden(profile)
    process = subprocess.Popen([executable, "--new-instance", "--profile", str(profile), "https://chatgpt.com/"],
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        if process.wait(timeout=1800) != 0:
            raise LoginError("Закройте уже открытое окно профиля ChatGPT и повторите вход.")
    finally:
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
        save_bitwarden(profile)


def compose_command(settings):
    # Commands come only from the locally installed private settings, never a URL.
    command = ["docker", "compose", "--project-name", settings["project"]]
    for file in settings["composeFiles"]:
        command.extend(["-f", file])
    environment = dict(os.environ, LYOD_CHATGPT_APP_CONFIG_DIR=settings["configDir"])
    environment["LYOD_CHATGPT_APP_TRANSPORT_PROXY"] = settings.get("proxy", "")
    return command, environment


def restart_bridge(settings):
    command, environment = compose_command(settings)
    subprocess.run(command + ["up", "-d", "--no-build", "--force-recreate", "--wait", "--wait-timeout", "45",
                              "chatgpt-app-transport", "chatgpt-app"],
                   env=environment, check=True, timeout=90, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def check_bridge(bridge):
    """Readiness only; account access was checked directly before saving."""
    from curl_cffi import requests
    address = urlsplit(bridge["baseUrl"])
    if (address.username or address.password or address.query or address.fragment
            or not (address.scheme == "https" or address.scheme == "http" and
                    address.hostname in ("localhost", "127.0.0.1", "::1"))):
        raise LoginError("Некорректный адрес локального моста.")
    with requests.Session(trust_env=False) as client:
        for attempt in range(10):
            try:
                response = client.get(bridge["baseUrl"].rstrip("/") + "/models",
                                      headers={"Authorization": "Bearer " + bridge["apiKey"]},
                                      timeout=2, allow_redirects=False)
                if response.status_code == 200 and isinstance(response.json().get("data"), list):
                    return
            except Exception:
                pass
            if attempt < 9:
                time.sleep(1)
    raise LoginError("Локальный мост не подтвердил готовность после обновления.")


def account_bridge(settings, account, original, bridge):
    """Reuse an account's bridge, or provision an isolated loopback-only pair."""
    import yaml
    root = Path(settings["configDir"])
    if account == email_value(bridge["email"]):
        return settings, original, bridge, False
    target = root / "accounts" / hashlib.sha256(account.encode()).hexdigest()[:24]
    if target.exists():
        saved = read_private(target / "browser-login.json")
        previous = yaml.safe_load((target / "app.prod.yaml").read_text())
        connection = read_private(target / "session.json")
        if saved["configDir"] != str(target) or email_value(connection["email"]) != account:
            raise LoginError("Сохранённое подключение аккаунта повреждено; другие аккаунты не изменены.")
        return saved, previous, connection, False

    # Reserve stopped accounts too: probing sockets alone cannot detect them.
    reserved_ports = {urlsplit(bridge["baseUrl"]).port}
    reserved_hosts = {urlsplit(original.get("chatgpt_base_url", "")).hostname}
    for descriptor in (root / "accounts").glob("*/session.json"):
        connection = read_private(descriptor)
        reserved_ports.add(urlsplit(connection["baseUrl"]).port)
        config = yaml.safe_load((descriptor.parent / "app.prod.yaml").read_text())
        reserved_hosts.add(urlsplit(config["chatgpt_base_url"]).hostname)
    # Both listeners are private. Distinct ports/IPs also work with a host-only proxy.
    for number in range(2, 255):
        port, transport_host = 3040 + number * 2, "127.0.0." + str(number)
        if port in reserved_ports or transport_host in reserved_hosts:
            continue
        try:
            with socket.socket() as app_socket, socket.socket() as transport_socket:
                app_socket.bind(("127.0.0.1", port))
                transport_socket.bind((transport_host, 3041))
            break
        except OSError:
            continue
    else:
        raise LoginError("Нет свободного локального адреса для нового аккаунта.")

    command, environment = compose_command(settings)
    result = subprocess.run(command + ["config", "--format", "json"], env=environment,
                            check=True, timeout=30, capture_output=True, text=True)
    resolved = json.loads(result.stdout)["services"]
    services = {}
    for name in ("chatgpt-app-transport", "chatgpt-app"):
        source = resolved[name]
        if not source.get("image"):
            raise LoginError("Для нового аккаунта нужны готовые образы локального моста.")
        services[name] = {key: source[key] for key in
                          ("image", "restart", "environment", "logging") if key in source}
        services[name].update(network_mode="host", volumes=[{
            "type": "bind", "source": str(target), "target": "/app/conf",
            "read_only": name == "chatgpt-app-transport"}])
    services["chatgpt-app-transport"].setdefault("environment", {}).update(
        CHATGPT_TRANSPORT_BIND=transport_host, CHATGPT_TRANSPORT_PROXY=settings.get("proxy", ""))
    services["chatgpt-app-transport"]["healthcheck"] = {
        "test": ["CMD", "python", "-c",
                 f"import socket; socket.create_connection(('{transport_host}', 3041), 2).close()"],
        "interval": "5s", "timeout": "3s", "retries": 3, "start_period": "5s"}
    services["chatgpt-app"]["depends_on"] = {"chatgpt-app-transport": {"condition": "service_healthy"}}
    connection = {"email": account, "baseUrl": f"http://127.0.0.1:{port}/v1", "apiKey": secrets.token_urlsafe(32)}
    config = dict(original, bind="127.0.0.1", port=port, chatgpt_base_url=f"http://{transport_host}:3041",
                  auth={"access_tokens": [connection["apiKey"]], "access_token_prefix": []}, chatgpts=[])
    saved = dict(settings, configDir=str(target), project=settings["project"] + "-" + target.name[:12],
                 composeFiles=[str(target / "compose.json")])
    target.mkdir(parents=True, mode=0o700)
    target.chmod(0o700)
    save_private(target / "compose.json", {"services": services})
    save_private(target / "session.json", connection)
    save_private(target / "browser-login.json", saved)
    return saved, config, connection, True


def discard_new_bridge(settings):
    command, environment = compose_command(settings)
    subprocess.run(command + ["down"], env=environment, check=True, timeout=90,
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    root = Path(settings["configDir"])
    for name in ("app.prod.yaml", "session.json", "browser-login.json", "compose.json"):
        (root / name).unlink(missing_ok=True)
    try:
        root.rmdir()
    except OSError:
        pass


def register_remote(settings, connection):
    if not settings.get("remote"):
        return False
    try:
        result = subprocess.run([sys.executable, str(Path(__file__).with_name("remote_registration.py"))],
                                input=json.dumps({"remote": settings["remote"], "connection": connection}),
                                text=True, capture_output=True, check=True, timeout=240)
        response = json.loads(result.stdout)
        if response.get("registered") is not True or response.get("email") != connection["email"]:
            raise ValueError()
        return True
    except Exception:
        raise LoginError("Локальный мост сохранён, но сервер не подтвердил подключение. Проверьте SSH и повторите "
                         "rotator-chatgpt-login --register-only --account " + connection["email"] +
                         ". Повторный вход в Firefox не нужен.") from None


def connect(settings, expected=None, progress=lambda text: None):
    root = Path(settings["configDir"])
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    with (root / "browser-login.lock").open("a") as lock:
        os.chmod(lock.name, 0o600)
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise LoginError("Вход уже открыт. Завершите его в отдельном окне Firefox.") from None
        config_file, session_file = root / "app.prod.yaml", root / "session.json"
        import yaml
        if config_file.stat().st_mode & 0o077:
            raise LoginError("Настройка моста должна быть приватной (0600).")
        original = yaml.safe_load(config_file.read_text())
        bridge = read_private(session_file)
        accounts = original.get("chatgpts", [])
        if len(accounts) != 1 or email_value(accounts[0].get("email")) != email_value(bridge.get("email")):
            raise LoginError("Исходное подключение ChatGPT повреждено; его сессия не изменена.")
        account = email_value(bridge["email"])
        profile = root / "firefox-profiles" / hashlib.sha256(account.encode()).hexdigest()[:24]
        progress("Войдите в ChatGPT и закройте отдельное окно Firefox. Эта страница обновится автоматически.")
        firefox_login(profile, fresh=expected is None)
        progress("Проверяем вход в ChatGPT…")
        session = fetch_session(read_cookies(profile), settings.get("proxy") or None)
        account = email_value(session["email"])
        if expected and account != email_value(expected):
            raise LoginError("Вы выбрали обновление " + email_value(expected) + ", но вошли в " + account +
                             ". Для добавления другого аккаунта используйте общий вход без выбора аккаунта.")
        if yaml.safe_load(config_file.read_text()) != original or read_private(session_file) != bridge:
            raise LoginError("Настройка моста изменилась во время входа. Повторите подключение; новые настройки сохранены.")
        target_settings, previous, connection, created = account_bridge(settings, account, original, bridge)
        target_file = Path(target_settings["configDir"]) / "app.prod.yaml"
        previous_accounts = previous.get("chatgpts", [])
        if not created and (len(previous_accounts) != 1 or email_value(previous_accounts[0].get("email")) != account):
            raise LoginError("Подключение не соответствует аккаунту; прежняя сессия не изменена.")
        entry = dict(previous_accounts[0]) if previous_accounts else {"email": account}
        entry["access_token"] = session["accessToken"]
        updated = dict(previous, chatgpts=[entry])
        progress("Добавляем аккаунт…" if created else "Обновляем авторизацию…")
        save_private(target_file, updated)
        try:
            restart_bridge(target_settings)
            check_bridge(connection)
        except Exception:
            if created:
                try:
                    discard_new_bridge(target_settings)
                except Exception:
                    raise LoginError("Новый мост не запустился; требуется его ручная очистка. Прежние аккаунты не изменены.") from None
                raise LoginError("Новый мост не запустился и удалён. Прежние аккаунты не изменены; повторите позже.") from None
            save_private(target_file, previous)
            try:
                restart_bridge(target_settings)
            except Exception:
                raise LoginError("Мост не запустился. Прежняя сессия восстановлена в файле, но мост нужно запустить вручную.") from None
            raise LoginError("Мост не принял обновление. Прежнее подключение восстановлено; повторите позже.") from None
        if settings.get("remote"):
            progress("Подключаем закрытый туннель и регистрируем аккаунт на сервере…")
        registered = register_remote(settings, connection)
        # Only safe diagnostic fields are retained, never the raw session response.
        save_private(root / "login-status.json", {
            "ok": True, "email": account, "checkedAt": int(time.time()),
            "created": created, "registered": registered, "sessionFile": str(target_file.parent / "session.json")})
        return account


PAGE = """<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>ChatGPT App — Lyod Rotator</title><style>
body{margin:0;background:#f2ede4;color:#202b22;font:17px/1.6 system-ui;display:grid;place-items:center;min-height:100vh}
main{background:#fffdf9;border:1px solid #deded5;border-radius:24px;padding:36px;max-width:600px;margin:24px}
h1{line-height:1.15}#status{padding:18px;background:#eef4ee;border-radius:14px}small{color:#566457}
</style><main><small>LYOD ROTATOR · CHATGPT APP</small><h1>Вход через Firefox</h1>
<p>В отдельном окне войдите в ChatGPT, затем закройте именно это окно. При общем входе прежний вход ChatGPT в этом окне сбрасывается, чтобы можно было выбрать аккаунт. Подключённые мосты и Bitwarden сохраняются. Сохранённый профиль используется повторно.</p>
<p id="status" role="status" aria-live="polite">Открываем Firefox…</p><small>Пароли и сессия не отображаются на этой странице. Мост остаётся на ПК. Если настроен сервер, аккаунт подключится к нему автоматически.</small>
<script>async function poll(){try{const r=await fetch('./status',{cache:'no-store'});const d=await r.json();document.getElementById('status').textContent=d.message;if(!d.done)setTimeout(poll,1000)}catch{document.getElementById('status').textContent='Помощник закрыт. Повторите вход кнопкой подключения.'}}poll()</script></main></html>"""


def run_login(settings, expected=None, open_page=True):
    nonce = secrets.token_urlsafe(32)
    state = {"done": False, "message": "Открываем Firefox…"}
    finished = threading.Event()

    def progress(text):
        state.update(message=text)
        save_private(Path(settings["configDir"]) / "login-progress.json", state)

    class StatusHandler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def do_GET(self):
            if self.headers.get("Host") != "127.0.0.1:" + str(self.server.server_port):
                self.send_error(403)
                return
            path = self.path
            if path not in ("/" + nonce + "/", "/" + nonce + "/status"):
                self.send_error(404)
                return
            payload = json.dumps(state).encode() if path.endswith("/status") else PAGE.encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json" if path.endswith("/status") else "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(payload)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("Referrer-Policy", "no-referrer")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Content-Security-Policy", "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'")
            self.end_headers()
            self.wfile.write(payload)

    def worker():
        try:
            account = connect(settings, expected, progress)
            status = read_private(Path(settings["configDir"]) / "login-status.json")
            if status.get("registered"):
                message = "Аккаунт подключён к ротатору: " + account + ". Можно закрыть страницу."
            else:
                message = "Локальный мост сохранён: " + account + ". Файл подключения: " + status["sessionFile"] + ". Серверная регистрация не настроена."
            state.update(message=message, ok=True)
        except Exception as error:
            state.update(message=str(error) if isinstance(error, LoginError) else
                         "Не удалось завершить вход. Профиль Firefox сохранён; повторите попытку.", ok=False)
        finally:
            state.update(done=True)
            try:
                save_private(Path(settings["configDir"]) / "login-progress.json", state)
            except OSError:
                pass
            finally:
                finished.set()

    with ThreadingHTTPServer(("127.0.0.1", 0), StatusHandler) as server:
        server.daemon_threads = True
        server.handle_error = lambda *_: None
        url = "http://127.0.0.1:" + str(server.server_port) + "/" + nonce + "/"
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        if open_page:
            subprocess.run(["xdg-open", url], timeout=15, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True)
        threading.Thread(target=worker, daemon=True).start()
        finished.wait(2000)
        if open_page:
            finished.wait()  # Worker has a bounded Firefox and network timeout.
            time.sleep(120)  # Keep the final result visible; no model request is running.
        server.shutdown()
    return 0 if state.get("ok") else 1


def desktop_quote(value):
    return '\"' + str(value).replace("\\", "\\\\").replace('\"', '\\\"').replace("`", "\\`").replace("$", "\\$").replace("%", "%%") + '\"'


def install(settings, root=ROOT, applications=None):
    settings = dict(settings, origin=origin(settings["origin"]), configDir=str(root.resolve()))
    read_private(root / "session.json")
    save_private(root / "browser-login.json", settings)
    applications = Path(applications or Path(os.environ.get("XDG_DATA_HOME", Path.home() / ".local/share")) / "applications")
    applications.mkdir(parents=True, exist_ok=True)
    entry = ("[Desktop Entry]\nType=Application\nName=ChatGPT App — Lyod Rotator\nNoDisplay=true\nTerminal=false\n"
             f"Exec={desktop_quote(sys.executable)} {desktop_quote(Path(__file__).resolve())} --open %u\n"
             f"MimeType=x-scheme-handler/{SCHEME};\n")
    (applications / DESKTOP_ID).write_text(entry)
    subprocess.run(["xdg-mime", "default", DESKTOP_ID, "x-scheme-handler/" + SCHEME], check=True, timeout=15)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--install", action="store_true")
    mode.add_argument("--open", metavar="URL")
    mode.add_argument("--login", action="store_true")
    parser.add_argument("--register-only", action="store_true", help="Повторить серверную регистрацию без браузера")
    parser.add_argument("--account", help="Обновить указанный аккаунт, сохранив вход в браузере")
    parser.add_argument("--root", type=Path, default=ROOT)
    parser.add_argument("--origin", default="https://rotator.lyod.online")
    parser.add_argument("--project", default="lyod-chatgpt-app")
    parser.add_argument("--compose-file", action="append", default=[])
    parser.add_argument("--proxy", default="")
    args = parser.parse_args()
    os.umask(0o077)
    try:
        if args.install:
            if not args.compose_file or any(not Path(p).is_file() for p in args.compose_file):
                raise LoginError("Укажите существующие compose-файлы локального моста.")
            install({"origin": args.origin, "project": args.project, "composeFiles": [str(Path(p).resolve()) for p in args.compose_file],
                     "proxy": args.proxy}, args.root)
            print("Помощник входа ChatGPT App установлен.")
            return 0
        settings = read_private(args.root / "browser-login.json")
        if args.account and not args.login:
            raise LoginError("Параметр --account используется только с --login.")
        if args.register_only:
            if not args.login or not settings.get("remote"):
                raise LoginError("Для регистрации нужна настройка сервера и режим --login.")
            connection = read_private(args.root / "session.json")
            if args.account and email_value(args.account) != email_value(connection["email"]):
                digest = hashlib.sha256(email_value(args.account).encode()).hexdigest()[:24]
                connection = read_private(args.root / "accounts" / digest / "session.json")
                if email_value(connection["email"]) != email_value(args.account):
                    raise LoginError("Сохранённое подключение не соответствует выбранному аккаунту.")
            check_bridge(connection)
            register_remote(settings, connection)
            print("Аккаунт подключён к ротатору: " + connection["email"])
            return 0
        expected = parse_link(args.open, settings["origin"]) if args.open else email_value(args.account) if args.account else None
        return run_login(settings, expected)
    except Exception as error:
        text = str(error) if isinstance(error, LoginError) else "Не удалось запустить вход ChatGPT App. Проверьте настройку локального моста."
        print(text, file=sys.stderr)
        if shutil.which("notify-send"):
            subprocess.run(["notify-send", "--", "ChatGPT App", text], timeout=15, check=False)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
