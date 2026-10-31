"""Install this build into an explicitly supplied local Obsidian vault.

Copies runtime files only, keeps existing plugin data, and verifies bytes.
Enabling the plugin is performed separately in Obsidian.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import tempfile
from datetime import datetime

parser = argparse.ArgumentParser()
parser.add_argument("vault", type=Path)
parser.add_argument("--owner", default="")
parser.add_argument("--repo", default="")
parser.add_argument("--idle-seconds", type=int)
args = parser.parse_args()
if args.idle_seconds is not None and not 3 <= args.idle_seconds <= 300:
    parser.error("--idle-seconds must be between 3 and 300")
project = Path(__file__).resolve().parent.parent
manifest = json.loads((project / "dist/manifest.json").read_text())
vault = args.vault.resolve(strict=True)
config = vault / ".obsidian"
if not config.is_dir():
    raise SystemExit("Expected an existing .obsidian configuration directory.")
target = config / "plugins" / manifest["id"]
if target.is_symlink():
    raise SystemExit("Refusing to replace a symlinked plugin directory.")
assets = ["main.js", "manifest.json", "styles.css"]
source_bytes = {name: (project / "dist" / name).read_bytes() for name in assets}
if target.exists():
    backup = config / ".github-bridge-backups" / (target.name + "-" + datetime.now().strftime("%Y%m%d-%H%M%S"))
    backup.parent.mkdir(parents=True, exist_ok=True)
    shutil.copytree(target, backup)
    print("Existing plugin backed up:", backup)
target.mkdir(parents=True, exist_ok=True)
for name, data in source_bytes.items():
    descriptor, temp = tempfile.mkstemp(prefix=".install-", dir=target)
    try:
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp, target / name)
    finally:
        if os.path.exists(temp):
            os.unlink(temp)
    if (target / name).read_bytes() != data:
        raise SystemExit("Installed asset verification failed: " + name)
data_file = target / "data.json"
if not data_file.exists():
    settings = {
        "owner": args.owner,
        "repo": args.repo,
        "branch": "main",
        "secretName": "vault-github-bridge",
        "device": "Mac",
        "autoSync": False,
        "readOnly": False,
        "intervalSeconds": 90,
        "idleSeconds": 10,
        "maxFileMB": 10,
        "excludedFolders": "",
    }
    with data_file.open("x") as handle:
        json.dump(settings, handle, ensure_ascii=False, indent=2)
if args.idle_seconds is not None:
    settings = json.loads(data_file.read_text())
    settings['idleSeconds'] = args.idle_seconds
    descriptor, temp = tempfile.mkstemp(prefix='.settings-', dir=target)
    try:
        with os.fdopen(descriptor, 'w') as handle:
            json.dump(settings, handle, ensure_ascii=False, indent=2)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp, data_file)
    finally:
        if os.path.exists(temp): os.unlink(temp)
print(json.dumps({
    "installed": str(target),
    "version": manifest["version"],
    "main_js_sha256": hashlib.sha256(source_bytes["main.js"]).hexdigest(),
    "existing_settings_preserved": True,
    "enabled_registry_unchanged": True,
}, ensure_ascii=False, indent=2))
