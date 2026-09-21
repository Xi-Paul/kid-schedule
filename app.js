/* app.js — 화면과 로직.
 * 저장소 접근은 전부 github.js 의 GH.Repo 를 통합니다.
 * 토큰은 이 파일에 없습니다. 사용자가 설정 탭에서 넣은 값을 localStorage 에서 읽습니다.
 */
"use strict";

/* ===================== 상수 ===================== */
const DOW = ["일", "월", "화", "수", "목", "금", "토"];
const KINDS = [
  { id: "school",  name: "학교",          color: "#3B82F6", emoji: "🏫" },
  { id: "academy", name: "학원",          color: "#A855F7", emoji: "📚" },
  { id: "study",   name: "공부·숙제",     color: "#F59E0B", emoji: "✏️" },
  { id: "sport",   name: "운동",          color: "#10B981", emoji: "⚽" },
  { id: "life",    name: "생활",          color: "#EC4899", emoji: "🪥" },
  { id: "play",    name: "놀이·쉬는 시간", color: "#06B6D4", emoji: "🎮" }
];
const kindOf = id => KINDS.find(k => k.id === id) || KINDS[0];

const STATE_LABEL = {
  locked:  "아직",
  todo:    "대기",
  running: "하는 중",
  done:    "완료",
  over:    "시간 초과",
  missed:  "놓침"
};

const LS = {
  conn:   "ks2.conn.v1",     // owner/repo/branch/statusRepo/role
  token:  "ks2.token.v1",
  sched:  "ks2.sched.cache.v1",
  notify: "ks2.notify.v1"
};

/* ===================== 상태 ===================== */
let cfg = null;              // config.json + 로컬 override
let conn = null;             // 접속 설정
let schedRepo = null, statusRepo = null;
let sched = null;            // 일정
let schedSha = null;
let dayKey = "";             // 오늘 YYYY-MM-DD
let day = { date: "", items: {} };   // 오늘 진행 기록
let dirty = new Set();       // 아직 저장소에 못 보낸 항목 id
let flushTimer = null;
let notifyOn = false;
let firedMap = {};
let recCache = null;

const role = () => (conn && conn.role) || "viewer";
const isParent = () => role() === "parent";
const canWrite = () => !!(statusRepo && statusRepo.authed);

/* ===================== 유틸 ===================== */
const $ = id => document.getElementById(id);
const pad = n => String(n).padStart(2, "0");
const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const mins = hm => { const [h, m] = String(hm).split(":").map(Number); return h * 60 + m; };
const hhmm = m => `${pad(Math.floor(m / 60) % 24)}:${pad(Math.round(m) % 60)}`;
const uid = () => Math.random().toString(36).slice(2, 9);
const nowDate = () => new Date();
const nowMin = () => { const d = nowDate(); return d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60; };

function human(m) {
  m = Math.max(0, Math.round(m));
  if (m < 60) return `${m}분`;
  const h = Math.floor(m / 60), r = m % 60;
  return r ? `${h}시간 ${r}분` : `${h}시간`;
}
function readLS(k, fb) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : fb; } catch (e) { return fb; } }
function writeLS(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { } }
function toast(msg) {
  const t = $("toast");
  t.textContent = msg; t.classList.add("show");
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove("show"), 2600);
}
function download(name, text, mime) {
  const url = URL.createObjectURL(new Blob([text], { type: mime + ";charset=utf-8" }));
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}
function syncState(s, text) {
  const el = $("syncline");
  el.dataset.s = s;
  $("syncText").textContent = text;
}

/* ===================== 제한시간 · 체크 시간창 ===================== */
/** 이 일정의 제한시간(분). 명시값 > 종료-시작 > 60분 */
function limitOf(e) {
  if (e.limitMin != null && e.limitMin !== "") return Number(e.limitMin);
  if (e.end) return Math.max(1, mins(e.end) - mins(e.start));
  return 60;
}
/** 체크 가능한 시간창(분 단위, 자정 기준) */
function windowOf(e) {
  const s = mins(e.start);
  const en = e.end ? mins(e.end) : s + limitOf(e);
  return { startM: s, endM: en, openM: s - cfg.check.beforeMin, closeM: en + cfg.check.afterMin };
}
/** 저장된 기록 + 현재 시각으로 상태를 판정 */
function stateOf(e, rec, nm) {
  if (rec && (rec.state === "done" || rec.state === "over")) return rec.state;
  if (rec && rec.state === "running") return "running";
  const w = windowOf(e);
  if (nm < w.openM) return "locked";
  if (nm > w.closeM) return "missed";
  return "todo";
}
/** 진행 중인 항목의 경과(분) */
function elapsedOf(rec) {
  if (!rec || !rec.startedAt) return null;
  const end = rec.doneAt ? new Date(rec.doneAt) : nowDate();
  return (end - new Date(rec.startedAt)) / 60000;
}

/* ===================== 일정 데이터 ===================== */
function emptySched() { return { version: 2, student: "", notifyBeforeMin: 10, weekly: [], once: [] }; }
function normalize(d) {
  const o = Object.assign(emptySched(), d || {});
  const fix = e => ({
    id: e.id || uid(), start: e.start, end: e.end || "",
    limitMin: (e.limitMin === "" || e.limitMin == null) ? null : Number(e.limitMin),
    title: e.title || "", kind: e.kind || "school", place: e.place || "",
    track: e.track === false ? false : true          // false = 진행 체크 대상이 아님(학교 등)
  });
  o.weekly = (o.weekly || []).map(e => Object.assign(fix(e), { day: Number(e.day), off: e.off || [] }))
    .filter(e => e.start && e.title && e.day >= 0 && e.day <= 6);
  o.once = (o.once || []).map(e => Object.assign(fix(e), { date: e.date }))
    .filter(e => e.date && e.start && e.title);
  o.notifyBeforeMin = Number(o.notifyBeforeMin ?? 10);
  return o;
}
function eventsOn(date) {
  const key = ymd(date), dw = date.getDay(), out = [];
  for (const e of sched.weekly) if (e.day === dw && !(e.off || []).includes(key)) out.push(e);
  for (const e of sched.once) if (e.date === key) out.push(e);
  return out.sort((a, b) => mins(a.start) - mins(b.start) || a.title.localeCompare(b.title));
}

/* ===================== 저장소 연결 ===================== */
async function loadConfig() {
  let base = {};
  try { base = await (await fetch("./config.json", { cache: "no-store" })).json(); } catch (e) { }
  cfg = {
    check: Object.assign({ beforeMin: 10, afterMin: 30 }, base.check || {}),
    statusDir: base.statusDir || "status"
  };
  const saved = readLS(LS.conn, null);
  conn = Object.assign({
    owner: base.owner || "", repo: base.repo || "", branch: base.branch || "main",
    statusOwner: base.statusOwner || null, statusRepo: base.statusRepo || null,
    statusBranch: base.statusBranch || "main",
    role: "viewer"
  }, saved || {});
  buildRepos();
}
function buildRepos() {
  const token = readLS(LS.token, "") || "";
  schedRepo = new GH.Repo({ owner: conn.owner, repo: conn.repo, branch: conn.branch, token });
  statusRepo = new GH.Repo({
    owner: conn.statusOwner || conn.owner,
    repo: conn.statusRepo || conn.repo,
    branch: conn.statusBranch || conn.branch,
    token
  });
}
const statusPath = key => `${cfg.statusDir}/${key}.json`;

/* ===================== 로드 ===================== */
async function loadSchedule() {
  // 1순위 API(최신 보장) → 2순위 Pages 사본 → 3순위 로컬 캐시
  if (schedRepo.authed) {
    try {
      const r = await schedRepo.readJson("schedule.json");
      if (!r.missing) { sched = normalize(r.data); schedSha = r.sha; writeLS(LS.sched, sched); return "api"; }
    } catch (e) { syncState("err", e.message); }
  }
  try {
    const r = await fetch("./schedule.json", { cache: "no-store" });
    if (r.ok) { sched = normalize(await r.json()); writeLS(LS.sched, sched); return "pages"; }
  } catch (e) { }
  const cached = readLS(LS.sched, null);
  sched = cached ? normalize(cached) : emptySched();
  return cached ? "cache" : "empty";
}

async function loadDay(force) {
  const key = ymd(nowDate());
  if (!force && day.date === key && !recCacheStale()) { /* 계속 진행 */ }
  dayKey = key;
  let remote = null;
  try {
    const r = statusRepo.authed
      ? await statusRepo.readJson(statusPath(key))
      : await statusRepo.readJsonPublic(statusPath(key));
    remote = r.missing ? null : r.data;
    syncState(statusRepo.authed ? "ok" : "ok", statusRepo.authed ? "저장소와 연결됨" : "읽기 전용");
  } catch (e) {
    syncState("err", e.message);
  }
  day = mergeDay(remote, key);
}
function recCacheStale() { return true; }

/** 원격 기록을 받되, 아직 못 보낸 로컬 변경(dirty)은 지키고 합칩니다. */
function mergeDay(remote, key) {
  const base = { date: key, updatedAt: null, items: {} };
  if (remote && remote.date === key && remote.items) Object.assign(base.items, remote.items);
  if (remote) base.updatedAt = remote.updatedAt || null;
  for (const id of dirty) {
    const v = day.items ? day.items[id] : undefined;
    if (v === undefined || v === null) delete base.items[id];
    else base.items[id] = v;
  }
  return base;
}

/* ===================== 저장 (디바운스 커밋) ===================== */
function markDirty(id) {
  dirty.add(id);
  syncState("busy", "저장 대기");
  clearTimeout(flushTimer);
  flushTimer = setTimeout(flush, 2500);
}
async function flush() {
  clearTimeout(flushTimer);
  if (!dirty.size) return;
  if (!canWrite()) { syncState("err", "토큰이 없어 저장소에 못 씁니다"); return; }

  const ids = [...dirty];
  const snap = new Map(ids.map(id => [id, day.items[id] ?? null]));
  syncState("busy", "저장 중");
  try {
    const r = await statusRepo.updateJson(statusPath(dayKey), cur => {
      const base = (cur && cur.date === dayKey && cur.items) ? cur : { date: dayKey, items: {} };
      base.items = base.items || {};
      for (const [id, v] of snap) { if (v === null) delete base.items[id]; else base.items[id] = v; }
      base.student = sched.student || "";
      base.updatedAt = new Date().toISOString();
      return base;
    }, `chore(status): ${dayKey} 진행 기록`);

    for (const id of ids) if (day.items[id] === (snap.get(id) ?? undefined) || snap.get(id) === null) dirty.delete(id);
    ids.forEach(id => dirty.delete(id));
    if (r.data) day = mergeDay(r.data, dayKey);
    const extra = r.attempts > 1 ? ` (${r.attempts}회 시도)` : "";
    syncState("ok", `저장됨 ${new Date().toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" })}${extra}`);
    recCache = null;
    render();
  } catch (e) {
    syncState("err", e.message);
    toast(e.message);
  }
}

/* ===================== 동작 ===================== */
function setRec(e, rec) {
  if (rec === null) delete day.items[e.id]; else day.items[e.id] = rec;
  markDirty(e.id);
  render();
}
function startTask(e) {
  const nm = nowMin(), w = windowOf(e);
  if (!isParent() && nm < w.openM) { toast(`${hhmm(w.openM)}부터 시작할 수 있어요`); return; }
  setRec(e, {
    state: "running",
    startedAt: nowDate().toISOString(),
    doneAt: null,
    elapsedMin: null,
    limitMin: limitOf(e),
    by: role()
  });
  global_NA()?.armLimit(e, day.items[e.id]);
  toast(`${e.title} 시작 — 제한 ${limitOf(e)}분`);
}
function completeTask(e) {
  const nm = nowMin(), w = windowOf(e);
  const prev = day.items[e.id];
  if (!isParent() && nm > w.closeM && !prev) {
    toast(`체크 시간이 지났습니다 (${hhmm(w.closeM)}까지)`); return;
  }
  const lim = limitOf(e);
  const doneAt = nowDate().toISOString();
  const el = prev && prev.startedAt ? (new Date(doneAt) - new Date(prev.startedAt)) / 60000 : null;
  const over = el != null && el > lim;
  setRec(e, {
    state: over ? "over" : "done",
    startedAt: prev ? prev.startedAt : null,
    doneAt,
    elapsedMin: el == null ? null : Math.round(el),
    limitMin: lim,
    by: role()
  });
  global_NA()?.disarmLimit(e);
  toast(over ? `${e.title} 완료 — 제한보다 ${human(el - lim)} 더 걸렸어요`
             : el == null ? `${e.title} 완료` : `${e.title} 완료 — ${human(el)}`);
}
function undoTask(e) { setRec(e, null); global_NA()?.disarmLimit(e); toast("되돌렸습니다"); }

/* ===================== 렌더 ===================== */
function renderHeader() {
  const now = nowDate();
  $("todayLabel").textContent = `${now.getMonth() + 1}월 ${now.getDate()}일 ${DOW[now.getDay()]}요일`;
  const hero = $("hero"), what = $("heroWhat"), when = $("heroWhen");
  const nm = nowMin();
  const list = eventsOn(now);

  const running = list.find(e => (day.items[e.id] || {}).state === "running");
  if (running) {
    const rec = day.items[running.id], el = elapsedOf(rec), lim = rec.limitMin || limitOf(running);
    hero.classList.remove("idle");
    what.textContent = `${kindOf(running.kind).emoji} ${running.title}`;
    when.textContent = el > lim
      ? `${human(el)} 경과 — 제한 ${lim}분을 ${human(el - lim)} 넘었어요`
      : `${human(el)} 경과 — ${human(lim - el)} 남음`;
    return;
  }
  const live = list.find(e => { const w = windowOf(e); return w.startM <= nm && nm < w.endM; });
  const next = list.find(e => mins(e.start) > nm);
  if (live) {
    hero.classList.remove("idle");
    what.textContent = `${kindOf(live.kind).emoji} ${live.title}`;
    when.textContent = live.end ? `${live.end}에 끝나요` : "지금 할 시간";
  } else if (next) {
    hero.classList.remove("idle");
    what.textContent = `${kindOf(next.kind).emoji} ${next.title}`;
    when.textContent = `${human(mins(next.start) - nm)} 뒤 · ${next.start}`;
  } else {
    hero.classList.add("idle");
    what.textContent = list.length ? "오늘 일정 끝! 🎉" : "오늘은 일정이 없어요";
    when.textContent = list.length ? "푹 쉬자" : "";
  }
}

function renderToday() {
  const wrap = $("timeline");
  const now = nowDate(), nm = nowMin();
  const list = eventsOn(now);
  wrap.innerHTML = "";
  if (!list.length) {
    wrap.innerHTML = `<div class="empty"><strong>오늘은 비어 있어요</strong>일정 탭에서 추가할 수 있습니다.</div>`;
    return;
  }
  let ruled = false;
  for (const e of list) {
    if (!ruled && mins(e.start) > nm) { wrap.appendChild(nowRule(now)); ruled = true; }
    wrap.appendChild(eventRow(e, nm));
  }
  if (!ruled) wrap.appendChild(nowRule(now));
}
function nowRule(now) {
  const d = document.createElement("div");
  d.className = "nowline";
  d.innerHTML = `<div class="clock">${pad(now.getHours())}:${pad(now.getMinutes())}</div><div class="rule"></div>`;
  return d;
}
/** 진행 체크 대상이 아닌 일정 — 시간만 보여줍니다 */
function plainRow(e, nm) {
  const k = kindOf(e.kind);
  const w = windowOf(e);
  const li = document.createElement("li");
  li.innerHTML = `
    <div class="clock">${e.start}${e.end ? `<small>${e.end}</small>` : ""}</div>
    <div class="ev" style="--c:${k.color}" data-st="plain" data-live="${w.startM <= nm && nm < w.endM ? 1 : 0}">
      <div class="ev-top">
        <span class="emoji">${k.emoji}</span>
        <span class="body"><span class="title"></span><span class="sub"></span></span>
      </div>
    </div>`;
  li.querySelector(".title").textContent = e.title;
  li.querySelector(".sub").textContent = [k.name, e.place].filter(Boolean).join(" · ");
  return li;
}

function eventRow(e, nm) {
  const k = kindOf(e.kind);
  if (e.track === false) return plainRow(e, nm);
  const rec = day.items[e.id] || null;
  const st = stateOf(e, rec, nm);
  const lim = (rec && rec.limitMin) || limitOf(e);
  const w = windowOf(e);
  const el = st === "running" ? elapsedOf(rec) : (rec && rec.elapsedMin != null ? rec.elapsedMin : null);

  const li = document.createElement("li");
  li.innerHTML = `
    <div class="clock">${e.start}${e.end ? `<small>${e.end}</small>` : ""}</div>
    <div class="ev" style="--c:${k.color}" data-st="${st}" data-live="${w.startM <= nm && nm < w.endM ? 1 : 0}">
      <div class="ev-top">
        <span class="emoji">${k.emoji}</span>
        <span class="body"><span class="title"></span><span class="sub"></span></span>
        <span class="badge ${st}">${STATE_LABEL[st]}</span>
      </div>
      <div class="slot"></div>
      <div class="acts"></div>
    </div>`;
  li.querySelector(".title").textContent = e.title;
  li.querySelector(".sub").textContent =
    [k.name, e.place, `제한 ${lim}분`].filter(Boolean).join(" · ");

  // 제한시간 진행바
  if (el != null) {
    const pct = Math.min(100, (el / lim) * 100);
    const over = el > lim;
    li.querySelector(".slot").innerHTML =
      `<div class="bar" data-over="${over ? 1 : 0}"><i style="width:${pct}%"></i></div>
       <div class="limitline"><span>${human(el)} 경과</span><span>${over ? `제한 ${lim}분 초과 ${human(el - lim)}` : `${human(lim - el)} 남음`}</span></div>`;
  } else if (st === "locked") {
    li.querySelector(".slot").innerHTML =
      `<div class="limitline"><span>${hhmm(w.openM)}부터 체크할 수 있어요</span><span></span></div>`;
  } else if (st === "todo" || st === "missed") {
    li.querySelector(".slot").innerHTML =
      `<div class="limitline"><span>체크 가능 ${hhmm(w.openM)} – ${hhmm(w.closeM)}</span><span></span></div>`;
  }

  // 버튼
  const acts = li.querySelector(".acts");
  const add = (text, cls, fn, dis) => {
    const b = document.createElement("button");
    b.className = "btn small " + cls; b.textContent = text; b.type = "button";
    if (dis) b.disabled = true; else b.addEventListener("click", fn);
    acts.appendChild(b);
  };
  if (!canWrite()) {
    acts.innerHTML = `<span class="limitline" style="margin:0">읽기 전용 — 설정에서 토큰을 넣으면 체크할 수 있습니다</span>`;
  } else if (st === "locked") {
    add("시작", "go", null, true);
  } else if (st === "todo") {
    add("시작", "go", () => startTask(e));
    add("바로 완료", "", () => completeTask(e));
  } else if (st === "running") {
    add("완료", "primary", () => completeTask(e));
    add("취소", "", () => undoTask(e));
  } else if (st === "done" || st === "over") {
    add("되돌리기", "", () => undoTask(e));
  } else if (st === "missed") {
    if (isParent()) add("완료로 표시", "", () => completeTask(e));
    else add("시간 지남", "", null, true);
  }
  return li;
}

function renderWeek() {
  const grid = $("weekGrid");
  const today = nowDate();
  const mon = new Date(today);
  mon.setDate(today.getDate() - ((today.getDay() + 6) % 7));
  grid.innerHTML = "";
  for (let i = 0; i < 7; i++) {
    const d = new Date(mon); d.setDate(mon.getDate() + i);
    const list = eventsOn(d);
    const isToday = ymd(d) === ymd(today);
    const box = document.createElement("div");
    box.className = "day" + (isToday ? " is-today" : "");
    let doneCnt = 0;
    const tracked = list.filter(e => e.track !== false);
    if (isToday) doneCnt = tracked.filter(e => ["done", "over"].includes((day.items[e.id] || {}).state)).length;
    box.innerHTML = `<h3>${DOW[d.getDay()]}<span>${d.getMonth() + 1}.${d.getDate()}${isToday && tracked.length ? ` · ${doneCnt}/${tracked.length}` : ""}</span></h3>`;
    if (!list.length) box.insertAdjacentHTML("beforeend", `<p class="none">없음</p>`);
    else {
      const ul = document.createElement("ul");
      for (const e of list) {
        const k = kindOf(e.kind);
        const li = document.createElement("li");
        li.style.setProperty("--c", k.color);
        li.innerHTML = `<b></b><i>${e.start}${e.end ? `–${e.end}` : ""}${e.track === false ? "" : " · 제한 " + limitOf(e) + "분"}</i>`;
        li.querySelector("b").textContent = e.title;
        ul.appendChild(li);
      }
      box.appendChild(ul);
    }
    grid.appendChild(box);
  }
}

/* ---- 기록 ---- */
async function renderRecords(force) {
  const box = $("recBody");
  if (recCache && !force) { paintRecords(recCache); return; }
  box.innerHTML = `<p class="hint">최근 7일 기록을 불러오는 중…</p>`;
  const days = [];
  for (let i = 0; i < 7; i++) { const d = nowDate(); d.setDate(d.getDate() - i); days.push(ymd(d)); }
  const out = [];
  for (const key of days) {
    try {
      const r = statusRepo.authed
        ? await statusRepo.readJson(statusPath(key))
        : await statusRepo.readJsonPublic(statusPath(key));
      out.push({ key, data: r.missing ? null : r.data });
    } catch (e) { out.push({ key, data: null, error: e.message }); }
  }
  recCache = out;
  paintRecords(out);
}
function paintRecords(rows) {
  const idx = {};
  for (const e of sched.weekly.concat(sched.once)) idx[e.id] = e;

  let total = 0, done = 0, over = 0;
  const per = {};
  const dayRows = [];

  for (const { key, data } of rows) {
    const d = new Date(key + "T12:00:00");
    const planned = eventsOn(d).filter(e => e.track !== false);
    const items = (data && data.items) || {};
    let dDone = 0, dOver = 0;
    for (const e of planned) {
      total++;
      const r = items[e.id];
      if (r && (r.state === "done" || r.state === "over")) {
        done++; dDone++;
        if (r.state === "over") { over++; dOver++; }
        if (r.elapsedMin != null) {
          per[e.id] = per[e.id] || { title: e.title, n: 0, sum: 0, over: 0, limit: r.limitMin || limitOf(e) };
          per[e.id].n++; per[e.id].sum += r.elapsedMin;
          if (r.state === "over") per[e.id].over++;
        }
      }
    }
    dayRows.push({ key, dow: DOW[d.getDay()], planned: planned.length, done: dDone, over: dOver });
  }

  const rate = total ? Math.round((done / total) * 100) : 0;
  let html = `<div class="stats">
      <div class="stat"><b>${rate}%</b><span>7일 완료율</span></div>
      <div class="stat"><b>${done}/${total}</b><span>완료 / 계획</span></div>
      <div class="stat"><b>${over}</b><span>제한시간 초과</span></div>
    </div>`;

  html += `<div class="panel"><h2>날짜별</h2><table class="rec"><thead><tr>
      <th>날짜</th><th>요일</th><th class="num">계획</th><th class="num">완료</th><th class="num">초과</th></tr></thead><tbody>`;
  for (const r of dayRows) {
    html += `<tr><td>${r.key.slice(5)}</td><td>${r.dow}</td>
      <td class="num">${r.planned}</td><td class="num">${r.done}</td>
      <td class="num${r.over ? " over" : ""}">${r.over || "—"}</td></tr>`;
  }
  html += `</tbody></table></div>`;

  const keys = Object.keys(per);
  html += `<div class="panel"><h2>일정별 소요시간</h2>`;
  if (!keys.length) {
    html += `<p class="hint">아직 "시작"을 눌러 측정한 기록이 없습니다. 시작을 눌러야 소요시간이 남습니다.</p>`;
  } else {
    html += `<table class="rec"><thead><tr><th>일정</th><th class="num">횟수</th>
      <th class="num">평균</th><th class="num">제한</th><th class="num">초과</th></tr></thead><tbody>`;
    for (const id of keys) {
      const p = per[id], avg = Math.round(p.sum / p.n);
      html += `<tr><td>${p.title}</td><td class="num">${p.n}</td>
        <td class="num${avg > p.limit ? " over" : ""}">${avg}분</td>
        <td class="num">${p.limit}분</td><td class="num${p.over ? " over" : ""}">${p.over || "—"}</td></tr>`;
    }
    html += `</tbody></table>`;
  }
  html += `</div>`;
  $("recBody").innerHTML = html;
}

/* ---- 일정 편집 ---- */
function renderEdit() {
  $("editGate").classList.toggle("hidden", isParent());
  $("editBody").classList.toggle("hidden", !isParent());
  if (!isParent()) return;

  const wl = $("weeklyList"), ol = $("onceList");
  const todayK = ymd(nowDate());
  const weekly = [...sched.weekly].sort((a, b) => ((a.day + 6) % 7) - ((b.day + 6) % 7) || mins(a.start) - mins(b.start));
  wl.innerHTML = weekly.length ? "" : `<li style="color:var(--ink-soft)">아직 없습니다.</li>`;
  for (const e of weekly) wl.appendChild(editRow(e, `${DOW[e.day]}요일 ${e.start}${e.end ? `–${e.end}` : ""} · ${e.track === false ? "체크 안 함" : "제한 " + limitOf(e) + "분"}`, "weekly"));

  const once = sched.once.filter(e => e.date >= todayK).sort((a, b) => a.date.localeCompare(b.date) || mins(a.start) - mins(b.start));
  ol.innerHTML = once.length ? "" : `<li style="color:var(--ink-soft)">예정된 일정이 없습니다.</li>`;
  for (const e of once) ol.appendChild(editRow(e, `${e.date} ${e.start}${e.end ? `–${e.end}` : ""} · ${e.track === false ? "체크 안 함" : "제한 " + limitOf(e) + "분"}`, "once"));

  $("fName").value = sched.student || "";
  $("fBefore").value = sched.notifyBeforeMin;
  $("fWinBefore").value = cfg.check.beforeMin;
  $("fWinAfter").value = cfg.check.afterMin;
}
function editRow(e, meta, bucket) {
  const k = kindOf(e.kind);
  const li = document.createElement("li");
  li.innerHTML = `<span class="dot" style="--c:${k.color}"></span>
    <span class="meta"><b></b><span></span></span>
    <button class="btn small danger" type="button">삭제</button>`;
  li.querySelector("b").textContent = `${k.emoji} ${e.title}`;
  li.querySelector(".meta span").textContent = meta + (e.place ? ` · ${e.place}` : "");
  li.querySelector("button").addEventListener("click", () => {
    sched[bucket] = sched[bucket].filter(x => x.id !== e.id);
    writeLS(LS.sched, sched); renderEdit(); renderWeek(); renderToday();
    toast("삭제했습니다. 저장소에 반영하려면 아래 저장 버튼을 누르세요.");
  });
  return li;
}

/* ---- 설정 ---- */
function renderSettings() {
  $("sOwner").value = conn.owner;
  $("sRepo").value = conn.repo;
  $("sBranch").value = conn.branch;
  $("sStatusRepo").value = conn.statusRepo || "";
  $("sRole").value = conn.role;
  $("sToken").value = readLS(LS.token, "") ? "••••••••••••••••" : "";
  const r = schedRepo.rate;
  $("rateInfo").textContent = r.remaining == null
    ? "아직 GitHub에 요청하지 않았습니다."
    : `남은 요청 ${r.remaining}회${r.reset ? ` · ${new Date(r.reset).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" })}에 회복` : ""}`;
  paintNotify();
}

function render() {
  renderHeader(); renderToday(); renderWeek(); renderEdit(); renderSettings();
}

/* APK(Capacitor)에서만 동작. 웹에서는 NativeAlarms 가 없거나 available=false 라 건너뜁니다.
   일정이 바뀔 때마다 안드로이드 알람을 통째로 다시 겁니다. */
let alarmSig = "";
function syncNativeAlarms() {
  if (!(global_NA() && global_NA().available)) return;
  const sig = JSON.stringify([sched.notifyBeforeMin, sched.weekly, sched.once]);
  if (sig === alarmSig) return;
  alarmSig = sig;
  global_NA().syncSchedule(sched, cfg).then(r => {
    if (r && !r.ok) toast("알람 등록 실패: " + r.error);
  });
}
function global_NA() { return typeof NativeAlarms !== "undefined" ? NativeAlarms : null; }

/* ===================== 알림 ===================== */
async function notify(title, body) {
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  const opts = { body, icon: "./icon-192.png", badge: "./icon-192.png", tag: title + body };
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    if (reg && reg.showNotification) return reg.showNotification(title, opts);
  } catch (e) { }
  try { new Notification(title, opts); } catch (e) { }
}
function paintNotify() {
  const bar = $("notifyBar"), txt = $("notifyText"), btn = $("notifyBtn");
  if (!("Notification" in window)) {
    txt.textContent = "이 브라우저는 알림을 지원하지 않습니다. 캘린더 파일을 쓰세요.";
    btn.classList.add("hidden"); return;
  }
  btn.classList.remove("hidden");
  if (Notification.permission === "granted" && notifyOn) {
    bar.classList.add("on"); bar.classList.remove("warn");
    txt.textContent = `알림 켜짐 — 일정 ${sched.notifyBeforeMin}분 전과 제한시간 초과 때 알립니다. 앱이 열려 있을 때만 울립니다.`;
    btn.textContent = "끄기";
  } else if (Notification.permission === "denied") {
    bar.classList.remove("on"); bar.classList.add("warn");
    txt.textContent = "알림이 차단돼 있습니다. 브라우저 사이트 설정에서 허용으로 바꿔 주세요.";
    btn.classList.add("hidden");
  } else {
    bar.classList.remove("on", "warn");
    txt.textContent = "일정 시간에 알림을 받으려면 켜 주세요.";
    btn.textContent = "알림 켜기";
  }
}

/* ===================== 틱 ===================== */
let lastDayKey = "";
function tick() {
  const now = nowDate(), key = ymd(now);
  if (key !== lastDayKey) {
    lastDayKey = key; firedMap = {}; recCache = null;
    loadDay(true).then(render);
    return;
  }
  renderHeader();
  // 진행 중 항목이 있으면 진행바를 위해 오늘 목록도 다시 그림
  if (Object.values(day.items).some(r => r && r.state === "running")) renderToday();

  if (!notifyOn || !("Notification" in window) || Notification.permission !== "granted") return;
  const nm = nowMin(), before = sched.notifyBeforeMin;
  for (const e of eventsOn(now)) {
    const tracked = e.track !== false;
    const rec = day.items[e.id] || null;
    const st = stateOf(e, rec, nm);
    const k = kindOf(e.kind);
    if (!tracked && (st === "todo" || st === "locked" || st === "missed")) {
      const diff0 = mins(e.start) - nm;
      if (before > 0 && diff0 <= before && diff0 > 0 && !firedMap[e.id + "|pre"]) {
        firedMap[e.id + "|pre"] = 1;
        notify(`${k.emoji} ${human(diff0)} 뒤 ${e.title}`, `${e.start} 시작${e.place ? " · " + e.place : ""}`);
      }
      continue;
    }
    if (st === "todo" || st === "locked") {
      const diff = mins(e.start) - nm;
      if (before > 0 && diff <= before && diff > 0 && !firedMap[e.id + "|pre"]) {
        firedMap[e.id + "|pre"] = 1;
        notify(`${k.emoji} ${human(diff)} 뒤 ${e.title}`, tracked ? `${e.start} 시작 · 제한 ${limitOf(e)}분` : `${e.start} 시작${e.place ? " · " + e.place : ""}`);
      }
      if (diff <= 0 && diff > -1.5 && !firedMap[e.id + "|now"]) {
        firedMap[e.id + "|now"] = 1;
        notify(`${k.emoji} ${e.title} 시작!`, tracked ? `제한 ${limitOf(e)}분 · 시작 버튼을 눌러 주세요` : (e.place || "지금 시작할 시간이에요"));
      }
    }
    if (st === "running") {
      const el = elapsedOf(rec), lim = rec.limitMin || limitOf(e);
      if (el > lim && !firedMap[e.id + "|over"]) {
        firedMap[e.id + "|over"] = 1;
        notify(`⏰ ${e.title} 제한시간 초과`, `${lim}분이 지났어요. 지금 ${human(el)} 경과`);
      }
    }
  }
}

/* ===================== ICS ===================== */
function icsEsc(s) { return String(s).replace(/([,;\\])/g, "\\$1").replace(/\n/g, "\\n"); }
function fold(line) {
  if (new Blob([line]).size <= 73) return line;
  const out = []; let buf = "";
  for (const ch of line) {
    if (new Blob([buf + ch]).size > 72) { out.push(buf); buf = " " + ch; } else buf += ch;
  }
  out.push(buf); return out.join("\r\n");
}
const dtL = (d, t) => d.replace(/-/g, "") + "T" + t.replace(":", "") + "00";
function buildIcs() {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").split(".")[0] + "Z";
  const BYDAY = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
  const before = sched.notifyBeforeMin;
  const L = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//kid-schedule//KR//", "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH", "X-WR-CALNAME:" + icsEsc((sched.student ? sched.student + " " : "") + "스케줄"),
    "X-WR-TIMEZONE:Asia/Seoul", "BEGIN:VTIMEZONE", "TZID:Asia/Seoul", "BEGIN:STANDARD",
    "DTSTART:19700101T000000", "TZOFFSETFROM:+0900", "TZOFFSETTO:+0900", "TZNAME:KST",
    "END:STANDARD", "END:VTIMEZONE"];
  const put = (e, dateStr, rrule) => {
    const k = kindOf(e.kind), lim = limitOf(e);
    const endT = e.end || hhmm(mins(e.start) + lim);
    L.push("BEGIN:VEVENT", `UID:${e.id}-${dateStr}@kid-schedule`, `DTSTAMP:${stamp}`,
      `DTSTART;TZID=Asia/Seoul:${dtL(dateStr, e.start)}`, `DTEND;TZID=Asia/Seoul:${dtL(dateStr, endT)}`,
      `SUMMARY:${icsEsc(k.emoji + " " + e.title)}`,
      `DESCRIPTION:${icsEsc("제한시간 " + lim + "분")}`);
    if (e.place) L.push(`LOCATION:${icsEsc(e.place)}`);
    L.push(`CATEGORIES:${icsEsc(k.name)}`);
    if (rrule) L.push(rrule);
    if ((e.off || []).length) L.push("EXDATE;TZID=Asia/Seoul:" + e.off.map(d => dtL(d, e.start)).join(","));
    if (before > 0) L.push("BEGIN:VALARM", "ACTION:DISPLAY", `TRIGGER:-PT${before}M`,
      "DESCRIPTION:" + icsEsc(`${before}분 뒤 ${e.title}`), "END:VALARM");
    L.push("END:VEVENT");
  };
  const today = nowDate(), mon = new Date(today);
  mon.setDate(today.getDate() - ((today.getDay() + 6) % 7));
  for (const e of sched.weekly) {
    const first = new Date(mon); first.setDate(mon.getDate() + ((e.day + 6) % 7));
    put(e, ymd(first), `RRULE:FREQ=WEEKLY;BYDAY=${BYDAY[e.day]}`);
  }
  for (const e of sched.once) put(e, e.date, null);
  L.push("END:VCALENDAR");
  return L.map(fold).join("\r\n") + "\r\n";
}

/* ===================== 이벤트 배선 ===================== */
function wire() {
  document.querySelectorAll("nav.tabs button").forEach(b => {
    b.addEventListener("click", () => {
      document.querySelectorAll("nav.tabs button").forEach(x => x.setAttribute("aria-selected", String(x === b)));
      ["today", "week", "rec", "edit", "set"].forEach(t => $("tab-" + t).classList.toggle("hidden", t !== b.dataset.tab));
      window.scrollTo({ top: 0 });
      if (b.dataset.tab === "rec") renderRecords(false);
    });
  });

  // 일정 추가 폼
  const sel = $("fKind");
  for (const k of KINDS) { const o = document.createElement("option"); o.value = k.id; o.textContent = `${k.emoji} ${k.name}`; sel.appendChild(o); }
  const dows = $("fDows");
  [1, 2, 3, 4, 5, 6, 0].forEach(d => {
    const l = document.createElement("label");
    l.innerHTML = `<input type="checkbox" value="${d}">${DOW[d]}`;
    dows.appendChild(l);
  });

  $("addForm").addEventListener("submit", ev => {
    ev.preventDefault();
    const title = $("fTitle").value.trim(), kind = $("fKind").value;
    const start = $("fStart").value, end = $("fEnd").value, place = $("fPlace").value.trim();
    const limitRaw = $("fLimit").value, date = $("fDate").value;
    const days = [...document.querySelectorAll("#fDows input:checked")].map(i => Number(i.value));
    if (!title || !start) { toast("이름과 시작 시간을 넣어 주세요"); return; }
    if (end && mins(end) <= mins(start)) { toast("끝 시간이 시작보다 빠릅니다"); return; }
    if (!days.length && !date) { toast("요일이나 날짜 중 하나는 골라 주세요"); return; }
    const limitMin = limitRaw === "" ? null : Math.max(1, Number(limitRaw));
    const track = $("fTrack").checked;
    if (days.length) for (const d of days) sched.weekly.push({ id: uid(), day: d, start, end, limitMin, title, kind, place, track, off: [] });
    if (date) sched.once.push({ id: uid(), date, start, end, limitMin, title, kind, place, track });
    writeLS(LS.sched, sched);
    ev.target.reset(); $("fStart").value = start; $("fTrack").checked = true;
    renderEdit(); renderWeek(); renderToday();
    toast("추가했습니다. 아래 저장 버튼으로 저장소에 반영하세요.");
  });

  $("fName").addEventListener("change", e => { sched.student = e.target.value.trim(); writeLS(LS.sched, sched); });
  $("fBefore").addEventListener("change", e => {
    sched.notifyBeforeMin = Math.max(0, Math.min(120, Number(e.target.value) || 0));
    e.target.value = sched.notifyBeforeMin; writeLS(LS.sched, sched); paintNotify();
  });
  $("fWinBefore").addEventListener("change", e => { cfg.check.beforeMin = Math.max(0, Number(e.target.value) || 0); render(); });
  $("fWinAfter").addEventListener("change", e => { cfg.check.afterMin = Math.max(0, Number(e.target.value) || 0); render(); });

  // 일정 저장소에 반영
  $("saveSched").addEventListener("click", async () => {
    if (!schedRepo.authed) { toast("토큰이 없어 저장할 수 없습니다"); return; }
    syncState("busy", "일정 저장 중");
    try {
      const r = await schedRepo.updateJson("schedule.json", () => sched, "chore(schedule): 일정 갱신");
      schedSha = r.sha;
      syncNativeAlarms();
      syncState("ok", "일정 저장됨");
      toast("저장소에 커밋했습니다");
    } catch (e) { syncState("err", e.message); toast(e.message); }
  });
  $("reloadSched").addEventListener("click", async () => {
    if (!confirm("저장소의 schedule.json 을 다시 불러옵니다. 저장하지 않은 편집은 사라집니다.")) return;
    localStorage.removeItem(LS.sched);
    await loadSchedule(); render(); syncNativeAlarms(); toast("다시 불러왔습니다");
  });

  // 설정 저장
  $("saveConn").addEventListener("click", async () => {
    conn.owner = $("sOwner").value.trim();
    conn.repo = $("sRepo").value.trim();
    conn.branch = $("sBranch").value.trim() || "main";
    const sr = $("sStatusRepo").value.trim();
    conn.statusRepo = sr || null;
    conn.statusOwner = sr ? (sr.includes("/") ? sr.split("/")[0] : conn.owner) : null;
    if (sr && sr.includes("/")) conn.statusRepo = sr.split("/")[1];
    conn.role = $("sRole").value;
    writeLS(LS.conn, conn);
    const tv = $("sToken").value;
    if (tv && !/^•+$/.test(tv)) writeLS(LS.token, tv.trim());
    buildRepos();
    syncState("busy", "확인 중");
    try {
      if (schedRepo.authed) {
        const info = await schedRepo.check();
        if (!info.canPush) { syncState("err", "이 토큰에는 쓰기 권한이 없습니다"); toast("Contents를 Read and write로 주세요"); }
        else syncState("ok", `${info.fullName} 연결됨`);
      } else syncState("ok", "읽기 전용");
      await loadSchedule(); await loadDay(true); recCache = null; render();
      toast("설정을 저장했습니다");
    } catch (e) { syncState("err", e.message); toast(e.message); }
  });
  $("clearToken").addEventListener("click", () => {
    if (!confirm("이 기기에 저장된 토큰을 지웁니다.")) return;
    localStorage.removeItem(LS.token); buildRepos(); render(); toast("토큰을 지웠습니다");
  });
  $("syncNow").addEventListener("click", async () => { await flush(); await loadDay(true); recCache = null; render(); toast("동기화했습니다"); });
  $("recReload").addEventListener("click", () => renderRecords(true));

  $("notifyBtn").addEventListener("click", async () => {
    if (notifyOn) { notifyOn = false; writeLS(LS.notify, false); paintNotify(); return; }
    const p = await Notification.requestPermission();
    if (p === "granted") { notifyOn = true; writeLS(LS.notify, true); notify("알림을 켰습니다", "일정 시간과 제한시간 초과를 알려줄게요."); }
    paintNotify();
  });

  $("expIcs").addEventListener("click", () => {
    if (!sched.weekly.length && !sched.once.length) { toast("내보낼 일정이 없습니다"); return; }
    download("schedule.ics", buildIcs(), "text/calendar");
    toast("내려받은 파일을 열면 캘린더에 등록됩니다");
  });
  $("expJson").addEventListener("click", () => download("schedule.json", JSON.stringify(sched, null, 2), "application/json"));

  document.addEventListener("visibilitychange", async () => {
    if (document.hidden) { flush(); return; }
    await loadDay(true); render(); tick();
  });
  window.addEventListener("beforeunload", () => { if (dirty.size) flush(); });
}

/* ===================== 시작 ===================== */
async function boot() {
  wire();
  await loadConfig();
  await loadSchedule();
  lastDayKey = ymd(nowDate());
  await loadDay(true);
  notifyOn = !!readLS(LS.notify, false) && ("Notification" in window) && Notification.permission === "granted";
  render();
  syncNativeAlarms();
  tick();
  setInterval(tick, 5000);
  setInterval(() => { if (!document.hidden && statusRepo.authed && !dirty.size) loadDay(true).then(render); }, 60000);
  try { navigator.serviceWorker?.register("./sw.js", { scope: "./" }).catch(() => { }); } catch (e) { }
}
if (typeof document !== "undefined") boot();
