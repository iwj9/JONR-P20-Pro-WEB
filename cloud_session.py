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

from paths import OLD_SESSION_PATH as _OLD_SESSION_PATH
from paths import SESSION_PATH

BASE = os.path.dirname(os.path.abspath(__file__))
SESS_PATH = SESSION_PATH
OLD_SESS_PATH = _OLD_SESSION_PATH
SERVERS = ["cn", "de", "us", "ru", "tw", "sg", "in", "i2"]

TOKEN_EXTRACTOR_COMMIT = "d8bb6a9e6aeff2d38ecc9e4caefcc58f8551e672"
TOKEN_EXTRACTOR_SHA256 = "e4eb8220df0f68c945c21cde5dbc5a0a276e7a035857b568d9423788ef192a30"
TOKEN_EXTRACTOR_URL = (
    "https://raw.githubusercontent.com/PiotrMachowski/"
    "Xiaomi-cloud-tokens-extractor/" + TOKEN_EXTRACTOR_COMMIT + "/token_extractor.py"
)
_EXTRACTOR_PATH = os.path.join(tempfile.gettempdir(), "token_extractor.py")
_SESSION_KEYS = ("_serviceToken", "_ssecurity", "userId", "_device_id", "_agent")
TARGET_MODEL = "xtl.vacuum.xm2216"


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


def _session_is_valid(conn, preferred=None):
    servers = ([preferred] if preferred else []) + [s for s in SERVERS if s != preferred]
    for server in servers:
        try:
            resp = conn.get_dev_cnt(server)
            if isinstance(resp, dict) and resp.get("code") == 0 and "result" in resp:
                return True
        except Exception:
            continue
    return False


def validate_session(preferred=None):
    """저장된 세션이 실제로 유효한지 확인한다."""
    sess = load_session()
    if not sess:
        return False
    xc = load_connector()
    if xc is None:
        return False
    try:
        conn = xc.PasswordXiaomiCloudConnector()
        _apply_session(conn, sess)
        return _session_is_valid(conn, preferred)
    except Exception:
        return False


def ensure_session(preferred=None):
    """앱 시작 시 세션을 확인하고, 만료됐으면 대화형 재로그인을 유도한다."""
    if validate_session(preferred):
        return True
    if not sys.stdin.isatty():
        print("[안내] Mi 클라우드 세션이 없거나 만료되었습니다. "
              "`python app.py --login` (최초라면 --setup)으로 다시 로그인하세요. "
              "로컬 제어는 계속 가능합니다.")
        return False
    print("[안내] Mi 클라우드 세션이 없거나 만료되어 로그인을 시작합니다.")
    try:
        return login_interactive(force=True)
    except (EOFError, KeyboardInterrupt):
        print("[안내] 로그인이 취소되었습니다. 로컬 제어는 계속 가능합니다.")
        return False


def login_interactive(force=False):
    """저장된 세션이 없거나 만료됐을 때 Mi 계정 로그인을 수행한다."""
    xc = load_connector()
    if xc is None:
        return False
    conn = xc.PasswordXiaomiCloudConnector()
    if not force:
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


def _discover_targets(conn):
    """로그인한 커넥터로 P20 Pro가 있는 서버와 기기 정보를 찾는다."""
    found = {}
    for srv in SERVERS:
        homes = []
        seen = set()
        try:
            resp = conn.get_homes(srv)
            result = resp.get("result") if isinstance(resp, dict) else None
            for home in (result or {}).get("homelist") or []:
                key = (home.get("id"), conn.userId)
                if key[0] is not None and key not in seen:
                    seen.add(key)
                    homes.append(key)
        except Exception:
            pass
        try:
            resp = conn.get_dev_cnt(srv)
            result = resp.get("result") if isinstance(resp, dict) else None
            for home in ((result or {}).get("share") or {}).get("share_family") or []:
                key = (home.get("home_id"), home.get("home_owner"))
                if key[0] is not None and key not in seen:
                    seen.add(key)
                    homes.append(key)
        except Exception:
            pass
        devices = []
        for home_id, owner in homes:
            try:
                resp = conn.get_devices(srv, home_id, owner)
                result = resp.get("result") if isinstance(resp, dict) else None
            except Exception:
                continue
            for item in (result or {}).get("device_info") or []:
                if str(item.get("model", "")).lower() != TARGET_MODEL:
                    continue
                devices.append({
                    "ip": str(item.get("localip") or "").strip(),
                    "token": str(item.get("token") or "").strip(),
                    "did": str(item.get("did") or "").strip(),
                    "name": str(item.get("name") or "").strip(),
                })
        if devices:
            found[srv] = devices
    return found


def setup_interactive():
    """한 번의 로그인으로 세션과 기기 설정을 모두 만든다."""
    xc = load_connector()
    if xc is None:
        return None
    conn = xc.PasswordXiaomiCloudConnector()
    if not conn.login():
        print("클라우드 로그인에 실패했습니다. Mi Home 계정을 확인한 뒤 다시 시도하세요.")
        return None
    try:
        save_session(conn.__dict__)
        print("[클라우드] 세션을 저장했습니다. (.xc_session.json)")
    except Exception as exc:
        print(f"[클라우드] 세션 저장 실패: {exc}")
        return None

    found = _discover_targets(conn)
    if not found:
        print(f"로그인은 성공했지만 {TARGET_MODEL} 기기를 찾지 못했습니다.")
        return None
    servers = list(found.keys())
    print("\n기기를 찾은 서버:")
    for srv in servers:
        print(f"  - {srv} : {len(found[srv])}대")
    default = servers[0] if len(servers) == 1 else ""
    prompt = f"적용할 서버를 입력하세요 (대소문자 무시)"
    if default:
        prompt += f" [기본: {default}]"
    print(prompt)
    lower_map = {s.lower(): s for s in servers}
    chosen = None
    while chosen is None:
        answer = input("서버: ").strip().lower()
        if not answer and default:
            answer = default
        chosen = lower_map.get(answer)
        if chosen is None:
            print("목록에 없는 서버입니다. 다시 입력하세요: " + ", ".join(servers))
    devices = found[chosen]
    if len(devices) > 1:
        print(f"같은 서버에 {len(devices)}대가 있어 첫 번째 기기를 사용합니다.")
    dev = devices[0]
    if not dev["ip"] or not dev["token"]:
        print("기기의 IP 또는 토큰을 읽지 못했습니다.")
        return None
    masked = dev["token"][:4] + "…" + dev["token"][-4:] if len(dev["token"]) == 32 else "(길이 비정상)"
    print(f"선택: 서버={chosen} IP={dev['ip']} DID={dev['did']} token={masked}")
    return {"ip": dev["ip"], "token": dev["token"], "did": dev["did"], "server": chosen}


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
