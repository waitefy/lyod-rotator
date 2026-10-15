"""Interactive Firefox login and optional SSH installation. Never prints cookies."""
import argparse
import json
import os
from pathlib import Path
import shlex
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import time


def read_cookies(profile):
    database = Path(profile) / "cookies.sqlite"
    with sqlite3.connect(database.resolve().as_uri() + "?mode=ro", uri=True, timeout=5) as connection:
        rows = connection.execute("""SELECT name, value FROM moz_cookies
            WHERE host IN ('.google.com', 'google.com') AND path = '/' AND isSecure = 1
            AND originAttributes = '' AND (expiry = 0 OR expiry > ?)
            AND name IN ('__Secure-1PSID', '__Secure-1PSIDTS')""", (int(time.time()),))
        cookies = dict(rows)
    if not cookies.get("__Secure-1PSID"):
        raise ValueError("Google session not found in the dedicated profile; sign in to Gemini App first")
    return cookies


def save_private(path, cookies):
    path = Path(path).expanduser().resolve()
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=".gemini-login-", dir=path.parent)
    try:
        with os.fdopen(fd, "w") as stream:
            json.dump(cookies, stream)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        Path(temporary).unlink(missing_ok=True)


def browser_login(profile, destination, firefox="firefox"):
    executable = shutil.which(firefox)
    if not executable:
        raise ValueError("Firefox is required on the computer where you sign in")
    profile = Path(profile).expanduser().resolve()
    profile.mkdir(mode=0o700, parents=True, exist_ok=True)
    profile.chmod(0o700)
    (profile / "user.js").write_text('user_pref("browser.shell.checkDefaultBrowser", false);\n'
                                    'user_pref("browser.aboutwelcome.enabled", false);\n'
                                    'user_pref("signon.rememberSignons", false);\n')
    process = subprocess.Popen([executable, "--new-instance", "--profile", str(profile), "https://gemini.google.com/app"],
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    print("В отдельном окне Firefox войдите в Google и проверьте, что доступен Argon.", flush=True)
    print("Затем закройте это окно Firefox. Cookies будут сохранены автоматически.", flush=True)
    try:
        if process.wait() != 0:
            raise ValueError("Firefox could not open the dedicated profile; close its existing window and retry")
        cookies = read_cookies(profile)
        save_private(destination, cookies)
        print("Веб-сессия сохранена локально. Значения cookies не выводятся.", flush=True)
    finally:
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()


REMOTE_INSTALL = r'''
import json,os,pathlib,tempfile,urllib.request,urllib.error
v=json.load(__import__('sys').stdin)
p=pathlib.Path(v['destination'])
if not p.is_absolute(): raise SystemExit('Remote cookie path must be absolute')
p.parent.mkdir(mode=0o700,parents=True,exist_ok=True)
old=p.read_bytes() if p.exists() else None
fd,tmp=tempfile.mkstemp(prefix='.gemini-login-',dir=p.parent)
with os.fdopen(fd,'w') as f: json.dump(v['cookies'],f)
os.replace(tmp,p)
try:
 state=pathlib.Path(v['stateDir'])
 config=json.loads((state/'accounts.json').read_text())
 token=(state/'.admin-token').read_text().strip()
 body={'provider':'gemini-web','email':v['email'],'cookiesFile':v['apiCookiePath']}
 request=urllib.request.Request('http://127.0.0.1:'+str(config['proxyPort'])+'/api/cli-login',data=json.dumps(body).encode(),headers={'Content-Type':'application/json','X-Rotator-Admin-Token':token})
 with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(request,timeout=480) as r:
  result=json.load(r)
  if not result.get('ok'): raise RuntimeError()
 print('Gemini App подключён на сервере. Argon доступен.')
except Exception:
 if old is None: p.unlink(missing_ok=True)
 else:
  fd,tmp=tempfile.mkstemp(prefix='.gemini-restore-',dir=p.parent)
  with os.fdopen(fd,'wb') as f: f.write(old)
  os.replace(tmp,p)
 raise SystemExit('Server rejected login or is unavailable; previous cookies restored. Check the server version and Argon access.')
'''


def install_remote(args):
    cookies = json.loads(Path(args.cookies_file).expanduser().read_text())
    payload = {"cookies": cookies, "destination": args.remote_cookie_file, "apiCookiePath": args.server_cookie_file,
               "stateDir": args.remote_state_dir, "email": args.email}
    command = ["ssh", "-F", "/dev/null", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "--",
               args.server, "python3 -c " + shlex.quote(REMOTE_INSTALL)]
    result = subprocess.run(command, input=json.dumps(payload).encode(), capture_output=True, timeout=500)
    if result.returncode:
        raise ValueError("Server login failed; previous server cookies were preserved. Check SSH access, the server version and Argon access")
    print("Gemini App подключён на сервере. Доступность Argon проверена.", flush=True)


def main():
    parser = argparse.ArgumentParser(description="Sign in to Gemini App through a dedicated Firefox profile")
    parser.add_argument("--cookies-file", default="~/.config/tuxevil-rotator/gemini-cookies.json")
    parser.add_argument("--profile", default="~/.config/tuxevil-rotator/gemini-firefox")
    parser.add_argument("--firefox", default="firefox")
    parser.add_argument("--server", help="SSH destination, for example root@rotator.lyod.online")
    parser.add_argument("--email", default="gemini-web-session@local", help="Rotator account identifier")
    parser.add_argument("--remote-cookie-file", default="/var/lib/tuxevil-rotator-gemini-session/gemini-cookies.json")
    parser.add_argument("--server-cookie-file", default="/sessions/gemini-cookies.json")
    parser.add_argument("--remote-state-dir", default="/var/lib/tuxevil-rotator-stage")
    parser.add_argument("--upload-only", action="store_true", help="Install the already saved private cookie file")
    args = parser.parse_args()
    os.umask(0o077)
    try:
        if not args.upload_only:
            browser_login(args.profile, args.cookies_file, args.firefox)
        if args.server:
            install_remote(args)
    except (OSError, ValueError, sqlite3.Error, subprocess.SubprocessError):
        print("Не удалось подключить Gemini App. Проверьте вход в отдельном профиле Firefox, доступность Argon и SSH.", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        return 130
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
