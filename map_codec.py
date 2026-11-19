"""지도/벽 데이터 코덱.

기기 지도 파일의 벽 필드는 base64로 감싼
`id,type[,pref],x1,y1,x2,y2,...;...` 문자열이다.
이 모듈은 그 문자열을 읽고 쓰는 최소 기능만 제공한다.
"""
from __future__ import annotations

import base64


def b64_text(value):
    """base64 문자열을 UTF-8 텍스트로 디코드한다. 실패 시 None."""
    if not isinstance(value, str) or not value:
        return None
    try:
        return base64.b64decode(value + "=" * (-len(value) % 4)).decode("utf-8", "replace")
    except Exception:
        return None


def decode_wall_field(field, leading=2):
    """base64 벽 문자열을 `{id, type, points, [pref]}` 목록으로 변환한다.

    카펫은 pref 필드가 붙기도/안 붙기도 하므로(기기·앱 버전 차이)
    좌표 개수가 홀수가 되면 leading 을 2↔3 으로 자동 보정한다.
    """
    text = b64_text(field)
    if not text or not text.strip():
        return []
    out = []
    for seg in text.split(";"):
        parts = [p for p in seg.split(",") if p.strip() != ""]
        if len(parts) < leading + 4 or not parts[0].lstrip("-").isdigit():
            continue
        lead = leading
        if (len(parts) - lead) % 2 != 0:
            alt = 3 if lead == 2 else 2
            if (len(parts) - alt) % 2 == 0:
                lead = alt
        if len(parts) < lead + 4 or (len(parts) - lead) % 2 != 0:
            continue
        try:
            wid, wtype = int(parts[0]), int(parts[1])
            nums = [int(float(v)) for v in parts[lead:]]
        except ValueError:
            continue
        pts = [[nums[i], nums[i + 1]] for i in range(0, len(nums) - 1, 2)]
        if pts:
            entry = {"id": wid, "type": wtype, "points": pts}
            if lead > 2:
                entry["pref"] = parts[2]
            out.append(entry)
    return out


def encode_wall_field(entries, leading=2):
    """`{id, type, points}` 목록을 base64 벽 문자열로 변환한다."""
    segs = []
    for entry in entries:
        nums = []
        for x, y in entry["points"]:
            nums += [str(int(x)), str(int(y))]
        head = [str(entry["id"]), str(entry["type"])]
        if leading > 2:
            head.append(str(entry.get("pref", "0")))
        segs.append(",".join(head + nums))
    return base64.b64encode(";".join(segs).encode()).decode()
