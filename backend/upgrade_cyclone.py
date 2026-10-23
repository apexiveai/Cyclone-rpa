from pathlib import Path
from datetime import datetime
import shutil

ROOT = Path(__file__).resolve().parents[1]
BACKUP = ROOT / "backups" / datetime.now().strftime("%Y%m%d_%H%M%S")

FILES = [
    ROOT / "backend" / "app" / "main.py",
    ROOT / "studio" / "src" / "WorkflowDesigner.tsx",
]

for path in FILES:
    if not path.is_file():
        raise SystemExit(f"ABORT: missing file: {path}")

for path in FILES:
    dest = BACKUP / path.relative_to(ROOT)
    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(path, dest)

print("Backup created:", BACKUP)
print("No project files have been replaced yet.")
print("Ready for the next upgrade step.")