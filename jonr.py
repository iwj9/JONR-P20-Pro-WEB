"""JONR P20 Pro (xtl.vacuum.xm2216) MIoT wrapper.

Raw miIO send() based — no model mapping needed.
Verified against miot-spec v4 + hass plugin probes (2026-09).

Actions (siid.aiid):
  2.1 start-sweep / 2.2 stop-sweeping (app does NOT use these for stop)
  2.7 pause-sweeping
  16.1 start-charge (return to dock)
  17.1 start-clean [clean-type, clean-values-json]
  17.2 pause-continue-work [robot-set-status 7=pause 8=resume]
  17.3 stop-clean (REAL stop, clears task)
  17.4 seek-robot (locate)
  17.5 set-virtual-walls [virtual-walls-action piid56] (Phase 2: thres)
"""
from __future__ import annotations

import warnings
warnings.filterwarnings("ignore")

from miio import Device
from miio.exceptions import DeviceException

MODEL = "xtl.vacuum.xm2216"

# siid 2 / piid 2 status names (spec v4)
STATUS_NAMES = {
    1: "대기", 2: "바쁨", 3: "지연", 4: "물걸레중", 5: "흡입+물걸레중",
    6: "일시정지", 7: "흡입중", 8: "에러", 9: "충전중", 10: "복귀중",
    11: "충전중단", 12: "걸레세척 복귀", 13: "충전완료", 14: "지도생성중",
    15: "업데이트중", 16: "절전", 17: "위치확인중", 18: "스테이션 동작중",
    19: "매핑 일시정지", 20: "충전복귀중단", 21: "세척복귀중단",
    22: "기기연결중", 23: "먼지비움 복귀중",
}

FAN_MODES = {"조용": 0, "자동": 1, "강력": 2, "터보": 3}
WATER_MODES = {"적음": 0, "중간": 1, "많음": 2}
CLEAN_MODES = {"흡입+물걸레": 0, "흡입만": 1, "물걸레만": 2, "흡입후물걸레": 3, "커스텀": 4}

# 핵심 상태 프로퍼티 (펌웨어 타임아웃 이슈로 10개씩 나눠 조회)
PROPS_CORE = [(2, 2), (16, 1), (17, 9), (17, 34), (17, 35), (17, 36),
              (17, 48), (17, 49), (17, 26), (17, 27)]
PROPS_CFG = [(17, 10), (17, 11), (17, 12), (17, 13), (17, 14), (17, 15),
             (17, 6), (17, 20), (17, 21), (17, 22),
             (17, 23), (17, 7), (17, 43), (17, 44), (17, 1), (17, 19),
             (17, 65), (17, 2), (17, 25), (17, 32), (17, 45),
             (17, 74), (17, 75)]


class JonrDevice:
    def __init__(self, ip: str, token: str, did: str = ""):
        token = (token or "").strip()
        if len(token) != 32 or any(c not in "0123456789abcdefABCDEF" for c in token):
            raise ValueError("token은 32자리 hex여야 합니다")
        self.ip = ip
        self.did = did or "jonr-web"
        # 이 기기는 로컬 액션 일부가 응답하지 않아(-9999) 타임아웃을 짧게 잡는다
        self._dev = Device(ip, token, model=MODEL, timeout=4)

    # ---- low level ----
    def _send(self, method, payload, retries=1):
        import time
        last = None
        for i in range(retries):
            try:
                return self._dev.send(method, payload)
            except DeviceException as e:
                last = e
                msg = str(e)
                if "Unable to recover" in msg or "-9999" in msg or "timeout" in msg.lower():
                    if i + 1 < retries:
                        time.sleep(0.8)
                    continue
                raise
        raise last

    def _get_props(self, props):
        out = {}
        last = None
        for i in range(0, len(props), 10):
            chunk = props[i:i + 10]
            req = [{"did": f"{s}-{p}", "siid": s, "piid": p} for s, p in chunk]
            try:
                resp = self._send("get_properties", req, retries=2)
            except DeviceException as e:
                last = e
                continue
            for r in resp:
                try:
                    s, p = int(r["siid"]), int(r["piid"])
                except Exception:
                    continue
                if r.get("code", -1) == 0:
                    out[(s, p)] = r.get("value")
                else:
                    out[(s, p)] = {"_error_code": r.get("code")}
        if last is not None and not out:
            raise RuntimeError(f"get_properties 실패: {last}")
        return out

    def _action(self, siid: int, aiid: int, params=None):
        payload = {"did": f"call-{siid}-{aiid}", "siid": siid,
                   "aiid": aiid, "in": params or []}
        try:
            return self._send("action", payload)
        except DeviceException as e:
            raise RuntimeError(f"action {siid}.{aiid} 실패: {e}")

    def _set_prop(self, siid: int, piid: int, value):
        try:
            return self._send("set_properties",
                              [{"did": f"set-{siid}-{piid}", "siid": siid,
                                "piid": piid, "value": value}])
        except DeviceException as e:
            raise RuntimeError(f"set {siid}.{piid} 실패: {e}")

    # ---- high level ----
    def info(self):
        try:
            i = self._dev.info()
            return {"model": getattr(i, "model", "?"),
                    "fw": getattr(i, "firmware_version", "?"),
                    "hw": getattr(i, "hardware_version", "?"),
                    "mac": getattr(i, "mac_address", "?")}
        except DeviceException as e:
            raise RuntimeError(f"info 실패: {e}")

    def status(self):
        data = {}
        data.update(self._get_props(PROPS_CORE))
        try:
            data.update(self._get_props(PROPS_CFG))
        except RuntimeError:
            pass  # 설정 읽기 실패해도 핵심 상태는 반환
        st = data.get((2, 2))
        return {
            "raw": {f"{s}.{p}": v for (s, p), v in data.items()},
            "status_code": st,
            "status_name": STATUS_NAMES.get(st, "?") if isinstance(st, int) else "?",
            "battery": data.get((16, 1)),
            "task": data.get((17, 9)),
            "task_targets": data.get((17, 34)),
            "error": data.get((17, 35)),
            "message": data.get((17, 36)),
            "return_status": data.get((17, 48)),
            "robot_status": data.get((17, 49)),
            "clean_time_min": (round(data.get((17, 26)) / 60.0, 1)
                               if isinstance(data.get((17, 26)), int) else None),
            "clean_area_m2": data.get((17, 27)),
            "mode": data.get((17, 10)),
            "fan": data.get((17, 13)),
            "water": data.get((17, 12)),
            "count": data.get((17, 14)),
            "route": data.get((17, 65)) if (17, 65) in data else None,
            "volume": data.get((17, 15)),
            "drying": data.get((17, 21)),
            "carpet_boost": data.get((17, 7)),
            "child_lock": data.get((17, 6)),
            "carpet_prefer": data.get((17, 11)),
            "carpet_twice": data.get((17, 74)),
            "carpet_first": data.get((17, 75)),
            "mop_augment": data.get((17, 43)),
            "break_clean": data.get((17, 2)),
            "disturb": data.get((17, 1)),
            "disturb_time": data.get((17, 19)),
            "language": data.get((17, 25)),
            "dust_collection": data.get((17, 20)),
            "drying_time": data.get((17, 22)),
            "mop_wash_freq": data.get((17, 23)),
            "consumables": data.get((17, 32)),
        }

    # 동작
    def start_full(self):
        self._action(17, 3)  # 열려있는 작업이 있으면 먼저 닫음
        import time
        time.sleep(2)
        return self._action(17, 1, [1, "[]"])

    def stop(self):
        # vacuum:stop-sweeping(2.2)은 작업이 안 닫힘 → 17.3 사용 (실측 근거)
        return self._action(17, 3)

    def pause(self):
        return self._action(17, 2, [7])

    def resume(self):
        return self._action(17, 2, [8])

    def dock(self):
        return self._action(16, 1)

    def locate(self):
        return self._action(17, 4)

    def room_clean(self, room_ids):
        self._action(17, 3)
        import time, json
        time.sleep(2)
        return self._action(17, 1, [3, json.dumps([int(x) for x in room_ids],
                                                  separators=(",", ":"))])

    def zone_clean(self, rect8):
        """구역 청소. 8의 배수(구역 1개=8숫자) 허용, 최대 5구역."""
        import time, json
        if not rect8 or len(rect8) % 8 != 0 or len(rect8) > 80:
            raise ValueError("구역은 8숫자 단위(최대 10구역)")
        self._action(17, 3)
        time.sleep(2)
        return self._action(17, 1, [4, json.dumps([int(x) for x in rect8],
                                                  separators=(",", ":"))])

    def spot_clean(self):
        self._action(17, 3)
        import time
        time.sleep(2)
        return self._action(17, 1, [6, ""])

    # 설정 (속성은 read-only라 액션으로 변경)
    def set_fan(self, v): return self._action(17, 26, [int(v)])
    def set_water(self, v): return self._action(17, 27, [int(v)])
    def set_mode(self, v): return self._action(17, 46, [int(v)])
    def set_count(self, v): return self._action(17, 28, [int(v)])
    def set_route(self, v): return self._action(17, 50, [int(v)])
    def set_volume(self, v): return self._action(17, 31, [int(v)])
    def set_child_lock(self, on): return self._action(17, 36, [bool(on)])
    def set_disturb(self, on): return self._action(17, 24, [bool(on)])
    def set_carpet_prefer(self, v): return self._action(17, 33, [int(v)])
    def set_carpet_boost(self, on): return self._action(17, 34, [bool(on)])
    def set_carpet_twice(self, on): return self._action(17, 55, [bool(on)])
    def set_carpet_first(self, on): return self._action(17, 56, [bool(on)])
    def set_drying(self, on): return self._action(17, 48, [bool(on)])
    def set_drying_time(self, v): return self._action(17, 43, [int(v)])
    def set_mop_freq(self, v): return self._action(17, 44, [int(v)])
    def set_dust_collection(self, v): return self._action(17, 32, [int(v)])
    def wash_mop(self): return self._action(17, 40, [True])
    def dry_mop(self): return self._action(17, 41, [True])
    def collect_dust(self): return self._action(17, 42, [True])
