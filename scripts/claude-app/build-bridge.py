#!/usr/bin/env python3
"""Build pinned ClewdR with Lyod's rate-limit and explicit web model/effort patch."""
import argparse
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

COMMIT = "ced44ece9cef0686262855479362072105ef9d8e"
PATCH = Path(__file__).with_name("clewdr-retry-after.patch")
TARGET = Path("~/.local/share/lyod-rotator/claude-app/clewdr-v0.13.5/clewdr-lyod").expanduser()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True)
    args = parser.parse_args()
    source = args.source.resolve()

    def git(*arguments):
        return subprocess.check_output(["git", "-C", str(source), *arguments], text=True).strip()

    if git("rev-parse", "HEAD") != COMMIT:
        parser.error("Expected the pinned v0.13.5 source commit")
    if git("status", "--porcelain"):
        # Never discard the caller's changes, even in the external checkout.
        if git("diff", "HEAD") != PATCH.read_text().strip() or git("ls-files", "--others", "--exclude-standard"):
            parser.error("Source has changes other than the exact Lyod patch")
    else:
        subprocess.run(["git", "apply", "--check", str(PATCH)], cwd=source, check=True)
        subprocess.run(["git", "apply", str(PATCH)], cwd=source, check=True)
    subprocess.run(["cargo", "test", "--locked", "-p", "clewdr", "lyod_"], cwd=source, check=True)
    subprocess.run(["cargo", "build", "--locked", "-p", "clewdr"], cwd=source, check=True)
    TARGET.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd, temporary = tempfile.mkstemp(dir=TARGET.parent)
    try:
        target = Path(os.environ.get("CARGO_TARGET_DIR", source / "target"))
        if not target.is_absolute():
            target = source / target
        with os.fdopen(fd, "wb") as output, (target / "debug/clewdr").open("rb") as binary:
            shutil.copyfileobj(binary, output)
            output.flush()
            os.fsync(output.fileno())
        os.chmod(temporary, 0o700)
        os.replace(temporary, TARGET)
    finally:
        Path(temporary).unlink(missing_ok=True)
    print("Installed pinned ClewdR with Lyod patch; stock release preserved.")


if __name__ == "__main__":
    main()
