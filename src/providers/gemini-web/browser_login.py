"""Interactive Firefox login and optional SSH installation. Never prints cookies."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import time
import urllib.request
import urllib.error
from urllib.parse import urlsplit


class LoginError(ValueError):
    """Safe, actionable diagnostic; never includes upstream error text."""


class IdentityRedirects(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, msg, headers, newurl):
        target = urlsplit(newurl)
        if target.hostname in ("google.com", "www.google.com") and target.path.startswith("/sorry/"):
            raise LoginError("Google требует дополнительную проверку в браузере. Откройте Gemini в сохранённом профиле и пройдите проверку.")
        if target.scheme != "https" or target.netloc != "gemini.google.com":
            raise LoginError("Google не подтвердил вход в Gemini. Повторно войдите в сохранённом профиле Firefox.")
        return super().redirect_request(request, fp, code, msg, headers, newurl)


def parse_identity(page):
    """Only use the authenticated Gemini bootstrap, never arbitrary page emails."""
    match = re.search(r"(?:window\.)?WIZ_global_data\s*=\s*", page)
    if not match:
        raise ValueError("Gemini account identity was not found")
    data, _ = json.JSONDecoder().raw_decode(page[match.end():])
    if not isinstance(data, dict):
        raise ValueError("Invalid Gemini account identity")
    email, account_id = data.get("oPEP7c"), data.get("S06Grb")
    if (not isinstance(email, str) or len(email) > 254 or not re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", email)
            or not isinstance(account_id, str) or not re.fullmatch(r"[0-9]{6,32}", account_id) or not data.get("SNlM0e")):
        raise ValueError("Cannot identify an authenticated Gemini account")
    return {"email": email.strip().lower(), "id": account_id}


def identify_account(cookies):
    request = urllib.request.Request("https://gemini.google.com/app", headers={
        "Cookie": "; ".join(name + "=" + value for name, value in cookies.items() if value),
        "User-Agent": "Mozilla/5.0",
    })
    try:
        response = urllib.request.build_opener(IdentityRedirects()).open(request, timeout=45)
    except urllib.error.HTTPError as error:
        target = urlsplit(error.headers.get("Location", ""))
        if target.hostname in ("google.com", "www.google.com") and target.path.startswith("/sorry/"):
            raise LoginError("Google требует дополнительную проверку в браузере. Повторите вход в сохранённом профиле Firefox.") from None
        raise LoginError(f"Проверка аккаунта Google отклонена (HTTP {error.code}). Сессия сохранена для повторной попытки.") from None
    with response:
        if not response.url.startswith("https://gemini.google.com/"):
            raise ValueError("Google sign-in did not complete")
        return parse_identity(response.read(8_000_000).decode("utf-8"))


def read_cookies(profile):
    database = Path(profile) / "cookies.sqlite"
    with sqlite3.connect(database.resolve().as_uri() + "?mode=ro", uri=True, timeout=5) as connection:
        rows = connection.execute("""SELECT name, value FROM moz_cookies
            WHERE (host IN ('.google.com', 'google.com') OR
                   (host IN ('.gemini.google.com', 'gemini.google.com') AND name = 'COMPASS')) AND path = '/'
            AND originAttributes = '' AND (expiry = 0 OR expiry > ?)
            AND (isSecure = 1 OR name IN ('SID', 'HSID', 'SSID', 'APISID', 'SAPISID', 'SIDCC',
                                         'SOCS', 'CONSENT', 'GOOGLE_ABUSE_EXEMPTION'))""", (int(time.time()),))
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
import fcntl,hashlib,json,os,pathlib,tempfile,urllib.request,urllib.error
v=json.load(__import__('sys').stdin)
p=pathlib.Path(v['destination'])
if not p.is_absolute(): raise SystemExit('Remote cookie path must be absolute')
p.parent.mkdir(mode=0o700,parents=True,exist_ok=True)
lock=(p.parent/'.login.lock').open('a')
os.chmod(p.parent/'.login.lock',0o600)
fcntl.flock(lock,fcntl.LOCK_EX)
state=pathlib.Path(v['stateDir'])
config=json.loads((state/'accounts.json').read_text())
identity=v.get('identity')
index_file=p.parent/'account-identities.json'
index=json.loads(index_file.read_text()) if identity and index_file.exists() else {}
if identity:
 key=hashlib.sha256(identity['id'].encode()).hexdigest()[:24]
 saved=index.get(identity['id'])
 accounts=config.get('accounts',[])
 if saved and any(a['email']==saved['email'] for a in accounts):
  v.update(saved)
 else:
  existing=None
  for account in accounts:
   credentials=[c for c in account.get('credentials',[]) if c.get('provider')=='gemini-web']
   for credential in credentials:
    try:
     relative=pathlib.Path(credential['cookiesFile']).relative_to(pathlib.Path(v['apiCookiePath']).parent)
     file=p.parent/relative
     if json.loads(file.read_text()).get('__Secure-1PSID')==v['cookies']['__Secure-1PSID']:
      existing=(account,credential,file)
    except (OSError,ValueError,KeyError): pass
  if existing:
   account,credential,file=existing
   v.update(email=account['email'],destination=str(file),apiCookiePath=credential['cookiesFile'])
  else:
   account=next((a for a in accounts if a['email'].lower()==identity['email'].lower()),None)
   credential=next((c for c in account.get('credentials',[]) if c.get('provider')=='gemini-web'),None) if account else None
   if credential:
    relative=pathlib.Path(credential['cookiesFile']).relative_to(pathlib.Path(v['apiCookiePath']).parent)
    v.update(email=account['email'],destination=str(p.parent/relative),apiCookiePath=credential['cookiesFile'])
   else:
    v.update(email=account['email'] if account else identity['email'],destination=str(p.parent/('gemini-'+key+'.json')),apiCookiePath=str(pathlib.Path(v['apiCookiePath']).parent/('gemini-'+key+'.json')))
 p=pathlib.Path(v['destination'])
p.parent.mkdir(mode=0o700,parents=True,exist_ok=True)
old=p.read_bytes() if p.exists() else None
fd,tmp=tempfile.mkstemp(prefix='.gemini-login-',dir=p.parent)
with os.fdopen(fd,'w') as f: json.dump(v['cookies'],f)
os.replace(tmp,p)
try:
 token=(state/'.admin-token').read_text().strip()
 body={'provider':'gemini-web','email':v['email'],'cookiesFile':v['apiCookiePath']}
 request=urllib.request.Request('http://127.0.0.1:'+str(config['proxyPort'])+'/api/cli-login',data=json.dumps(body).encode(),headers={'Content-Type':'application/json','X-Rotator-Admin-Token':token})
 with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(request,timeout=480) as r:
  result=json.load(r)
  if not result.get('ok'): raise RuntimeError()
  v['email']=result.get('email',v['email'])
 if identity:
  index[identity['id']]={k:v[k] for k in ('email','destination','apiCookiePath')}
  fd,tmp=tempfile.mkstemp(prefix='.gemini-identities-',dir=index_file.parent)
  with os.fdopen(fd,'w') as f: json.dump(index,f)
  os.replace(tmp,index_file)
 print(json.dumps({'email':v['email'],'isNew':bool(result.get('isNew'))}))
except Exception as error:
 if old is None: p.unlink(missing_ok=True)
 else:
  fd,tmp=tempfile.mkstemp(prefix='.gemini-restore-',dir=p.parent)
  with os.fdopen(fd,'wb') as f: f.write(old)
  os.replace(tmp,p)
 print(json.dumps({'error':'server-login-rejected','status':error.code if isinstance(error,urllib.error.HTTPError) else None}))
 raise SystemExit('Server login check failed; previous cookies restored.')
'''


def install_remote(args):
    cookies = json.loads(Path(args.cookies_file).expanduser().read_text())
    payload = {"cookies": cookies, "destination": args.remote_cookie_file, "apiCookiePath": args.server_cookie_file,
               "stateDir": args.remote_state_dir, "email": args.email}
    if getattr(args, "identity", None):
        payload["identity"] = args.identity
    command = ["ssh", "-F", "/dev/null", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "--",
               args.server, "python3 -c " + shlex.quote(REMOTE_INSTALL)]
    result = subprocess.run(command, input=json.dumps(payload).encode(), capture_output=True, timeout=500)
    if result.returncode:
        if result.returncode == 255:
            raise LoginError("Не удалось подключиться к серверу по SSH. Локальная сессия сохранена; повторите попытку позже.")
        status = None
        try:
            diagnostic = json.loads(result.stdout)
            if isinstance(diagnostic, dict) and diagnostic.get("error") == "server-login-rejected":
                value = diagnostic.get("status")
                if isinstance(value, int) and 400 <= value <= 599:
                    status = value
        except ValueError:
            pass
        if status in (401, 403):
            detail = f"Сервер не подтвердил сессию Gemini (HTTP {status}). Возможны истечение сессии или дополнительная проверка Google для IP сервера. Проверьте сессию и сетевой маршрут к Google."
        elif status == 404:
            detail = "Сессия проверена, но Argon недоступен для этого аккаунта (HTTP 404)."
        elif status == 429:
            detail = "Проверка Gemini App ограничена сервером (HTTP 429). Повторный вход сейчас не требуется; дождитесь снятия ограничения."
        else:
            detail = "Сервер не смог завершить проверку Gemini App" + (f" (HTTP {status})." if status else ".")
        raise LoginError(detail + " Предыдущие cookies на сервере восстановлены; локальная сессия сохранена.")
    result = json.loads(result.stdout)
    action = "Добавлен аккаунт" if result["isNew"] else "Обновлена сессия аккаунта"
    display = getattr(args, "identity", None) or {"email": result["email"]}
    print(f"{action}: {display['email']}. Доступность Argon проверена.", flush=True)
    return result


def automatic_login(args, directory=None, expected_email=None):
    # A fresh profile avoids Google's shared multi-login cookies selecting the
    # primary account when the user intended to add another one.
    directory = Path(directory or "~/.config/tuxevil-rotator").expanduser()
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    temporary = Path(tempfile.mkdtemp(prefix="pending-", dir=directory))
    try:
        source = args.cookies_file
        if not args.upload_only:
            source = str(Path(temporary) / "cookies.json")
            browser_login(args.profile or str(Path(temporary) / "firefox"), source, args.firefox)
        cookies = json.loads(Path(source).expanduser().read_text())
        args.identity = identify_account(cookies)
        if expected_email and args.identity["email"].casefold() != expected_email.casefold():
            raise LoginError("В Firefox выбран другой аккаунт. Сессия на сервере не изменена; войдите в нужный аккаунт и повторите подключение.")
        key = hashlib.sha256(args.identity["id"].encode()).hexdigest()[:24]
        destination = directory / "gemini-web" / key / "cookies.json"
        save_private(destination, cookies)
        args.cookies_file = str(destination)
        install_remote(args)
    except (OSError, ValueError, sqlite3.Error, subprocess.SubprocessError) as error:
        detail = str(error) if isinstance(error, LoginError) else "Не удалось завершить проверку аккаунта или подключение к серверу."
        saved = Path(source).expanduser()
        retry = (f"rotator-gemini-login --profile {shlex.quote(str(temporary / 'firefox'))}"
                 if not args.upload_only and not args.profile else
                 f"rotator-gemini-login --upload-only --cookies-file {shlex.quote(str(saved))}")
        raise LoginError(f"{detail}\nПовторная попытка: {retry}") from None
    else:
        shutil.rmtree(temporary)


def main():
    parser = argparse.ArgumentParser(description="Sign in to Gemini App through a dedicated Firefox profile")
    parser.add_argument("--cookies-file", default="~/.config/tuxevil-rotator/gemini-cookies.json")
    parser.add_argument("--profile", help="Optional existing Firefox profile; automatic login uses a clean profile")
    parser.add_argument("--firefox", default="firefox")
    parser.add_argument("--server", help="SSH destination, for example root@rotator.lyod.online")
    parser.add_argument("--email", help="Manual rotator identifier; omit to detect the Google account automatically")
    parser.add_argument("--remote-cookie-file", default="/var/lib/tuxevil-rotator-gemini-session/gemini-cookies.json")
    parser.add_argument("--server-cookie-file", default="/sessions/gemini-cookies.json")
    parser.add_argument("--remote-state-dir", default="/var/lib/tuxevil-rotator-stage")
    parser.add_argument("--upload-only", action="store_true", help="Install the already saved private cookie file")
    args = parser.parse_args()
    os.umask(0o077)
    try:
        if args.server and args.email is None:
            automatic_login(args)
            return 0
        if not args.upload_only:
            browser_login(args.profile or "~/.config/tuxevil-rotator/gemini-firefox", args.cookies_file, args.firefox)
        if args.server:
            install_remote(args)
    except LoginError as error:
        print(str(error), file=sys.stderr)
        return 1
    except (OSError, ValueError, sqlite3.Error, subprocess.SubprocessError):
        print("Не удалось подключить Gemini App. Проверьте вход в отдельном профиле Firefox, доступность Argon и SSH.", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        return 130
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
