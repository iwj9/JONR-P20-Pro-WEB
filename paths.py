"""실행 파일/소스 실행 모두에서 일관된 경로를 제공한다.

- user_dir: 설정·세션·채널 파일을 저장할 사용자 폴더
  - 소스 실행: 이 파일이 있는 폴더
  - PyInstaller: exe가 있는 폴더 (onedir 기준 dist/JONR-P20-Pro-Web)
- resource_dir: static/ 같은 번들 리소스가 있는 폴더
  - 소스 실행: 이 파일이 있는 폴더
  - PyInstaller: sys._MEIPASS (onedir에서는 _internal 폴더)
"""
from __future__ import annotations

import os
import sys

FROZEN = getattr(sys, "frozen", False)
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
USER_DIR = os.path.dirname(os.path.abspath(sys.executable)) if FROZEN else BASE_DIR
RESOURCE_DIR = getattr(sys, "_MEIPASS", BASE_DIR)

CONFIG_PATH = os.path.join(USER_DIR, "config.json")
SESSION_PATH = os.path.join(USER_DIR, ".xc_session.json")
OLD_SESSION_PATH = os.path.join(USER_DIR, ".xc_session.pkl")
CHANNEL_PATH = os.path.join(USER_DIR, ".channel_map.json")
STATIC_DIR = os.path.join(RESOURCE_DIR, "static")
