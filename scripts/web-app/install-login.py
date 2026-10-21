#!/usr/bin/env python3
"""Install pinned Qwen/DeepSeek local bridges and desktop login handlers."""
import argparse
import importlib.util
import os
from urllib.parse import urlsplit
from pathlib import Path
import shlex
import subprocess
import sys

REPO = Path(__file__).resolve().parents[2]
REVISION = "a54a9bb5d32413dea819ab0a0bc37dfc352de928"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--origin", required=True)
    args = parser.parse_args()
    source = REPO / "src/providers/web-app/browser_login.py"
    sys.path.insert(0, str(source.parent))
    spec = importlib.util.spec_from_file_location("web_login_installer", source)
    login = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(login)
    origin = login.ui.origin(args.origin)
    target = login.SOURCE
    target.parent.mkdir(parents=True, exist_ok=True)
    if not target.exists():
        subprocess.run(["git", "init", str(target)], check=True, capture_output=True)
        subprocess.run(["git", "-C", str(target), "remote", "add", "origin", "https://github.com/mmmlllnnn/FreeTokenAPI.git"], check=True)
        subprocess.run(["git", "-C", str(target), "fetch", "--depth=1", "origin", REVISION], check=True)
        subprocess.run(["git", "-C", str(target), "checkout", "--detach", "FETCH_HEAD"], check=True)
    actual = subprocess.check_output(["git", "-C", str(target), "rev-parse", "HEAD"], text=True).strip()
    if actual != REVISION or (target / ".env").exists():
        raise RuntimeError("Unexpected bridge revision or shared environment file")
    venv = Path.home() / ".local/share/lyod-rotator/web-app-venv"
    if not (venv / "bin/python").exists():
        subprocess.run([sys.executable, "-m", "venv", str(venv)], check=True)
    subprocess.run([str(venv / "bin/python"), "-m", "pip", "install", "-r", str(Path(__file__).with_name("requirements.lock"))], check=True)
    if not __import__('shutil').which('node'):
        raise RuntimeError("Node.js is required for DeepSeek proof of work")
    shared_settings = Path.home() / ".config/lyod-rotator/claude-app/browser-login.json"
    shared = login.ui.read_private(shared_settings) if shared_settings.exists() else {}
    for provider, label in [("qwen-app", "Qwen"), ("deepseek-app", "DeepSeek")]:
        root = Path.home() / ".config/lyod-rotator" / provider
        root.mkdir(parents=True, exist_ok=True, mode=0o700)
        settings_path = root / "browser-login.json"
        settings = login.ui.read_private(settings_path) if settings_path.exists() else {}
        settings.update(provider=provider, configDir=str(root), origin=origin)
        if "remote" not in settings and shared.get("remote"):
            settings["remote"] = shared["remote"]
        if not settings.get("proxy"):
            candidate = os.environ.get("HTTPS_PROXY") or os.environ.get("https_proxy") or os.environ.get("ALL_PROXY") or os.environ.get("all_proxy")
            if candidate:
                url = urlsplit(candidate)
                if url.scheme not in ("http", "https", "socks5", "socks5h") or not url.hostname or url.username or url.password or url.query or url.fragment:
                    raise RuntimeError("Use a proxy without embedded credentials")
                settings["proxy"] = candidate
        login.ui.save_private(settings_path, settings)
        scheme = "lyod-" + provider.removesuffix("-app")
        launcher = Path.home() / ".local/bin" / ("rotator-" + provider.removesuffix("-app") + "-login")
        launcher.parent.mkdir(parents=True, exist_ok=True)
        launcher.write_text("#!/bin/sh\nexec " + shlex.join([str(venv / "bin/python"), str(source), "--provider", provider]) + ' "$@"\n')
        launcher.chmod(0o755)
        desktop = Path.home() / ".local/share/applications" / (scheme + "-login.desktop")
        desktop.parent.mkdir(parents=True, exist_ok=True)
        desktop.write_text('[Desktop Entry]\nType=Application\nName=Lyod ' + label + ' Login\nExec=' + login.ui.desktop_quote(str(launcher)) + ' --open %u\nTerminal=false\nNoDisplay=true\nMimeType=x-scheme-handler/' + scheme + ';\n')
        subprocess.run(["xdg-mime", "default", desktop.name, "x-scheme-handler/" + scheme], check=True)
    print("Installed rotator-qwen-login and rotator-deepseek-login. Existing accounts preserved.")


if __name__ == "__main__":
    main()
