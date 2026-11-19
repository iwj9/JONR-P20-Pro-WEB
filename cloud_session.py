"""Mi 클라우드 세션 보조.

지도 파일은 Mi 클라우드 KS3에서 내려받는다.
이 모듈은 token_extractor.py의 로그인 코드를 재사용하되,
다운로드한 파일의 커밋과 SHA256을 고정해 임의 코드 실행 위험을 줄인다.
세션은 pickle 대신 JSON으로 저장한다. (.xc_session.json, 절대 공유 금지)
"""
from __future__ import annotations

import hashlib
import importlib.util
import json
import os
import pickle
import sys
import tempfile

import requests

BASE = os.path.dirname(os.path.abspath(__file__))
SESS_PATH = os.path.join(BASE, ".xc_session.json")
OLD_SESS_PATH = os.path.join(BASE, ".xc_session.pkl")
SERVERS = ["cn", "de", "us", "ru", "tw", "sg", "in", "i2"]

TOKEN_EXTRACTOR_COMMIT = "d8bb6a9e6aeff2d38ecc9e4caefcc58f8551e672"
TOKEN_EXTRACTOR_SHA256 = "e4eb8220df0f68c945c21cde5dbc5a0a276e7a035857b568d9423788ef192a30"
TOKEN_EXTRACTOR_URL = (
    "https://raw.githubusercontent.com/PiotrMachowski/"
    "Xiaomi-cloud-tokens-extractor/" + TOKEN_EXTRACTOR_COMMIT + "/token_extractor.py"
)
_EXTRACTOR_PATH = os.path.join(tempfile.gettempdir(), "token_extractor.py")
_SESSION_KEYS = ("_serviceToken", "_ssecurity", "userId", "_device_id", "_agent")


def session_exists():
    return os.path.exists(SESS_PATH) or os.path.exists(OLD_SESS_PATH)


def _valid_extractor(path):
    try:
        with open(path, "rb") as fh:
            return hashlib.sha256(fh.read()).hexdigest() == TOKEN_EXTRACTOR_SHA256
    except OSError:
        return False


def load_connector():
    """고정된 커밋·해시의 token_extractor.py만 불러온다."""
    if not _valid_extractor(_EXTRACTOR_PATH):
        try:
            resp = requests.get(TOKEN_EXTRACTOR_URL, timeout=30)
            resp.raise_for_status()
            digest = hashlib.sha256(resp.content).hexdigest()
            if digest != TOKEN_EXTRACTOR_SHA256:
                print(f"token_extractor.py 해시 불일치: {digest}")
                return None
            with open(_EXTRACTOR_PATH, "wb") as fh:
                fh.write(resp.content)
        except Exception as exc:
            print(f"token_extractor.py 내려받기 실패: {exc}")
            return None
    old_argv = sys.argv
    sys.argv = ["cloud_session"]  # token_extractor의 모듈 수준 인자 파싱 무력화
    try:
        spec = importlib.util.spec_from_file_location("xc_token", _EXTRACTOR_PATH)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module
    except Exception as exc:
        print(f"token_extractor.py 로드 실패: {exc}")
        return None
    finally:
        sys.argv = old_argv


class _SafeUnpickler(pickle.Unpickler):
    """레거시 세션 파일에서 기본 자료형만 읽는다."""

    def find_class(self, module, name):
        raise pickle.UnpicklingError("안전하지 않은 객체 포함")


def load_session():
    """JSON 세션을 읽고, 레거시 pickle이 있으면 안전하게 변환한다."""
    if os.path.exists(SESS_PATH):
        try:
            with open(SESS_PATH, encoding="utf-8") as fh:
                data = json.load(fh)
            if isinstance(data, dict):
                return {k: str(data[k]) for k in _SESSION_KEYS if k in data}
        except Exception:
            pass
    if os.path.exists(OLD_SESS_PATH):
        try:
            with open(OLD_SESS_PATH, "rb") as fh:
                data = _SafeUnpickler(fh).load()
            if isinstance(data, dict):
                clean = {k: str(data[k]) for k in _SESSION_KEYS if k in data}
                if clean:
                    save_session(clean)
                    try:
                        os.remove(OLD_SESS_PATH)
                    except OSError:
                        pass
                    return clean
        except Exception:
            pass
    return None


def save_session(data):
    clean = {k: str(data[k]) for k in _SESSION_KEYS if k in data}
    with open(SESS_PATH, "w", encoding="utf-8") as fh:
        json.dump(clean, fh, ensure_ascii=False, indent=2)
    try:
        os.chmod(SESS_PATH, 0o600)
    except OSError:
        pass


def _apply_session(conn, sess):
    for key in _SESSION_KEYS:
        if key in sess:
            setattr(conn, key, sess[key])


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
    sess = load_session()
    if sess:
        _apply_session(conn, sess)
        if _session_is_valid(conn):
            print("[클라우드] 저장된 세션을 재사용합니다.")
            return True
    if not conn.login():
        print("클라우드 로그인에 실패했습니다. Mi Home 계정을 확인한 뒤 다시 시도하세요.")
        return False
    try:
        save_session(conn.__dict__)
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
