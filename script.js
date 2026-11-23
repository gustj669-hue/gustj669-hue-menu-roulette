// ===== 상수 =====
const CATEGORIES = ["한식", "중식", "일식", "양식", "기타"];
const ALL = "전체";
const MAX_HISTORY = 5;
const SPIN_MS = 900;     // 애니메이션 시간 (0.5~1초 범위)
const TICK_MS = 70;      // 메뉴가 바뀌는 간격
const STORAGE_KEY = "menuRoulette.v1";
const THEME_KEY = "menuRoulette.theme";

function defaultMenus() {
  return [
    ["김치찌개", "한식"], ["비빔밥", "한식"], ["돈까스", "일식"], ["초밥", "일식"],
    ["짜장면", "중식"], ["파스타", "양식"], ["치킨", "기타"], ["떡볶이", "한식"],
  ].map(([name, category]) => ({ name, category, enabled: true, eaten: false }));
}

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
      });
    });
    return {
      menus,
      history: Array.isArray(d.history)
        ? d.history.filter((h) => typeof h === "string").slice(0, MAX_HISTORY) : [],
      filter: d.filter === ALL || CATEGORIES.includes(d.filter) ? d.filter : ALL,
      excludeEaten: d.excludeEaten !== false,
    };
  } catch (e) {
    return null;   // 저장 데이터가 깨졌거나 저장소를 못 쓰면 기본값 사용
  }
}

function saveState() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ menus, history, filter, excludeEaten }));
  } catch (e) { /* 저장 실패는 무시 (앱은 계속 동작) */ }
}

// ===== 상태(State) =====
const saved = loadState();
let menus = saved ? saved.menus : defaultMenus();
let history = saved ? saved.history : [];      // 최근 뽑은 기록 (최신이 앞)
let filter = saved ? saved.filter : ALL;       // 카테고리 필터
let excludeEaten = saved ? saved.excludeEaten : true;  // 먹은 메뉴 제외 옵션
let query = "";           // 검색어 (화면 목록만 거름, 뽑기 후보에는 영향 없음)
let editing = null;       // 수정 중인 메뉴
let focusEdit = false;
let spinning = false;     // 애니메이션 중복 실행 방지
let lastPick = "";        // 마지막으로 뽑힌 메뉴

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

// ===== 계산 =====
function getVisible() {
  return menus.filter((m) => filter === ALL || m.category === filter);
}

// 화면에 보여 줄 목록 = 카테고리 필터 + 검색어 (뽑기 후보와는 별개)
function getListed() {
  const q = query.trim().toLowerCase();
  return getVisible().filter((m) => q === "" || m.name.toLowerCase().includes(q));
}

// 뽑기 후보 = 필터에 맞고 + 체크되어 있고 + (먹은 메뉴 제외 옵션이면) 먹음 표시가 없는 메뉴
function getCandidates() {
  return getVisible()
    .filter((m) => m.enabled && !(excludeEaten && m.eaten))
    .map((m) => m.name);
}

function randomItem(list) {
  return list[Math.floor(Math.random() * list.length)];
}

function mapUrl(name) {
  return "https://map.naver.com/p/search/" + encodeURIComponent(name + " 맛집");
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
      const commit = () => commitEdit(menu, input.value, sel.value);
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") commit();
        if (e.key === "Escape") cancelEdit();
      });
      li.append(input, sel,
        makeMiniButton("저장", menu.name + " 수정 저장", commit, "on"),
        makeMiniButton("취소", "수정 취소", cancelEdit));
      menuListEl.appendChild(li);
      return;
    }

    const excluded = !menu.enabled || (excludeEaten && menu.eaten);
    li.className = "menu-item" + (excluded ? " off" : "");

    const check = document.createElement("input");
    check.type = "checkbox";
    check.checked = menu.enabled;
    check.setAttribute("aria-label", menu.name + " 후보에 포함");
    check.addEventListener("change", () => { menu.enabled = check.checked; render(); });

    const name = document.createElement("span");
    name.className = "name";
    name.textContent = menu.name;

    const tag = document.createElement("span");
    tag.className = "tag";
    tag.textContent = menu.category;

    const actions = document.createElement("div");
    actions.className = "actions";

    const eat = makeMiniButton(menu.eaten ? "먹음 ✓" : "먹음", menu.name + " 먹음 표시", () => {
      menu.eaten = !menu.eaten;
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
      menus = menus.filter((m) => m !== menu);
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

function render() {
  renderFilter();
  renderList();
  renderHistory();
  excludeCheck.checked = excludeEaten;

  const count = getCandidates().length;
  const label = filter === ALL ? "전체" : filter;
  countEl.textContent = label + " 후보 " + count + "개 / 메뉴 " + getVisible().length + "개"
    + (query.trim() ? " (검색 결과 " + getListed().length + "개)" : "");

  if (count === 0) {
    errorEl.textContent = (filter === ALL ? "" : "'" + filter + "' ")
      + "후보가 없어요. 메뉴를 체크하거나 '먹음' 표시를 풀어 주세요.";
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
function addMenu() {
  const name = menuInput.value.trim();
  if (name === "") { addErrorEl.textContent = "메뉴 이름을 입력해 주세요."; return; }
  if (menus.some((m) => m.name === name)) { addErrorEl.textContent = "이미 있는 메뉴예요."; return; }

  menus.push({ name, category: categorySelect.value, enabled: true, eaten: false });
  menuInput.value = "";
  addErrorEl.textContent = "";
  clearSearch();      // 새 메뉴가 검색 때문에 안 보이는 일 방지
  render();
  menuInput.focus();
}

function commitEdit(menu, rawName, category) {
  const name = rawName.trim();
  if (name === "") { addErrorEl.textContent = "메뉴 이름을 입력해 주세요."; return; }
  if (menus.some((m) => m !== menu && m.name === name)) { addErrorEl.textContent = "이미 있는 메뉴예요."; return; }

  menu.name = name;
  menu.category = category;
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

$("selectAllBtn").addEventListener("click", () => { getListed().forEach((m) => (m.enabled = true)); render(); });
$("clearAllBtn").addEventListener("click", () => { getListed().forEach((m) => (m.enabled = false)); render(); });
$("resetEatenBtn").addEventListener("click", () => { menus.forEach((m) => (m.eaten = false)); render(); });

excludeCheck.addEventListener("change", () => { excludeEaten = excludeCheck.checked; render(); });

$("clearHistoryBtn").addEventListener("click", () => { history = []; render(); });

$("resetMenusBtn").addEventListener("click", () => {
  if (!confirm("메뉴를 기본 목록으로 되돌릴까요? 추가·수정한 내용이 사라져요.")) return;
  menus = defaultMenus();
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
  if (menu) menu.eaten = true;
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

applyTheme(initialTheme());
render();
