/* ------------------------------------------------------------------
   기능 설명(title) 일괄 지정
   - 브라우저 기본 툴팁을 사용한다. (마우스를 올리면 표시)
   - 문구는 Mi Home 공식 플러그인의 한국어 설명을 참고해 이 앱에 맞게 정리.
   - 동적으로 다시 그려지는 목록(방/영역/소모품)은 MutationObserver로 재적용.
------------------------------------------------------------------- */
(() => {
  const TIPS = {
    /* ===== 지도 뷰어 ===== */
    "#mapWrap .map-stats": "이번 청소의 면적·시간과 현재 배터리 잔량입니다.",
    "#statArea": "이번 청소에서 청소한 면적(m²)입니다.",
    "#statTime": "이번 청소에 걸린 시간(분)입니다.",
    "#statBattery": "현재 배터리 잔량입니다.",
    "#cfgBtn": "설정 — 테마, 로봇/스테이션 설정, 연결 정보를 엽니다.",
    "[data-close]": "이 창을 닫습니다.",
    "#zoomOut": "지도를 축소합니다.",
    "#zoomVal": "현재 지도 확대 비율입니다.",
    "#zoomIn": "지도를 확대합니다.",
    "#zoomFit": "지도를 화면 크기에 맞춥니다.",
    "#stateBadge": "현재 로봇의 동작 상태입니다.",

    /* ===== 상단 도구 탭 ===== */
    "#toolTabs [data-tool='full']":
      "전체 청소 — 집 전체를 청소합니다. 청소 모드·흡입력·물량·횟수·경로를 설정합니다.",
    "#toolTabs [data-tool='room']":
      "방 청소 — 지도에서 방을 클릭해 선택한 순서대로 청소합니다.",
    "#toolTabs [data-tool='zone']":
      "구역 청소 — 지도에 사각형 구역을 그려 그곳만 청소합니다. 최대 10개까지 지정할 수 있습니다.",
    "#toolTabs [data-tool='walls']":
      "금지 구역 — 문턱, 가상벽/금지구역, 물걸레 금지, 카펫을 지도에 추가하거나 편집합니다.",

    /* ===== 지도 선택 ===== */
    "#mapSel": "기기에 저장된 지도 중 사용할 지도를 선택합니다.",
    "#mapSwitchBtn": "선택한 지도로 전환합니다. 지도가 여러 개일 때 사용합니다.",

    /* ===== 청소 모드 ===== */
    "#modeSeg": "청소 모드 — 흡입과 물걸레 동작 방식을 선택합니다.",
    "#modeSeg button[data-v='0']": "흡입과 물걸레질을 동시에 진행합니다.",
    "#modeSeg button[data-v='1']":
      "물걸레질 없이 흡입 청소만 합니다. 카펫이나 물에 약한 바닥에 적합합니다.",
    "#modeSeg button[data-v='2']":
      "흡입 없이 물걸레질만 합니다. 이미 먼지를 제거한 바닥에 적합합니다.",
    "#modeSeg button[data-v='3']":
      "먼저 흡입 청소를 한 뒤 이어서 물걸레질을 합니다. 가장 꼼꼼한 방식입니다.",

    /* ===== 흡입력 ===== */
    "#fanSeg": "흡입력 — 먼지를 빨아들이는 세기를 선택합니다.",
    "#fanSeg button[data-v='0']":
      "소음이 가장 작습니다. 수면 시간이나 조용한 환경에 적합합니다.",
    "#fanSeg button[data-v='1']": "일상 청소에 적합한 기본 흡입력입니다.",
    "#fanSeg button[data-v='2']": "먼지가 많은 바닥에 적합한 강한 흡입력입니다.",
    "#fanSeg button[data-v='3']":
      "최대 흡입력입니다. 소음과 배터리 소모가 가장 큽니다.",

    /* ===== 물걸레 습도 ===== */
    "#waterSeg": "물걸레 습도 — 바닥에 뿌리는 물의 양을 선택합니다.",
    "#waterSeg button[data-v='0']":
      "물을 적게 뿌립니다. 마른 바닥이나 물에 약한 바닥에 적합합니다.",
    "#waterSeg button[data-v='1']": "일반적인 바닥 청소에 적합한 기본 물량입니다.",
    "#waterSeg button[data-v='2']":
      "물을 많이 뿌립니다. 찌든 오염에 적합하지만 마르는 시간이 깁니다.",

    /* ===== 청소 횟수 ===== */
    "#countSeg": "청소 횟수 — 같은 구역을 몇 번 청소할지 정합니다.",
    "#countSeg button[data-v='1']": "한 번 청소합니다.",
    "#countSeg button[data-v='2']":
      "같은 구역을 두 번 청소합니다. 청소 시간과 배터리 소모가 늘어납니다.",

    /* ===== 청소 경로 ===== */
    "#routeSeg": "청소 경로 — 청소 속도와 꼼꼼함의 균형을 정합니다.",
    "#routeSeg button[data-v='0']":
      "청소 시간이 짧고 물도 절약합니다. 깨끗한 바닥이나 임시 청소에 적합합니다.",
    "#routeSeg button[data-v='1']":
      "일상적인 바닥 청소에 적합하며 속도와 효율의 균형을 맞춥니다.",
    "#routeSeg button[data-v='2']":
      "대청소에 적합합니다. 청소 시간이 길고 물·배터리 소모가 많습니다.",

    /* ===== 방 선택 ===== */
    "#roomBlock": "방 선택 — 지도에서 방을 클릭한 순서대로 청소합니다. 다시 클릭하면 선택이 해제됩니다.",
    "#roomChips .chip":
      "클릭하면 청소 순서에 추가됩니다. 다시 클릭하면 선택에서 제외됩니다.",

    /* ===== 동작 ===== */
    "#startBtn":
      "선택한 모드로 청소를 시작합니다. 청소 중에는 일시정지 버튼으로 바뀝니다.",
    "#stopBtn": "진행 중인 청소나 스테이션 작업을 즉시 종료합니다.",
    "#dockBtn": "로봇을 스테이션으로 복귀시켜 충전합니다.",
    "#collectBtn": "스테이션으로 돌아가 먼지통을 자동으로 비웁니다.",
    "#washBtn": "물걸레 세척을 위해 스테이션으로 복귀합니다.",
    "#dryBtn": "물걸레 패드를 열풍으로 건조합니다.",

    /* ===== 금지 구역 ===== */
    "#kindChips": "영역 종류 — 지도에 추가할 항목을 선택합니다.",
    "#kindChips [data-kind='thres']":
      "문턱 — 미닫이 문턱(슬라이딩 도어 레일)과 문지방(문 아래 턱)을 등록합니다.",
    "#kindChips [data-kind='virtual']":
      "가상벽/진입금지 — 로봇이 넘거나 들어가지 못하는 선 또는 영역입니다.",
    "#kindChips [data-kind='mop']":
      "물걸레 금지 — 물걸레 청소만 하지 않는 영역입니다. 카펫이나 물에 약한 바닥에 사용합니다.",
    "#kindChips [data-kind='carpet']":
      "카펫 — 카펫 영역을 등록하고 카펫별 청소 전략을 설정합니다.",
    "#typeBlock": "선택한 영역의 세부 종류입니다. ? 버튼에서 자세한 설명을 볼 수 있습니다.",
    "#typeHelp": "문턱·가상벽·금지구역 종류의 자세한 설명을 봅니다.",
    "#elemType": "문턱/영역의 세부 종류를 선택합니다.",
    "#elemList":
      "등록된 영역 목록입니다. 카펫 항목을 클릭하면 펼쳐서 개별 전략을 설정할 수 있습니다.",
    "#wallsSaveBtn": "지도에 그린 변경 사항과 카펫별 전략을 기기에 저장합니다.",
    "#wallsCancelBtn":
      "저장하지 않은 변경을 모두 취소하고 마지막 저장 상태로 되돌립니다.",
    "#wallsHint":
      "문턱: 클릭-클릭 또는 드래그로 그립니다. 영역: 드래그로 이동, 흰 점으로 크기 조절, X로 삭제합니다.",

    /* ===== 카펫 개별 전략 (동적) ===== */
    "#elemList .carpet-item": "클릭하면 이 카펫의 개별 전략 설정을 펼칩니다.",
    "#elemList [data-carpet-custom]":
      "켜면 이 카펫에만 적용되는 전략을 따로 설정합니다. 끄면 전역 카펫 청소 방식을 따릅니다.",
    "#elemList [data-carpet-strat='0']":
      "적응 — 카펫 감지 시 물걸레를 들어 올리고 흡입력을 조절합니다. 단모 카펫에 적합합니다.",
    "#elemList [data-carpet-strat='1']":
      "회피 — 카펫 영역을 피해 청소합니다. 중장모 카펫에 적합합니다.",
    "#elemList [data-carpet-strat='2']":
      "통과 — 카펫을 청소하지 않고 지나가기만 합니다. 출입문 매트에 적합합니다.",
    "#elemList [data-carpet-strat='3']":
      "무시 — 카펫도 일반 바닥처럼 흡입+물걸레 청소합니다. 카펫이 없는 환경에 적합합니다.",
    "#elemList [data-carpet-opt='boost']":
      "카펫 부스트 — 이 카펫을 청소할 때 흡입력을 자동으로 높입니다. 적응 모드에서만 적용됩니다.",
    "#elemList [data-carpet-opt='twice']":
      "카펫 2회 청소 — 이 카펫을 지그재그로 두 번 청소합니다. 적응 모드에서만 적용됩니다.",
    "#elemList [data-carpet-opt='first']":
      "카펫 먼저 청소 — 다른 구역보다 이 카펫을 먼저 청소합니다. 적응 모드에서만 적용됩니다.",

    /* ===== 설정 ===== */
    "#themeSeg": "테마 — 화면 밝기 모드를 선택합니다. 시스템은 기기 설정을 따릅니다.",
    "#themeSeg [data-theme-v='system']": "기기(OS)의 라이트/다크 설정을 자동으로 따릅니다.",
    "#themeSeg [data-theme-v='light']": "항상 밝은 화면으로 표시합니다.",
    "#themeSeg [data-theme-v='dark']": "항상 어두운 화면으로 표시합니다.",
    "[data-open='winRobot']":
      "로봇 설정 — 카펫 청소 방식, 물걸레 확장, 차일드락, 청소금지 시간, 음성을 설정합니다.",
    "[data-open='winStation']":
      "스테이션 설정 — 물걸레 세척 간격, 열풍 건조, 자동 먼지 비움을 설정합니다.",
    "[data-open='winConsum']":
      "소모품 및 유지보수 — 브러시·필터·걸레패드 등의 사용률과 교체 시기를 확인합니다.",
    "#locateBtn": "로봇이 소리를 내 현재 위치를 알려줍니다.",
    "#cfgIp": "로봇의 로컬 네트워크 IP 주소입니다.",
    "#cfgToken":
      "로봇 제어에 필요한 32자리 토큰입니다. 외부에 노출되지 않도록 주의하세요.",
    "#cfgTokenEye": "토큰을 화면에 표시하거나 숨깁니다.",
    "#cfgDid": "기기 고유 ID(DID)입니다. 클라우드 명령 라우팅에 사용됩니다.",
    "#cfgForceCloud":
      "켜면 로컬 연결이 가능해도 모든 명령을 클라우드로 전송합니다.",
    "#cfgSave": "IP·토큰·DID 등 연결 설정을 저장합니다.",

    /* ===== 로봇 설정 — 카펫 ===== */
    "#carpetSeg": "카펫 청소 방식 — 카펫 종류에 따라 청소 계획을 선택합니다.",
    "#carpetSeg button[data-v='0']":
      "적응 — 카펫 감지 시 물걸레를 들어 올리고 흡입력을 조절합니다. 단모 카펫에 적합합니다.",
    "#carpetSeg button[data-v='1']":
      "회피 — 카펫 영역을 피해 청소합니다. 중장모 카펫에 적합합니다.",
    "#carpetSeg button[data-v='2']":
      "통과 — 카펫을 청소하지 않고 지나가기만 합니다. 출입문 매트에 적합합니다.",
    "#carpetSeg button[data-v='3']":
      "무시 — 카펫도 일반 바닥처럼 흡입+물걸레 청소합니다. 카펫이 없는 환경에 적합합니다.",
    "#boostWrap": "카펫 부스트 — 카펫을 청소할 때 흡입력을 자동으로 높입니다.",
    "#twiceWrap":
      "카펫 2회 청소 — 카펫을 지그재그로 두 번 청소합니다. 적응 모드에서만 표시됩니다.",
    "#firstWrap":
      "카펫 먼저 청소 — 다른 구역보다 카펫을 먼저 청소한 뒤 물걸레로 나머지를 청소합니다. 적응 모드에서만 표시됩니다.",

    /* ===== 로봇 설정 — 일반 ===== */
    "#optMopAugment":
      "물걸레 확장 — 벽면과 가장자리 청소 시 걸레가 자동으로 확장됩니다.",
    "#optBreakClean":
      "중단된 구역 이어서 청소 — 배터리가 충분해지면 중단된 청소를 이어서 진행합니다.",
    "#optChildLock":
      "차일드락 — 로봇의 버튼을 잠그고 앱으로만 조작할 수 있게 합니다.",

    /* ===== 청소금지 시간 ===== */
    "#optDisturb":
      "청소금지 시간 — 설정한 시간 동안 로봇이 스스로 청소를 시작하지 않습니다.",
    "#dndStart": "청소금지 시간이 시작되는 시각입니다.",
    "#dndEnd": "청소금지 시간이 끝나는 시각입니다.",
    "#dndNoDust": "청소금지 시간에는 자동 먼지 비움을 하지 않습니다.",
    "#dndNoDry": "청소금지 시간에는 자동 건조를 하지 않습니다.",
    "#dndSave": "청소금지 시간 설정을 저장합니다.",

    /* ===== 음성 ===== */
    "#langSel": "로봇의 음성 안내 언어를 선택합니다.",
    "#volRange": "로봇 음성 안내의 음량입니다.",

    /* ===== 스테이션 ===== */
    "#mopFreqSeg": "물걸레 세척 간격 — 청소 중 몇 분마다 물걸레를 세척할지 정합니다.",
    "#mopFreqSeg button[data-v='5']": "청소 5분마다 물걸레를 세척합니다.",
    "#mopFreqSeg button[data-v='10']": "청소 10분마다 물걸레를 세척합니다.",
    "#mopFreqSeg button[data-v='15']": "청소 15분마다 물걸레를 세척합니다.",
    "#optDrying": "열풍 건조 — 물걸레 세척 후 열풍으로 패드를 말립니다.",
    "#dryTimeSeg": "열풍 건조 시간을 선택합니다.",
    "#dryTimeSeg button[data-v='120']": "2시간 동안 열풍 건조합니다.",
    "#dryTimeSeg button[data-v='180']": "3시간 동안 열풍 건조합니다.",
    "#dryTimeSeg button[data-v='240']": "4시간 동안 열풍 건조합니다.",
    "#dustSeg": "자동 먼지 비움 — 청소 몇 회마다 먼지통을 비울지 정합니다.",
    "#dustSeg button[data-v='0']": "자동 먼지 비움을 사용하지 않습니다.",
    "#dustSeg button[data-v='3']": "청소 5회마다 자동으로 먼지통을 비웁니다.",
    "#dustSeg button[data-v='1']": "청소할 때마다 자동으로 먼지통을 비웁니다.",

    /* ===== 소모품 ===== */
    "#consumList .item":
      "소모품의 사용률과 잔여 수명입니다. 소모품을 교체한 뒤 수명 초기화를 누르세요.",
    "#consumList [data-reset]": "이 소모품의 사용 카운터를 새것 기준으로 초기화합니다.",
  };

  function applyTips() {
    for (const sel in TIPS) {
      let nodes;
      try { nodes = document.querySelectorAll(sel); } catch (e) { continue; }
      nodes.forEach((el) => {
        if (el.title !== TIPS[sel]) el.title = TIPS[sel];
      });
    }
    // 입력 요소의 설명을 감싸는 label에도 복사해, 텍스트에 마우스를 올려도 보이게 한다.
    document.querySelectorAll("label > input[title], label > select[title]").forEach((el) => {
      const lab = el.closest("label");
      if (lab && lab.title !== el.title) lab.title = el.title;
    });
  }

  function init() {
    applyTips();
    const mo = new MutationObserver(applyTips);
    ["roomChips", "elemList", "consumList"].forEach((id) => {
      const el = document.getElementById(id);
      if (el) mo.observe(el, { childList: true, subtree: true });
    });
  }

  if (document.readyState === "loading")
    document.addEventListener("DOMContentLoaded", init);
  else init();
})();
