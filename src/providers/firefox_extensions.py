"""Keep Bitwarden state across isolated provider login profiles."""
import fcntl
import json
import os
from pathlib import Path
import re
import shutil
import tempfile
import zipfile

BITWARDEN_ID = "{446900e4-71c2-419f-a6a7-df9c091e268b}"
ENABLE_SIDELOAD = 'user_pref("extensions.autoDisableScopes", 0);'
UUID_PREF = "extensions.webextensions.uuids"
TOOLBAR_PREF = "browser.uiCustomization.state"
WIDGET = "_446900e4-71c2-419f-a6a7-df9c091e268b_-browser-action"


def _preferences(profile):
    values = {}
    for filename in ("user.js", "prefs.js"):
        path = profile / filename
        if path.exists():
            for key, value in re.findall(r'^user_pref\(("(?:[^"\\]|\\.)*"), (.+)\);$', path.read_text(), re.M):
                values[json.loads(key)] = json.loads(value)
    return values


def _state_root():
    root = Path.home() / ".config/lyod-rotator/browser-extensions"
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    root.chmod(0o700)
    return root


def _write_state(profile, destination):
    """Snapshot only Bitwarden's storage and toolbar placement from a closed profile."""
    preferences = _preferences(profile)
    uuid = json.loads(preferences.get(UUID_PREF, "{}")).get(BITWARDEN_ID)
    if not uuid or not re.fullmatch(r"[a-fA-F0-9-]{36}", uuid):
        return False
    locations = [profile / "browser-extension-data" / BITWARDEN_ID]
    locations.extend((profile / "storage/default").glob("moz-extension+++" + uuid + "*"))
    files = [path for location in locations if location.is_dir() for path in location.rglob("*")
             if path.is_file() and not path.is_symlink()]
    if not files:
        return False
    toolbar = json.loads(preferences.get(TOOLBAR_PREF, "{}"))
    area = next((name for name, widgets in toolbar.get("placements", {}).items() if WIDGET in widgets), None)
    fd, temporary = tempfile.mkstemp(prefix=".bitwarden-state-", dir=destination.parent)
    try:
        with os.fdopen(fd, "wb") as output, zipfile.ZipFile(output, "w") as archive:
            archive.writestr("state.json", json.dumps(dict(uuid=uuid, area=area, toolbar=toolbar)))
            for path in files:
                archive.write(path, str(path.relative_to(profile)))
        os.replace(temporary, destination)
    finally:
        Path(temporary).unlink(missing_ok=True)
    return True


def save_bitwarden(profile):
    """Keep encrypted extension state locally; never change vault locking policy."""
    profile = Path(profile)
    root = _state_root()
    with (root / "state.lock").open("a") as state_lock, (profile / ".parentlock").open("a") as browser_lock:
        fcntl.flock(state_lock, fcntl.LOCK_EX)
        fcntl.lockf(browser_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        return _write_state(profile, root / "bitwarden-state.zip")


def _restore_state(profile):
    root = _state_root()
    with (root / "state.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        state = root / "bitwarden-state.zip"
        if not state.exists():
            # Migrate an existing helper profile without opening or printing its vault.
            profiles = list(root.parent.glob("*/firefox-profiles/*"))
            for candidate in sorted(profiles, key=lambda p: p.stat().st_mtime, reverse=True):
                try:
                    with (candidate / ".parentlock").open("a") as browser_lock:
                        fcntl.lockf(browser_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                        if _write_state(candidate, state):
                            break
                except BlockingIOError:
                    continue
        if not state.exists():
            return
        preferences = _preferences(profile)
        with zipfile.ZipFile(state) as archive:
            metadata = json.loads(archive.read("state.json"))
            uuid = metadata["uuid"]
            if not re.fullmatch(r"[a-fA-F0-9-]{36}", uuid):
                raise ValueError("Invalid Bitwarden storage identifier")
            # Remove old SQLite WAL/journal files belonging to this extension only.
            for location in (profile / "browser-extension-data" / BITWARDEN_ID,
                             profile / "storage/default" / ("moz-extension+++" + uuid),
                             profile / "storage/default" / ("moz-extension+++" + uuid + "^userContextId=4294967295")):
                if location.exists():
                    shutil.rmtree(location)
            for member in archive.infolist():
                parts = Path(member.filename).parts
                allowed = (len(parts) > 2 and parts[:2] == ("browser-extension-data", BITWARDEN_ID)) or (
                    len(parts) > 3 and parts[:2] == ("storage", "default") and
                    parts[2] in ("moz-extension+++" + uuid, "moz-extension+++" + uuid + "^userContextId=4294967295"))
                if not allowed or ".." in parts:
                    continue
                target = profile / member.filename
                target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
                with target.open("wb") as output:
                    output.write(archive.read(member))
                target.chmod(0o600)
        uuids = json.loads(preferences.get(UUID_PREF, "{}"))
        uuids[BITWARDEN_ID] = uuid
        updates = {UUID_PREF: json.dumps(uuids)}
        toolbar = json.loads(preferences[TOOLBAR_PREF]) if TOOLBAR_PREF in preferences else metadata["toolbar"]
        placements = toolbar.setdefault("placements", {})
        for widgets in placements.values():
            while WIDGET in widgets:
                widgets.remove(WIDGET)
        if metadata["area"]:
            placements.setdefault(metadata["area"], []).append(WIDGET)
        updates[TOOLBAR_PREF] = json.dumps(toolbar)
        # prefs.js is Firefox-owned; append overrides to user.js for the next launch.
        with (profile / "user.js").open("a") as output:
            for key, value in updates.items():
                output.write("\nuser_pref(" + json.dumps(key) + ", " + json.dumps(value) + ");\n")


def install_bitwarden(profile, source=None):
    """Install the XPI and restore only Bitwarden state, never provider cookies.

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
        _restore_state(profile)
        return True
