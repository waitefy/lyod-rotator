"""Install the locally trusted Bitwarden package into isolated login profiles."""
import fcntl
import json
import os
from pathlib import Path
import shutil
import tempfile
import zipfile

BITWARDEN_ID = "{446900e4-71c2-419f-a6a7-df9c091e268b}"
ENABLE_SIDELOAD = 'user_pref("extensions.autoDisableScopes", 0);'


def install_bitwarden(profile, source=None):
    """Copy only the XPI, never vault state, cookies or another profile's settings.

    Existing installations are kept so Firefox can update them independently.
    Without a local package, login still works without the optional extension.
    """
    profile = Path(profile)
    profile.mkdir(parents=True, exist_ok=True, mode=0o700)
    with (profile / ".parentlock").open("a") as lock:
        fcntl.lockf(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        destination = profile / "extensions" / (BITWARDEN_ID + ".xpi")
        if not destination.exists():
            if source is None:
                root = Path.home() / ".config/lyod-rotator"
                source = root / "browser-extensions/bitwarden.xpi"
                if not source.exists():
                    source = next((root / "chatgpt-app/firefox-profiles").glob("*/extensions/" + BITWARDEN_ID + ".xpi"), None)
            if source is None or not Path(source).is_file():
                return False
            with zipfile.ZipFile(source) as archive:
                manifest = json.loads(archive.read("manifest.json"))
                settings = manifest.get("browser_specific_settings") or manifest.get("applications") or {}
                if settings.get("gecko", {}).get("id") != BITWARDEN_ID:
                    raise ValueError("Expected the locally installed Bitwarden extension")
            destination.parent.mkdir(mode=0o700, exist_ok=True)
            fd, temporary = tempfile.mkstemp(prefix=".bitwarden-", dir=destination.parent)
            try:
                with os.fdopen(fd, "wb") as output, Path(source).open("rb") as package:
                    shutil.copyfileobj(package, output)
                os.replace(temporary, destination)
            finally:
                Path(temporary).unlink(missing_ok=True)
        preferences = profile / "user.js"
        current = preferences.read_text() if preferences.exists() else ""
        if ENABLE_SIDELOAD not in current.splitlines():
            preferences.write_text(current + ("\n" if current and not current.endswith("\n") else "") + ENABLE_SIDELOAD + "\n")
        return True
