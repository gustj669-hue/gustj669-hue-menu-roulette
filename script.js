// ===== 상수 =====
const CATEGORIES = ["한식", "중식", "일식", "양식", "기타"];
const TIMES = ["아침", "점심", "저녁", "야식"];
const ALL = "전체";
const MAX_HISTORY = 5;
const MAX_UNDO = 30;           // 되돌리기 최대 단계
const SPIN_MS = 900;           // 애니메이션 시간 (0.5~1초 범위)
const TICK_MS = 70;            // 메뉴가 바뀌는 간격
const TIME_CHECK_MS = 30000;   // 시간대가 바뀌었는지 확인하는 간격
const STORAGE_KEY = "menuRoulette.v1";
const THEME_KEY = "menuRoulette.theme";

function defaultMenus() {
  return [
    ["김치찌개", "한식", ["아침", "점심", "저녁"]],
    ["비빔밥",   "한식", ["아침", "점심", "저녁"]],
    ["돈까스",   "일식", ["점심", "저녁"]],
    ["초밥",     "일식", ["점심", "저녁"]],
    ["짜장면",   "중식", ["점심", "저녁", "야식"]],
    ["파스타",   "양식", ["점심", "저녁"]],
    ["치킨",     "기타", ["저녁", "야식"]],
    ["떡볶이",   "한식", ["점심", "저녁", "야식"]],
  ].map(([name, category, times]) => ({ name, category, enabled: true, eaten: false, times }));
}

// 시간대 목록 정리: 잘못된 값은 버리고 순서를 맞춤 (없으면 모든 시간대)
function normalizeTimes(arr) {
  if (!Array.isArray(arr)) return [...TIMES];
  return TIMES.filter((t) => arr.includes(t));
}

const isTimeMode = (v) => v === "off" || v === "auto" || TIMES.includes(v);

// ===== 저장 / 불러오기 (localStorage) =====
function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const d = JSON.parse(raw);
    if (!d || !Array.isArray(d.menus)) return null;

    const seen = new Set();
    const menus = [];
    d.menus.forEach((m) => {
      if (!m || typeof m.name !== "string") return;
      const name = m.name.trim();
      if (!name || seen.has(name)) return;
      seen.add(name);
      menus.push({
        name,
        category: CATEGORIES.includes(m.category) ? m.category : "기타",
        enabled: m.enabled !== false,
        eaten: m.eaten === true,
        times: normalizeTimes(m.times),   // 이전 버전 저장 데이터는 모든 시간대로 처리
      });
    });
    return {
      menus,
      history: Array.isArray(d.history)
        ? d.history.filter((h) => typeof h === "string").slice(0, MAX_HISTORY) : [],
      filter: d.filter === ALL || CATEGORIES.includes(d.filter) ? d.filter : ALL,
      excludeEaten: d.excludeEaten !== false,
      timeMode: isTimeMode(d.timeMode) ? d.timeMode : "off",
    };
  } catch (e) {
    return null;   // 저장 데이터가 깨졌거나 저장소를 못 쓰면 기본값 사용
  }
}

function saveState() {
  try {
    localStorage.setItem(STORAGE_KEY,
      JSON.stringify({ menus, history, filter, excludeEaten, timeMode }));
  } catch (e) { /* 저장 실패는 무시 (앱은 계속 동작) */ }
}

// ===== 상태(State) =====
const saved = loadState();
let menus = saved ? saved.menus : defaultMenus();
let history = saved ? saved.history : [];      // 최근 뽑은 기록 (최신이 앞)
let filter = saved ? saved.filter : ALL;       // 카테고리 필터
let excludeEaten = saved ? saved.excludeEaten : true;  // 먹은 메뉴 제외 옵션
let timeMode = saved ? saved.timeMode : "off"; // 시간대 모드: off / auto / 아침·점심·저녁·야식
let undoStack = [];       // 되돌리기 기록 (스택): { label, menus(JSON 문자열) }
let query = "";           // 검색어 (화면 목록만 거름, 뽑기 후보에는 영향 없음)
let editing = null;       // 수정 중인 메뉴
let focusEdit = false;
let spinning = false;     // 애니메이션 중복 실행 방지
let lastPick = "";        // 마지막으로 뽑힌 메뉴
let lastSlot = null;      // 마지막으로 화면에 반영한 시간대

// ===== 요소 =====
const $ = (id) => document.getElementById(id);
const resultEl = $("result");
const mapLinkEl = $("mapLink");
const eatBtn = $("eatBtn");
const errorEl = $("error");
const addErrorEl = $("addError");
const pickBtn = $("pickBtn");
const menuInput = $("menuInput");
const categorySelect = $("categorySelect");
const searchInput = $("searchInput");
const filterBar = $("filterBar");
const menuListEl = $("menuList");
const countEl = $("candidateCount");
const historyEl = $("history");
const excludeCheck = $("excludeEaten");
const themeBtn = $("themeBtn");
const undoBtn = $("undoBtn");
const statusEl = $("statusMsg");
const timeSelect = $("timeMode");
const timeInfoEl = $("timeInfo");

// ===== 시간대 =====
// 시각 → 시간대: 아침 05~10시 / 점심 11~15시 / 저녁 16~21시 / 야식 22~04시
function slotOf(date) {
  const h = date.getHours();
  if (h >= 5 && h < 11) return "아침";
  if (h >= 11 && h < 16) return "점심";
  if (h >= 16 && h < 22) return "저녁";
  return "야식";
}

// 지금 적용 중인 시간대 (모드가 꺼져 있으면 null)
function activeSlot() {
  if (timeMode === "off") return null;
  if (timeMode === "auto") return slotOf(new Date());
  return timeMode;
}

const isInSlot = (menu, slot) => slot === null || menu.times.includes(slot);

// ===== 계산 =====
function getVisible() {
  return menus.filter((m) => filter === ALL || m.category === filter);
}

// 화면에 보여 줄 목록 = 카테고리 필터 + 검색어 (뽑기 후보와는 별개)
function getListed() {
  const q = query.trim().toLowerCase();
  return getVisible().filter((m) => q === "" || m.name.toLowerCase().includes(q));
}

// 뽑기 후보 = 카테고리가 맞고 AND 체크되어 있고
//            AND NOT(먹은 메뉴 제외 ON AND 먹음 표시) AND (시간대 모드 OFF OR 지금 시간대에 맞음)
function getCandidates() {
  const slot = activeSlot();
  return getVisible()
    .filter((m) => m.enabled && !(excludeEaten && m.eaten) && isInSlot(m, slot))
    .map((m) => m.name);
}

function randomItem(list) {
  return list[Math.floor(Math.random() * list.length)];
}

function mapUrl(name) {
  return "https://map.naver.com/p/search/" + encodeURIComponent(name + " 맛집");
}

// ===== 되돌리기 (Undo) =====
function setStatus(text) {
  statusEl.textContent = text;
}

// 메뉴 목록을 바꾸는 모든 동작은 이 함수를 거침:
// 바꾸기 전 상태를 스택에 쌓아 두고, 실제로 바뀐 경우에만 기록한다.
function mutate(label, change) {
  const before = JSON.stringify(menus);
  change();
  if (JSON.stringify(menus) === before) return;   // 바뀐 게 없으면 기록하지 않음
  undoStack.push({ label, menus: before });
  if (undoStack.length > MAX_UNDO) undoStack.shift();
  setStatus("");
}

function undo() {
  const last = undoStack.pop();
  if (!last) return;
  menus = JSON.parse(last.menus);
  editing = null;
  addErrorEl.textContent = "";
  setStatus("↩ 되돌렸어요: " + last.label);
  render();
}

// ===== 화면 그리기 =====
function renderFilter() {
  filterBar.innerHTML = "";
  [ALL, ...CATEGORIES].forEach((cat) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "chip" + (cat === filter ? " active" : "");
    btn.textContent = cat;
    btn.setAttribute("aria-pressed", String(cat === filter));
    btn.addEventListener("click", () => { filter = cat; render(); });
    filterBar.appendChild(btn);
  });
}

function makeCategorySelect(selected) {
  const sel = document.createElement("select");
  sel.setAttribute("aria-label", "카테고리");
  CATEGORIES.forEach((cat) => {
    const opt = document.createElement("option");
    opt.value = cat;
    opt.textContent = cat;
    sel.appendChild(opt);
  });
  sel.value = selected;
  return sel;
}

// 시간대 체크박스 묶음 (메뉴 추가 / 수정에서 같이 사용)
function makeTimePicker(selected) {
  const wrap = document.createElement("div");
  wrap.className = "time-pick";
  const boxes = TIMES.map((t) => {
    const label = document.createElement("label");
    const box = document.createElement("input");
    box.type = "checkbox";
    box.value = t;
    box.checked = selected.includes(t);
    label.append(box, " " + t);
    wrap.appendChild(label);
    return box;
  });
  return {
    el: wrap,
    values: () => boxes.filter((b) => b.checked).map((b) => b.value),
    setAll: (on) => boxes.forEach((b) => (b.checked = on)),
  };
}

function makeMiniButton(text, label, onClick, extraClass) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "mini" + (extraClass ? " " + extraClass : "");
  btn.textContent = text;
  if (label) btn.setAttribute("aria-label", label);
  btn.addEventListener("click", onClick);
  return btn;
}

function renderList() {
  menuListEl.innerHTML = "";
  const visible = getListed();
  const slot = activeSlot();

  if (visible.length === 0) {
    const li = document.createElement("li");
    li.className = "empty";
    const q = query.trim();
    li.textContent = q
      ? "'" + q + "'에 맞는 메뉴가 없어요." + (filter === ALL ? "" : " (카테고리: " + filter + ")")
      : "이 카테고리에는 메뉴가 없어요. 위에서 추가해 보세요.";
    menuListEl.appendChild(li);
    return;
  }

  visible.forEach((menu) => {
    const li = document.createElement("li");

    // 수정 모드
    if (menu === editing) {
      li.className = "menu-item editing";
      const input = document.createElement("input");
      input.type = "text";
      input.className = "edit-input";
      input.maxLength = 20;
      input.value = menu.name;
      input.setAttribute("aria-label", "메뉴 이름 수정");
      const sel = makeCategorySelect(menu.category);
      const picker = makeTimePicker(menu.times);
      const commit = () => commitEdit(menu, input.value, sel.value, picker.values());
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") commit();
        if (e.key === "Escape") cancelEdit();
      });
      li.append(input, sel, picker.el,
        makeMiniButton("저장", menu.name + " 수정 저장", commit, "on"),
        makeMiniButton("취소", "수정 취소", cancelEdit));
      menuListEl.appendChild(li);
      return;
    }

    const excluded = !menu.enabled || (excludeEaten && menu.eaten) || !isInSlot(menu, slot);
    li.className = "menu-item" + (excluded ? " off" : "");

    const check = document.createElement("input");
    check.type = "checkbox";
    check.checked = menu.enabled;
    check.setAttribute("aria-label", menu.name + " 후보에 포함");
    check.addEventListener("change", () => {
      const on = check.checked;
      mutate("'" + menu.name + "' 체크 " + (on ? "켬" : "끔"), () => { menu.enabled = on; });
      render();
    });

    // 이름 + (모든 시간대가 아니면) 먹는 시간대 표시
    const name = document.createElement("div");
    name.className = "name";
    const nameText = document.createElement("span");
    nameText.className = "n";
    nameText.textContent = menu.name;
    name.appendChild(nameText);
    if (menu.times.length < TIMES.length) {
      const sub = document.createElement("small");
      sub.className = "times";
      sub.textContent = menu.times.length ? menu.times.join("·") : "시간대 없음";
      name.appendChild(sub);
    }

    const tag = document.createElement("span");
    tag.className = "tag";
    tag.textContent = menu.category;

    const actions = document.createElement("div");
    actions.className = "actions";

    const eat = makeMiniButton(menu.eaten ? "먹음 ✓" : "먹음", menu.name + " 먹음 표시", () => {
      const next = !menu.eaten;
      mutate("'" + menu.name + "' 먹음 " + (next ? "표시" : "해제"), () => { menu.eaten = next; });
      render();
    }, menu.eaten ? "on" : "");
    eat.setAttribute("aria-pressed", String(menu.eaten));

    const edit = makeMiniButton("수정", menu.name + " 수정", () => {
      editing = menu;
      focusEdit = true;
      addErrorEl.textContent = "";
      render();
    });

    const del = makeMiniButton("삭제", menu.name + " 삭제", () => {
      mutate("'" + menu.name + "' 삭제", () => { menus = menus.filter((m) => m !== menu); });
      if (editing === menu) editing = null;
      render();
    }, "danger");

    actions.append(eat, edit, del);
    li.append(check, name, tag, actions);
    menuListEl.appendChild(li);
  });

  if (focusEdit) {
    const el = menuListEl.querySelector(".edit-input");
    if (el) { el.focus(); el.select(); }
    focusEdit = false;
  }
}

function renderHistory() {
  historyEl.innerHTML = "";
  if (history.length === 0) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = "아직 뽑은 메뉴가 없어요.";
    historyEl.appendChild(li);
    return;
  }
  history.forEach((item) => {
    const li = document.createElement("li");
    li.textContent = item;
    historyEl.appendChild(li);
  });
}

function renderTimeInfo() {
  timeSelect.value = timeMode;
  const slot = activeSlot();
  if (!slot) {
    timeInfoEl.textContent = "꺼져 있어요. 켜면 지금 먹기 좋은 시간대의 메뉴만 후보가 돼요.";
    return;
  }
  const count = menus.filter((m) => m.times.includes(slot)).length;
  let how = "수동 선택";
  if (timeMode === "auto") {
    const now = new Date();
    const hh = String(now.getHours()).padStart(2, "0");
    const mm = String(now.getMinutes()).padStart(2, "0");
    how = "자동 · 현재 " + hh + ":" + mm;
  }
  timeInfoEl.textContent = "적용 중: '" + slot + "' 시간대 (" + how + ") · 이 시간대 메뉴 " + count + "개";
}

function render() {
  renderFilter();
  renderList();
  renderHistory();
  renderTimeInfo();
  excludeCheck.checked = excludeEaten;
  lastSlot = activeSlot();

  undoBtn.disabled = undoStack.length === 0;
  undoBtn.textContent = "↩ 되돌리기" + (undoStack.length ? " (" + undoStack.length + ")" : "");

  const count = getCandidates().length;
  const label = filter === ALL ? "전체" : filter;
  countEl.textContent = label + " 후보 " + count + "개 / 메뉴 " + getVisible().length + "개"
    + (query.trim() ? " (검색 결과 " + getListed().length + "개)" : "");

  if (count === 0) {
    const slot = activeSlot();
    errorEl.textContent = (filter === ALL ? "" : "'" + filter + "' ")
      + "후보가 없어요. 메뉴를 체크하거나 '먹음' 표시를 풀어 주세요."
      + (slot ? " 지금은 '" + slot + "' 시간대 모드예요. 모드를 끄거나 메뉴의 시간대를 바꿔 보세요." : "");
  } else {
    errorEl.textContent = "";
  }
  pickBtn.disabled = count === 0 || spinning;

  saveState();
}

// ===== 검색 =====
function clearSearch() {
  query = "";
  searchInput.value = "";
}

// ===== 메뉴 추가 / 수정 =====
const addTimes = makeTimePicker(TIMES);   // 추가 폼의 시간대 선택 (기본: 모두 선택)

function addMenu() {
  const name = menuInput.value.trim();
  if (name === "") { addErrorEl.textContent = "메뉴 이름을 입력해 주세요."; return; }
  if (menus.some((m) => m.name === name)) { addErrorEl.textContent = "이미 있는 메뉴예요."; return; }

  const category = categorySelect.value;
  const times = addTimes.values();
  mutate("'" + name + "' 추가", () => {
    menus.push({ name, category, enabled: true, eaten: false, times });
  });
  menuInput.value = "";
  addTimes.setAll(true);
  addErrorEl.textContent = "";
  clearSearch();      // 새 메뉴가 검색 때문에 안 보이는 일 방지
  render();
  menuInput.focus();
}

function commitEdit(menu, rawName, category, times) {
  const name = rawName.trim();
  if (name === "") { addErrorEl.textContent = "메뉴 이름을 입력해 주세요."; return; }
  if (menus.some((m) => m !== menu && m.name === name)) { addErrorEl.textContent = "이미 있는 메뉴예요."; return; }

  const label = menu.name === name ? "'" + name + "' 수정" : "'" + menu.name + "' → '" + name + "' 수정";
  mutate(label, () => {
    menu.name = name;
    menu.category = category;
    menu.times = times;
  });
  editing = null;
  addErrorEl.textContent = "";
  render();
}

function cancelEdit() {
  editing = null;
  addErrorEl.textContent = "";
  render();
}

// ===== 뽑기 =====
function pick() {
  const items = getCandidates();
  if (spinning || items.length === 0) return;

  const final = randomItem(items);   // 결과는 후보 안에서만 선택
  spinning = true;
  pickBtn.disabled = true;
  mapLinkEl.hidden = true;
  eatBtn.hidden = true;
  resultEl.className = "result spinning";

  // 메뉴 이름이 빠르게 바뀌다가 하나로 멈춤
  const timer = setInterval(() => {
    resultEl.textContent = randomItem(items);
  }, TICK_MS);

  setTimeout(() => {
    clearInterval(timer);
    finishPick(final);
  }, SPIN_MS);
}

function finishPick(final) {
  lastPick = final;
  resultEl.textContent = final;
  resultEl.className = "result done";

  mapLinkEl.href = mapUrl(final);
  mapLinkEl.textContent = "📍 근처 '" + final + "' 맛집 찾기";
  mapLinkEl.hidden = false;
  eatBtn.hidden = false;

  history.unshift(final);
  history = history.slice(0, MAX_HISTORY);

  spinning = false;
  render();
}

// ===== 다크 모드 =====
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  themeBtn.textContent = theme === "dark" ? "☀️ 라이트" : "🌙 다크";
  themeBtn.setAttribute("aria-pressed", String(theme === "dark"));
  const meta = document.querySelector('meta[name="theme-color"]');   // 폰 주소창 색
  if (meta) meta.content = theme === "dark" ? "#1d1930" : "#fff3c4";
}

function initialTheme() {
  try {
    const t = localStorage.getItem(THEME_KEY);
    if (t === "dark" || t === "light") return t;
  } catch (e) { /* 무시 */ }
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

// ===== 이벤트 =====
pickBtn.addEventListener("click", pick);
undoBtn.addEventListener("click", undo);

// Ctrl+Z (Mac은 Cmd+Z): 글자 입력칸에서는 브라우저 기본 동작을 쓰고, 그 밖에서는 메뉴 되돌리기
document.addEventListener("keydown", (e) => {
  if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.key.toLowerCase() !== "z") return;
  if (e.target.matches('input[type="text"], input[type="search"], textarea')) return;
  e.preventDefault();
  undo();
});

searchInput.addEventListener("input", () => {
  query = searchInput.value;
  editing = null;       // 검색어가 바뀌면 수정 모드는 닫음
  addErrorEl.textContent = "";
  render();
});
searchInput.addEventListener("keydown", (e) => {
  if (e.key === "Escape") { clearSearch(); render(); }
});
$("addBtn").addEventListener("click", addMenu);
menuInput.addEventListener("keydown", (e) => { if (e.key === "Enter") addMenu(); });

$("selectAllBtn").addEventListener("click", () => {
  mutate("전체 선택", () => getListed().forEach((m) => (m.enabled = true)));
  render();
});
$("clearAllBtn").addEventListener("click", () => {
  mutate("전체 해제", () => getListed().forEach((m) => (m.enabled = false)));
  render();
});
$("resetEatenBtn").addEventListener("click", () => {
  mutate("먹음 표시 모두 지우기", () => menus.forEach((m) => (m.eaten = false)));
  render();
});

excludeCheck.addEventListener("change", () => { excludeEaten = excludeCheck.checked; render(); });

timeSelect.addEventListener("change", () => {
  timeMode = isTimeMode(timeSelect.value) ? timeSelect.value : "off";
  render();
});

$("clearHistoryBtn").addEventListener("click", () => { history = []; render(); });

$("resetMenusBtn").addEventListener("click", () => {
  if (!confirm("메뉴를 기본 목록으로 되돌릴까요? 추가·수정한 내용이 사라져요.\n(되돌리기 버튼으로 복구할 수 있어요)")) return;
  mutate("기본 메뉴로 초기화", () => { menus = defaultMenus(); });
  history = [];
  filter = ALL;
  editing = null;
  clearSearch();
  addErrorEl.textContent = "";
  mapLinkEl.hidden = true;
  eatBtn.hidden = true;
  resultEl.className = "result";
  resultEl.textContent = "🍽️ 뽑기를 눌러봐!";
  render();
});

eatBtn.addEventListener("click", () => {
  const menu = menus.find((m) => m.name === lastPick);
  if (menu) mutate("'" + menu.name + "' 먹음 표시", () => { menu.eaten = true; });
  eatBtn.hidden = true;
  render();
});

themeBtn.addEventListener("click", () => {
  const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  applyTheme(next);
  try { localStorage.setItem(THEME_KEY, next); } catch (e) { /* 무시 */ }
});

// ===== 시작 =====
CATEGORIES.forEach((cat) => {
  const opt = document.createElement("option");
  opt.value = cat;
  opt.textContent = cat;
  categorySelect.appendChild(opt);
});

[["off", "사용 안 함"], ["auto", "자동 (지금 시각)"], ...TIMES.map((t) => [t, t + " (수동 선택)"])]
  .forEach(([value, text]) => {
    const opt = document.createElement("option");
    opt.value = value;
    opt.textContent = text;
    timeSelect.appendChild(opt);
  });

$("addTimes").appendChild(addTimes.el);

// 시간이 흘러 시간대가 바뀌면 후보를 다시 계산 (자동 모드)
setInterval(() => {
  if (spinning || editing) return;
  if (activeSlot() !== lastSlot) render();
  else renderTimeInfo();
}, TIME_CHECK_MS);

applyTheme(initialTheme());
render();
