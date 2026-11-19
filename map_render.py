"""KS3 지도 파일 디코딩 + PNG 렌더 + 좌표 변환.

- 래스터: fields[0] base64->JSON {map, lz4Len, width, height, xMin, yMax, chargePos}
  (LZ4 raw block 디코더는 moriceh/jonr-vac MIT 코드 포팅)
- 벽: fields[4..7] base64 "id,type[,pref],x1,y1,..." (map_codec 디코더 사용)
- 장면 좌표계: wall/pos 좌표 그대로(scene). 픽셀 변환은 _CANVAS=800 기준
  (공식 플러그인 동일): screenX=worldY, screenY=800-worldX.

PNG에는 바닥/벽/방/기존 가상벽·문턱·도크를 굽고, 문턱 편집 캔버스용
메타(scale, x_min, y_max 등)를 함께 반환한다.
"""
from __future__ import annotations

import base64
import io
import json
import os
import struct
import sys

BASE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, BASE)
from map_codec import b64_text, decode_wall_field  # noqa: E402

_CANVAS = 800.0
_TARGET_PX = 800

C_UNKNOWN = (0, 0, 0, 0)
C_WALL = (109, 125, 125)
C_FLOOR = (214, 228, 228)
C_ROOMS = [(191, 232, 228), (241, 229, 182), (197, 218, 246), (244, 205, 189)]
C_VWALL = (227, 55, 37)
C_MOP = (255, 171, 71)
C_CARPET = (44, 213, 174)
C_THRES = (255, 140, 0)


# ---- LZ4 raw block decoder (moriceh/jonr-vac, MIT, 플러그인 JS 포팅) ----
def _read_len_run(src, i, total):
    while True:
        if i >= len(src):
            raise ValueError("lz4: truncated length extension")
        b = src[i]
        i += 1
        total += b
        if b != 255:
            return total, i


def lz4_block_decompress(src: bytes, expected: int) -> bytes:
    out = bytearray()
    i, n = 0, len(src)
    while i < n:
        token = src[i]
        i += 1
        lit = token >> 4
        if lit == 15:
            lit, i = _read_len_run(src, i, lit)
        if i + lit > n:
            raise ValueError("lz4: truncated literal run")
        out += src[i:i + lit]
        i += lit
        if i == n:
            break
        if i + 2 > n:
            raise ValueError("lz4: truncated match offset")
        offset = src[i] | (src[i + 1] << 8)
        i += 2
        if offset == 0 or offset > len(out):
            raise ValueError("lz4: out-of-range back offset")
        ml = token & 0x0F
        if ml == 15:
            ml, i = _read_len_run(src, i, ml)
        pos = len(out) - offset
        end = len(out) + ml + 4
        while len(out) < end:
            out.append(out[pos])
            pos += 1
    if len(out) < expected:
        raise ValueError(f"lz4: decoded {len(out)} < expected {expected}")
    return bytes(out[:expected])


def _b64_bytes(v: str) -> bytes:
    return base64.b64decode(v + "=" * (-len(v) % 4))


def decode_map_file(raw: bytes):
    """KS3 지도 JSON -> 렌더용 dict. 실패 시 None."""
    try:
        obj = json.loads(raw.decode("utf-8", "replace"))
    except Exception:
        return None
    if not isinstance(obj, dict):
        return None
    fields = obj.get("fields") or []

    def field_json(i):
        if i >= len(fields):
            return None
        t = b64_text(fields[i]) if isinstance(fields[i], str) else None
        if not t:
            return None
        try:
            return json.loads(t)
        except Exception:
            return None

    meta = field_json(0)
    if not isinstance(meta, dict):
        return None
    try:
        w, h = int(meta["width"]), int(meta["height"])
        x_min = int(meta.get("xMin") or 0)
        y_max = int(meta.get("yMax") or 0)
        lz4_len = int(meta.get("lz4Len") or 0)
        blob = meta.get("map")
    except (KeyError, TypeError, ValueError):
        return None
    if not blob or lz4_len <= 1 or w * h != lz4_len:
        return None
    try:
        raster = lz4_block_decompress(_b64_bytes(blob), lz4_len)
    except Exception:
        return None
    cp = meta.get("chargePos")
    if isinstance(cp, str):
        try:
            cp = json.loads(cp)
        except Exception:
            cp = {}
    if not isinstance(cp, dict):
        cp = {}

    walls = {}
    for idx, key in [(4, "virtualWalls"), (5, "mopWalls"), (6, "carpet"), (7, "thres")]:
        lead = 3 if idx == 6 else 2
        f = fields[idx] if len(fields) > idx else None
        walls[key] = decode_wall_field(f, lead)

    # f8: 카펫별 개별 전략 [{id, prefer, boost, twice, first}, ...]
    carpet_prefer = fields[8] if len(fields) > 8 and isinstance(fields[8], list) else []

    # f2: 로봇 위치/방향 (평문 JSON {"x","y","a"}), f1: 청소 경로 (base64+lz4)
    pos = None
    if len(fields) > 2 and isinstance(fields[2], str) and fields[2].strip():
        try:
            p = json.loads(fields[2])
            if isinstance(p, dict) and p.get("x") is not None:
                pos = {"x": float(p["x"]), "y": float(p["y"]),
                       "a": float(p.get("a") or 0)}
        except Exception:
            pos = None
    trace = decode_trace(fields[1] if len(fields) > 1 else None)

    return {"map_id": obj.get("mapId"), "raster": raster, "width": w,
            "height": h, "x_min": x_min, "y_max": y_max,
            "resolution": int(meta.get("resolution") or 5),
            "walls": walls, "carpet_prefer": carpet_prefer,
            "charge": cp, "pos": pos, "trace": trace}


def decode_trace(field):
    """f1 {trace: b64(lz4), lz4Len} → [{'m': workMode, 'p': [[x,y],...]}, ...]."""
    obj = None
    try:
        t = b64_text(field) if isinstance(field, str) else None
        obj = json.loads(t) if t else None
    except Exception:
        return []
    if not isinstance(obj, dict) or not obj.get("trace"):
        return []
    try:
        blob = lz4_block_decompress(_b64_bytes(obj["trace"]),
                                    int(obj.get("lz4Len") or 0))
    except Exception:
        return []
    out, cur, cur_mode = [], [], 0
    for i in range(0, len(blob) - len(blob) % 7, 7):
        x, y, _theta, attr = struct.unpack_from("<hhHB", blob, i)
        mode = attr & 0x07
        if attr & 0x80:                      # break
            if len(cur) > 1:
                out.append({"m": cur_mode, "p": cur})
            cur = []
            continue
        cur_mode = mode
        cur.append([x, y])
    if len(cur) > 1:
        out.append({"m": cur_mode, "p": cur})
    return out


def render_scale(w, h):
    return max(2, min(8, round(_TARGET_PX / max(w, h, 1))))


def screen_to_pixel(sx, sy, d):
    k = d["scale"]
    ox = d.get("ox", 0)
    oy = d.get("oy", 0)
    col = sx - d["y_max"]
    row_top = (d["height"] - 1) - ((_CANVAS - sy) - d["x_min"])
    return col * k + k / 2.0 + ox, row_top * k + k / 2.0 + oy


def pixel_to_scene(px, py, d):
    k = d["scale"]
    ox = d.get("ox", 0)
    oy = d.get("oy", 0)
    col = (px - ox - k / 2.0) / k
    row_top = (py - oy - k / 2.0) / k
    sx = col + d["y_max"]
    sy = _CANVAS - d["x_min"] - (d["height"] - 1) + row_top
    return sx, sy


def pos_to_px(pos, meta):
    """scene 좌표 → 캔버스 px. (screen_to_pixel 역변환 아님: 정방향)"""
    if not pos:
        return None
    k = meta["scale"]
    ox = meta.get("ox", 0)
    oy = meta.get("oy", 0)
    col = pos["x"] - meta["y_max"]
    row = (meta["height"] - 1) - ((800 - pos["y"]) - meta["x_min"])
    return {"x": col * k + k / 2.0 + ox, "y": row * k + k / 2.0 + oy,
            "a": pos.get("a", 0)}


def trace_to_px(trace, meta):
    out = []
    k = meta["scale"]
    ox = meta.get("ox", 0)
    oy = meta.get("oy", 0)
    for seg in trace or []:
        pts = []
        for x, y in seg.get("p", []):
            col = x - meta["y_max"]
            row = (meta["height"] - 1) - ((800 - y) - meta["x_min"])
            pts.append([col * k + k / 2.0 + ox, row * k + k / 2.0 + oy])
        if len(pts) > 1:
            out.append({"m": seg.get("m", 0), "p": pts})
    return out


def room_geometries(data, meta, areas):
    """래스터에서 방별 bbox 를 뽑아 클릭 가능한 방 목록 생성."""
    from collections import defaultdict
    w, h = data["width"], data["height"]
    rast = data["raster"]
    cells = defaultdict(list)
    for r in range(h):
        for c in range(w):
            v = rast[(h - 1 - r) * w + c]
            if v >= 3:
                cells[v].append((c, r))
    by_rid = {}
    for a in areas or []:
        if isinstance(a, dict) and a.get("room_id") is not None:
            try:
                by_rid[int(a["room_id"])] = a
            except (TypeError, ValueError):
                continue
    k = meta["scale"]
    ox = meta.get("ox", 0)
    oy = meta.get("oy", 0)
    out = []
    for v, cs in cells.items():
        rid = v if v in by_rid else (v - 2 if (v - 2) in by_rid else None)
        a = by_rid.get(rid, {})
        xs = [c for c, _r in cs]
        ys = [r for _c, r in cs]
        # 행 단위 수평 스팬(정확한 클릭 판정·칠하기용, px 좌표)
        rows = {}
        for c, r in cs:
            rows.setdefault(r, []).append(c)
        spans = []
        for r, cols in rows.items():
            cols.sort()
            start = prev = cols[0]
            for c in cols[1:]:
                if c == prev + 1:
                    prev = c
                    continue
                spans.append([r * k + oy, start * k + ox, (prev + 1) * k + ox])
                start = prev = c
            spans.append([r * k + oy, start * k + ox, (prev + 1) * k + ox])
        default_name = f"방{a.get('id')}" if a.get("id") is not None else f"방{rid}"
        out.append({
            "raster_id": v,
            "room_id": rid,
            "name": (a.get("name") or default_name),
            "bbox": [min(xs) * k + ox, min(ys) * k + oy,
                     (max(xs) + 1) * k + ox, (max(ys) + 1) * k + oy],
            "spans": spans,
        })
    out.sort(key=lambda x: (x["room_id"] is None, x["room_id"] or 0))
    return out


def clean_points(pts):
    """문턱은 4슬롯 고정이라 뒤에 [0,0] 패딩이 붙는다 → 실제 점만 반환."""
    out = [(x, y) for x, y in pts if not (x == 0 and y == 0)]
    return out or list(pts)


def render_png(data, scale=None):
    from PIL import Image
    w, h = data["width"], data["height"]
    k = scale or render_scale(w, h)
    # 외곽 여백: 지도 밖에 걸친 구역도 편집할 수 있게
    pad = max(40, int(max(w, h) * k * 0.25))
    ox, oy = pad, pad
    d = dict(data, scale=k, ox=ox, oy=oy)
    img = Image.new("RGBA", (w * k + pad * 2, h * k + pad * 2), C_UNKNOWN)
    px = img.load()
    rast = data["raster"]
    for r in range(h):
        for c in range(w):
            v = rast[(h - 1 - r) * w + c]
            if v == 1:
                col = C_WALL
            elif v == 2:
                col = C_FLOOR
            elif v >= 3:
                col = C_ROOMS[(v - 3) % len(C_ROOMS)]
            else:
                continue
            for dy in range(k):
                for dx in range(k):
                    px[c * k + dx + ox, r * k + dy + oy] = col
    return img, {"scale": k, "width": w, "height": h,
                 "x_min": d["x_min"], "y_max": d["y_max"],
                 "resolution": d.get("resolution", 5),
                 "ox": ox, "oy": oy, "pad": pad,
                 "map_id": d["map_id"],
                 "img_w": w * k + pad * 2, "img_h": h * k + pad * 2}


def walls_for_frontend(data, meta):
    out = {}
    prefs = {}
    for p in data.get("carpet_prefer") or []:
        try:
            prefs[int(p.get("id"))] = {
                "prefer": int(p.get("prefer") or 0),
                "boost": int(p.get("boost") or 0),
                "twice": int(p.get("twice") or 0),
                "first": int(p.get("first") or 0),
            }
        except Exception:
            continue
    for key in ("virtualWalls", "mopWalls", "carpet", "thres"):
        lst = []
        for e in data["walls"].get(key, []):
            raw_pts = e["points"]
            if key == "thres":
                raw_pts = clean_points(raw_pts)
                if len(raw_pts) >= 4:      # 띠(4점)면 양 변의 중점으로 선 환산
                    p0, p1, p2, p3 = raw_pts[:4]
                    raw_pts = [((p0[0] + p3[0]) / 2, (p0[1] + p3[1]) / 2),
                               ((p1[0] + p2[0]) / 2, (p1[1] + p2[1]) / 2)]
            pts = [screen_to_pixel(x, y, meta) for x, y in raw_pts]
            if key == "thres":
                pts = pts[:2]
            item = {"id": e["id"], "type": e["type"], "pts": pts}
            if key == "carpet" and int(e["id"]) in prefs:
                item["prefer"] = prefs[int(e["id"])]
            lst.append(item)
        out[key] = lst
    return out


if __name__ == "__main__":
    # 자가진단: 합성 지도로 렌더 파이프라인 검증 (실지도 불필요)
    import random
    raw = bytearray()
    W, H = 60, 40
    for r in range(H):
        for c in range(W):
            if c == 0 or r == 0 or c == W - 1 or r == H - 1:
                raw.append(1)
            elif (c // 10 + r // 10) % 2 == 0:
                raw.append(3 + (c // 20))
            else:
                raw.append(2)
    try:
        import lz4.block as _lz4
        comp = _lz4.compress(bytes(raw), store_size=False)
    except ImportError:
        comp = None
        print("selftest 제한: lz4 패키지 없음 → 파일 파싱 단계 생략, 렌더만 검증")
    if comp is not None:
        import base64 as _b
        f0 = _b.b64encode(json.dumps(
            {"width": W, "height": H, "xMin": 100, "yMax": 200,
             "lz4Len": len(raw), "resolution": 5,
             "map": _b.b64encode(comp).decode(),
             "chargePos": {"x": 350.0, "y": 230.0}}).encode()).decode()
        import map_codec as _codec
        th = _codec.encode_wall_field(
            [{"id": 0, "type": 2, "points": [[210, 300], [250, 300]]}])
        vw = _codec.encode_wall_field(
            [{"id": 0, "type": 1, "points": [[210, 280], [210, 320]]}])
        f = ["", "", "", "", vw, "", "", th, "", ""]
        f[0] = f0
        fake = json.dumps({"mapId": 99, "fields": f}).encode()
        d = decode_map_file(fake)
        assert d and d["width"] == W and len(d["walls"]["thres"]) == 1, "파싱 실패"
        print("파싱 OK")
    else:
        d = {"map_id": 99, "raster": bytes(raw), "width": W, "height": H,
             "x_min": 100, "y_max": 200,
             "walls": {"virtualWalls": [{"id": 0, "type": 1,
                                        "points": [[210, 280], [210, 320]]}],
                       "mopWalls": [], "carpet": [],
                       "thres": [{"id": 0, "type": 2,
                                  "points": [[210, 300], [250, 300]]}]},
             "charge": {"x": 350.0, "y": 230.0}}
    img, meta = render_png(d)
    img.save(os.path.join(BASE, "selftest_map.png"))
    # 좌표 왕복 검증
    sx, sy = 230.0, 300.0
    px, py = screen_to_pixel(sx, sy, meta)
    sx2, sy2 = pixel_to_scene(px, py, meta)
    assert abs(sx - sx2) < 1e-6 and abs(sy - sy2) < 1e-6, (sx2, sy2)
    print(f"렌더 OK: {meta['img_w']}x{meta['img_h']} scale={meta['scale']} selftest_map.png")
