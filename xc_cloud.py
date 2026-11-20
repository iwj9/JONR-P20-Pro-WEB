"""백엔드용 클라우드 세션 (비밀번호 저장 없음, 캐시된 세션 재사용).

`cloud_session.py`가 저장한 `.xc_session.json`을 읽어 세션을 복원한다.
세션이 없거나 만료됐으면 지도 기능만 비활성화되고, 로컬 제어는 계속 동작한다.
"""
import json
import os
import sys

import cloud_session as cs
from paths import RESOURCE_DIR

sys.path.insert(0, RESOURCE_DIR)

_CONN = None
_SRV = None
_XC = None


def _load_xc():
    global _XC
    if _XC is None:
        _XC = cs.load_connector()
    return _XC


def get_cloud():
    """(conn, server) 또는 (None, None). 로그인 프롬프트 없음."""
    global _CONN, _SRV
    if _CONN is not None:
        return _CONN, _SRV
    sess = cs.load_session()
    if not sess:
        return None, None
    xc = _load_xc()
    if xc is None:
        return None, None
    conn = xc.PasswordXiaomiCloudConnector()
    try:
        cs._apply_session(conn, sess)
        for srv in cs.SERVERS:
            try:
                if isinstance(conn.get_dev_cnt(srv), dict):
                    _CONN, _SRV = conn, srv
                    return _CONN, _SRV
            except Exception:
                continue
    except Exception:
        pass
    return None, None


def invalidate():
    global _CONN, _SRV
    _CONN, _SRV = None, None


def cloud_action(did, siid, aiid, in_params, timeout=60):
    """성공 시 응답 dict, 세션 문제 시 RuntimeError."""
    import requests
    conn, srv = get_cloud()
    if conn is None:
        raise RuntimeError("클라우드 세션 없음. `python app.py --login`으로 Mi 계정 로그인을 한 번 실행하세요.")
    base = "https://" + ("" if srv == "cn" else srv + ".") + "api.io.mi.com/app"
    body = {"params": {"did": str(did), "siid": siid, "aiid": aiid,
                       "in": list(in_params)}}
    try:
        resp = conn.execute_api_call_encrypted(
            base + "/miotspec/action", {"data": json.dumps(body)})
    except Exception as e:
        invalidate()
        raise RuntimeError(f"클라우드 호출 실패: {e}")
    if not isinstance(resp, dict) or resp.get("code") != 0:
        raise RuntimeError(f"클라우드 응답 오류: {str(resp)[:200]}")
    return resp, srv


def action_on_device_server(did, siid, aiid, in_params, prefer=None):
    """기기가 바인딩된 서버를 찾아 액션 실행. (서버 틀리면 'get udid error')"""
    conn, _s = get_cloud()
    if conn is None:
        raise RuntimeError("클라우드 세션 없음. `python app.py --login`으로 Mi 계정 로그인을 한 번 실행하세요.")
    order = []
    for s in ([prefer] if prefer else []) + cs.SERVERS:
        if s and s not in order:
            order.append(s)
    last = None
    for srv in order:
        base = "https://" + ("" if srv == "cn" else srv + ".") + "api.io.mi.com/app"
        body = {"params": {"did": str(did), "siid": siid, "aiid": aiid,
                           "in": list(in_params)}}
        try:
            resp = conn.execute_api_call_encrypted(
                base + "/miotspec/action", {"data": json.dumps(body)})
        except Exception as e:
            last = f"{srv}: 호출 실패 {str(e)[:100]}"
            continue
        if isinstance(resp, dict) and resp.get("code") == 0:
            return resp, srv
        last = f"{srv}: {str(resp)[:150]}"
    invalidate()
    raise RuntimeError(f"전 서버 거부. 마지막: {last}")


def cloud_download(objname, server=None, timeout=60):
    import requests
    conn, srv = get_cloud()
    if conn is None:
        raise RuntimeError("클라우드 세션 없음. `python app.py --login`으로 Mi 계정 로그인을 한 번 실행하세요.")
    srvs = [server] if server else cs.SERVERS
    for s in srvs:
        base = "https://" + ("" if s == "cn" else s + ".") + "api.io.mi.com/app"
        try:
            url = cs.file_url(conn, base, objname)
            if not url:
                continue
            dl = requests.get(url, timeout=timeout)
            if dl.status_code == 200 and dl.content:
                return dl.content, s
        except Exception:
            continue
    raise RuntimeError("지도 다운로드 실패")
