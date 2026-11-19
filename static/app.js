const $ = (id) => document.getElementById(id);
const api = async (p, o = {}) => {
  o.headers = { ...(o.headers || {}), "X-Requested-With": "XMLHttpRequest" };
  const r = await fetch(p, o);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || ("HTTP " + r.status));
  return j;
};
const post = (p, body) => api(p, {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body || {}),
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let toastTimer = null;
function toast(msg, ms = 3200) {
  const t = $("toast");
  t.textContent = msg; t.classList.add("on");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("on"), ms);
}

const STATUS_KO = {
  1: "대기", 2: "바쁨", 3: "지연", 4: "물걸레 중", 5: "흡입+물걸레 중", 6: "일시정지",
  7: "청소 중", 8: "에러", 9: "충전 중", 10: "복귀 중", 11: "충전 중단", 12: "세척 복귀",
  13: "충전 완료", 14: "지도 생성", 15: "업데이트", 16: "절전", 17: "위치 확인",
  18: "스테이션 동작", 19: "매핑 일시정지", 20: "충전 복귀", 21: "세척 복귀",
  22: "기기 연결", 23: "먼지 비움 복귀",
};
const MODE_KO = { 0: "흡입+물걸레 중", 1: "흡입 중", 2: "물걸레 중", 3: "흡입 후 물걸레 중" };
const RSTATUS_KO = {
  Asleep: "휴면 중", Relocate: "위치 확인 중", WashMop: "걸레 세척 중",
  ClctDust: "먼지통 비우는 중", HotDry: "걸레패드 열풍건조 중",
  WindDry: "걸레패드 송풍건조 중", BackWashMop: "걸레 세척하러 복귀",
  BackClctDust: "먼지통 비우러 복귀", BackWashPause: "복귀 중지",
  BackClctPause: "복귀 중지", BPPauseReturn: "복귀 중지", BPReturn: "스테이션으로 복귀",
  Charging: "충전 중", ChargeAsleep: "충전 완료",
};
const STATION_STATES = new Set(["WashMop", "HotDry", "WindDry", "ClctDust",
  "BackWashMop", "BackClctDust", "BPReturn", "BPPauseReturn", "BackWashPause", "BackClctPause"]);
const CLEAN_STATES = [2, 4, 5, 7];

function statusText(st, mode, rstat) {
  if (rstat && STATION_STATES.has(rstat)) return RSTATUS_KO[rstat] || "스테이션 동작";
  if (CLEAN_STATES.includes(st)) return MODE_KO[mode] || "청소 중";
  if (rstat && RSTATUS_KO[rstat]) return RSTATUS_KO[rstat];
  return STATUS_KO[st] || "–";
}
function syncSeg(id, val) {
  if (val == null) return;
  document.querySelectorAll(`#${id} button`).forEach((b) => {
    b.classList.toggle("active", +b.dataset.v === +val);
  });
}
/* 모드에 따른 흡입력/물걸레 습도 비활성 (즉시 반영용) */
function setModeAvailability(mode) {
  const mopOnly = +mode === 2, sweepOnly = +mode === 1;
  $("fanSeg").classList.toggle("dimmed", mopOnly);
  $("waterSeg").classList.toggle("dimmed", sweepOnly);
  $("fanDim").textContent = mopOnly ? "물걸레만 모드에서는 사용 안함" : "";
  $("waterDim").textContent = sweepOnly ? "흡입만 모드에서는 사용 안함" : "";
}
/* 카펫 부스트/2회/먼저는 전역 적응 모드에서만 표시 */
function setCarpetOptionsVisibility(mode) {
  const on = +mode === 0;
  ["boostWrap", "twiceWrap", "firstWrap"].forEach((id) => {
    const el = $(id);
    if (el) el.classList.toggle("hidden", !on);
  });
}

async function refresh() {
  let s;
  for (let i = 0; i < 3; i++) {
    try { s = await api("/api/status"); break; }
    catch (e) { if (i === 2) { $("mainSub").textContent = "연결 실패"; return; } await sleep(1200); }
  }
  window.__S = s;
  const st = s.status_code;
  const cleaning = CLEAN_STATES.includes(st);
  const docked = [9, 11, 13, 18].includes(st) || STATION_STATES.has(s.robot_status);

  $("statArea").textContent = s.clean_area_m2 ?? 0;
  $("statTime").textContent = s.clean_time_min ?? 0;
  $("statBattery").textContent = s.battery ?? "–";
  const txt = statusText(st, s.mode, s.robot_status);
  $("stateBadge").textContent = txt;
  $("mainSub").textContent = txt + " · " + (s.device_info?.fw || "");

  $("startBtn").textContent = cleaning ? "❚❚ 일시정지" : "▶ 청소 시작";
  $("stopBtn").disabled = !cleaning;
  $("dockBtn").disabled = docked;

  syncSeg("modeSeg", s.mode);
  syncSeg("fanSeg", s.fan);
  syncSeg("waterSeg", s.water);
  syncSeg("countSeg", s.count);
  syncSeg("routeSeg", s.route);
  syncSeg("carpetSeg", s.carpet_prefer);
  setCarpetOptionsVisibility(s.carpet_prefer);

  // 모드에 따른 비활성화
  setModeAvailability(s.mode);

  if (s.drying != null) $("optDrying").checked = !!s.drying;
  if (s.carpet_boost != null) $("optCarpetBoost").checked = !!s.carpet_boost;
  if (s.carpet_twice != null) $("optCarpetTwice").checked = !!s.carpet_twice;
  if (s.carpet_first != null) $("optCarpetFirst").checked = !!s.carpet_first;
  if (s.child_lock != null) $("optChildLock").checked = !!s.child_lock;
  if (s.mop_augment != null) $("optMopAugment").checked = !!s.mop_augment;
  if (s.break_clean != null) $("optBreakClean").checked = !!s.break_clean;
  if (s.disturb != null) { $("optDisturb").checked = !!s.disturb; $("disturbBox").classList.toggle("hidden", !s.disturb); }
  if (s.drying_time != null) syncSeg("dryTimeSeg", s.drying_time);
  if (s.mop_wash_freq != null) syncSeg("mopFreqSeg", s.mop_wash_freq);
  if (s.dust_collection != null) syncSeg("dustSeg", s.dust_collection);
  if (s.volume != null) { $("volRange").value = s.volume; $("volVal").textContent = s.volume; }
  if (s.language != null) $("langSel").value = String(s.volume != null ? s.language : s.language);
  if (s.disturb_time) {
    try {
      const d = typeof s.disturb_time === "string" ? JSON.parse(s.disturb_time) : s.disturb_time;
      $("dndStart").value = `${String(d.startHour).padStart(2, "0")}:${String(d.startMin).padStart(2, "0")}`;
      $("dndEnd").value = `${String(d.endHour).padStart(2, "0")}:${String(d.endMin).padStart(2, "0")}`;
      $("dndNoDust").checked = !!d.notDust;
      $("dndNoDry").checked = !!d.notDry;
    } catch (e) { /* ignore */ }
  }
  window.__CLEANING = cleaning;
  window.__STATUS = st;
  if (typeof window.syncZoneCleaning === "function") {
    window.syncZoneCleaning(cleaning, st, s.robot_status);
  }
  if (typeof window.syncCleanTargets === "function") {
    window.syncCleanTargets(s);
  }
}

/* ---------- 동작 ---------- */
async function act(name, extra) {
  try {
    const r = await post("/api/action", { name, ...(extra || {}) });
    toast(r.transport === "local" ? "전송됨" : "클라우드로 전송됨");
    await sleep(600);
    refresh();
    return r;
  } catch (e) { toast("실패: " + e.message); throw e; }
}
$("startBtn").onclick = async () => {
  const s = window.__S || {};
  const cleaning = CLEAN_STATES.includes(s.status_code);
  if (cleaning) return act("pause");
  const t = (typeof TOOL !== "undefined") ? TOOL : "full";
  if (t === "walls") { toast("금지 구역 설정 중입니다 — 청소 탭에서 시작하세요"); return; }
  if (t === "room") return startSelectedRooms();
  if (t === "zone") return startZones();
  return act("start");
};
$("stopBtn").onclick = () => act("stop");
$("dockBtn").onclick = () => act("dock");
$("collectBtn").onclick = () => act("collect");
$("washBtn").onclick = () => act("wash");
$("dryBtn").onclick = () => act("dry");
$("locateBtn").onclick = () => act("locate");

[["modeSeg", "mode"], ["fanSeg", "fan"], ["waterSeg", "water"],
 ["countSeg", "count"], ["routeSeg", "route"], ["carpetSeg", "carpet_prefer"]].forEach(([seg, key]) => {
  document.querySelectorAll(`#${seg} button`).forEach((b) => {
    b.onclick = async () => {
      syncSeg(seg, +b.dataset.v);
      if (seg === "modeSeg") setModeAvailability(+b.dataset.v);   // 즉시 반영
      if (seg === "carpetSeg") setCarpetOptionsVisibility(+b.dataset.v);
      const slow = setTimeout(() => toast("클라우드 경유로 적용 중…", 4000), 1200);
      try { await post("/api/set", { key, value: +b.dataset.v }); toast("적용됨"); }
      catch (e) { toast("실패: " + e.message); refresh(); }
      finally { clearTimeout(slow); }
    };
  });
});

[["optDrying", "drying"], ["optCarpetBoost", "carpet_boost"], ["optChildLock", "child_lock"],
 ["optCarpetTwice", "carpet_twice"], ["optCarpetFirst", "carpet_first"],
 ["optMopAugment", "mop_augment"], ["optBreakClean", "break_clean"]].forEach(([id, key]) => {
  $(id).onchange = async (e) => {
    try { await post("/api/set", { key, value: e.target.checked }); toast("저장됨"); refresh(); }
    catch (err) { toast("실패: " + err.message); e.target.checked = !e.target.checked; }
  };
});
$("optDisturb").onchange = async (e) => {
  $("disturbBox").classList.toggle("hidden", !e.target.checked);
  try { await post("/api/set", { key: "disturb", value: e.target.checked }); }
  catch (err) { toast("실패: " + err.message); }
};
$("dndSave").onclick = async () => {
  const [sh, sm] = $("dndStart").value.split(":").map(Number);
  const [eh, em] = $("dndEnd").value.split(":").map(Number);
  try {
    await post("/api/set", { key: "disturb_time", value: {
      startHour: sh, startMin: sm, endHour: eh, endMin: em,
      notDust: $("dndNoDust").checked ? 1 : 0, notDry: $("dndNoDry").checked ? 1 : 0 } });
    toast("청소금지 시간 저장됨");
  } catch (e) { toast("실패: " + e.message); }
};
$("volRange").oninput = (e) => { $("volVal").textContent = e.target.value; };
$("volRange").onchange = async (e) => {
  try { await post("/api/set", { key: "volume", value: +e.target.value }); toast("음량 저장됨"); }
  catch (err) { toast("실패: " + err.message); }
};
$("langSel").onchange = async (e) => {
  try { await post("/api/set", { key: "language", value: +e.target.value }); toast("언어 변경 요청됨"); }
  catch (err) { toast("실패: " + err.message + " (미지원일 수 있음)"); }
};
[["mopFreqSeg", "mop_freq"], ["dryTimeSeg", "drying_time"], ["dustSeg", "dust_collection"]].forEach(([seg, key]) => {
  document.querySelectorAll(`#${seg} button`).forEach((b) => {
    b.onclick = async () => {
      syncSeg(seg, +b.dataset.v);
      try { await post("/api/set", { key, value: +b.dataset.v }); toast("적용됨"); }
      catch (e) { toast("실패: " + e.message); refresh(); }
    };
  });
});

/* ---------- 지도 목록 ---------- */
async function loadMaps() {
  for (let i = 0; i < 3; i++) {
    try {
      const d = await api("/api/maps/list");
      const sel = $("mapSel");
      sel.innerHTML = "";
      (d.maps || []).forEach((m) => {
        const o = document.createElement("option");
        o.value = m.mapId;
        o.textContent = `${m.name || ("지도 " + m.mapId)}${m.status === 1 ? " (사용 중)" : ""}`;
        if (m.status === 1) o.selected = true;
        sel.appendChild(o);
      });
      return;
    } catch (e) {
      if (i === 2) toast("지도 목록 실패: " + e.message);
      else await sleep(1500);
    }
  }
}
$("mapSwitchBtn").onclick = async () => {
  const mid = +$("mapSel").value;
  if (!Number.isFinite(mid)) return;
  toast("지도 전환 중…", 30000);
  try {
    const r = await post("/api/maps/switch", { mapId: mid });
    SELECTED = [];
    await loadMap(true); await loadMaps();
    toast(`지도 ${r.map_id} 로 전환`);
  } catch (e) { toast("전환 실패: " + e.message, 6000); }
};

/* ---------- 설정 ---------- */
async function loadCfg() {
  try {
    const c = await api("/api/config");
    if (c.ip) $("cfgIp").value = c.ip;
    if (c.did) $("cfgDid").value = c.did;
    // 전체 토큰은 서버에서 보내지 않는다. 변경할 때만 새로 입력한다.
    const tokenEl = $("cfgToken");
    tokenEl.value = "";
    tokenEl.placeholder = c.has_token
      ? "저장됨 — 변경 시 새 토큰 입력"
      : "32자리 hex";
    $("cfgForceCloud").checked = !!c.force_cloud;
  } catch (e) { /* ignore */ }
}
/* 토큰 보기/숨기기 */
function hideToken() {
  $("cfgToken").type = "password";
  $("cfgTokenEye").textContent = "보기";
  $("cfgTokenEye").title = "토큰 보기";
  $("cfgTokenEye").setAttribute("aria-pressed", "false");
}
$("cfgTokenEye").onclick = () => {
  const show = $("cfgToken").type === "password";
  $("cfgToken").type = show ? "text" : "password";
  $("cfgTokenEye").textContent = show ? "숨기기" : "보기";
  $("cfgTokenEye").title = show ? "토큰 숨기기" : "토큰 보기";
  $("cfgTokenEye").setAttribute("aria-pressed", String(show));
};
$("cfgSave").onclick = async (e) => {
  e.preventDefault();
  $("cfgMsg").textContent = "확인 중…";
  try {
    const r = await post("/api/config", {
      ip: $("cfgIp").value, token: $("cfgToken").value,
      did: $("cfgDid").value, force_cloud: $("cfgForceCloud").checked });
    $("cfgMsg").textContent = "연결 OK · " + (r.info?.model || "");
    $("cfgToken").value = "";
    hideToken();
    loadCfg(); refresh();
  } catch (err) { $("cfgMsg").textContent = "실패: " + err.message; }
};
$("cfgForceCloud").onchange = async (e) => {
  try { await post("/api/config", { force_cloud: e.target.checked });
    toast(e.target.checked ? "모든 명령 클라우드" : "자동 선택"); }
  catch (err) { toast("실패: " + err.message); }
};

/* ---------- 테마 (웹앱 전용, localStorage) ---------- */
const THEME_KEY = "jonr.theme";
const THEME_MODES = ["system", "light", "dark"];
function themeSetting() {
  const t = document.documentElement.dataset.theme;
  return THEME_MODES.includes(t) ? t : "system";
}
function resolvedTheme() {
  const t = themeSetting();
  if (t !== "system") return t;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}
function syncThemeSeg() {
  const cur = themeSetting();
  document.querySelectorAll("#themeSeg button").forEach((b) => {
    const on = b.dataset.themeV === cur;
    b.classList.toggle("active", on);
    b.setAttribute("aria-pressed", String(on));
  });
}
function setTheme(t, persist = true) {
  if (!THEME_MODES.includes(t)) t = "system";
  document.documentElement.dataset.theme = t;
  if (persist) {
    try { localStorage.setItem(THEME_KEY, t); } catch (e) { /* ignore */ }
  }
  syncThemeSeg();
  if (typeof drawAll === "function") drawAll();
}
document.querySelectorAll("#themeSeg button").forEach((b) => {
  b.onclick = () => setTheme(b.dataset.themeV);
});
syncThemeSeg();
const themeMq = window.matchMedia("(prefers-color-scheme: dark)");
if (themeMq.addEventListener) {
  themeMq.addEventListener("change", () => {
    if (themeSetting() === "system" && typeof drawAll === "function") drawAll();
  });
}

setInterval(refresh, 15000);

/* ===== 화면 방향(가로/세로) 대응 ===== */
function updateOrientation() {
  const portrait = window.innerWidth < window.innerHeight;
  document.body.classList.toggle("portrait", portrait);
  if (typeof layoutMap === "function" && typeof MAPMETA !== "undefined" && MAPMETA) {
    requestAnimationFrame(() => layoutMap());
  }
  if (typeof drawAll === "function") requestAnimationFrame(() => drawAll());
}
window.addEventListener("resize", updateOrientation);
updateOrientation();
