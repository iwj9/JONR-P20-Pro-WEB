/* ================= 스택형 창 관리 ================= */
/* 새 창이 보이도록 rail 스크롤을 즉시 이동 (가로/세로 공통) */
function revealWin(w) {
  const rail = $("rail");
  const pad = 12;
  const vertical = getComputedStyle(rail).flexDirection === "column";
  const wr = w.getBoundingClientRect();
  const rr = rail.getBoundingClientRect();
  if (vertical) {
    rail.scrollTop = Math.max(0, rail.scrollTop + wr.top - rr.top - pad);
  } else {
    rail.scrollLeft = Math.max(0, rail.scrollLeft + wr.left - rr.left - pad);
  }
}
function openWin(id) {
  const w = $(id);
  if (!w) return;
  w.classList.remove("hidden");
  w.scrollTop = 0;
  if (id === "winSettings") {
    hideToken?.();
    loadCfg?.();
  }
  // 1) 창이 배치된 뒤 2) 지도 레이아웃을 다시 잡고 3) 최종 위치로 스크롤
  requestAnimationFrame(() => {
    if (typeof layoutMap === "function") layoutMap();
    if (typeof drawAll === "function") drawAll();
    requestAnimationFrame(() => revealWin(w));
  });
}

/* ================= rail 드래그 스크롤 ================= */
function initRailDrag() {
  const rail = $("rail");
  if (!rail) return;
  // 지도와 "끌어서 조작하는" 입력 요소만 제외. 버튼·라벨·스위치는
  // 짧게 클릭하면 원래 동작, 5px 이상 끌면 스크롤로 동작한다.
  const NO_DRAG =
    ".win-map, textarea, select, " +
    'input:not([type="checkbox"]):not([type="radio"]), ' +
    '[contenteditable]:not([contenteditable="false"]), [role="slider"]';
  let drag = null;
  let suppressClick = false;
  let suppressTimer = 0;

  const onDown = (e) => {
    if (e.pointerType !== "mouse" || e.button !== 0) return;
    // 새 클릭이 시작되면 이전 드래그의 click 차단은 즉시 해제
    suppressClick = false;
    clearTimeout(suppressTimer);
    if (e.altKey) return;                       // Alt+드래그 = 텍스트 선택
    if (!(e.target instanceof Element) || e.target.closest(NO_DRAG)) return;
    const vertical = getComputedStyle(rail).flexDirection === "column";
    drag = {
      id: e.pointerId,
      x: e.clientX, y: e.clientY,
      left: rail.scrollLeft, top: rail.scrollTop,
      vertical, moved: false,
    };
    // 아직 포인터 캡처/드래그를 시작하지 않는다 → 짧은 클릭은 그대로 전달
    rail.classList.add("rail-armed");
  };

  const onMove = (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    if (!drag.moved) {
      if (Math.abs(dx) < 5 && Math.abs(dy) < 5) return;
      drag.moved = true;
      rail.classList.add("rail-dragging");
      try { rail.setPointerCapture?.(e.pointerId); } catch (err) { /* ignore */ }
    }
    if (drag.vertical) rail.scrollTop = drag.top - dy;
    else rail.scrollLeft = drag.left - dx;
  };

  const end = (e) => {
    if (!drag || (e && e.pointerId !== drag.id)) return;
    const moved = drag.moved;
    const id = drag.id;
    drag = null;
    rail.classList.remove("rail-armed", "rail-dragging");
    if (rail.hasPointerCapture?.(id)) rail.releasePointerCapture(id);
    if (moved) {
      // 드래그가 끝난 뒤 따라오는 click이 버튼/탭을 잘못 누르지 않게 1회 차단
      suppressClick = true;
      clearTimeout(suppressTimer);
      suppressTimer = setTimeout(() => { suppressClick = false; }, 250);
    }
  };

  rail.addEventListener("pointerdown", onDown);
  window.addEventListener("pointermove", onMove, { passive: true });
  window.addEventListener("pointerup", end);
  window.addEventListener("pointercancel", end);
  window.addEventListener("blur", () => end());
  rail.addEventListener("lostpointercapture", end);

  rail.addEventListener("click", (e) => {
    if (!suppressClick) return;
    suppressClick = false;
    clearTimeout(suppressTimer);
    e.preventDefault();
    e.stopPropagation();
  }, true);

  rail.addEventListener("selectstart", (e) => {
    if (drag) e.preventDefault();
  });
  rail.addEventListener("dragstart", (e) => {
    if (!(e.target instanceof Element) || !e.target.closest("input, textarea")) {
      e.preventDefault();
    }
  });

  // Alt(Option)을 누르고 있는 동안만 텍스트 선택 허용
  const textSelect = (on) => document.body.classList.toggle("text-select", on);
  window.addEventListener("keydown", (e) => { if (e.key === "Alt") textSelect(true); });
  window.addEventListener("keyup", (e) => { if (e.key === "Alt") textSelect(false); });
  window.addEventListener("blur", () => textSelect(false));
}
initRailDrag();
function closeWin(id) {
  const w = $(id);
  if (!w) return;
  w.classList.add("hidden");
  if (id === "winSettings") hideToken?.();
  if (id === "winConsum") { /* keep */ }
}
document.querySelectorAll("[data-close]").forEach((b) => {
  b.onclick = () => closeWin(b.dataset.close);
});
document.querySelectorAll("[data-open]").forEach((b) => {
  b.onclick = () => openWin(b.dataset.open);
});
$("cfgBtn").onclick = () => openWin("winSettings");

/* ================= 소모품 ================= */
const CONSUM_KO = {
  sideBrush: "사이드 브러시", rollBrush: "메인 브러시", filter: "먼지통 필터",
  mop: "걸레 패드", dustbag: "더스트백", engineSensor: "본체 센서",
  mopCleaningTrough: "걸레 세척 싱크", filterScreen: "필터 스크린",
};
async function loadConsumables() {
  const box = $("consumList");
  box.innerHTML = '<span class="hint">불러오는 중…</span>';
  try {
    const d = await api("/api/consumables");
    const items = d.items || [];
    if (!items.length) { box.innerHTML = '<span class="hint">데이터 없음</span>'; return; }
    box.innerHTML = "";
    items.forEach((it) => {
      const used = Math.max(0, Math.min(100, Number(it.used) || 0));
      const remain = 100 - used;
      const cls = remain <= 10 ? "dead" : (remain <= 30 ? "low" : "");
      const row = document.createElement("div");
      row.className = "item";
      row.style.display = "block";
      row.innerHTML = `
        <div style="display:flex;justify-content:space-between;align-items:center">
          <b>${CONSUM_KO[it.type] || it.type}</b>
          <span>잔여 ${remain}%</span>
        </div>
        <div class="cbar ${cls}"><i style="width:${remain}%"></i></div>
        <div style="display:flex;justify-content:flex-end;margin-top:8px">
          <button class="btn ghost" data-reset="${it.type}">수명 초기화</button>
        </div>`;
      box.appendChild(row);
    });
    box.querySelectorAll("[data-reset]").forEach((b) => {
      b.onclick = async () => {
        if (!confirm("이 소모품의 수명 카운터를 초기화할까요?")) return;
        try {
          await post("/api/consumables/reset", { type: b.dataset.reset });
          toast("초기화 요청됨");
          await sleep(1500);
          loadConsumables();
        } catch (e) { toast("실패: " + e.message); }
      };
    });
  } catch (e) {
    box.innerHTML = `<span class="hint">실패: ${e.message}</span>`;
  }
}

function initPanels() {
  loadCfg?.();
  const openConsum = document.querySelector('[data-open="winConsum"]');
  if (openConsum) {
    const orig = openConsum.onclick;
    openConsum.onclick = (ev) => { if (orig) orig(ev); loadConsumables(); };
  }
  // 창 열릴 때 상태 갱신
  const obs = new MutationObserver(() => { });
  obs.observe(document.body, { subtree: true, attributes: true, attributeFilter: ["class"] });
}
