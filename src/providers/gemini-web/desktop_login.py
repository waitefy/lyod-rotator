"""Local, user-installed URL handler. URLs never choose an SSH host or carry secrets."""
import argparse
import contextlib
import fcntl
import io
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import uuid
from urllib.parse import parse_qs, urlsplit

import browser_login

SCHEME = "tuxevil-gemini"
DESKTOP_ID = "tuxevil-gemini-login.desktop"
ROOT = Path("~/.config/tuxevil-rotator").expanduser()


def origin(value):
    parsed = urlsplit(value)
    if (parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password
            or parsed.path not in ("", "/") or parsed.query or parsed.fragment):
        raise browser_login.LoginError("Для сайта ротатора нужен HTTPS origin без пути и параметров.")
    return "https://" + parsed.netloc.lower().removesuffix(":443")


def parse_link(value, trusted_origin):
    if len(value) > 2048:
        raise browser_login.LoginError("Некорректная ссылка входа.")
    parsed = urlsplit(value)
    if (parsed.scheme != SCHEME or parsed.netloc != "login" or parsed.path not in ("", "/")
            or parsed.fragment):
        raise browser_login.LoginError("Некорректная ссылка входа.")
    fields = parse_qs(parsed.query, keep_blank_values=True, strict_parsing=True)
    if set(fields) - {"origin", "account"} or any(len(v) != 1 for v in fields.values()):
        raise browser_login.LoginError("Ссылка содержит неподдерживаемые параметры.")
    if origin(fields.get("origin", [""])[0]) != origin(trusted_origin):
        raise browser_login.LoginError("Этот сайт не совпадает с настроенным ротатором. Подключение отменено.")
    email = fields.get("account", [""])[0]
    if email and (len(email) > 254 or not re.fullmatch(r"[^\s@<>\x00-\x1f]+@[^\s@<>\x00-\x1f]+\.[^\s@<>\x00-\x1f]+", email)):
        raise browser_login.LoginError("Некорректный аккаунт в ссылке.")
    return email.casefold() or None


def desktop_quote(value):
    # Desktop Entry Exec quoting, not shell quoting. Escape field-code expansion too.
    return '"' + str(value).replace("\\", "\\\\").replace('"', '\\"').replace("`", "\\`").replace("$", "\\$").replace("%", "%%") + '"'


def install(server, site, root=ROOT, applications=None):
    if not re.fullmatch(r"[a-zA-Z0-9_.-]+@[a-zA-Z0-9][a-zA-Z0-9.-]*", server):
        raise browser_login.LoginError("Нужен SSH-адрес вида user@server без дополнительных параметров.")
    settings = {"server": server, "origin": origin(site)}
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    browser_login.save_private(root / "desktop-login.json", settings)
    applications = Path(applications or Path(os.environ.get("XDG_DATA_HOME", Path.home() / ".local/share")) / "applications")
    applications.mkdir(parents=True, exist_ok=True)
    script = Path(__file__).resolve()
    entry = ("[Desktop Entry]\nType=Application\nName=Gemini App — Rotator Login\n"
             "NoDisplay=true\nTerminal=false\n"
             f"Exec={desktop_quote(sys.executable)} {desktop_quote(script)} --open %u\n"
             f"MimeType=x-scheme-handler/{SCHEME};\n")
    (applications / DESKTOP_ID).write_text(entry)
    subprocess.run(["xdg-mime", "default", DESKTOP_ID, "x-scheme-handler/" + SCHEME], check=True, timeout=15)


def connect(link, root=ROOT):
    config = json.loads((root / "desktop-login.json").read_text())
    email = parse_link(link, config["origin"])
    # One active login prevents racing profile-index writes and duplicate Firefox windows.
    with (root / "desktop-login.lock").open("a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise browser_login.LoginError("Вход уже открыт. Завершите его в отдельном окне Firefox.") from None
        index_file = root / "desktop-profiles.json"
        index = json.loads(index_file.read_text()) if index_file.exists() else {}
        key = index.get(email) if email else None
        # Only generated profile IDs are read from the private index.
        if not isinstance(key, str) or not re.fullmatch(r"[0-9a-f]{32}", key):
            key = uuid.uuid4().hex
        profile = root / "desktop-profiles" / key
        if email:
            # Keep the profile reachable even if authentication or upload fails.
            index[email] = key
            browser_login.save_private(index_file, index)
        args = argparse.Namespace(server=config["server"], email=None, upload_only=False,
                                  cookies_file=str(profile / "cookies.json"), profile=str(profile / "firefox"),
                                  firefox="firefox", remote_cookie_file="/var/lib/tuxevil-rotator-gemini-session/gemini-cookies.json",
                                  server_cookie_file="/sessions/gemini-cookies.json", remote_state_dir="/var/lib/tuxevil-rotator-stage")
        # Existing CLI owns cookie extraction, identity verification, upload and server rollback.
        browser_login.automatic_login(args, root, expected_email=email)
        actual = args.identity["email"].casefold()
        index[actual] = key
        browser_login.save_private(index_file, index)
        return actual


def message(text, error=False):
    if shutil.which("zenity"):
        subprocess.run(["zenity", "--error" if error else "--info", "--no-markup",
                        "--title=Gemini App — Rotator", "--text=" + text], timeout=600, check=False)
    elif shutil.which("notify-send"):
        subprocess.run(["notify-send", "--app-name=Rotator", "--", "Gemini App", text], timeout=15, check=False)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--install", action="store_true")
    mode.add_argument("--open", metavar="URL")
    parser.add_argument("--server")
    parser.add_argument("--origin")
    args = parser.parse_args()
    os.umask(0o077)
    try:
        if args.install:
            if not args.server or not args.origin:
                parser.error("--install requires --server and --origin")
            install(args.server, args.origin)
            print("Кнопки входа Gemini App на сайте подключены к этому компьютеру.")
        else:
            # No cookie material is printed; suppress the CLI's terminal-only progress.
            with contextlib.redirect_stdout(io.StringIO()):
                email = connect(args.open)
            message(f"Gemini App подключён: {email}.\nМожно вернуться на сайт ротатора.")
    except (OSError, ValueError, KeyError, subprocess.SubprocessError) as error:
        text = str(error) if isinstance(error, browser_login.LoginError) else "Не удалось завершить подключение. Повторите вход кнопкой на сайте; сохранённый профиль Firefox будет использован повторно."
        if args.open:
            message(text, error=True)
        else:
            print(text, file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
