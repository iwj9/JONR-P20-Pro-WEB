"""JONR P20 Pro 최초 설정 / 재로그인 도구.

사용법:
  JONR-P20-Pro-Configure.exe            최초 설정 (토큰·IP·DID·서버 + 세션 저장)
  JONR-P20-Pro-Configure.exe --relogin  저장된 세션 만료 시 재로그인

이 파일은 설치 프로그램이 아니다. 설정 값은 exe와 같은 폴더에 저장된다.
"""
from __future__ import annotations

import sys

import app
import cloud_session
import xc_cloud
from paths import USER_DIR


def main():
    if "--help" in sys.argv or "-h" in sys.argv:
        print("JONR P20 Pro 설정 도구")
        print("  JONR-P20-Pro-Configure.exe            최초 설정")
        print("  JONR-P20-Pro-Configure.exe --relogin  세션 갱신")
        return 0
    if "--relogin" in sys.argv:
        print("[설정] Mi 클라우드 세션을 갱신합니다.")
        ok = cloud_session.login_interactive(force=True)
        if ok:
            xc_cloud.invalidate()
            print("[설정] 세션 갱신 완료. Web.exe를 다시 실행하세요.")
        else:
            print("[설정] 세션 갱신 실패. Mi Home 계정과 네트워크를 확인하세요.")
        return 0 if ok else 1

    print("[설정] Mi Home 계정으로 최초 설정을 시작합니다.")
    setup = cloud_session.setup_interactive()
    if not setup:
        print("[설정] 설정 실패. Mi Home 계정과 네트워크를 확인하세요.")
        return 1
    cfg = app.load_config()
    cfg.update(setup)
    app.save_config(cfg)
    print(f"[설정] 완료. 설정 파일은 `{USER_DIR}`에 저장되었습니다.")
    print("[설정] 이제 JONR-P20-Pro-Web.exe를 실행하세요.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
