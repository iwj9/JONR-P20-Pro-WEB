"""JONR P20 Pro 로컬 웹 대시보드 백엔드. 실행: python app.py → http://127.0.0.1:5000"""
from __future__ import annotations

import json
import os
import sys
import threading
import time
from flask import Flask, jsonify, request, send_from_directory, Response, abort

from jonr import JonrDevice
import cloud_session
import map_codec as codec
import map_render
import xc_cloud

BASE = os.path.dirname(os.path.abspath(__file__))
CONFIG_PATH = os.path.join(BASE, "config.json")
STATIC_DIR = os.path.join(BASE, "static")

app = Flask(__name__, static_folder=STATIC_DIR, static_url_path="/static")
app.config["SEND_FILE_MAX_AGE_DEFAULT"] = 0

ALLOWED_HOSTS = {"127.0.0.1:5000", "localhost:5000", "127.0.0.1", "localhost"}
ALLOWED_ORIGINS = {"http://127.0.0.1:5000", "http://localhost:5000"}


@app.before_request
def _local_request_only():
    """로컬 브라우저에서만 요청을 허용한다. (CSRF/DNS rebinding 완화)"""
    if request.host not in ALLOWED_HOSTS:
        abort(403)
    if request.method in ("POST", "PUT", "PATCH", "DELETE"):
        origin = request.headers.get("Origin")
        if origin and origin not in ALLOWED_ORIGINS:
            abort(403)
        if request.headers.get("Sec-Fetch-Site") == "cross-site":
            abort(403)
        if request.headers.get("X-Requested-With") != "XMLHttpRequest":
            abort(403)
        if request.mimetype != "application/json":
            abort(415)


@app.after_request
def _no_cache(resp):
    if request.path.startswith("/static/"):
        resp.headers["Cache-Control"] = "no-store, max-age=0"
    return resp

_MAP_CACHE = {"png": None, "meta": None, "walls": None, "map_id": None,
              "obj": None, "raw": None}
_LOCK = threading.RLock()
_CONFIG_CACHE = {"mtime": None, "data": {}}
_DEVICE_CACHE = {"key": None, "dev": None}


def load_config():
    try:
        mtime = os.stat(CONFIG_PATH).st_mtime_ns
    except OSError:
        return {}
    with _LOCK:
        if _CONFIG_CACHE["mtime"] == mtime:
            return dict(_CONFIG_CACHE["data"])
        try:
            with open(CONFIG_PATH, encoding="utf-8") as f:
                data = json.load(f)
        except Exception:
            data = {}
        _CONFIG_CACHE.update(mtime=mtime, data=data)
        return dict(data)


def save_config(cfg):
    with _LOCK:
        with open(CONFIG_PATH, "w", encoding="utf-8") as f:
            json.dump(cfg, f, ensure_ascii=False, indent=2)
        try:
            _CONFIG_CACHE.update(mtime=os.stat(CONFIG_PATH).st_mtime_ns,
                                 data=dict(cfg))
        except OSError:
            _CONFIG_CACHE["mtime"] = None


def get_device() -> JonrDevice:
    cfg = load_config()
    ip, token = cfg.get("ip", ""), cfg.get("token", "")
    if not ip or not token:
        raise RuntimeError("IP/token 미설정 — 우측 상단 설정에서 입력하세요")
    did = cfg.get("did", "")
    key = (ip, token, did)
    with _LOCK:
        if _DEVICE_CACHE["key"] != key or _DEVICE_CACHE["dev"] is None:
            _DEVICE_CACHE["dev"] = JonrDevice(ip, token, did)
            _DEVICE_CACHE["key"] = key
        return _DEVICE_CACHE["dev"]


@app.route("/")
def index():
    return send_from_directory(STATIC_DIR, "index.html")


@app.route("/api/health")
def health():
    return jsonify({"ok": True, "model": "xtl.vacuum.xm2216"})


@app.route("/api/config", methods=["GET", "POST"])
def config():
    if request.method == "GET":
        cfg = load_config()
        tok = cfg.get("token", "")
        resp = jsonify({
            "ip": cfg.get("ip", ""),
            "did": cfg.get("did", ""),
            "has_token": len(tok) == 32,
            "token_masked": (tok[:4] + "…" + tok[-4:] if len(tok) == 32 else ""),
            "force_cloud": bool(cfg.get("force_cloud")),
        })
        resp.headers["Cache-Control"] = "no-store"
        return resp
    data = request.get_json(silent=True) or {}
    saved = load_config()
    if "force_cloud" in data and not any(data.get(k) for k in ("ip", "token", "did")):
        saved["force_cloud"] = bool(data.get("force_cloud"))
        save_config(saved)
        return jsonify({"ok": True, "force_cloud": saved["force_cloud"]})
    ip = str(data.get("ip", "")).strip() or str(saved.get("ip", "")).strip()
    token = str(data.get("token", "")).strip() or str(saved.get("token", "")).strip()
    did = str(data.get("did", "")).strip() or str(saved.get("did", "")).strip()
    if not ip or not token:
        return jsonify({"ok": False, "error": "ip/token 필요"}), 400
    try:
        dev = JonrDevice(ip, token, did)
        info = dev.info()
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 400
    cfg = {"ip": ip, "token": token, "did": did,
           "server": saved.get("server", ""),
           "force_cloud": bool(data.get("force_cloud", saved.get("force_cloud")))}
    save_config(cfg)
    return jsonify({"ok": True, "info": info})


@app.route("/api/status")
def status():
    try:
        dev = get_device()
        st = dev.status()
        try:
            st["device_info"] = dev.info()
        except Exception:
            pass
        return jsonify({"ok": True, **st})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 502


def _cloud_start(name, data):
    """시작 계열(start/room/zone/spot)을 클라우드로: stop-clean 후 start-clean."""
    if name == "start":
        params = [1, "[]"]
    elif name == "room":
        ids = [int(x) for x in (data.get("room_ids") or [])]
        params = [3, json.dumps(ids, separators=(",", ":"))]
    elif name == "zone":
        rects = data.get("rects")
        if not rects and data.get("rect"):
            rects = [data["rect"]]
        ring = []
        for r in rects or []:
            x1, y1, x2, y2 = [int(v) for v in r]
            xa, xb = sorted((x1, x2))
            ya, yb = sorted((y1, y2))
            ring += [xa, ya, xb, ya, xb, yb, xa, yb]
        params = [4, json.dumps(ring, separators=(",", ":"))]
    elif name == "spot":
        params = [6, ""]
    else:
        raise ValueError(name)
    try:
        _cloud_action(17, 3, [])          # 이전 작업 닫기
    except Exception:
        pass
    time.sleep(2)
    return _cloud_action(17, 1, params)


@app.route("/api/action", methods=["POST"])
def action():
    data = request.get_json(silent=True) or {}
    name = str(data.get("name", "")).lower()
    if name not in ACTION_CODES and name not in ("spot", "room", "zone"):
        return jsonify({"ok": False, "error": f"unknown action: {name}"}), 400
    default_ch = "cloud" if name in ("start", "room", "zone", "spot") else "local"
    channel = _chan_get("actions", name, default_ch)
    if channel == "cloud":
        try:
            if name in ("start", "room", "zone", "spot"):
                return jsonify({"ok": True, **_cloud_start(name, data)})
            siid, aiid, params = ACTION_CODES[name]
            return jsonify({"ok": True, **_cloud_action(siid, aiid, params)})
        except Exception as e:
            if name in ACTION_CODES or name in ("start", "room", "zone", "spot"):
                return jsonify({"ok": False, "error": str(e)}), 502
    try:
        dev = get_device()
        if name == "start":
            r = dev.start_full()
        elif name == "stop":
            r = dev.stop()
        elif name == "pause":
            r = dev.pause()
        elif name == "resume":
            r = dev.resume()
        elif name == "dock":
            r = dev.dock()
        elif name == "locate":
            r = dev.locate()
        elif name == "spot":
            r = dev.spot_clean()
        elif name == "room":
            ids = data.get("room_ids") or []
            r = dev.room_clean(ids)
        elif name == "zone":
            rects = data.get("rects")
            if not rects and data.get("rect"):
                rects = [data["rect"]]
            ring = []
            for rct in rects or []:
                x1, y1, x2, y2 = [int(v) for v in rct]
                xa, xb = sorted((x1, x2))
                ya, yb = sorted((y1, y2))
                ring += [xa, ya, xb, ya, xb, yb, xa, yb]
            r = dev.zone_clean(ring)
        elif name == "wash":
            r = dev.wash_mop()
        elif name == "dry":
            r = dev.dry_mop()
        elif name == "collect":
            r = dev.collect_dust()
        else:
            return jsonify({"ok": False, "error": f"unknown action: {name}"}), 400
        _chan_set("actions", name, "local")
        return jsonify({"ok": True, "transport": "local",
                        "result": r if isinstance(r, (list, dict)) else str(r)})
    except Exception as e:
        if name in ACTION_CODES or name in ("start", "room", "zone", "spot"):
            try:
                if name in ("start", "room", "zone", "spot"):
                    r = _cloud_start(name, data)
                else:
                    siid, aiid, params = ACTION_CODES[name]
                    r = _cloud_action(siid, aiid, params)
                _chan_set("actions", name, "cloud")
                return jsonify({"ok": True, "fallback": str(e)[:120], **r})
            except Exception as e2:
                return jsonify({"ok": False, "error": f"{e} / 클라우드: {e2}"}), 502
        return jsonify({"ok": False, "error": str(e)}), 502


CHANNEL_PATH = os.path.join(BASE, ".channel_map.json")


def _chan_load():
    try:
        with open(CHANNEL_PATH, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {"settings": {}, "actions": {}}


def _chan_get(kind, key, default):
    if load_config().get("force_cloud"):
        return "cloud"
    return _chan_load().get(kind, {}).get(key, default)


def _chan_set(kind, key, val):
    m = _chan_load()
    m.setdefault(kind, {})[key] = val
    try:
        with open(CHANNEL_PATH, "w", encoding="utf-8") as f:
            json.dump(m, f, ensure_ascii=False, indent=1)
    except Exception:
        pass


SET_CODES = {
    "fan": (17, 26), "water": (17, 27), "mode": (17, 46),
    "count": (17, 28), "route": (17, 50), "volume": (17, 31),
    "child_lock": (17, 36), "disturb": (17, 24),
    "carpet_prefer": (17, 33), "carpet_boost": (17, 34),
    "carpet_twice": (17, 55), "carpet_first": (17, 56),
    "drying": (17, 48), "drying_time": (17, 43),
    "mop_freq": (17, 44), "dust_collection": (17, 32),
    "break_clean": (17, 25), "mop_augment": (17, 35),
}
ACTION_CODES = {
    "start": (17, 1, [1, "[]"]), "stop": (17, 3, []),
    "pause": (17, 2, [7]), "resume": (17, 2, [8]),
    "dock": (16, 1, []), "locate": (17, 4, []),
    "wash": (17, 40, [True]), "dry": (17, 41, [True]),
    "collect": (17, 42, [True]),
}


def _preferred_server():
    """설정에 저장된 서버를 우선, 없으면 마지막 지도 다운로드 서버를 쓴다."""
    return str(load_config().get("server") or "").strip() or _MAP_CACHE.get("srv")


def _cloud_action(siid, aiid, params):
    cfg = load_config()
    did = (cfg.get("did") or "").strip()
    resp, srv = xc_cloud.action_on_device_server(did, siid, aiid, params,
                                                prefer=_preferred_server())
    res = (resp.get("result") or {}) if isinstance(resp, dict) else {}
    if isinstance(res, dict) and res.get("code") not in (None, 0):
        raise RuntimeError(f"기기 거부: {res}")
    return {"transport": "cloud", "server": srv, "code": resp.get("code")}


@app.route("/api/set", methods=["POST"])
def setting():
    data = request.get_json(silent=True) or {}
    key = str(data.get("key", "")).lower()
    val = data.get("value")
    if key == "disturb_time":
        try:
            payload = json.dumps(val if isinstance(val, dict) else {
                "startHour": int(val[0]), "startMin": int(val[1]),
                "endHour": int(val[2]), "endMin": int(val[3]),
                "notDust": int(val[4]), "notDry": int(val[5]),
            }, separators=(",", ":"))
            return jsonify({"ok": True, **_cloud_action(17, 30, [payload])})
        except Exception as e:
            return jsonify({"ok": False, "error": str(e)}), 502
    if key == "language":
        try:
            payload = json.dumps({"language": int(val)}, separators=(",", ":"))
            return jsonify({"ok": True, **_cloud_action(17, 21, [payload])})
        except Exception as e:
            return jsonify({"ok": False, "error": str(e)}), 502
    if key not in SET_CODES:
        return jsonify({"ok": False, "error": f"unknown key: {key}"}), 400
    # 설정류는 로컬 핸들러가 응답하지 않는 기기라 기본이 클라우드
    channel = _chan_get("settings", key, "cloud")
    if channel == "local":
        try:
            dev = get_device()
            fn = {
                "fan": lambda: dev.set_fan(int(val)),
                "water": lambda: dev.set_water(int(val)),
                "mode": lambda: dev.set_mode(int(val)),
                "count": lambda: dev.set_count(int(val)),
                "route": lambda: dev.set_route(int(val)),
                "volume": lambda: dev.set_volume(int(val)),
                "child_lock": lambda: dev.set_child_lock(bool(val)),
                "disturb": lambda: dev.set_disturb(bool(val)),
                "carpet_prefer": lambda: dev.set_carpet_prefer(int(val)),
                "carpet_boost": lambda: dev.set_carpet_boost(bool(val)),
                "carpet_twice": lambda: dev.set_carpet_twice(bool(val)),
                "carpet_first": lambda: dev.set_carpet_first(bool(val)),
                "drying": lambda: dev.set_drying(bool(val)),
                "drying_time": lambda: dev.set_drying_time(int(val)),
                "mop_freq": lambda: dev.set_mop_freq(int(val)),
                "dust_collection": lambda: dev.set_dust_collection(int(val)),
            }[key]
            r = fn()
            return jsonify({"ok": True, "transport": "local",
                            "result": r if isinstance(r, (list, dict)) else str(r)})
        except Exception as e:
            _chan_set("settings", key, "cloud")
            note = str(e)[:100]
    else:
        note = "설정 명령은 클라우드 전용(로컬 핸들러 미응답)"
    try:
        siid, aiid = SET_CODES[key]
        conv = {"child_lock": bool, "disturb": bool, "carpet_boost": bool,
                "carpet_twice": bool, "carpet_first": bool,
                "drying": bool}.get(key, int)
        r = _cloud_action(siid, aiid, [conv(val)])
        return jsonify({"ok": True, "note": note, **r})
    except Exception as e2:
        return jsonify({"ok": False, "error": str(e2)}), 502


@app.route("/api/map")
def map_info():
    # 구버전 placeholder (호환 유지)
    return jsonify({
        "ok": False,
        "phase": 2,
        "error": "지도/문턱 편집은 Phase 2 (토큰 확보 후 실측 연동). "
                 "지금은 Mi Home 커스텀 맵 뷰어 임시 우회 + 아래 /api/threshold/format 참고.",
    }), 501


def _current_map_obj():
    dev = get_device()
    last = None
    for _ in range(3):
        try:
            r = dev._action(17, 12)
            out = (r.get("out") if isinstance(r, dict) else r) or []
            for it in out:
                v = it.get("value") if isinstance(it, dict) else it
                if isinstance(v, str) and v:
                    return v
            last = f"빈 응답: {str(r)[:120]}"
        except Exception as e:
            last = str(e)[:150]
        time.sleep(2)
    raise RuntimeError(f"지도 파일명을 못 받음({last}). 로봇 전원/WiFi 확인.")


def _maps_infos():
    """복층 저장 지도 목록. [{mapId, name, status}]"""
    dev = get_device()
    last = None
    infos_obj = None
    for _ in range(3):
        try:
            r = dev._action(17, 13)
            out = (r.get("out") if isinstance(r, dict) else r) or []
            for it in out:
                v = it.get("value") if isinstance(it, dict) else it
                if isinstance(v, str) and v:
                    infos_obj = v
                    break
            if infos_obj:
                break
            last = f"빈 응답: {str(r)[:120]}"
        except Exception as e:
            last = str(e)[:150]
        time.sleep(2)
    if not infos_obj:
        raise RuntimeError(f"지도 목록을 못 받음({last}). 로봇 전원/WiFi 확인.")
    raw, _srv = xc_cloud.cloud_download(infos_obj)
    obj = json.loads(raw.decode("utf-8", "replace"))
    if not isinstance(obj, list):
        raise RuntimeError("지도 목록 형식 오류")
    return [{"mapId": e.get("mapId"), "name": e.get("name"),
             "status": e.get("status")} for e in obj if isinstance(e, dict)]


def _invalidate_map_cache():
    with _LOCK:
        _MAP_CACHE.update({"png": None, "meta": None, "walls": None,
                           "map_id": None, "obj": None, "raw": None,
                           "data": None})


def _load_map(refresh=False):
    with _LOCK:
        if _MAP_CACHE["png"] is not None and not refresh:
            return _MAP_CACHE
        cfg = load_config()
        obj = _current_map_obj()
        raw, srv = xc_cloud.cloud_download(obj)
        data = map_render.decode_map_file(raw)
        if data is None:
            raise RuntimeError("지도 파싱 실패")
        img, meta = map_render.render_png(data)
        import io
        buf = io.BytesIO()
        img.save(buf, format="PNG")
        _MAP_CACHE.update({"png": buf.getvalue(), "meta": meta,
                           "walls": data["walls"], "map_id": data["map_id"],
                           "obj": obj, "raw": raw, "data": data, "srv": srv})
        return _MAP_CACHE


@app.route("/api/map/image")
def map_image():
    try:
        m = _load_map(refresh=request.args.get("refresh") == "1")
        return Response(m["png"], mimetype="image/png")
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 502


def _map_areas(map_id):
    """infos 파일에서 현재 지도 방 목록(areas) 추출. 실패 시 []."""
    try:
        dev = get_device()
        r = dev._action(17, 13)
        out = (r.get("out") if isinstance(r, dict) else r) or []
        objname = next((it.get("value") if isinstance(it, dict) else it
                        for it in out if isinstance(it, (dict, str))), None)
        if not objname:
            return []
        raw, _srv = xc_cloud.cloud_download(objname)
        lst = json.loads(raw.decode("utf-8", "replace"))
        for ent in lst if isinstance(lst, list) else []:
            if isinstance(ent, dict) and ent.get("mapId") == map_id:
                areas = ent.get("areas")
                if isinstance(areas, str):
                    try:
                        areas = json.loads(areas)
                    except Exception:
                        return []
                return areas if isinstance(areas, list) else []
    except Exception:
        pass
    return []


@app.route("/api/map/live")
def map_live():
    """현재 로봇 위치/방향 + 청소 경로(px). 청소 중 5초 폴링용."""
    try:
        m = _load_map()                       # meta 확보(캐시)
        meta = m["meta"]
        dev = get_device()
        r = dev._action(17, 12)
        out = (r.get("out") if isinstance(r, dict) else r) or []
        obj = next((it.get("value") if isinstance(it, dict) else it
                    for it in out if isinstance(it, (dict, str))), None)
        if not obj:
            return jsonify({"ok": False, "error": "지도 파일명 없음"}), 502
        raw, _srv = xc_cloud.cloud_download(obj)
        live = map_render.decode_live(raw)
        if live is None:
            return jsonify({"ok": False, "error": "지도 파싱 실패"}), 502
        pos = map_render.pos_to_px(live.get("pos"), meta)
        if pos is None or (abs(pos["x"]) < 1 and abs(pos["y"]) < 1):
            # 도킹 중에는 (0,0)을 올리기도 한다 → 도크 위치로 대체
            dock = map_render.pos_to_px(live.get("charge") or {}, meta)
            if dock:
                pos = {"x": dock["x"], "y": dock["y"], "a": 0, "docked": True}
        trace = map_render.trace_to_px(live.get("trace"), meta)
        return jsonify({"ok": True, "pos": pos, "trace": trace})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 502


@app.route("/api/map/data")
def map_data():
    try:
        m = _load_map(refresh=request.args.get("refresh") == "1")
        meta, data = m["meta"], m["data"]
        areas = _map_areas(meta["map_id"])
        return jsonify({"ok": True, "meta": meta,
                        "charge": map_render.pos_to_px(data.get("charge"), meta),
                        "walls_px": map_render.walls_for_frontend(data, meta),
                        "rooms": map_render.room_geometries(data, meta, areas),
                        "thres": data["walls"].get("thres", [])})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 502




@app.route("/api/clean/room", methods=["POST"])
def clean_room():
    try:
        body = request.get_json(silent=True) or {}
        ids = [int(x) for x in (body.get("room_ids") or [])]
        if not ids:
            return jsonify({"ok": False, "error": "방을 선택하세요"}), 400
        if _chan_get("actions", "room", "cloud") == "cloud":
            return jsonify({"ok": True, "room_ids": ids,
                            **_cloud_start("room", {"room_ids": ids})})
        try:
            get_device().room_clean(ids)
            return jsonify({"ok": True, "room_ids": ids, "transport": "local"})
        except Exception as e:
            _chan_set("actions", "room", "cloud")
            return jsonify({"ok": True, "room_ids": ids,
                            "fallback": str(e)[:120],
                            **_cloud_start("room", {"room_ids": ids})})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 502


@app.route("/api/clean/zone", methods=["POST"])
def clean_zone():
    try:
        body = request.get_json(silent=True) or {}
        rects = body.get("rects")
        if not rects and body.get("rect"):
            rects = [body["rect"]]
        if not rects:
            return jsonify({"ok": False, "error": "구역을 지정하세요"}), 400
        if len(rects) > 10:
            return jsonify({"ok": False, "error": "구역은 최대 10개"}), 400
        ring = []
        for r in rects:
            x1, y1, x2, y2 = [int(v) for v in r]
            xa, xb = sorted((x1, x2))
            ya, yb = sorted((y1, y2))
            ring += [xa, ya, xb, ya, xb, yb, xa, yb]
        if _chan_get("actions", "zone", "cloud") == "cloud":
            return jsonify({"ok": True, "count": len(rects), "values": ring,
                            **_cloud_start("zone", {"rects": rects})})
        try:
            get_device().zone_clean(ring)
            return jsonify({"ok": True, "count": len(rects),
                            "values": ring, "transport": "local"})
        except Exception as e:
            _chan_set("actions", "zone", "cloud")
            return jsonify({"ok": True, "count": len(rects), "values": ring,
                            "fallback": str(e)[:120],
                            **_cloud_start("zone", {"rects": rects})})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 502


@app.route("/api/consumables", methods=["GET"])
def consumables_get():
    try:
        dev = get_device()
        raw = dev._get_props([(17, 32)]).get((17, 32))
        items = json.loads(raw) if isinstance(raw, str) else (raw or [])
        return jsonify({"ok": True, "items": items})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 502


@app.route("/api/consumables/reset", methods=["POST"])
def consumables_reset():
    try:
        body = request.get_json(silent=True) or {}
        ctype = str(body.get("type", ""))
        if not ctype:
            return jsonify({"ok": False, "error": "type 필요"}), 400
        r = _cloud_action(17, 20, [ctype])
        return jsonify({"ok": True, **r})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 502


@app.route("/api/maps/list")
def maps_list():
    try:
        return jsonify({"ok": True, "maps": _maps_infos()})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 502


@app.route("/api/maps/switch", methods=["POST"])
def maps_switch():
    try:
        body = request.get_json(silent=True) or {}
        mid = int(body["mapId"])
        dev = get_device()
        try:
            last = None
            for _ in range(2):
                try:
                    dev._action(17, 9, [mid])
                    break
                except Exception as e:
                    last = e
                    time.sleep(2)
            else:
                raise last
        except Exception:
            cfg = load_config()
            did = (cfg.get("did") or "").strip()
            if not did:
                raise RuntimeError("로컬 전환 실패 + did 없음. config.json did 확인.")
            xc_cloud.action_on_device_server(did, 17, 9, [mid],
                                             prefer=_preferred_server())
        time.sleep(3)
        _invalidate_map_cache()
        m = _load_map(refresh=True)
        return jsonify({"ok": True, "map_id": m["meta"]["map_id"]})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 502


WALL_KINDS = {
    # kind: (aiid, mode, shape)
    "thres": (54, 2, "line"),      # 문턱 (17.54 carpetlist)
    "carpet": (54, 1, "rect"),     # 카펫 (17.54 carpetlist)
    "virtual": (5, 1, "line"),     # 가상벽/진입금지 (17.5 virtuaList)
    "mop": (5, 2, "rect"),         # 물걸레 금지 (17.5 virtuaList)
}


def _shape_points(kind, pts, wtype=2):
    """pts: [x1,y1,x2,y2]. 선형(가상벽·문턱)은 2점, 구역형은 4점 링."""
    x1, y1, x2, y2 = [int(v) for v in pts]
    shape = WALL_KINDS[kind][2]
    if shape == "line":
        return f"{x1},{y1},{x2},{y2}"
    xa, xb = sorted((x1, x2))
    ya, yb = sorted((y1, y2))
    return f"{xa},{ya},{xb},{ya},{xb},{yb},{xa},{yb}"


@app.route("/api/carpet/prefer", methods=["POST"])
def carpet_prefer_save():
    """카펫 한 영역의 개별 전략 (17.57 carpet-preference)."""
    try:
        body = request.get_json(silent=True) or {}
        cid = int(body.get("id"))
        custom = bool(body.get("custom"))
        prefer = int(body.get("prefer") or 0)
        boost = bool(body.get("boost"))
        twice = bool(body.get("twice"))
        first = bool(body.get("first"))
        if prefer not in (0, 1, 2, 3):
            return jsonify({"ok": False, "error": "prefer 값이 올바르지 않습니다"}), 400
        # 부스트/2회/먼저는 적응 모드에서만 유효
        if prefer != 0:
            boost = twice = first = False
        m = _load_map()
        ids = {int(e["id"]) for e in m["data"]["walls"].get("carpet", [])
               if isinstance(e.get("id"), int)}
        if cid not in ids:
            return jsonify({"ok": False, "error": f"카펫 #{cid}를 찾을 수 없습니다"}), 404
        mid = m["meta"]["map_id"]
        payload = {"id": cid, "mapid": mid, "action": 0 if custom else 1,
                   "prefer": prefer, "boost": int(boost),
                   "twice": int(twice), "first": int(first)}
        result = _cloud_action(17, 57, [payload])
        # 다음 지도 로드에 반영되도록 메모리 캐시도 갱신
        prefs = m["data"].setdefault("carpet_prefer", [])
        prefs[:] = [p for p in prefs if int(p.get("id", -1)) != cid]
        if custom:
            prefs.append({"id": cid, "prefer": prefer,
                          "boost": int(boost), "twice": int(twice),
                          "first": int(first)})
        return jsonify({"ok": True, "id": cid, "custom": custom,
                        "prefer": prefer, "boost": boost,
                        "twice": twice, "first": first, **result})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 502


@app.route("/api/carpet/prefer/batch", methods=["POST"])
def carpet_prefer_batch():
    """저장 버튼에서 모아둔 카펫별 전략을 한 번에 적용."""
    try:
        body = request.get_json(silent=True) or {}
        items = body.get("items") or []
        if not isinstance(items, list) or not items:
            return jsonify({"ok": False, "error": "items 필요"}), 400
        m = _load_map()
        mid = m["meta"]["map_id"]
        ids = {int(e["id"]) for e in m["data"]["walls"].get("carpet", [])
               if isinstance(e.get("id"), int)}
        prefs = m["data"].setdefault("carpet_prefer", [])
        applied = 0
        errors = []
        for it in items:
            cid = None
            try:
                cid = int(it.get("id"))
                custom = bool(it.get("custom"))
                prefer = int(it.get("prefer") or 0)
                boost = bool(it.get("boost"))
                twice = bool(it.get("twice"))
                first = bool(it.get("first"))
                if prefer not in (0, 1, 2, 3):
                    raise ValueError("prefer 값 오류")
                if prefer != 0:
                    boost = twice = first = False
                if cid not in ids:
                    raise ValueError(f"카펫 #{cid} 없음")
                payload = {"id": cid, "mapid": mid,
                           "action": 0 if custom else 1,
                           "prefer": prefer, "boost": int(boost),
                           "twice": int(twice), "first": int(first)}
                _cloud_action(17, 57, [payload])
                prefs[:] = [p for p in prefs if int(p.get("id", -1)) != cid]
                if custom:
                    prefs.append({"id": cid, "prefer": prefer,
                                  "boost": int(boost), "twice": int(twice),
                                  "first": int(first)})
                applied += 1
            except Exception as e:
                errors.append(f"#{cid if cid is not None else '?'}: {e}")
        return jsonify({"ok": not errors, "applied": applied, "errors": errors})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e), "applied": 0, "errors": [str(e)]}), 502


@app.route("/api/walls/save", methods=["POST"])
def walls_save():
    """벽/구역/문턱/카펫 일괄 저장. kind별로 액션·mode가 다르다."""
    try:
        body = request.get_json(silent=True) or {}
        kind = str(body.get("kind", ""))
        if kind not in WALL_KINDS:
            return jsonify({"ok": False, "error": f"unknown kind: {kind}"}), 400
        adds = body.get("adds") or []
        updates = body.get("updates") or []
        deletes = body.get("deletes") or []
        if not (adds or updates or deletes):
            return jsonify({"ok": False, "error": "변경 사항 없음"}), 400
        m = _load_map()
        mid = m["meta"]["map_id"]
        cfg = load_config()
        did = (cfg.get("did") or "").strip()
        action, mode, _shape = WALL_KINDS[kind]
        if action == 54:
            mode = 1 if kind == "carpet" else 2
        else:
            mode = 1 if kind == "virtual" else 2
        cur = {e["id"]: e for e in m["data"]["walls"].get(kind, [])}
        used = [e["id"] for lst in m["data"]["walls"].values() for e in lst
                if isinstance(e.get("id"), int)]
        nid = max(used, default=-1) + 1
        items = []
        for a in adds:
            items.append({"type": int(a.get("type", 1)), "mapId": mid, "mode": mode,
                          "action": "add", "isActive": True, "aid": nid,
                          "point": _shape_points(kind, a["pts"], a.get("type", 1))})
            nid += 1
        for u in updates:
            tid = int(u["id"])
            ref = cur.get(tid, {})
            items.append({"id": tid, "type": int(u.get("type", ref.get("type", 1))),
                          "mapId": mid, "mode": mode, "action": "mod",
                          "isActive": True,
                          "point": _shape_points(kind, u["pts"], u.get("type", 1))})
        for d in deletes:
            tid = int(d if not isinstance(d, dict) else d["id"])
            ref = cur.get(tid, {})
            pts_src = ref.get("points") or [[0, 0], [0, 0]]
            x1, y1 = pts_src[0]
            x2, y2 = pts_src[-1]
            items.append({"id": tid, "type": ref.get("type", 1), "mapId": mid,
                          "mode": mode, "action": "del", "isActive": True,
                          "point": _shape_points(kind, [x1, y1, x2, y2],
                                                 ref.get("type", 2))})
        # 청크(5개) 전송
        if not items:
            return jsonify({"ok": True, "kind": kind, "noop": True,
                            "walls": m["data"]["walls"].get(kind, [])})
        key = "carpetlist" if action == 54 else "virtuaList"
        total = (len(items) + 4) // 5
        last = None
        for i in range(0, len(items), 5):
            chunk = items[i:i + 5]
            payload = json.dumps({"index": i // 5, "total": total, key: chunk},
                                 separators=(",", ":"))
            last, _srv = xc_cloud.action_on_device_server(
                did, 17, action, [payload], prefer=_preferred_server())
            res = (last.get("result") or {}) if isinstance(last, dict) else {}
            if isinstance(res, dict) and res.get("code") not in (None, 0):
                raise RuntimeError(f"기기 거부: {res}")
            if total > 1:
                time.sleep(0.6)
        time.sleep(6)
        m2 = _load_map(refresh=True)
        return jsonify({"ok": True, "kind": kind,
                        "walls": m2["data"]["walls"].get(kind, []),
                        "detail": {"sent": len(items),
                                   "code": last.get("code") if isinstance(last, dict) else None}})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 502


@app.route("/api/threshold/save", methods=["POST"])
def threshold_save():
    """문턱 일괄 저장: 추가/수정(mod)/삭제(del)를 한 번에."""
    try:
        body = request.get_json(silent=True) or {}
        adds = body.get("adds") or []
        updates = body.get("updates") or []
        deletes = body.get("deletes") or []
        if not (adds or updates or deletes):
            return jsonify({"ok": False, "error": "변경 사항 없음"}), 400
        m = _load_map()
        mid = m["meta"]["map_id"]
        cur = {e["id"]: e for e in m["data"]["walls"].get("thres", [])}
        ids = [e["id"] for lst in m["data"]["walls"].values() for e in lst
               if isinstance(e.get("id"), int)]
        nid = max(ids, default=-1) + 1
        items = []
        for a in adds:
            x1, y1, x2, y2 = [int(v) for v in (a.get("pts") or [a["x1"], a["y1"], a["x2"], a["y2"]])]
            items.append({"type": int(a.get("type", 2)), "mapId": mid, "mode": 2,
                          "action": "add", "isActive": True, "aid": nid,
                          "point": f"{x1},{y1},{x2},{y2}"})
            nid += 1
        for u in updates:
            tid = int(u["id"])
            ref = cur.get(tid, {})
            x1, y1, x2, y2 = [int(v) for v in u["pts"]]
            items.append({"id": tid, "type": int(u.get("type", ref.get("type", 2))),
                          "mapId": mid, "mode": 2, "action": "mod",
                          "isActive": True, "point": f"{x1},{y1},{x2},{y2}"})
        for d in deletes:
            tid = int(d if not isinstance(d, dict) else d["id"])
            ref = cur.get(tid, {})
            pts = ref.get("points") or [[0, 0], [0, 0]]
            x1, y1 = pts[0]
            x2, y2 = pts[-1]
            items.append({"id": tid, "type": ref.get("type", 2), "mapId": mid,
                          "mode": 2, "action": "del", "isActive": True,
                          "point": f"{int(x1)},{int(y1)},{int(x2)},{int(y2)}"})
        resp = _send_carpet_marking(items, mid)
        time.sleep(6)
        m2 = _load_map(refresh=True)
        thres = m2["walls"].get("thres", [])
        return jsonify({"ok": True, "thres": thres,
                        "detail": {"sent": len(items),
                                   "cloud_code": resp.get("code") if isinstance(resp, dict) else None}})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 502


@app.route("/api/threshold/list")
def threshold_list():
    try:
        m = _load_map()
        th = []
        for e in m["walls"].get("thres", []):
            pts = map_render.clean_points(e["points"])
            th.append({"id": e["id"], "type": e["type"],
                       "points": [[int(x), int(y)] for x, y in pts]})
        return jsonify({"ok": True, "thres": th})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 502








def _wall_chunks(items):
    """앱과 동일: 5개 단위 청크 + index/total 래퍼."""
    out = []
    total = (len(items) + 4) // 5
    for i in range(0, len(items), 5):
        out.append((i // 5, total, items[i:i + 5]))
    return out




def _send_carpet_marking(items, map_id, wait=7):
    """문턱 저장: carpet-marking(17.54) / {index,total,carpetlist:[...]} (앱과 동일)."""
    cfg = load_config()
    did = (cfg.get("did") or "").strip()
    if not did:
        for v in [_current_map_obj()]:
            parts = v.split("/")
            if len(parts) >= 2:
                did = parts[1]
    last = None
    for idx, total, chunk in _wall_chunks(items):
        payload = json.dumps({"index": idx, "total": total,
                              "carpetlist": chunk}, separators=(",", ":"))
        resp, _srv = xc_cloud.action_on_device_server(
            did, 17, 54, [payload], prefer=_preferred_server())
        last = resp
        res = (resp.get("result") or {}) if isinstance(resp, dict) else {}
        if isinstance(res, dict) and res.get("code") not in (None, 0):
            raise RuntimeError(f"기기 거부: {res}")
        if total > 1:
            time.sleep(0.6)
    time.sleep(wait)
    return last


def _verify_thres(expect_point, expect_present=True, rounds=4):
    """재다운로드로 문턱 반영 확인. expect_point=(x1,y1,x2,y2)."""
    detail = []
    m2 = None
    for attempt in range(rounds):
        if attempt:
            time.sleep(12)
        try:
            _load_map(refresh=True)
            m2 = _load_map()
        except Exception as e:
            detail.append(f"{attempt + 1}차 재다운로드 실패 {str(e)[:60]}")
            continue
        pts = [(tuple(e["points"][0]), tuple(e["points"][1]))
               for e in m2["walls"].get("thres", [])]
        want = (tuple(expect_point[:2]), tuple(expect_point[2:]))
        hit = (want in pts) if expect_present else (want not in pts)
        detail.append(f"{attempt + 1}차 thres={len(pts)}개 "
                      f"{'확인' if hit else '미반영'}")
        if hit:
            break
    thres = (m2["walls"].get("thres", []) if m2 else [])
    return hit, thres, detail







@app.route("/api/threshold/add", methods=["POST"])
def threshold_add():
    try:
        body = request.get_json(silent=True) or {}
        pts = [int(body["x1"]), int(body["y1"]), int(body["x2"]), int(body["y2"])]
        ttype = int(body.get("type", 2))
        if ttype not in (1, 2):
            return jsonify({"ok": False, "error": "type은 1(미닫이 문턱) 또는 2(문지방)입니다"}), 400
        m = _load_map()
        mid = m["meta"]["map_id"]
        cur_entries = {k: list(v) for k, v in m["data"]["walls"].items()}
        all_ids = [e["id"] for lst in cur_entries.values() for e in lst
                   if isinstance(e.get("id"), int)]
        aid = max(all_ids, default=-1) + 1
        wall = {"type": ttype, "mapId": mid, "mode": 2,
                "action": "add", "isActive": True, "aid": aid,
                "point": f"{pts[0]},{pts[1]},{pts[2]},{pts[3]}"}
        resp = _send_carpet_marking([wall], mid)
        ok, thres2, tries = _verify_thres(pts, expect_present=True)
        return jsonify({"ok": ok, "id": aid, "thres": thres2,
                        "detail": {"tries": tries,
                                   "cloud_code": resp.get("code") if isinstance(resp, dict) else None},
                        "msg": "저장+검증됨" if ok else "미반영"})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 502


@app.route("/api/threshold/delete", methods=["POST"])
def threshold_delete():
    try:
        body = request.get_json(silent=True) or {}
        did_del = int(body["id"])
        m = _load_map()
        mid = m["meta"]["map_id"]
        target = next((e for e in m["data"]["walls"].get("thres", [])
                       if e["id"] == did_del), None)
        if target is None:
            return jsonify({"ok": False, "error": f"문턱 #{did_del} 없음"}), 404
        x1, y1 = target["points"][0]
        x2, y2 = target["points"][1]
        wall = {"id": did_del, "type": target["type"], "mapId": mid,
                "mode": 2, "action": "del", "isActive": True,
                "point": f"{int(x1)},{int(y1)},{int(x2)},{int(y2)}"}
        resp = _send_carpet_marking([wall], mid)
        ok, thres2, tries = _verify_thres([x1, y1, x2, y2],
                                          expect_present=False)
        return jsonify({"ok": ok, "thres": thres2,
                        "detail": {"tries": tries,
                                   "cloud_code": resp.get("code") if isinstance(resp, dict) else None}})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 502


@app.route("/api/threshold/format")
def threshold_format():
    return jsonify({
        "ok": True,
        "summary": "문턱: carpet-marking(17.54) / {index,total,carpetlist:[{type,mapId,mode:2,action,isActive,aid|id,point:'x1,y1,x2,y2'}]}. "
                   "가상벽·물금지: set-virtual-walls(17.5)에 같은 래퍼(키 virtuaList).",
        "types": {"push_pull_doorsill_미닫이_문턱": 1, "gate_stone_문지방": 2},
        "mode": 2,
    })


if __name__ == "__main__":
    if "--setup" in sys.argv:
        setup = cloud_session.setup_interactive()
        if not setup:
            raise SystemExit(1)
        cfg = load_config()
        cfg.update(setup)
        save_config(cfg)
        print("[설정] config.json에 IP/토큰/DID/서버를 저장했습니다. 이제 `python app.py`만 실행하면 됩니다.")
        raise SystemExit(0)
    if "--login" in sys.argv:
        raise SystemExit(0 if cloud_session.login_interactive() else 1)
    os.makedirs(STATIC_DIR, exist_ok=True)
    if not cloud_session.session_exists():
        print("[안내] Mi 클라우드 세션이 없습니다. 지도 기능을 사용하려면 "
              "`python app.py --setup`을 먼저 실행하세요. (로컬 제어는 가능)")
    print("JONR P20 Pro dashboard → http://127.0.0.1:5000")
    app.run(host="127.0.0.1", port=5000, debug=False, threaded=True)
