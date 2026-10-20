#!/usr/bin/env python3
"""Install the pinned local Claude App login helper (Linux x86_64)."""
import argparse
import hashlib
import io
import json
import os
from pathlib import Path
import platform
import shlex
import subprocess
import sys
import tempfile
import urllib.request
import zipfile

VERSION = "0.13.5"
SHA256 = "ecad65308f055540ae2e9c1afdae8c192b01946fda2c4e2bc6b3a645c30262fd"
URL = f"https://github.com/Xerxes-2/clewdr/releases/download/v{VERSION}/clewdr-linux-x86_64.zip"
REPO = Path(__file__).resolve().parents[2]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--origin", required=True)
    parser.add_argument("--proxy")
    args = parser.parse_args()
    if platform.system() != "Linux" or platform.machine() not in ("x86_64", "AMD64"):
        parser.error("This pinned release supports Linux x86_64 only")
    spec_path = REPO / "src/providers/claude-app/browser_login.py"
    import importlib.util
    spec = importlib.util.spec_from_file_location("claude_installer", spec_path)
    login = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(login)
    trusted_origin = login.ui.origin(args.origin)
    if args.proxy:
        from urllib.parse import urlsplit
        url = urlsplit(args.proxy)
        if url.scheme not in ("http", "https", "socks5", "socks5h") or not url.hostname or url.username or url.password or url.query or url.fragment:
            parser.error("Use a proxy URL without embedded credentials")
    if not login.BINARY.is_file():
        parser.error("First run scripts/claude-app/build-bridge.py --source /path/to/clewdr-v0.13.5")
    target = login.RELEASE_BINARY
    target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    with urllib.request.urlopen(URL, timeout=120) as response:
        archive = response.read(100 * 1024 * 1024)
    if hashlib.sha256(archive).hexdigest() != SHA256:
        raise RuntimeError("ClewdR release checksum mismatch; installation stopped")
    with zipfile.ZipFile(io.BytesIO(archive)) as archive:
        names = [name for name in archive.namelist() if Path(name).name == "clewdr"]
        if len(names) != 1:
            raise RuntimeError("Unexpected ClewdR archive layout")
        binary = archive.read(names[0])
    fd, temporary = tempfile.mkstemp(dir=target.parent)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(binary)
        os.chmod(temporary, 0o700)
        os.replace(temporary, target)
    finally:
        Path(temporary).unlink(missing_ok=True)
    venv = Path.home() / ".local/share/lyod-rotator/claude-login-venv"
    if not (venv / "bin/python").exists():
        subprocess.run([sys.executable, "-m", "venv", str(venv)], check=True)
    subprocess.run([str(venv / "bin/python"), "-m", "pip", "install", "curl_cffi==0.16.3", "PyYAML==6.0.3"], check=True)
    login.ROOT.mkdir(parents=True, exist_ok=True, mode=0o700)
    settings_path = login.ROOT / "browser-login.json"
    settings = login.ui.read_private(settings_path) if settings_path.exists() else {}
    settings.update(configDir=str(login.ROOT), origin=trusted_origin)
    if args.proxy:
        settings["proxy"] = args.proxy
    login.ui.save_private(settings_path, settings)
    launcher = Path.home() / ".local/bin/rotator-claude-login"
    launcher.parent.mkdir(parents=True, exist_ok=True)
    launcher.write_text("#!/bin/sh\nexec " + shlex.join([str(venv / "bin/python"), str(spec_path)]) + ' "$@"\n')
    launcher.chmod(0o755)
    desktop = Path.home() / ".local/share/applications/lyod-claude-login.desktop"
    desktop.parent.mkdir(parents=True, exist_ok=True)
    # Desktop Exec quoting differs from shell quoting; escape reserved characters.
    quoted = str(launcher).replace("\\", "\\\\").replace('"', '\\"').replace("`", "\\`").replace("$", "\\$").replace("%", "%%")
    desktop.write_text('[Desktop Entry]\nType=Application\nName=Lyod Claude Login\nExec="' + quoted + '" --open %u\nTerminal=false\nNoDisplay=true\nMimeType=x-scheme-handler/lyod-claude;\n')
    subprocess.run(["xdg-mime", "default", desktop.name, "x-scheme-handler/lyod-claude"], check=True)
    print("Installed rotator-claude-login. Existing account sessions were preserved.")


if __name__ == "__main__":
    main()
