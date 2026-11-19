"""Mi 클라우드 세션 보조.

지도 파일은 기기 로컬이 아니라 Mi 클라우드 KS3에서 내려받는다.
이 모듈은 token_extractor.py의 로그인 코드를 재사용해 세션을 만들고
`.xc_session.pkl`에 저장한다. (세션 파일은 절대 공유하지 말 것)

token_extractor.py는 README의 안내에 따라 임시 폴더에 한 번 내려받으면 된다.
"""
from __future__ import annotations

import importlib.util
import json
import os
import pickle
import sys
import tempfile

BASE = os.path.dirname(os.path.abspath(__file__))
SESS_PATH = os.path.join(BASE, ".xc_session.pkl")
SERVERS = ["cn", "de", "us", "ru", "tw", "sg", "in", "i2"]


def session_exists():
    return os.path.exists(SESS_PATH)


def load_connector():
    """임시 폴더의 token_extractor.py를 모듈로 불러온다."""
    xc_path = os.path.join(tempfile.gettempdir(), "token_extractor.py")
    if not os.path.exists(xc_path):
        print("token_extractor.py가 없습니다. 아래 명령으로 내려받으세요:")
        print('curl.exe -sL "https://raw.githubusercontent.com/PiotrMachowski/'
              'Xiaomi-cloud-tokens-extractor/master/token_extractor.py" '
              '-o "%TEMP%\\token_extractor.py"')
        return None
    old_argv = sys.argv
    sys.argv = ["cloud_session"]  # token_extractor의 모듈 수준 인자 파싱 무력화
    try:
        spec = importlib.util.spec_from_file_location("xc_token", xc_path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module
    except Exception as exc:
        print(f"token_extractor.py 로드 실패: {exc}")
        return None
    finally:
        sys.argv = old_argv


def _apply_session(conn, sess):
    conn._serviceToken = sess["_serviceToken"]
    conn._ssecurity = sess["_ssecurity"]
    conn.userId = sess["userId"]
    conn._device_id = sess.get("_device_id", conn._device_id)
    conn._agent = sess.get("_agent", conn._agent)


def _session_is_valid(conn):
    for server in SERVERS:
        try:
            if isinstance(conn.get_dev_cnt(server), dict):
                return True
        except Exception:
            continue
    return False


def login_interactive():
    """저장된 세션이 없거나 만료됐을 때 Mi 계정 로그인을 수행한다."""
    xc = load_connector()
    if xc is None:
        return False
    conn = xc.PasswordXiaomiCloudConnector()
    if os.path.exists(SESS_PATH):
        try:
            with open(SESS_PATH, "rb") as fh:
                _apply_session(conn, pickle.load(fh))
            if _session_is_valid(conn):
                print("[클라우드] 저장된 세션을 재사용합니다.")
                return True
        except Exception:
            pass
    if not conn.login():
        print("클라우드 로그인에 실패했습니다. Mi Home 계정을 확인한 뒤 다시 시도하세요.")
        return False
    try:
        with open(SESS_PATH, "wb") as fh:
            pickle.dump({
                "_serviceToken": conn._serviceToken,
                "_ssecurity": conn._ssecurity,
                "userId": conn.userId,
                "_device_id": conn._device_id,
                "_agent": conn._agent,
            }, fh)
        print("[클라우드] 로그인 성공. 세션을 로컬에 저장했습니다. (공유 금지)")
    except Exception as exc:
        print(f"[클라우드] 세션 저장 실패(무시): {exc}")
    return True


def file_url(conn, base, obj):
    """KS3 오브젝트 이름을 다운로드 URL로 변환한다."""
    for endpoint in ("get_interim_file_url_pro", "get_interim_file_url"):
        try:
            resp = conn.execute_api_call_encrypted(
                base + f"/v2/home/{endpoint}",
                {"data": json.dumps({"obj_name": obj})})
        except Exception:
            continue
        if isinstance(resp, dict):
            result = resp.get("result") or {}
            if isinstance(result, str) and result.startswith("http"):
                return result
            if isinstance(result, dict) and isinstance(result.get("url"), str):
                return result["url"]
    return None
