/* ================= 지도 편집기 (방/구역/금지구역·문턱·카펫) ================= */
let MAPMETA = null, WALLS = null, ROOMS = [], TOOL = "full";
let DOCK = null;              // 충전 스테이션 px 위치
let SELECTED = [];            // 방 선택 순서
let ZONES = [];               // {id, x0,y0,x1,y1}
let ZONE_TASK = false;        // 구역 청소 시작됨(청소 중에는 편집 잠금)
let CLEANING_LOCK = false;    // 로봇이 청소 중이면 방/구역 변경 잠금
let ZONE_SAW_CLEAN = false;   // 실제 청소 상태를 한 번이라도 봤는지
let ZONE_STARTED_AT = 0;
let ELEMS = [];               // 요소 편집 대상
let ORIGINAL = [];            // 취소용 원본
let DRAFT = null, DRAG = null, SECOND = false, DOWN_AT = null;
let PAN = null;
let PANX = 0, PANY = 0;
let LIVE = { pos: null, trace: [] };
let KIND = "thres";
let seq = 1;
const ZOOM_MIN = 0.6, ZOOM_MAX = 3;
let ZOOM = 1;

const KINDS = {
  thres:   { label: "문턱", color: "#ff8c00", shape: "line",
             types: [{ v: 2, l: "문지방", shape: "line" },
                     { v: 1, l: "미닫이 문턱", shape: "line" }] },
  virtual: { label: "가상벽", color: "#e33725", shape: "line",
             types: [{ v: 1, l: "가상벽", shape: "line" },
                     { v: 2, l: "금지구역", shape: "rect" }] },
  mop:     { label: "물걸레 금지", color: "#ffab47", shape: "rect",
             types: [{ v: 2, l: "물걸레 금지", shape: "rect" }] },
  carpet:  { label: "카펫", color: "#2cd5ae", shape: "rect",
             types: [{ v: 1, l: "카펫", shape: "rect" }] },
};
const KIND_ORDER = ["virtualWalls", "mopWalls", "carpet", "thres"];
const KEY_TO_KIND = { virtualWalls: "virtual", mopWalls: "mop", carpet: "carpet", thres: "thres" };
const CARPET_STRAT = ["적응", "회피", "통과", "무시"];
const CARPET_EXPANDED = new Set();

/* 현재 청소 대상: MiOT 17.34 clean-values (공식 플러그인도 같은 필드를 읽는다) */
function parseCleanTargets(raw) {
  let arr = raw;
  if (typeof arr === "string") {
    try { arr = JSON.parse(arr); } catch (e) { return null; }
  }
  if (!Array.isArray(arr) || !arr.length) return null;
  const nums = arr.map(v => (typeof v === "number" ? v : Number(v)));
  if (nums.some(n => !Number.isFinite(n))) return null;
  const maxAbs = Math.max(...nums.map(Math.abs));
  // 구역은 구역당 8개 좌표(4점)로 전달된다. 방 ID는 훨씬 작은 정수다.
  if (nums.length % 8 === 0 && maxAbs > 50) {
    const zones = [];
    for (let i = 0; i < nums.length; i += 8) {
      const p = nums.slice(i, i + 8);
      const xs = [p[0], p[2], p[4], p[6]], ys = [p[1], p[3], p[5], p[7]];
      zones.push({ id: seq + i / 8,
                   x0: Math.min(...xs), y0: Math.min(...ys),
                   x1: Math.max(...xs), y1: Math.max(...ys) });
    }
    return { kind: "zone", zones };
  }
  return { kind: "room", selected: nums.map(Math.round) };
}
function syncCleanTargets(s) {
  if (!window.__CLEANING) {
    ZONE_TASK = false;
    return;
  }
  const parsed = parseCleanTargets(s?.task_targets);
  if (!parsed) return;
  if (parsed.kind === "room") {
    SELECTED = ROOMS.length
      ? parsed.selected.filter(id => ROOMS.some(rm => rm.room_id === id))
      : parsed.selected.slice();
    ZONES = [];
    ZONE_TASK = false;
  } else {
    SELECTED = [];
    ZONES = parsed.zones;
    ZONE_TASK = true;
    ZONE_SAW_CLEAN = true;
    ZONE_STARTED_AT = Date.now();
    seq = Math.max(seq, ...ZONES.map(z => z.id + 1));
  }
}
function cleaningNotice() {
  toast("현재 청소 중입니다. 방·구역을 변경할 수 없습니다. 변경하려면 작업을 종료하세요.");
}

function currentType() {
  const m = KINDS[KIND];
  const v = +($("elemType").value || (m.types?.[0]?.v ?? 1));
  return (m.types || []).find((t) => +t.v === v) || m.types?.[0] || { v: 1, l: m.label, shape: m.shape };
}

const mapImg = $("mapImg"), mapCv = $("mapCanvas"), mapWrap = $("mapWrap"), mapInner = $("mapInner");
const HIT = 11;

/* 캔버스는 CSS 변수를 직접 못 읽으므로 현재 테마의 색을 JS로 계산 */
function mapColors() {
  const t = document.documentElement.dataset.theme || "system";
  const dark = t === "dark" ||
    (t === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  return {
    dark,
    handle: dark ? "#fff" : "#16211f",
    traceWide: dark ? "rgba(255,255,255,.20)" : "rgba(0,0,0,.20)",
    traceHalf: dark ? "rgba(255,255,255,.50)" : "rgba(0,0,0,.50)",
    traceFull: dark ? "rgba(255,255,255,1)" : "rgba(0,0,0,1)",
    robotOuter: dark ? "#f4fffc" : "#16211f",
    robotInner: dark ? "#101614" : "#fff",
    robotDir: dark ? "#2CD5AE" : "#0e9f82",
    stationFill: dark ? "#101614" : "#fff",
    stationBorder: dark ? "#f4fffc" : "#16211f",
    stationBolt: dark ? "#2CD5AE" : "#0e9f82",
    iconShadow: dark ? "rgba(0,0,0,.55)" : "rgba(0,0,0,.28)",
    draft: dark ? "#7ff0d6" : "#0e9f82",
  };
}

/* 청소 경로: 점 사이를 2차 곡선으로 부드럽게 연결 (표시용) */
let TRACE_CACHE = { sig: "", items: [] };
function traceCurvePath(pts) {
  const path = new Path2D();
  path.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length - 1; i++) {
    const p = pts[i], n = pts[i + 1];
    path.quadraticCurveTo(p[0], p[1],
      (p[0] + n[0]) / 2, (p[1] + n[1]) / 2);
  }
  const last = pts[pts.length - 1];
  path.lineTo(last[0], last[1]);
  return path;
}
function traceSignature(trace) {
  let h = 2166136261;
  for (const seg of trace || []) {
    const pts = seg.p || seg;
    if (!pts?.length) continue;
    h ^= ((+seg.m || 0) + 1);
    h = Math.imul(h, 16777619);
    for (const p of pts) {
      h ^= (p[0] | 0);
      h = Math.imul(h, 16777619);
      h ^= (p[1] | 0);
      h = Math.imul(h, 16777619);
    }
  }
  return `${(trace || []).length}:${h >>> 0}`;
}
function traceDrawPaths(trace) {
  const sig = traceSignature(trace);
  if (TRACE_CACHE.sig === sig) return TRACE_CACHE.items;
  const items = [];
  for (const seg of trace || []) {
    const pts = seg.p || seg;
    if (!pts || pts.length < 2) continue;
    items.push({ m: +seg.m || 0, path: traceCurvePath(pts) });
  }
  TRACE_CACHE = { sig, items };
  return items;
}

function sf() { return mapCv.width / Math.max(mapCv.getBoundingClientRect().width, 1); }
function pxToScene(px, py) {
  const k = MAPMETA.scale, ox = MAPMETA.ox || 0, oy = MAPMETA.oy || 0;
  const col = (px - ox - k / 2) / k, row = (py - oy - k / 2) / k;
  return [Math.round(col + MAPMETA.y_max),
          Math.round(800 - MAPMETA.x_min - (MAPMETA.height - 1) + row)];
}
function metersPerUnit() {
  return (MAPMETA?.resolution || 5) / 100;
}
function fmtMeters(v) {
  const n = Math.round(v * 10) / 10;
  return (Math.abs(n - Math.round(n)) < 0.05 ? String(Math.round(n)) : n.toFixed(1)) + "m";
}
function lineMeters(a, b) {
  const k = MAPMETA?.scale || 1;
  return Math.hypot(b[0] - a[0], b[1] - a[1]) / k * metersPerUnit();
}
function rectMeters(a, b) {
  const k = MAPMETA?.scale || 1;
  return [Math.abs(b[0] - a[0]) / k * metersPerUnit(),
          Math.abs(b[1] - a[1]) / k * metersPerUnit()];
}
function evtPos(e) {
  const r = mapCv.getBoundingClientRect();
  return [(e.clientX - r.left) / r.width * mapCv.width,
          (e.clientY - r.top) / r.height * mapCv.height];
}
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
function segDist(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy || 1;
  let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}
const clone = (o) => JSON.parse(JSON.stringify(o));

function hint(msg) {
  const el = $("wallsHint");
  if (el && !$("wallsPane").classList.contains("hidden")) el.textContent = msg;
  else toast(msg, 2400);
}


/* ---------- 줌 ---------- */
function mapFitWidth() {
  const cw = mapWrap.clientWidth, ch = mapWrap.clientHeight;
  const ar = (MAPMETA.img_w || 1) / (MAPMETA.img_h || 1);
  return Math.min(cw, ch * ar);
}
function mapBaseX(width) {
  // margin:0 auto 는 폭이 컨테이너보다 커지면 여백을 0으로 처리한다.
  const cw = mapWrap.clientWidth;
  return Math.max(0, (cw - width) / 2);
}
function applyZoom(z, anchor) {
  const oldZoom = ZOOM;
  const nextZoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, z));
  if (anchor && nextZoom !== oldZoom) {
    const fitW = mapFitWidth();
    // 확대 전 커서 아래의 지도 좌표(배율 1 기준)
    const baseX0 = mapBaseX(fitW * oldZoom);
    const qx = (anchor.x - (baseX0 + PANX)) / oldZoom;
    const qy = (anchor.y - PANY) / oldZoom;
    // 확대 후에도 같은 지도 좌표가 커서 아래에 오도록 팬 보정
    const baseX1 = mapBaseX(fitW * nextZoom);
    PANX = anchor.x - baseX1 - qx * nextZoom;
    PANY = anchor.y - qy * nextZoom;
    clampPan();
  }
  ZOOM = nextZoom;
  layoutMap();
  $("zoomVal").textContent = Math.round(ZOOM * 100) + "%";
  drawAll();
}
function clampPan() {
  const cw = mapWrap.clientWidth, ch = mapWrap.clientHeight;
  const mx = cw * 0.9, my = ch * 0.9;
  PANX = Math.max(-mx, Math.min(mx, PANX));
  PANY = Math.max(-my, Math.min(my, PANY));
}
function applyPan() {
  mapInner.style.transform = `translate(${PANX}px, ${PANY}px)`;
}
function layoutMap() {
  if (!MAPMETA) return;
  const fitW = mapFitWidth();
  mapInner.style.width = fitW * ZOOM + "px";
  mapInner.style.margin = "0 auto";
  applyPan();
}
window.addEventListener("resize", () => { layoutMap(); drawAll(); });
$("zoomIn").onclick = () => applyZoom(ZOOM * 1.2);
$("zoomOut").onclick = () => applyZoom(ZOOM / 1.2);
$("zoomFit").onclick = () => { PANX = 0; PANY = 0; applyZoom(1); };
mapWrap.addEventListener("wheel", (e) => {
  if (!MAPMETA) return;
  if (e.ctrlKey || e.metaKey) {           // Ctrl(⌘)+휠 = 확대/축소
    e.preventDefault();
    const rect = mapWrap.getBoundingClientRect();
    const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
    applyZoom(ZOOM * factor, {
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
    });
  }
}, { passive: false });

/* ---------- 그리기 ---------- */
function drawAll() {
  if (!MAPMETA) return;
  const s = sf();
  const ctx = mapCv.getContext("2d");
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, mapCv.width, mapCv.height);
  const TC = mapColors();
  const pendingLabels = [];

  const line = (pts, color, w, dash) => {
    if (!pts?.length) return;
    ctx.save();
    ctx.strokeStyle = color; ctx.lineWidth = w * s;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.setLineDash((dash || []).map((v) => v * s));
    ctx.beginPath();
    pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.stroke(); ctx.restore();
  };
  const dot = (p, color, r = 5) => {
    ctx.save(); ctx.fillStyle = color;
    ctx.beginPath(); ctx.arc(p[0], p[1], r * s, 0, Math.PI * 2); ctx.fill(); ctx.restore();
  };
  const xBtn = (p, r = 8) => {
    ctx.save();
    ctx.fillStyle = "rgba(20,26,24,.9)";
    ctx.beginPath(); ctx.arc(p[0], p[1], r * s, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = "#fff"; ctx.lineWidth = 2 * s;
    const d = r * 0.42 * s;
    ctx.beginPath();
    ctx.moveTo(p[0] - d, p[1] - d); ctx.lineTo(p[0] + d, p[1] + d);
    ctx.moveTo(p[0] + d, p[1] - d); ctx.lineTo(p[0] - d, p[1] + d);
    ctx.stroke(); ctx.restore();
  };
  const label = (text, x, y, bg, fg, size = 12, align = "center") => {
    ctx.save();
    const fs = Math.round(size * s);
    ctx.font = `700 ${fs}px "Malgun Gothic", sans-serif`;
    ctx.textBaseline = "middle";
    const w = ctx.measureText(text).width + fs * 0.9, h = fs * 1.7, r = h / 2;
    const x0 = align === "left" ? x : align === "right" ? x - w : x - w / 2;
    const y0 = y - h / 2;
    ctx.beginPath();
    ctx.moveTo(x0 + r, y0);
    ctx.arcTo(x0 + w, y0, x0 + w, y0 + h, r);
    ctx.arcTo(x0 + w, y0 + h, x0, y0 + h, r);
    ctx.arcTo(x0, y0 + h, x0, y0, r);
    ctx.arcTo(x0, y0, x0 + w, y0, r);
    ctx.closePath(); ctx.fillStyle = bg; ctx.fill();
    ctx.fillStyle = fg;
    if (align === "center") {
      ctx.textAlign = "center";
      ctx.fillText(text, x, y + 0.5 * s);
    } else {
      ctx.textAlign = "left";
      ctx.fillText(text, x0 + fs * 0.45, y + 0.5 * s);
    }
    ctx.restore();
  };
  const rectOf = (el) => [Math.min(el.a[0], el.b[0]), Math.min(el.a[1], el.b[1]),
                          Math.max(el.a[0], el.b[0]), Math.max(el.a[1], el.b[1])];

  /* 방 */
  if (TOOL === "room") {
    const k = MAPMETA.scale || 1;
    ROOMS.forEach((rm) => {
      const order = SELECTED.indexOf(rm.room_id);
      const sel = order >= 0;
      if (sel) {
        ctx.save();
        ctx.beginPath();
        (rm.spans || []).forEach(([y, x0, x1]) => ctx.rect(x0, y, x1 - x0, k));
        ctx.clip();
        ctx.strokeStyle = "rgba(44,213,174,.75)"; ctx.lineWidth = 1.4 * s;
        const step = 9 * s, hh = rm.bbox[3] - rm.bbox[1];
        for (let x = rm.bbox[0] - hh; x < rm.bbox[2] + hh; x += step) {
          ctx.beginPath(); ctx.moveTo(x, rm.bbox[1]);
          ctx.lineTo(x + hh, rm.bbox[3]); ctx.stroke();
        }
        ctx.restore();
      }
      if (rm.lx != null) {
        if (sel) label(`${rm.name} (${order + 1})`, rm.lx, rm.ly, "rgba(44,213,174,.95)", "#04322a", 13.5);
        else label(rm.name, rm.lx, rm.ly, "rgba(10,20,18,.62)", "#eafff9", 11.5);
      }
    });
  }

  /* 청소 경로 (Mi Home 플러그인 MapTraceView와 동일한 스타일, 2차 곡선 보정) */
  const s2 = sf();
  const unitPx = (mapCv.clientWidth || 800) / (MAPMETA.width || 1);
  const w0 = Math.max(0.75, 0.5 * unitPx);
  const wWide = 5 * unitPx;
  const wCore = Math.max(0.75, 1 * unitPx);
  const strokePath = (path, color, w) => {
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = w * s;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.stroke(path);
    ctx.restore();
  };
  for (const item of traceDrawPaths(LIVE.trace || [])) {
    const m = item.m;
    if (m === 0) {
      strokePath(item.path, TC.traceFull, w0);
    } else if (m === 1) {
      strokePath(item.path, TC.traceWide, wWide);
      strokePath(item.path, TC.traceHalf, wCore);
    } else if (m === 2) {
      strokePath(item.path, TC.traceWide, wWide);
      strokePath(item.path, TC.traceFull, wCore);
    }
    // 공식 플러그인과 동일하게 type 3/4는 그리지 않는다.
  }
  /* 스테이션 */
  if (DOCK) {
    const side = 28 * s2, hh = side / 2, rr = 6 * s2;
    const x = DOCK.x - hh, y = DOCK.y - hh;
    ctx.save();
    ctx.shadowColor = TC.iconShadow; ctx.shadowBlur = 4 * s2;
    ctx.fillStyle = TC.stationFill;
    ctx.strokeStyle = TC.stationBorder;
    ctx.lineWidth = 2.2 * s2;
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.arcTo(x + side, y, x + side, y + side, rr);
    ctx.arcTo(x + side, y + side, x, y + side, rr);
    ctx.arcTo(x, y + side, x, y, rr);
    ctx.arcTo(x, y, x + side, y, rr);
    ctx.closePath();
    ctx.fill(); ctx.stroke();
    ctx.shadowColor = "transparent"; ctx.shadowBlur = 0;
    // 번개
    const bolt = [[.10, -.31], [-.22, .04], [-.03, .04], [-.10, .31], [.22, -.05], [.03, -.05]];
    ctx.fillStyle = TC.stationBolt;
    ctx.strokeStyle = TC.stationBolt;
    ctx.lineWidth = 1.6 * s2;
    ctx.lineJoin = "round"; ctx.lineCap = "round";
    ctx.beginPath();
    bolt.forEach(([bx, by], i) => {
      const X = DOCK.x + bx * side, Y = DOCK.y + by * side;
      if (i) ctx.lineTo(X, Y); else ctx.moveTo(X, Y);
    });
    ctx.closePath();
    ctx.fill(); ctx.stroke();
    ctx.restore();
  }

  /* 로봇 (원형 + 내부 방향선) */
  if (LIVE.pos) {
    const px = LIVE.pos.x, py = LIVE.pos.y;
    const R = 11 * s2;
    ctx.save();
    ctx.shadowColor = TC.iconShadow; ctx.shadowBlur = 4 * s2;
    ctx.fillStyle = TC.robotOuter;
    ctx.beginPath(); ctx.arc(px, py, R, 0, Math.PI * 2); ctx.fill();
    ctx.shadowColor = "transparent"; ctx.shadowBlur = 0;
    ctx.fillStyle = TC.robotInner;
    ctx.beginPath(); ctx.arc(px, py, R * 0.80, 0, Math.PI * 2); ctx.fill();
    const ang = -(LIVE.pos.a || 0) / 100;   // 0.01rad, 화면 좌표계 반전
    ctx.strokeStyle = TC.robotDir;
    ctx.lineWidth = R * 0.34;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(px, py);
    ctx.lineTo(px + Math.cos(ang) * R * 0.60, py + Math.sin(ang) * R * 0.60);
    ctx.stroke();
    ctx.restore();
  }

  /* 저장된 요소 (보기 탭에서도 표시) */
  const showElems = true;
  if (showElems) {
    ELEMS.forEach((el) => {
      if (el.deleted) return;
      const meta = KINDS[el.kind];
      const active = TOOL === "walls" && el.kind === KIND;
      const base = meta.color;
      const col = el.isNew ? "#22c55e" : (el.dirty ? "#ffc107" : base);
      const rgb = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16),
                          parseInt(h.slice(5, 7), 16)];
      const [r0, g0, b0] = rgb(col.startsWith("#") ? col : "#ffffff");
      ctx.globalAlpha = active ? 1 : 0.8;
      if (el.shape === "line") {
        let w = active ? 5 : 4;
        // 문지방(type 2)은 미닫이 문턱(type 1)과 구분되도록 조금 더 두껍게 그린다.
        if (el.kind === "thres") w = (el.type === 2 ? 7 : 3.5) * (active ? 1 : 0.8);
        line([el.a, el.b], col, w);
      } else {
        const [x0, y0, x1, y1] = rectOf(el);
        ctx.save();
        ctx.fillStyle = `rgba(${r0},${g0},${b0},0.22)`;
        ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
        ctx.strokeStyle = col;
        ctx.lineWidth = (active ? 3.5 : 3) * s;
        ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
        ctx.restore();
      }
      ctx.globalAlpha = 1;
      if (TOOL === "walls" && el.kind === KIND) {
        const num = el.isNew ? "새" : "#" + el.id;
        const t = el.kind === "carpet" && el.pref?.custom
          ? `${num} 카펫 (${CARPET_STRAT[el.pref.prefer] || "?"})`
          : `${num} ${typeText(el.kind, el.type)}`;
        let lx, ly;
        if (el.shape === "line") {
          lx = (el.a[0] + el.b[0]) / 2;
          ly = (el.a[1] + el.b[1]) / 2 - 18 * s;
        } else {
          const [bx0, by0, bx1] = rectOf(el);
          lx = (bx0 + bx1) / 2;
          ly = by0 - 14 * s;
        }
        pendingLabels.push(() =>
          label(t, lx, ly, "rgba(10,20,18,.78)", "#e9fffb", 10));
      }
      if (!active) return;
      if (el.shape === "line") {
        dot(el.a, TC.handle, 5); dot(el.b, TC.handle, 5);
        const mid = [(el.a[0] + el.b[0]) / 2, (el.a[1] + el.b[1]) / 2];
        const nx = -(el.b[1] - el.a[1]), ny = el.b[0] - el.a[0];
        const len = Math.hypot(nx, ny) || 1;
        xBtn([mid[0] + nx / len * 16 * s, mid[1] + ny / len * 16 * s]);
      } else {
        const [x0, y0, x1, y1] = rectOf(el);
        dot([x0, y0], TC.handle, 6); dot([x1, y1], TC.handle, 6); xBtn([x1, y0]);
      }
    });
  }

  /* 구역 청소 영역 (청소 중에는 잠금 표시) */
  if (TOOL === "zone" || ZONE_TASK) {
    const locked = ZONE_TASK;
    ZONES.forEach((z, i) => {
      ctx.save();
      ctx.fillStyle = locked ? "rgba(44,213,174,.20)" : "rgba(44,213,174,.16)";
      ctx.strokeStyle = locked ? "#1fc7a2" : "#2CD5AE";
      ctx.lineWidth = (locked ? 2.5 : 2) * s;
      if (!locked) ctx.setLineDash([6 * s, 4 * s]);
      ctx.fillRect(z.x0, z.y0, z.x1 - z.x0, z.y1 - z.y0);
      ctx.strokeRect(z.x0, z.y0, z.x1 - z.x0, z.y1 - z.y0);
      ctx.restore();
      if (!locked) {
        dot([z.x0, z.y0], TC.handle, 6); dot([z.x1, z.y1], TC.handle, 6); xBtn([z.x1, z.y0]);
      }
      label(locked ? `구역 ${i + 1} · 청소 중` : `구역 ${i + 1}`,
            (z.x0 + z.x1) / 2, z.y0 - 13 * s, "rgba(10,20,18,.7)", "#d8fff5", 10.5);
    });
  }

  /* 생성 중 */
  if (DRAFT?.b) {
    if (TOOL === "zone" || (TOOL === "walls" && (DRAFT.shape || currentType().shape) === "rect")) {
      const x0 = Math.min(DRAFT.a[0], DRAFT.b[0]), y0 = Math.min(DRAFT.a[1], DRAFT.b[1]);
      const x1 = Math.max(DRAFT.a[0], DRAFT.b[0]), y1 = Math.max(DRAFT.a[1], DRAFT.b[1]);
      ctx.save();
      ctx.fillStyle = "rgba(44,213,174,.14)"; ctx.strokeStyle = TC.draft;
      ctx.lineWidth = 2 * s; ctx.setLineDash([4 * s, 4 * s]);
      ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
      ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
      ctx.restore();
    } else {
      line([DRAFT.a, DRAFT.b], "#22c55e", 4);
      dot(DRAFT.a, "#22c55e", 5); dot(DRAFT.b, "#22c55e", 5);
    }
  } else if (DRAFT) dot(DRAFT.a, "#22c55e", 5);

  /* 라벨은 모든 도형/핸들 위에 마지막으로 그린다 */
  pendingLabels.forEach((fn) => fn());

  /* 크기 조절 중 중앙에 실제 크기 표시 */
  let sizeText = null, sizeX = 0, sizeY = 0;
  if (TOOL === "zone" && DRAG && (DRAG.hit.kind === "pt-a" || DRAG.hit.kind === "pt-b")) {
    const z = DRAG.hit.ref;
    const [w, h] = rectMeters([z.x0, z.y0], [z.x1, z.y1]);
    sizeText = `${fmtMeters(w)} x ${fmtMeters(h)}`;
    sizeX = (z.x0 + z.x1) / 2; sizeY = (z.y0 + z.y1) / 2;
  } else if (TOOL === "walls" && DRAG && DRAG.hit.ref &&
             (DRAG.hit.kind === "pt-a" || DRAG.hit.kind === "pt-b")) {
    const el = DRAG.hit.ref;
    if (el.shape === "line") {
      sizeText = fmtMeters(lineMeters(el.a, el.b));
      sizeX = (el.a[0] + el.b[0]) / 2; sizeY = (el.a[1] + el.b[1]) / 2;
    } else {
      const x0 = Math.min(el.a[0], el.b[0]), y0 = Math.min(el.a[1], el.b[1]);
      const x1 = Math.max(el.a[0], el.b[0]), y1 = Math.max(el.a[1], el.b[1]);
      const [w, h] = rectMeters([x0, y0], [x1, y1]);
      sizeText = `${fmtMeters(w)} x ${fmtMeters(h)}`;
      sizeX = (x0 + x1) / 2; sizeY = (y0 + y1) / 2;
    }
  } else if (DRAFT?.b) {
    const rect = TOOL === "zone" ||
      (TOOL === "walls" && (DRAFT.shape || currentType().shape) === "rect");
    if (rect) {
      const x0 = Math.min(DRAFT.a[0], DRAFT.b[0]), y0 = Math.min(DRAFT.a[1], DRAFT.b[1]);
      const x1 = Math.max(DRAFT.a[0], DRAFT.b[0]), y1 = Math.max(DRAFT.a[1], DRAFT.b[1]);
      const [w, h] = rectMeters([x0, y0], [x1, y1]);
      sizeText = `${fmtMeters(w)} x ${fmtMeters(h)}`;
      sizeX = (x0 + x1) / 2; sizeY = (y0 + y1) / 2;
    } else {
      sizeText = fmtMeters(lineMeters(DRAFT.a, DRAFT.b));
      sizeX = (DRAFT.a[0] + DRAFT.b[0]) / 2;
      sizeY = (DRAFT.a[1] + DRAFT.b[1]) / 2;
    }
  }
  if (sizeText) label(sizeText, sizeX, sizeY, "rgba(10,20,18,.9)", "#e9fffb", 11.5);
}

/* ---------- 히트 테스트 ---------- */
function roomCentroid(rm) {
  let ws = 0, xs = 0, ys = 0;
  (rm.spans || []).forEach(([y, x0, x1]) => {
    const w = x1 - x0;
    ws += w; xs += (x0 + x1) / 2 * w; ys += (y + MAPMETA.scale / 2) * w;
  });
  return ws ? [xs / ws, ys / ws] : null;
}
function hitRoom(px, py) {
  for (const rm of ROOMS) {
    for (const [y, x0, x1] of rm.spans || []) {
      if (py >= y && py < y + (MAPMETA?.scale || 1) && px >= x0 && px <= x1) return rm;
    }
  }
  return null;
}
function elemOfKind() {
  return ELEMS.filter((e) => e.kind === KIND && !e.deleted);
}
function hitElem(p) {
  const r = HIT * sf();
  const list = elemOfKind();
  for (let i = list.length - 1; i >= 0; i--) {
    const el = list[i];
    if (el.shape === "line") {
      const mid = [(el.a[0] + el.b[0]) / 2, (el.a[1] + el.b[1]) / 2];
      const nx = -(el.b[1] - el.a[1]), ny = el.b[0] - el.a[0];
      const len = Math.hypot(nx, ny) || 1;
      const del = [mid[0] + nx / len * 16 * sf(), mid[1] + ny / len * 16 * sf()];
      if (dist(p, del) < r) return { kind: "del", ref: el };
      if (dist(p, el.a) < r) return { kind: "pt-a", ref: el };
      if (dist(p, el.b) < r) return { kind: "pt-b", ref: el };
      if (segDist(p, el.a, el.b) < 8 * sf()) return { kind: "move", ref: el };
    } else {
      const x0 = Math.min(el.a[0], el.b[0]), y0 = Math.min(el.a[1], el.b[1]);
      const x1 = Math.max(el.a[0], el.b[0]), y1 = Math.max(el.a[1], el.b[1]);
      if (dist(p, [x1, y0]) < r) return { kind: "del", ref: el };
      if (dist(p, [x0, y0]) < r) return { kind: "pt-a", ref: el };
      if (dist(p, [x1, y1]) < r) return { kind: "pt-b", ref: el };
      if (p[0] >= x0 && p[0] <= x1 && p[1] >= y0 && p[1] <= y1)
        return { kind: "move", ref: el };
    }
  }
  return null;
}

/* ---------- 이동(팬): 뷰어 전체에서 동작 ---------- */
mapWrap.addEventListener("mousedown", (e) => {
  if (!MAPMETA) return;
  const isPanBtn = e.button === 1 || e.button === 2;
  const isFullLeft = e.button === 0 && TOOL === "full";
  if (!isPanBtn && !isFullLeft) return;
  e.preventDefault();
  PAN = { x: e.clientX, y: e.clientY, ox: PANX, oy: PANY };
  mapWrap.style.cursor = "grabbing";
}, { capture: true });

window.addEventListener("mousemove", (e) => {
  if (!PAN) return;
  PANX = PAN.ox + (e.clientX - PAN.x);
  PANY = PAN.oy + (e.clientY - PAN.y);
  clampPan(); applyPan();
}, { capture: true });

window.addEventListener("mouseup", () => {
  if (!PAN) return;
  PAN = null;
  mapWrap.style.cursor = (TOOL === "full") ? "grab" : "crosshair";
}, { capture: true });

/* ---------- 입력 ---------- */
mapCv.addEventListener("mousedown", (e) => {
  if (!MAPMETA || e.button !== 0) return;   // 우/휠클릭은 뷰어(mapWrap)에서 처리
  if (TOOL === "full") return;              // 전체 청소 탭: 좌클릭은 이동 전용
  const p = evtPos(e);

  if (TOOL === "room") {
    if (CLEANING_LOCK) { cleaningNotice(); return; }
    const rm = hitRoom(p[0], p[1]);
    if (rm?.room_id != null) {
      const i = SELECTED.indexOf(rm.room_id);
      if (i >= 0) SELECTED.splice(i, 1); else SELECTED.push(rm.room_id);
      renderRooms(); drawAll();
    }
    return;
  }
  if (TOOL === "zone") {
    if (CLEANING_LOCK) { cleaningNotice(); return; }
    if (ZONE_TASK) {
      toast("구역 청소 중 — 이동/수정/삭제할 수 없습니다");
      return;
    }
    const h = zoneHit(p);
    if (h) {
      if (h.kind === "del") { ZONES = ZONES.filter((z) => z !== h.ref); renderZoneInfo(); drawAll(); return; }
      DRAG = { hit: h, start: p, orig: { a: [h.ref.x0, h.ref.y0], b: [h.ref.x1, h.ref.y1] } };
      return;
    }
  }
  if (TOOL === "walls") {
    const h = hitElem(p);
    if (h) {
      if (h.kind === "del") { h.ref.deleted = true; renderElems(); drawAll(); return; }
      DRAG = { hit: h, start: p, orig: { a: [...h.ref.a], b: [...h.ref.b] } };
      return;
    }
  }

  SECOND = !!DRAFT;
  DOWN_AT = p;
  if (!DRAFT) {
    const ct = currentType();
    DRAFT = { a: p, b: null, type: +ct.v, shape: ct.shape || KINDS[KIND].shape };
  } else DRAFT.b = p;
  drawAll();
});

mapCv.addEventListener("mousemove", (e) => {
  if (!MAPMETA || PAN) return;
  const p = evtPos(e);
  if (DRAG) {
    const dx = p[0] - DRAG.start[0], dy = p[1] - DRAG.start[1];
    const el = DRAG.hit.ref, o = DRAG.orig;
    if (DRAG.hit.kind === "move") {
      if (TOOL === "zone") {
        el.x0 = o.a[0] + dx; el.y0 = o.a[1] + dy; el.x1 = o.b[0] + dx; el.y1 = o.b[1] + dy;
      } else {
        el.a = [o.a[0] + dx, o.a[1] + dy]; el.b = [o.b[0] + dx, o.b[1] + dy];
        if (!el.isNew) el.dirty = true;
      }
    } else if (DRAG.hit.kind === "pt-a") {
      if (TOOL === "zone") { el.x0 = Math.min(p[0], el.x1 - 12); el.y0 = Math.min(p[1], el.y1 - 12); }
      else { el.a = p; if (!el.isNew) el.dirty = true; }
    } else if (DRAG.hit.kind === "pt-b") {
      if (TOOL === "zone") { el.x1 = Math.max(p[0], el.x0 + 12); el.y1 = Math.max(p[1], el.y0 + 12); }
      else { el.b = p; if (!el.isNew) el.dirty = true; }
    }
    drawAll();
    return;
  }
  if (DRAFT) { DRAFT.b = p; drawAll(); }
});

mapCv.addEventListener("mouseup", (e) => {
  if (!MAPMETA || PAN) return;
  const p = evtPos(e);
  if (DRAG) {
    if (TOOL === "zone") renderZoneInfo(); else renderElems();
    DRAG = null;
    return;
  }
  if (!DRAFT) return;
  DRAFT.b = p;
  const moved = DOWN_AT ? dist(p, DOWN_AT) * sf() : 0;
  const second = SECOND;
  SECOND = false; DOWN_AT = null;
  if (moved >= 8 || second) finalizeShape();
  else drawAll();
});
mapCv.addEventListener("contextmenu", (e) => e.preventDefault());

function zoneHit(p) {
  const r = HIT * sf();
  for (let i = ZONES.length - 1; i >= 0; i--) {
    const z = ZONES[i];
    if (dist(p, [z.x1, z.y0]) < r) return { kind: "del", ref: z };
    if (dist(p, [z.x0, z.y0]) < r) return { kind: "pt-a", ref: z };
    if (dist(p, [z.x1, z.y1]) < r) return { kind: "pt-b", ref: z };
    if (p[0] >= z.x0 && p[0] <= z.x1 && p[1] >= z.y0 && p[1] <= z.y1)
      return { kind: "move", ref: z };
  }
  return null;
}

function finalizeShape() {
  if (!DRAFT?.b) { DRAFT = null; return; }
  const a = DRAFT.a, b = DRAFT.b;
  if (dist(a, b) * sf() < 10) { toast("너무 작습니다"); DRAFT = null; drawAll(); return; }
  if (TOOL === "zone") {
    if (CLEANING_LOCK) { DRAFT = null; cleaningNotice(); return; }
    if (ZONES.length >= 10) { toast("구역은 최대 10개"); DRAFT = null; drawAll(); return; }
    ZONES.push({ id: seq++, x0: Math.min(a[0], b[0]), y0: Math.min(a[1], b[1]),
                 x1: Math.max(a[0], b[0]), y1: Math.max(a[1], b[1]) });
    renderZoneInfo();
    hint(`구역 ${ZONES.length}/10 — 추가로 그리거나 청소 시작`);
  } else if (TOOL === "walls") {
    const meta = KINDS[KIND];
    const tv = DRAFT.type ?? +currentType().v;
    const tdef = (meta.types || []).find((x) => +x.v === tv) || currentType();
    ELEMS.push({ key: "n" + seq++, kind: KIND, id: null, type: tv,
                 shape: DRAFT.shape || tdef.shape || meta.shape,
                 a: [...a], b: [...b], pref: null,
                 isNew: true, dirty: false });
    renderElems();
    hint(`${tdef.l || meta.label} 추가됨 — 저장을 누르세요`);
  }
  DRAFT = null;
  PENDING = null; PREVIEW = null; DOWN_AT = null; SECOND = false;
  drawAll();
}

/* ---------- 목록/패널 ---------- */
function renderRooms() {
  const box = $("roomChips");
  box.innerHTML = "";
  ROOMS.forEach((rm) => {
    if (rm.room_id == null) return;
    const order = SELECTED.indexOf(rm.room_id);
    const b = document.createElement("button");
    b.className = "chip" + (order >= 0 ? " sel" : "") + (CLEANING_LOCK ? " disabled" : "");
    b.disabled = CLEANING_LOCK;
    b.textContent = order >= 0 ? `${order + 1}. ${rm.name}` : rm.name;
    b.onclick = () => {
      if (CLEANING_LOCK) { cleaningNotice(); return; }
      const i = SELECTED.indexOf(rm.room_id);
      if (i >= 0) SELECTED.splice(i, 1); else SELECTED.push(rm.room_id);
      renderRooms(); drawAll();
    };
    box.appendChild(b);
  });
    }

function renderZoneInfo() {
  const n = ZONES.length;
      const mPer = (MAPMETA?.scale || 4) * 20;
  }

/* 청소 중 구역 잠금 상태 동기화 (app.js refresh에서 호출) */
const ZONE_BUSY_RS = new Set([
  "WashMop", "HotDry", "WindDry", "ClctDust", "BackWashMop", "BackClctDust",
  "BPReturn", "BPPauseReturn", "BackWashPause", "BackClctPause",
]);
function syncZoneCleaning(cleaning, st, rstat) {
  const wasLocked = CLEANING_LOCK;
  CLEANING_LOCK = !!cleaning;
  if (wasLocked !== CLEANING_LOCK) {
    renderRooms(); drawAll();
    if (!CLEANING_LOCK) {
      DRAFT = null; DRAG = null;
      hint("청소 종료 — 방/구역 변경이 가능합니다");
    }
  }
  if (!ZONE_TASK) return;
  const paused = st === 6;
  const station = st === 18 || ZONE_BUSY_RS.has(rstat);
  const moving = [10, 12, 17, 19, 20, 21, 23].includes(st);
  if (cleaning || paused || station || moving) {
    ZONE_SAW_CLEAN = true;
    return;
  }
  // 시작 요청이 실제 청소로 이어지지 않은 경우를 대비한 안전 해제
  if (!ZONE_SAW_CLEAN && Date.now() - ZONE_STARTED_AT < 60000) return;
  ZONE_TASK = false;
  DRAFT = null; DRAG = null;
  drawAll();
  hint("구역 청소 종료 — 이제 구역을 수정할 수 있습니다");
}

function kindMeta(kind) {
  return KINDS[kind];
}
function renderKindChips() {
  document.querySelectorAll("#kindChips .chip").forEach((b) => {
    b.classList.toggle("sel", b.dataset.kind === KIND);
  });
  const meta = KINDS[KIND];
  const sel = $("elemType");
  sel.innerHTML = "";
  (meta.types || []).forEach((t) => {
    const o = document.createElement("option");
    o.value = t.v; o.textContent = t.l; sel.appendChild(o);
  });
  $("typeBlock").style.display = (meta.types || []).length > 1 ? "" : "none";
}
document.querySelectorAll("#kindChips .chip").forEach((b) => {
  b.onclick = () => {
    KIND = b.dataset.kind;
    renderKindChips(); renderElems(); drawAll();
    $("wallsHint").textContent =
      KIND === "thres" ? "문턱: 클릭-클릭/드래그 · 끝점=조절 · X=삭제"
      : "영역: 클릭-클릭/드래그로 추가 · 드래그=이동 · 흰 점=조절 · X=삭제";
  };
});

const TYPE_KO = {
  thres: { 1: "미닫이", 2: "문지방" },
  virtual: { 1: "가상벽", 2: "금지구역" },
  mop: { 2: "물걸레 금지" },
  carpet: { 1: "카펫" },
};
function typeText(kind, t) {
  return (TYPE_KO[kind] || {})[t] || "–";
}
function elemTitle(e) {
  if (e.kind === "virtual" || e.kind === "thres") return typeText(e.kind, e.type);
  return KINDS[e.kind].label;
}

function globalCarpetPref() {
  const s = window.__S || {};
  const prefer = Number.isInteger(+s.carpet_prefer) ? +s.carpet_prefer : 0;
  return {
    prefer,
    boost: prefer === 0 && !!s.carpet_boost,
    twice: prefer === 0 && !!s.carpet_twice,
    first: prefer === 0 && !!s.carpet_first,
  };
}

function normCarpetPref(p) {
  if (!p?.custom) return null;
  const prefer = Number(p.prefer) || 0;
  return {
    custom: true,
    prefer,
    boost: prefer === 0 && !!p.boost,
    twice: prefer === 0 && !!p.twice,
    first: prefer === 0 && !!p.first,
  };
}
function prefKey(p) { return JSON.stringify(normCarpetPref(p)); }
function originalCarpetPref(e) {
  return ORIGINAL.find((x) => x.key === e.key)?.pref || null;
}
function isPrefDirty(e) {
  return e.kind === "carpet" && !e.deleted &&
    prefKey(e.pref) !== prefKey(originalCarpetPref(e));
}

function carpetPanel(e) {
  const p = e.pref?.custom
    ? e.pref
    : { custom: false, prefer: 0, boost: false, twice: false, first: false };
  const adaptive = p.prefer === 0;
  const opts = [
    ["boost", "카펫 부스트", p.boost],
    ["twice", "카펫 2회 청소", p.twice],
    ["first", "카펫 먼저 청소", p.first],
  ];
  return `<div class="carpet-panel">
    <label class="switch"><input type="checkbox" data-carpet-custom="${e.key}" ${p.custom ? "checked" : ""}><span>개별 전략 사용</span></label>
    ${p.custom ? `
      <div class="seg carpet-strat">
        ${CARPET_STRAT.map((name, i) =>
          `<button type="button" data-carpet-strat="${i}" class="${p.prefer === i ? "active" : ""}">${name}</button>`
        ).join("")}
      </div>
      ${adaptive ? opts.map(([key, name, val]) =>
        `<label class="switch"><input type="checkbox" data-carpet-opt="${key}" ${val ? "checked" : ""}><span>${name}</span></label>`
      ).join("") : ""}
    ` : `<p class="hint">전역 전략을 따릅니다.</p>`}
  </div>`;
}

function carpetElement(e) {
  const A = pxToScene(e.a[0], e.a[1]), B = pxToScene(e.b[0], e.b[1]);
  const tag = e.isNew ? "추가" : (e.dirty || isPrefDirty(e) ? "변경" : "저장됨");
  const num = e.isNew ? "새" : `#${e.id}`;
  const open = CARPET_EXPANDED.has(e.key);
  const strat = e.pref?.custom ? `(${CARPET_STRAT[e.pref.prefer] || "?"})` : "";
  return `<div class="carpet-block">
    <div class="item carpet-item ${open ? "carpet-open" : ""}" data-carpet-key="${e.key}">
      <span>${open ? "▾" : "▸"} ${num} ${elemTitle(e)} · ${tag}</span>
      <span class="carpet-side">
        ${strat ? `<b class="carpet-badge">${strat}</b>` : ""}
        <span class="mono">(${A})→(${B})</span>
      </span>
    </div>
    ${open ? carpetPanel(e) : ""}
  </div>`;
}

function updateCarpetDraft(el, custom, overrides = {}) {
  if (!el) return;
  const base = el.pref?.custom ? { ...el.pref } : globalCarpetPref();
  el.pref = normCarpetPref({ ...base, ...overrides, custom });
  renderElems(); drawAll();
}

function bindCarpetList() {
  const box = $("elemList");
  const find = (key) => ELEMS.find((e) => e.key === key && e.kind === "carpet");
  box.querySelectorAll(".carpet-item").forEach((row) => {
    row.onclick = () => {
      const key = row.dataset.carpetKey;
      if (CARPET_EXPANDED.has(key)) CARPET_EXPANDED.delete(key);
      else CARPET_EXPANDED.add(key);
      renderElems();
    };
  });
  box.querySelectorAll("[data-carpet-custom]").forEach((cb) => {
    cb.onchange = () => {
      const e = find(cb.dataset.carpetCustom);
      if (e) updateCarpetDraft(e, cb.checked, cb.checked ? globalCarpetPref() : {});
    };
  });
  box.querySelectorAll("[data-carpet-strat]").forEach((b) => {
    b.onclick = () => {
      const row = b.closest(".carpet-block")?.querySelector(".carpet-item");
      const e = row ? find(row.dataset.carpetKey) : null;
      if (e?.pref?.custom) updateCarpetDraft(e, true, { prefer: +b.dataset.carpetStrat });
    };
  });
  box.querySelectorAll("[data-carpet-opt]").forEach((cb) => {
    cb.onchange = () => {
      const row = cb.closest(".carpet-block")?.querySelector(".carpet-item");
      const e = row ? find(row.dataset.carpetKey) : null;
      if (e?.pref?.custom) updateCarpetDraft(e, true, { [cb.dataset.carpetOpt]: cb.checked });
    };
  });
}

function renderElems() {
  const list = elemOfKind();
  const adds = list.filter((e) => e.isNew).length;
  const mods = list.filter((e) => e.dirty && !e.isNew).length;
  const dels = ELEMS.filter((e) => e.deleted && !e.isNew).length;
  const prefMods = list.filter((e) => !e.isNew && isPrefDirty(e)).length;
  const total = adds + mods + dels + prefMods;
  $("wallsSaveBtn").disabled = total === 0;
  $("wallsSaveBtn").textContent = total
    ? `저장 (${[adds ? `추가 ${adds}` : "", mods ? `변경 ${mods}` : "",
                    prefMods ? `전략 ${prefMods}` : "",
                    dels ? `삭제 ${dels}` : ""].filter(Boolean).join(", ")})`
    : "변경 없음";
  $("elemList").innerHTML = list.length
    ? list.map((e) => {
        if (e.kind === "carpet") return carpetElement(e);
        const A = pxToScene(e.a[0], e.a[1]), B = pxToScene(e.b[0], e.b[1]);
        const tag = e.isNew ? "추가" : (e.dirty ? "변경" : "저장됨");
        const num = e.isNew ? "새" : `#${e.id}`;
        return `<div class="item"><span>${num} ${elemTitle(e)} · ${tag}</span>
          <span class="mono">(${A})→(${B})</span></div>`;
      }).join("")
    : '<span class="hint">등록된 항목 없음</span>';
  bindCarpetList();
}

/* ---------- 재생 버튼용 (탭 맥락) ---------- */
async function startSelectedRooms() {
  if (window.__CLEANING || CLEANING_LOCK) { cleaningNotice(); return; }
  if (!SELECTED.length) { toast("방을 먼저 선택하세요"); return; }
  try {
    await post("/api/clean/room", { room_ids: SELECTED });
    CLEANING_LOCK = true;
    toast(`${SELECTED.length}개 방 순서대로 청소 시작`);
    refresh();
  } catch (e) { toast("실패: " + e.message); }
}
async function startZones() {
  if (window.__CLEANING || CLEANING_LOCK) { cleaningNotice(); return; }
  if (!ZONES.length) { toast("구역을 먼저 그리세요"); return; }
  try {
    const rects = ZONES.map((z) => {
      const A = pxToScene(z.x0, z.y0), B = pxToScene(z.x1, z.y1);
      return [A[0], A[1], B[0], B[1]];
    });
    await post("/api/clean/zone", { rects });
    // 청소가 끝날 때까지 구역을 지도에 유지하고 편집을 잠근다
    ZONE_TASK = true;
    CLEANING_LOCK = true;
    ZONE_SAW_CLEAN = false;
    ZONE_STARTED_AT = Date.now();
    DRAFT = null; DRAG = null;
    renderZoneInfo(); renderRooms(); drawAll();
    toast(`${rects.length}개 구역 청소 시작 — 청소 중에는 수정할 수 없습니다`);
    refresh();
  } catch (e) { toast("실패: " + e.message); }
}

/* ---------- 카펫 개별 전략 저장 보조 ---------- */
function sceneBBoxOf(e) {
  const A = pxToScene(e.a[0], e.a[1]), B = pxToScene(e.b[0], e.b[1]);
  return [Math.min(A[0], B[0]), Math.min(A[1], B[1]),
          Math.max(A[0], B[0]), Math.max(A[1], B[1])];
}
function wallBBoxScene(w) {
  const pts = w.points || [];
  if (!pts.length) return null;
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}
function matchNewCarpet(e, walls, used) {
  const b = sceneBBoxOf(e);
  return walls.find((w) => {
    if (used.has(+w.id) || +w.type !== +e.type) return false;
    const wb = wallBBoxScene(w);
    return wb && Math.abs(wb[0] - b[0]) <= 4 && Math.abs(wb[1] - b[1]) <= 4 &&
      Math.abs(wb[2] - b[2]) <= 4 && Math.abs(wb[3] - b[3]) <= 4;
  });
}
function carpetPrefItem(e, id) {
  const p = normCarpetPref(e.pref);
  return p ? { id, custom: true, prefer: p.prefer, boost: p.boost,
               twice: p.twice, first: p.first }
           : { id, custom: false, prefer: 0, boost: false, twice: false, first: false };
}

/* ---------- 버튼 ---------- */

$("wallsSaveBtn").onclick = async () => {
  const groups = {};
  ELEMS.forEach((e) => {
    const g = groups[e.kind] || (groups[e.kind] = { adds: [], updates: [], deletes: [] });
    const pts = [pxToScene(e.a[0], e.a[1]), pxToScene(e.b[0], e.b[1])];
    const flat = [pts[0][0], pts[0][1], pts[1][0], pts[1][1]];
    if (e.deleted && !e.isNew) g.deletes.push(e.id);
    else if (e.isNew && !e.deleted) g.adds.push({ type: e.type, pts: flat });
    else if (e.dirty && !e.deleted) g.updates.push({ id: e.id, type: e.type, pts: flat });
  });
  const jobs = Object.entries(groups).filter(([, g]) =>
    g.adds.length || g.updates.length || g.deletes.length);
  const prefChanges = ELEMS.filter((e) =>
    e.kind === "carpet" && !e.deleted && isPrefDirty(e));
  if (!jobs.length && !prefChanges.length) return;
  const beforeIds = new Set(ELEMS
    .filter((e) => e.kind === "carpet" && !e.isNew && e.id != null)
    .map((e) => +e.id));
  $("wallsSaveBtn").disabled = true;
  toast("저장 중… (형상 + 카펫 전략, 클라우드 경유, 최대 1분)", 60000);
  try {
    const prefItems = [];
    for (const [kind, g] of jobs) {
      const r = await post("/api/walls/save", { kind, ...g });
      if (kind !== "carpet") continue;
      const newWalls = (r.walls || []).filter((w) => !beforeIds.has(+w.id));
      const used = new Set();
      prefChanges.filter((e) => e.isNew).forEach((e) => {
        const w = matchNewCarpet(e, newWalls, used);
        if (!w) throw new Error(`새 카펫 ID 매칭 실패 (${e.key})`);
        used.add(+w.id);
        prefItems.push(carpetPrefItem(e, +w.id));
      });
    }
    prefChanges.filter((e) => !e.isNew).forEach((e) => {
      prefItems.push(carpetPrefItem(e, e.id));
    });
    if (prefItems.length) {
      const r = await post("/api/carpet/prefer/batch", { items: prefItems });
      if (!r.ok) throw new Error((r.errors || []).join("; ") || "카펫 전략 저장 실패");
    }
    toast("저장 완료");
    await loadMap(true);
  } catch (e) {
    toast("실패: " + e.message, 8000);
    await loadMap(true);
  }
};
$("wallsCancelBtn").onclick = () => {
  ELEMS = clone(ORIGINAL);
  DRAFT = null; DRAG = null;
  renderElems(); drawAll();
  toast("편집 취소 — 형상과 카펫 전략을 모두 되돌렸습니다");
};

/* ---------- 탭 ---------- */
document.querySelectorAll("#toolTabs .tab").forEach((t) => {
  t.onclick = () => {
    TOOL = t.dataset.tool;
    const locked = !!window.__CLEANING || CLEANING_LOCK;
    if (locked && (TOOL === "room" || TOOL === "zone")) cleaningNotice();
    document.querySelectorAll("#toolTabs .tab").forEach((x) => x.classList.toggle("active", x === t));
    $("cleanPane").classList.toggle("hidden", TOOL === "walls");
    $("wallsPane").classList.toggle("hidden", TOOL !== "walls");
    $("roomBlock").classList.toggle("hidden", TOOL !== "room");
    DRAFT = null; DRAG = null;
    mapCv.style.cursor = (TOOL === "full") ? "grab" : "crosshair";
    hint(TOOL === "full" ? "전체 청소 — ▶ 로 시작 · 좌드래그/우클릭으로 지도 이동"
      : TOOL === "room" ? (locked
          ? "청소 중 — 방 선택이 잠겼습니다. 변경하려면 작업을 종료하세요"
          : "방을 클릭해 선택 (클릭 순서 = 청소 순서) · ▶ = 선택 방 청소")
      : TOOL === "zone" ? (locked
          ? "청소 중 — 구역 생성·수정이 잠겼습니다. 변경하려면 작업을 종료하세요"
          : (ZONE_TASK
            ? "구역 청소 중 — 구역은 이동/수정/삭제할 수 없습니다"
            : "지도에 구역을 그리세요 · ▶ = 그린 구역 청소 (최대 10개)"))
      : "요소를 골라 추가/이동/조절/삭제 후 저장하세요");
    drawAll();
    requestAnimationFrame(() => layoutMap && layoutMap());
  };
});

const HELP = {
  thres: {
    title: "문턱 종류: 미닫이 문턱 / 문지방",
    html: `
      <dt>미닫이 문턱</dt>
      <dd>미닫이·슬라이딩 도어의 <b>레일</b>처럼 얇고 낮은 턱입니다.</dd>
      <dt>문지방</dt>
      <dd>문 아래를 가로지르는 <b>돌·목재 문지방</b>입니다.</dd>
      <dt>선택 기준</dt>
      <dd>문 바닥에 <b>레일</b>이 있으면 미닫이 문턱, <b>돌·목재로 된 턱</b>이 있으면 문지방을 선택하세요.</dd>
      <dt>그리는 법</dt>
      <dd>문틈(벽이 끊긴 곳)을 <b>가로지르게</b> 긋습니다. 허공에 그리면 인식되지 않을 수 있습니다.</dd>`,
  },
  virtual: {
    title: "가상벽 / 금지구역",
    html: `
      <dt>가상벽 (선)</dt>
      <dd>로봇이 <b>넘지 못하는 선</b>. 문 앞이나 복도 입구를 막을 때 사용합니다.</dd>
      <dt>금지구역 (사각형)</dt>
      <dd>로봇이 <b>들어가지 않는 영역</b>. 전선·화분·매트처럼 넓은 구역을 통째로 뺄 때 사용합니다.</dd>`,
  },
};
$("typeHelp").onclick = () => {
  const h = HELP[KIND];
  if (!h) return;
  $("helpTitle").textContent = h.title;
  $("helpBody").innerHTML = h.html;
  $("helpDlg").showModal();
};

/* ---------- 지도 로드 ---------- */
function buildElems() {
  const out = [];
  let n = 1;
  KIND_ORDER.forEach((key) => {
    const kind = KEY_TO_KIND[key];
    (WALLS?.[key] || []).forEach((e) => {
      const pts = e.pts || [];
      if (pts.length < 2) return;
      if (kind === "thres") {
        out.push({ key: key + ":" + e.id, kind, id: e.id, type: e.type,
                   shape: "line",
                   a: [pts[0][0], pts[0][1]], b: [pts[1][0], pts[1][1]],
                   isNew: false, dirty: false, deleted: false });
        n++;
        return;
      }
      const isLine = pts.length === 2;
      const a = [pts[0][0], pts[0][1]];
      const b = isLine ? [pts[1][0], pts[1][1]]
        : [pts.reduce((m, p) => Math.max(m, p[0]), -1e9),
           pts.reduce((m, p) => Math.max(m, p[1]), -1e9)];
      const a2 = isLine ? a : [pts.reduce((m, p) => Math.min(m, p[0]), 1e9),
                               pts.reduce((m, p) => Math.min(m, p[1]), 1e9)];
      const pref = (kind === "carpet" && e.prefer) ? {
        custom: true,
        prefer: Number(e.prefer.prefer) || 0,
        boost: !!Number(e.prefer.boost),
        twice: !!Number(e.prefer.twice),
        first: !!Number(e.prefer.first),
      } : null;
      out.push({ key: key + ":" + e.id, kind, id: e.id, type: e.type,
                 shape: isLine ? "line" : "rect",
                 a: isLine ? a : a2, b: isLine ? b : [
                   pts.reduce((m, p) => Math.max(m, p[0]), -1e9),
                   pts.reduce((m, p) => Math.max(m, p[1]), -1e9)],
                 pref,
                 isNew: false, dirty: false, deleted: false });
      n++;
    });
  });
  seq = Math.max(seq, n);
  return out;
}

async function loadMap(refresh) {
  const ph = $("mapPlaceholder"), pt = $("mapPlaceholderText");
  if (!refresh) {
    $("mapWrap").classList.remove("loaded");
    ph.classList.remove("error");
    pt.textContent = "지도 불러오는 중…";
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      if (attempt) pt.textContent = `지도 불러오는 중… (재시도 ${attempt}/2)`;
      const d = await api("/api/map/data" + (refresh ? "?refresh=1" : ""));
      MAPMETA = d.meta; WALLS = d.walls_px; ROOMS = d.rooms || [];
      DOCK = d.charge || null;
      ROOMS.forEach((rm) => { const c = roomCentroid(rm); if (c) { rm.lx = c[0]; rm.ly = c[1]; } });
      mapImg.src = "/api/map/image?t=" + Date.now() + (refresh ? "&refresh=1" : "");
      await new Promise((res) => { mapImg.onload = res; mapImg.onerror = res; });
      if (!mapImg.naturalWidth) throw new Error("이미지 로드 실패");
      mapCv.width = mapImg.naturalWidth; mapCv.height = mapImg.naturalHeight;
      $("mapWrap").classList.add("loaded");
            DRAFT = null; DRAG = null;
      ELEMS = buildElems();
      ORIGINAL = clone(ELEMS);
      CLEANING_LOCK = !!window.__CLEANING;
      syncCleanTargets(window.__S || {});
      renderRooms(); renderZoneInfo(); renderKindChips(); renderElems();
      applyZoom(ZOOM);
      refreshLive();
      $("mapWrap").classList.add("loaded");
      ph.classList.remove("error");
      hint("준비됨 — 상단 탭에서 작업을 선택하세요");
      return;
    } catch (e) {
      if (attempt === 2) {
        ph.classList.remove("loaded");
        ph.classList.add("error");
        pt.textContent = "지도 불러오기 실패 — 클릭하여 다시 시도";
        ph.onclick = () => { ph.onclick = null; loadMap(!refresh); };
        $("mapWrap").classList.remove("loaded");
        return;
      }
      pt.textContent = `지도 불러오는 중… (재시도 ${attempt + 1}/2)`;
      await sleep(2000);
    }
  }
}

async function refreshLive() {
  try {
    const d = await api("/api/map/live");
    LIVE = { pos: d.pos || null, trace: d.trace || [] };
    drawAll();
  } catch (e) { /* 무시 */ }
}
/* 위치 갱신: 이동/복귀/스테이션 작업 중에는 5초, 그 외에는 상태 변화 시 1회 */
const LIVE_ACTIVE = new Set([2, 4, 5, 7, 9, 10, 11, 12, 17, 18, 20, 21, 23]);
let LAST_STATUS = null;
setInterval(() => {
  const st = window.__STATUS;
  if (st === LAST_STATUS && !LIVE_ACTIVE.has(st)) return;
  LAST_STATUS = st;
  refreshLive();
}, 5000);

window.addEventListener("resize", drawAll);
window.addEventListener("keydown", (e) => {
  if (e.key === "Escape") { DRAFT = null; DRAG = null; drawAll(); hint("취소됨"); }
});
/* 초기 탭 상태 반영 */
(function initToolState() {
  $("cleanPane").classList.remove("hidden");
  $("wallsPane").classList.add("hidden");
  $("roomBlock").classList.add("hidden");
})();
