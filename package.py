"""dist/JONR-P20-Pro 폴더를 Release용 ZIP으로 만든다."""
from __future__ import annotations

import pathlib
import zipfile

root = pathlib.Path("dist/JONR-P20-Pro")
out = pathlib.Path("JONR-P20-Pro-portable.zip")
if not root.is_dir():
    raise SystemExit("dist/JONR-P20-Pro 폴더가 없습니다. build.ps1을 먼저 실행하세요.")

with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as zf:
    for path in root.rglob("*"):
        if path.is_file():
            zf.write(path, path.relative_to(root))
print(f"[패키징] {out} ({out.stat().st_size} bytes)")
