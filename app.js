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

let who = "";                // 지금 보고 있는 아이 id, 또는 "all"(부모만)
let dayMap = {};             // 아이 id → { date, items }
let dirtyMap = {};           // 아이 id → Set(아직 못 보낸 항목 id)
let flushTimer = null;
let notifyOn = false;
let firedMap = {};
let recCache = null;
let holidays = {};          // "YYYY-MM-DD" → 공휴일 이름
let editing = null;         // 수정 중인 일정 {bucket, id} — null 이면 새로 추가하는 중
let formGeo = null;         // 입력 칸에 올려둔 장소 {lat, lng, radius}

/* ---- 아이 ---- */
const kids = () => (sched && sched.kids) || [];
const kidById = id => kids().find(k => k.id === id) || null;
/** 지금 화면에 걸린 아이들 */
const scopeKids = () => (who === "all" ? kids() : kids().filter(k => k.id === who));
/** 편집·기록처럼 한 명이 정해져야 하는 화면인지 */
const oneKid = () => (who !== "all" && kidById(who)) ? who : null;
const kidTag = e => { const k = kidById(e.kid); return k ? `${k.emoji} ${k.name}` : ""; };

/** 그 일정의 오늘 기록 */
function recOf(e) {
  const d = dayMap[e.kid];
  return (d && d.items[e.id]) || null;
}
function dirtyOf(id) { return dirtyMap[id] || (dirtyMap[id] = new Set()); }

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
/** 일정이 차지하는 시간대 [시작, 끝). 끝이 없으면 제한시간만큼으로 봅니다. */
function spanOf(e) {
  const s0 = mins(e.start);
  return [s0, e.end ? mins(e.end) : s0 + limitOf(e)];
}
/**
 * 같은 날 안에서 시간이 겹치는 일정을 찾습니다.
 * 겹침 기준은 [시작, 끝) — 앞 일정이 끝나는 시각에 다음이 시작하는 건 겹침이 아닙니다.
 * @returns {Map<string, string[]>} 일정 id → 겹치는 상대 이름들
 */
function overlapMap(list) {
  const m = new Map();
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const [as, ae] = spanOf(list[i]), [bs, be] = spanOf(list[j]);
      if (as < be && bs < ae) {
        if (!m.has(list[i].id)) m.set(list[i].id, []);
        if (!m.has(list[j].id)) m.set(list[j].id, []);
        m.get(list[i].id).push(list[j].title);
        m.get(list[j].id).push(list[i].title);
      }
    }
  }
  return m;
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
function emptySched() {
  return { version: 3, kids: [{ id: "kid1", name: "첫째", emoji: "🐯", color: "#3B82F6" }],
           notifyBeforeMin: 10, weekly: [], once: [] };
}
const KID_EMOJI = ["🐯", "🐰", "🐻", "🦊", "🐼", "🐨"];
const KID_COLOR = ["#3B82F6", "#EC4899", "#10B981", "#A855F7", "#F59E0B", "#06B6D4"];
function normalize(d) {
  const o = Object.assign(emptySched(), d || {});

  // 아이 목록. 예전 형식(student 하나)이면 첫째 한 명으로 옮깁니다.
  o.kids = (Array.isArray(d && d.kids) && d.kids.length ? d.kids : null)
    ? d.kids.map((k, i) => ({
        id: String(k.id || "kid" + (i + 1)),
        name: k.name || `아이 ${i + 1}`,
        emoji: k.emoji || KID_EMOJI[i % KID_EMOJI.length],
        color: k.color || KID_COLOR[i % KID_COLOR.length]
      }))
    : [{ id: "kid1", name: (d && d.student) || "첫째", emoji: "🐯", color: "#3B82F6" }];
  delete o.student;
  const defKid = o.kids[0].id;
  const okKid = id => o.kids.some(k => k.id === id) ? id : defKid;
  const fix = e => ({
    id: e.id || uid(), start: e.start, end: e.end || "",
    limitMin: (e.limitMin === "" || e.limitMin == null) ? null : Number(e.limitMin),
    title: e.title || "", kind: e.kind || "school", place: e.place || "",
    track: e.track === false ? false : true,         // false = 진행 체크 대상이 아님(학교 등)
    onHoliday: e.onHoliday === "keep" ? "keep" : "skip",  // 공휴일에 유지할지 쉴지
    geo: (e.geo && e.geo.lat != null && e.geo.lng != null)
      ? { lat: Number(e.geo.lat), lng: Number(e.geo.lng), radius: Number(e.geo.radius) || 300 }
      : null,
    kid: okKid(e.kid)
  });
  o.weekly = (o.weekly || []).map(e => Object.assign(fix(e), { day: Number(e.day), off: e.off || [] }))
    .filter(e => e.start && e.title && e.day >= 0 && e.day <= 6);
  o.once = (o.once || []).map(e => Object.assign(fix(e), { date: e.date }))
    .filter(e => e.date && e.start && e.title);
  o.notifyBeforeMin = Number(o.notifyBeforeMin ?? 10);
  return o;
}
/* ===================== 장소 확인 ===================== */
/*
 * 아이가 시작·완료를 누를 때 "등록된 장소 근처인가"만 기기에서 판정합니다.
 * 좌표는 절대 기록하지 않습니다. 저장되는 값은 here / away / unknown 셋 중 하나뿐입니다.
 * 장소 좌표는 schedule.json 에 소수점 3자리(약 110m 격자)로만 넣습니다.
 */
const LS_GEO = "ks2.geo.v1";
const geoOn = () => !!readLS(LS_GEO, false);

/** 현재 위치 한 번 읽기. 네이티브면 Capacitor, 아니면 브라우저 API. */
async function readPosition(timeout = 8000) {
  const Cap = window.Capacitor;
  if (Cap && Cap.isNativePlatform && Cap.isNativePlatform() && Cap.Plugins && Cap.Plugins.Geolocation) {
    const p = await Cap.Plugins.Geolocation.getCurrentPosition({ enableHighAccuracy: false, timeout });
    return { lat: p.coords.latitude, lng: p.coords.longitude, acc: p.coords.accuracy };
  }
  return new Promise((res, rej) => {
    if (!navigator.geolocation) return rej(new Error("이 기기는 위치를 지원하지 않습니다"));
    navigator.geolocation.getCurrentPosition(
      p => res({ lat: p.coords.latitude, lng: p.coords.longitude, acc: p.coords.accuracy }),
      e => rej(e),
      { enableHighAccuracy: false, timeout, maximumAge: 30000 });
  });
}

/** 두 지점 사이 거리(m) — 하버사인 */
function distM(a, b) {
  const R = 6371000, rad = d => d * Math.PI / 180;
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 +
            Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * 등록된 장소 근처인지 판정합니다.
 * @returns "here" | "away" | "unknown" | null(검사 안 함)
 */
async function checkSpot(e) {
  if (!e.geo || !geoOn()) return null;
  try {
    const pos = await readPosition();
    const allow = (e.geo.radius || 300) + Math.min(pos.acc || 0, 200);  // GPS 오차만큼 넉넉히
    return distM(pos, e.geo) <= allow ? "here" : "away";
    // pos 는 여기서 버려집니다. 어디에도 저장하지 않습니다.
  } catch (err) {
    return "unknown";
  }
}
const SPOT_LABEL = { here: "📍 장소 확인", away: "📍 다른 곳", unknown: "📍 확인 못 함" };

/* ===================== 공휴일 ===================== */
/**
 * holidays.json 을 읽습니다. 연도별로 묶여 있으므로 한 장으로 펼칩니다.
 * 음력 기반(설날·추석·부처님오신날)과 대체공휴일은 매년 날짜가 달라지므로
 * 프로그램으로 계산하지 않고 데이터로 관리합니다. 임시공휴일도 여기에 넣으면 바로 반영됩니다.
 */
async function loadHolidays() {
  try {
    const r = await fetch("./holidays.json", { cache: "no-store" });
    if (!r.ok) throw new Error(r.status);
    const raw = await r.json();
    const flat = {};
    for (const [k, v] of Object.entries(raw)) {
      if (k.startsWith("_") || typeof v !== "object") continue;   // _note 같은 설명 줄은 건너뜀
      Object.assign(flat, v);
    }
    holidays = flat;
  } catch (e) { holidays = {}; }
}
/** 그날이 공휴일이면 이름, 아니면 null */
const holidayOn = key => holidays[key] || null;
/** 그 해 데이터가 하나도 없으면 true — 사용자에게 추가하라고 알려야 합니다 */
function holidayYearMissing(year) {
  return !Object.keys(holidays).some(k => k.startsWith(year + "-"));
}

/** 특정 날짜의 일정 목록 (시작시간 순). 공휴일에 쉬는 반복 일정은 빠집니다. */
function eventsOn(date, kidId) {
  const key = ymd(date), dw = date.getDay(), out = [];
  const hol = holidayOn(key);
  const want = kidId ? [kidId] : scopeKids().map(k => k.id);
  for (const e of sched.weekly) {
    if (!want.includes(e.kid)) continue;
    if (e.day !== dw) continue;
    if ((e.off || []).includes(key)) continue;
    if (hol && e.onHoliday !== "keep") continue;   // 공휴일엔 기본적으로 쉽니다
    out.push(e);
  }
  // 하루짜리 일정은 날짜를 콕 집어 넣은 것이므로 공휴일이어도 그대로 둡니다(예약 등).
  for (const e of sched.once) if (e.date === key && want.includes(e.kid)) out.push(e);
  return out.sort((a, b) => mins(a.start) - mins(b.start) || a.title.localeCompare(b.title));
}

/** 공휴일이라 빠진 반복 일정들 */
function skippedOn(date) {
  const key = ymd(date), dw = date.getDay();
  if (!holidayOn(key)) return [];
  const want = scopeKids().map(k => k.id);
  return sched.weekly.filter(e => want.includes(e.kid) && e.day === dw && e.onHoliday !== "keep" && !(e.off || []).includes(key))
    .sort((a, b) => mins(a.start) - mins(b.start));
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
// 아이마다 다른 파일에 씁니다. 둘이 동시에 체크해도 커밋이 충돌하지 않습니다.
const statusPath = (kid, key) => `${cfg.statusDir}/${kid}/${key}.json`;

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
  dayKey = key;
  let err = null, okCnt = 0;

  for (const k of scopeKids()) {
    let remote = null;
    try {
      const r = statusRepo.authed
        ? await statusRepo.readJson(statusPath(k.id, key))
        : await statusRepo.readJsonPublic(statusPath(k.id, key));
      remote = r.missing ? null : r.data;
      okCnt++;
    } catch (e) { err = e.message; }
    dayMap[k.id] = mergeDay(k.id, remote, key);
  }
  syncState(err ? "err" : "ok",
    err ? err : (statusRepo.authed ? "저장소와 연결됨" : "읽기 전용"));
}

function recCacheStale() { return true; }

/** 원격 기록을 받되, 아직 못 보낸 로컬 변경(dirty)은 지키고 합칩니다. */
function mergeDay(kidId, remote, key) {
  const base = { date: key, updatedAt: null, items: {} };
  if (remote && remote.date === key && remote.items) Object.assign(base.items, remote.items);
  if (remote) base.updatedAt = remote.updatedAt || null;
  const local = dayMap[kidId];
  for (const id of dirtyOf(kidId)) {
    const v = local ? local.items[id] : undefined;
    if (v === undefined || v === null) delete base.items[id];
    else base.items[id] = v;
  }
  return base;
}

/* ===================== 저장 (디바운스 커밋) ===================== */
function markDirty(kidId, id) {
  dirtyOf(kidId).add(id);
  syncState("busy", "저장 대기");
  clearTimeout(flushTimer);
  flushTimer = setTimeout(flush, 2500);
}
async function flush() {
  clearTimeout(flushTimer);
  const pending = Object.keys(dirtyMap).filter(k => dirtyMap[k].size);
  if (!pending.length) return;
  if (!canWrite()) { syncState("err", "토큰이 없어 저장소에 못 씁니다"); return; }

  syncState("busy", "저장 중");
  let failed = null;
  for (const kidId of pending) {
    const ids = [...dirtyMap[kidId]];
    const cur = dayMap[kidId] || { date: dayKey, items: {} };
    const snap = new Map(ids.map(id => [id, cur.items[id] ?? null]));
    try {
      const r = await statusRepo.updateJson(statusPath(kidId, dayKey), remote => {
        const base = (remote && remote.date === dayKey && remote.items) ? remote : { date: dayKey, items: {} };
        base.items = base.items || {};
        for (const [id, v] of snap) { if (v === null) delete base.items[id]; else base.items[id] = v; }
        base.kid = kidId;
        base.name = (kidById(kidId) || {}).name || "";
        base.updatedAt = new Date().toISOString();
        return base;
      }, `chore(status): ${(kidById(kidId) || {}).name || kidId} ${dayKey} 진행 기록`);
      ids.forEach(id => dirtyMap[kidId].delete(id));
      if (r.data) dayMap[kidId] = mergeDay(kidId, r.data, dayKey);
    } catch (e) { failed = e.message; }
  }
  recCache = null;
  if (failed) { syncState("err", failed); toast(failed); }
  else syncState("ok", `저장됨 ${new Date().toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" })}`);
  render();
}

/* ===================== 동작 ===================== */
function setRec(e, rec) {
  const d = dayMap[e.kid] || (dayMap[e.kid] = { date: dayKey, items: {} });
  if (rec === null) delete d.items[e.id]; else d.items[e.id] = rec;
  markDirty(e.kid, e.id);
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
  global_NA()?.armLimit(e, recOf(e));
  toast(`${e.title} 시작 — 제한 ${limitOf(e)}분`);
  applySpot(e, "atStart");
}
function completeTask(e) {
  const nm = nowMin(), w = windowOf(e);
  const prev = recOf(e);
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
  applySpot(e, "atDone");
  toast(over ? `${e.title} 완료 — 제한보다 ${human(el - lim)} 더 걸렸어요`
             : el == null ? `${e.title} 완료` : `${e.title} 완료 — ${human(el)}`);
}
/** 장소 판정을 백그라운드로 돌려 기록에 덧붙입니다. 화면을 막지 않습니다. */
function applySpot(e, field) {
  checkSpot(e).then(spot => {
    if (!spot) return;
    const rec = recOf(e);
    if (!rec) return;              // 그새 되돌렸으면 아무것도 하지 않습니다
    rec[field] = spot;
    markDirty(e.kid, e.id);
    render();
    if (spot === "away") toast(`${e.title} — 등록한 장소가 아닙니다`);
  });
}

function undoTask(e) { setRec(e, null); global_NA()?.disarmLimit(e); toast("되돌렸습니다"); }

/* ===================== 렌더 ===================== */
function renderHeader() {
  const now = nowDate();
  $("todayLabel").textContent = `${now.getMonth() + 1}월 ${now.getDate()}일 ${DOW[now.getDay()]}요일`;
  const hero = $("hero"), what = $("heroWhat"), when = $("heroWhen");
  const nm = nowMin();
  const list = eventsOn(now);
  const hol = holidayOn(ymd(now));
  $("todayLabel").textContent += hol ? `  ·  ${hol}` : "";

  const running = list.find(e => (recOf(e) || {}).state === "running");
  if (running) {
    const rec = recOf(running), el = elapsedOf(rec), lim = rec.limitMin || limitOf(running);
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
    if (hol && !list.length) {
      what.textContent = `🎌 ${hol} — 쉬는 날`;
      when.textContent = "오늘은 일정 없이 쉬어요";
    } else {
      what.textContent = list.length ? "오늘 일정 끝! 🎉" : "오늘은 일정이 없어요";
      when.textContent = list.length ? "푹 쉬자" : "";
    }
  }
}

function renderToday() {
  const wrap = $("timeline");
  const now = nowDate(), nm = nowMin();
  const list = eventsOn(now);
  const hol = holidayOn(ymd(now));
  const skipped = skippedOn(now);
  wrap.innerHTML = "";

  if (hol) {
    const b = document.createElement("div");
    b.className = "holibar";
    b.innerHTML = `<b>🎌 ${hol}</b>` + (skipped.length
      ? `<span>${withEun(skipped.map(e => e.title).join(", "))} 공휴일이라 오늘 쉽니다</span>`
      : `<span>공휴일입니다</span>`);
    wrap.appendChild(b);
  }
  if (!list.length) {
    wrap.insertAdjacentHTML("beforeend",
      `<div class="empty"><strong>${hol ? "푹 쉬는 날이에요" : "오늘은 비어 있어요"}</strong>${hol ? "" : "일정 탭에서 추가할 수 있습니다."}</div>`);
    return;
  }
  // 겹침은 같은 아이 안에서만 따집니다. 두 아이 일정이 같은 시간인 건 정상입니다.
  const ov = new Map();
  for (const k of scopeKids())
    for (const [id, names] of overlapMap(list.filter(e => e.kid === k.id))) ov.set(id, names);
  let ruled = false;
  for (const e of list) {
    if (!ruled && mins(e.start) > nm) { wrap.appendChild(nowRule(now)); ruled = true; }
    wrap.appendChild(eventRow(e, nm, ov.get(e.id)));
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
function plainRow(e, nm, clash) {
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
  li.querySelector(".sub").textContent =
    [who === "all" ? kidTag(e) : "", k.name, e.place].filter(Boolean).join(" · ");
  if (clash && clash.length) li.querySelector(".ev").appendChild(clashLine(clash));
  return li;
}

/** "겹침" 안내 한 줄 */
function clashLine(names) {
  const p = document.createElement("p");
  p.className = "clash";
  p.textContent = `⚠ ${withGwa([...new Set(names)].join(", "))} 시간이 겹칩니다`;
  return p;
}

/** 마지막 글자에 받침이 있는지 */
function hasBatchim(text) {
  const code = String(text).trim().slice(-1).charCodeAt(0);
  return code >= 0xAC00 && code <= 0xD7A3 && (code - 0xAC00) % 28 !== 0;
}
const withGwa = t => `${t}${hasBatchim(t) ? "과" : "와"}`;
const withEun = t => `${t}${hasBatchim(t) ? "은" : "는"}`;
const withEul = t => `${t}${hasBatchim(t) ? "을" : "를"}`;

function eventRow(e, nm, clash) {
  const k = kindOf(e.kind);
  if (e.track === false) return plainRow(e, nm, clash);
  const rec = recOf(e);
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
        <span class="badges"><span class="badge ${st}">${STATE_LABEL[st]}</span></span>
      </div>
      <div class="slot"></div>
      <div class="acts"></div>
    </div>`;
  li.querySelector(".title").textContent = e.title;
  li.querySelector(".sub").textContent =
    [who === "all" ? kidTag(e) : "", k.name, e.place, `제한 ${lim}분`].filter(Boolean).join(" · ");

  // 장소 확인 결과 — 좌표가 아니라 판정 결과만 표시합니다
  const spot = rec && (rec.atDone || rec.atStart);
  if (spot) {
    const b = document.createElement("span");
    b.className = "badge spot-" + spot;
    b.textContent = SPOT_LABEL[spot];
    li.querySelector(".badges").prepend(b);
  }

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

  if (clash && clash.length) li.querySelector(".slot").appendChild(clashLine(clash));

  // 버튼
  const acts = li.querySelector(".acts");
  const add = (text, cls, fn, dis) => {
    const b = document.createElement("button");
    b.className = "btn small " + cls; b.textContent = text; b.type = "button";
    if (dis) b.disabled = true; else b.addEventListener("click", fn);
    acts.appendChild(b);
  };
  if (!canWrite()) {
    acts.remove();                       // 읽기 전용 안내는 위 알림 박스에 한 번만 띄웁니다
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
    const hol = holidayOn(ymd(d));
    const box = document.createElement("div");
    box.className = "day" + (isToday ? " is-today" : "") + (hol ? " is-holiday" : "");
    let doneCnt = 0;
    const tracked = list.filter(e => e.track !== false);
    if (isToday) doneCnt = tracked.filter(e => ["done", "over"].includes((recOf(e) || {}).state)).length;
    box.innerHTML = `<h3>${DOW[d.getDay()]}<span>${d.getMonth() + 1}.${d.getDate()}${isToday && tracked.length ? ` · ${doneCnt}/${tracked.length}` : ""}</span></h3>`;
    if (hol) box.insertAdjacentHTML("beforeend", `<p class="holiname">🎌 ${hol}</p>`);
    if (!list.length) box.insertAdjacentHTML("beforeend", `<p class="none">${hol ? "쉬는 날" : "없음"}</p>`);
    else {
      const ul = document.createElement("ul");
      for (const e of list) {
        const k = kindOf(e.kind);
        const li = document.createElement("li");
        li.style.setProperty("--c", k.color);
        li.innerHTML = `<b></b><i>${who === "all" ? kidTag(e) + " · " : ""}${e.start}${e.end ? `–${e.end}` : ""}${e.track === false ? "" : " · 제한 " + limitOf(e) + "분"}</i>`;
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
  if (!oneKid()) {
    box.innerHTML = `<div class="empty"><strong>아이를 한 명 골라 주세요</strong>기록은 한 명씩 봅니다.</div>`;
    return;
  }
  if (recCache && recCache.kid === who && !force) { paintRecords(recCache.rows); return; }
  box.innerHTML = `<p class="hint">최근 7일 기록을 불러오는 중…</p>`;
  const days = [];
  for (let i = 0; i < 7; i++) { const d = nowDate(); d.setDate(d.getDate() - i); days.push(ymd(d)); }
  const out = [];
  for (const key of days) {
    try {
      const r = statusRepo.authed
        ? await statusRepo.readJson(statusPath(who, key))
        : await statusRepo.readJsonPublic(statusPath(who, key));
      out.push({ key, data: r.missing ? null : r.data });
    } catch (e) { out.push({ key, data: null, error: e.message }); }
  }
  recCache = { kid: who, rows: out };
  paintRecords(out);
}
function paintRecords(rows) {
  const idx = {};
  for (const e of sched.weekly.concat(sched.once)) if (e.kid === who) idx[e.id] = e;

  let total = 0, done = 0, over = 0;
  const per = {};
  const dayRows = [];

  for (const { key, data } of rows) {
    const d = new Date(key + "T12:00:00");
    const planned = eventsOn(d, who).filter(e => e.track !== false);
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
  const gate = $("editGate");
  gate.classList.toggle("hidden", isParent() && oneKid());
  $("editBody").classList.toggle("hidden", !(isParent() && oneKid()));
  if (!isParent()) {
    gate.innerHTML = `설정 탭에서 역할을 <b style="margin:0 4px">부모</b>로 바꾸면 일정을 편집할 수 있습니다.`;
    return;
  }
  if (!oneKid()) {
    gate.innerHTML = `위에서 아이를 한 명 고르면 그 아이의 일정을 편집할 수 있습니다. <b>모두</b> 상태에서는 편집할 수 없습니다.`;
    return;
  }
  const me = kidById(who);
  $("kidLabel").textContent = `${me.emoji} ${me.name}`;

  const wl = $("weeklyList"), ol = $("onceList");
  const todayK = ymd(nowDate());
  const todayDow = nowDate().getDay();

  // 요일별로 묶어서 그립니다. 비어 있는 요일도 보여야 빠진 날을 알 수 있습니다.
  wl.innerHTML = "";
  for (const d of [1, 2, 3, 4, 5, 6, 0]) {
    const items = sched.weekly.filter(e => e.kid === who && e.day === d).sort((a, b) => mins(a.start) - mins(b.start));
    const ov = overlapMap(items);
    const sec = document.createElement("section");
    sec.className = "dgrp" + (d === todayDow ? " is-today" : "") + (ov.size ? " has-clash" : "");
    sec.innerHTML = `<h3><span class="dname">${DOW[d]}요일</span>
        <span class="cnt">${items.length ? items.length + "건" : ""}${ov.size ? ` <b class="clashtag">겹침 ${ov.size}건</b>` : ""}</span>
        <button class="btn small addhere" type="button">+ 추가</button></h3>`;
    sec.querySelector(".addhere").addEventListener("click", () => prefillDay(d));

    if (!items.length) {
      sec.insertAdjacentHTML("beforeend", `<p class="none">없음</p>`);
    } else {
      const ul = document.createElement("ul");
      ul.className = "list";
      for (const e of items) {
        ul.appendChild(editRow(e,
          `${e.start}${e.end ? `–${e.end}` : ""} · ${e.track === false ? "체크 안 함" : "제한 " + limitOf(e) + "분"}${e.onHoliday === "keep" ? " · 공휴일에도 진행" : ""}${e.geo ? " · 📍장소확인" : ""}`,
          "weekly", ov.get(e.id)));
      }
      sec.appendChild(ul);
    }
    wl.appendChild(sec);
  }

  const once = sched.once.filter(e => e.kid === who && e.date >= todayK).sort((a, b) => a.date.localeCompare(b.date) || mins(a.start) - mins(b.start));
  ol.innerHTML = once.length ? "" : `<li style="color:var(--ink-soft)">예정된 일정이 없습니다.</li>`;
  // 하루짜리 일정은 같은 날짜에 있는 것들끼리, 그리고 그날 요일의 반복 일정과도 비교합니다.
  for (const e of once) {
    const sameDay = sched.once.filter(x => x.kid === e.kid && x.date === e.date)
      .concat(sched.weekly.filter(w => w.kid === e.kid && w.day === new Date(e.date + "T12:00:00").getDay()
                                    && !(w.off || []).includes(e.date)));
    const clash = overlapMap(sameDay).get(e.id);
    ol.appendChild(editRow(e, `${e.date} ${e.start}${e.end ? `–${e.end}` : ""} · ${e.track === false ? "체크 안 함" : "제한 " + limitOf(e) + "분"}`, "once", clash));
  }

  $("fName").value = me.name;
  $("fBefore").value = sched.notifyBeforeMin;
  $("fWinBefore").value = cfg.check.beforeMin;
  $("fWinAfter").value = cfg.check.afterMin;
}
/** 입력 칸의 장소 표시를 갱신합니다. */
function paintFormGeo() {
  const el = $("geoState");
  if (!el) return;
  if (formGeo) {
    el.textContent = `등록됨 ${formGeo.lat.toFixed(3)}, ${formGeo.lng.toFixed(3)} · 반경 ${formGeo.radius}m`;
    el.className = "geoset";
    $("fRadius").value = formGeo.radius;
  } else {
    el.textContent = "등록 안 됨 — 장소 확인을 쓰지 않습니다";
    el.className = "";
  }
}

/** 목록에서 고른 일정을 입력 칸에 그대로 올려 수정 모드로 들어갑니다. */
function startEdit(e, bucket) {
  editing = { bucket, id: e.id };
  $("fTitle").value = e.title;
  $("fKind").value = e.kind;
  $("fStart").value = e.start;
  $("fEnd").value = e.end || "";
  $("fLimit").value = e.limitMin == null ? "" : e.limitMin;
  $("fPlace").value = e.place || "";
  $("fDate").value = bucket === "once" ? e.date : "";
  document.querySelectorAll("#fDows input").forEach(i => { i.checked = bucket === "weekly" && Number(i.value) === e.day; });
  $("fTrack").checked = e.track !== false;
  $("fHoli").checked = e.onHoliday === "keep";
  formGeo = e.geo ? { ...e.geo } : null;
  paintFormGeo();

  $("formTitle").textContent = "일정 수정";
  $("fSubmit").textContent = "수정 저장";
  $("fCancel").classList.remove("hidden");
  const b = $("editBanner");
  b.classList.remove("hidden");
  b.textContent = `✏️ ${withEul(e.title)} 고치는 중입니다 — ${bucket === "once" ? e.date : DOW[e.day] + "요일"} ${e.start}. 새로 추가하려면 '수정 취소'를 누르세요.`;
  try { $("addPanel").scrollIntoView({ behavior: "smooth", block: "start" }); }
  catch (err) { window.scrollTo({ top: 0 }); }
  setTimeout(() => $("fTitle").focus(), 300);
}
function cancelEdit(silent) {
  editing = null;
  $("addForm").reset();
  $("fTrack").checked = true; $("fHoli").checked = false;
  formGeo = null; paintFormGeo();
  $("formTitle").textContent = "일정 추가";
  $("fSubmit").textContent = "일정 추가";
  $("fCancel").classList.add("hidden");
  $("editBanner").classList.add("hidden");
  renderEdit();
  if (!silent) toast("수정을 취소했습니다");
}

/** 요일 헤더의 "+ 추가" — 그 요일만 체크하고 입력 칸으로 올려 줍니다. */
function prefillDay(d) {
  if (editing) cancelEdit(true);
  document.querySelectorAll("#fDows input").forEach(i => { i.checked = Number(i.value) === d; });
  $("fDate").value = "";
  try { $("addPanel").scrollIntoView({ behavior: "smooth", block: "start" }); }
  catch (e) { window.scrollTo({ top: 0 }); }
  setTimeout(() => $("fTitle").focus(), 300);
  toast(`${DOW[d]}요일에 추가합니다`);
}

function editRow(e, meta, bucket, clash) {
  const k = kindOf(e.kind);
  const li = document.createElement("li");
  li.innerHTML = `<span class="dot" style="--c:${k.color}"></span>
    <span class="meta"><b></b><span></span></span>
    <button class="btn small btn-edit" type="button">수정</button>
    <button class="btn small danger btn-del" type="button">삭제</button>`;
  li.querySelector("b").textContent = `${k.emoji} ${e.title}`;
  li.querySelector(".meta span").textContent = meta + (e.place ? ` · ${e.place}` : "");
  if (clash && clash.length) li.querySelector(".meta").appendChild(clashLine(clash));

  // 제목 영역을 누르면 바로 수정 모드로 들어갑니다.
  const meta_ = li.querySelector(".meta");
  meta_.classList.add("tapedit");
  meta_.setAttribute("role", "button");
  meta_.setAttribute("tabindex", "0");
  meta_.title = "눌러서 수정";
  const go = () => startEdit(e, bucket);
  meta_.addEventListener("click", go);
  meta_.addEventListener("keydown", ev => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); go(); } });

  if (editing && editing.id === e.id) li.classList.add("editing");

  li.querySelector(".btn-edit").addEventListener("click", go);
  li.querySelector(".btn-del").addEventListener("click", () => {
    if (!confirm(`${withEul(e.title)} 지울까요?`)) return;
    sched[bucket] = sched[bucket].filter(x => x.id !== e.id);
    if (editing && editing.id === e.id) cancelEdit(true);
    writeLS(LS.sched, sched); renderEdit(); renderWeek(); renderToday();
    toast("삭제했습니다. 저장소에 반영하려면 아래 저장 버튼을 누르세요.");
  });
  return li;
}

/* ---- 설정 ---- */
function paintGeoSettings() {
  const b = $("geoToggle");
  if (!b) return;
  const on = geoOn();
  b.textContent = on ? "장소 확인 끄기" : "장소 확인 켜기";
  b.className = "btn" + (on ? " go" : "");
  const withGeo = sched.weekly.concat(sched.once).filter(e => e.geo).length;
  $("geoInfo").textContent = on
    ? `켜짐 — 장소가 등록된 일정 ${withGeo}개. 체크할 때 근처인지만 판정하고 좌표는 저장하지 않습니다.`
    : `꺼짐 — 장소가 등록된 일정은 ${withGeo}개 있지만 이 기기에서는 판정하지 않습니다.`;
}

function renderSettings() {
  $("sOwner").value = conn.owner;
  $("sRepo").value = conn.repo;
  $("sBranch").value = conn.branch;
  $("sStatusRepo").value = conn.statusRepo || "";
  $("sRole").value = conn.role;
  $("sToken").value = readLS(LS.token, "") ? "••••••••••••••••" : "";
  const yr = String(nowDate().getFullYear());
  const hi = $("holiInfo");
  if (holidayYearMissing(yr)) {
    hi.className = "hint warnline";
    hi.textContent = `${yr}년 공휴일이 등록되지 않았습니다. 저장소의 holidays.json 에 추가해 주세요. 그전까지는 공휴일에도 평소대로 일정이 뜹니다.`;
  } else {
    const cnt = Object.keys(holidays).filter(k => k.startsWith(yr + "-")).length;
    const next = Object.keys(holidays).filter(k => k >= ymd(nowDate())).sort()[0];
    hi.className = "hint";
    hi.textContent = `${yr}년 공휴일 ${cnt}일 등록됨` + (next ? ` · 다음 공휴일 ${next} ${holidays[next]}` : "");
  }

  const r = schedRepo.rate;
  $("rateInfo").textContent = r.remaining == null
    ? "아직 GitHub에 요청하지 않았습니다."
    : `남은 요청 ${r.remaining}회${r.reset ? ` · ${new Date(r.reset).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" })}에 회복` : ""}`;
  paintNotify();
  paintGeoSettings();
}

/** 헤더의 아이 선택 버튼 */
function renderKidBar() {
  const bar = $("kidBar");
  if (!bar) return;
  bar.innerHTML = "";
  const opts = kids().map(k => ({ id: k.id, label: `${k.emoji} ${k.name}` }));
  if (kids().length > 1 && isParent()) opts.push({ id: "all", label: "👨‍👩‍👧‍👦 모두" });
  bar.classList.toggle("hidden", opts.length < 2);

  for (const o of opts) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "kidchip" + (who === o.id ? " on" : "");
    b.textContent = o.label;
    b.addEventListener("click", async () => {
      if (who === o.id) return;
      who = o.id;
      conn.who = who; writeLS(LS.conn, conn);
      if (editing) cancelEdit(true);
      recCache = null;
      await loadDay(true);
      render();
      syncNativeAlarms(true);
    });
    bar.appendChild(b);
  }
}

function render() {
  renderKidBar();
  renderHeader(); renderToday(); renderWeek(); renderEdit(); renderSettings();
}

/* APK(Capacitor)에서만 동작. 웹에서는 NativeAlarms 가 없거나 available=false 라 건너뜁니다.
   일정이 바뀔 때마다 안드로이드 알람을 통째로 다시 겁니다. */
let alarmSig = "";
function syncNativeAlarms(force) {
  if (!(global_NA() && global_NA().available)) return;
  const want = scopeKids().map(k => k.id);
  const scoped = {
    notifyBeforeMin: sched.notifyBeforeMin,
    weekly: sched.weekly.filter(e => want.includes(e.kid)),
    once: sched.once.filter(e => want.includes(e.kid))
  };
  const sig = JSON.stringify([who, scoped]);
  if (sig === alarmSig && !force) return;
  alarmSig = sig;
  global_NA().syncSchedule(scoped, cfg).then(r => {
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
  if (!canWrite()) {
    bar.classList.remove("on"); bar.classList.add("warn");
    txt.textContent = "읽기 전용입니다. 체크하려면 설정 탭에서 토큰을 넣어 주세요.";
    btn.classList.add("hidden");
    return;
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
  if (Object.values(dayMap).some(d => Object.values(d.items || {}).some(r => r && r.state === "running"))) renderToday();

  if (!notifyOn || !("Notification" in window) || Notification.permission !== "granted") return;
  const nm = nowMin(), before = sched.notifyBeforeMin;
  for (const e of eventsOn(now)) {
    const tracked = e.track !== false;
    const rec = recOf(e);
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
        notify(`${who === "all" ? kidTag(e) + " · " : ""}${k.emoji} ${human(diff)} 뒤 ${e.title}`, tracked ? `${e.start} 시작 · 제한 ${limitOf(e)}분` : `${e.start} 시작${e.place ? " · " + e.place : ""}`);
      }
      if (diff <= 0 && diff > -1.5 && !firedMap[e.id + "|now"]) {
        firedMap[e.id + "|now"] = 1;
        notify(`${who === "all" ? kidTag(e) + " · " : ""}${k.emoji} ${e.title} 시작!`, tracked ? `제한 ${limitOf(e)}분 · 시작 버튼을 눌러 주세요` : (e.place || "지금 시작할 시간이에요"));
      }
    }
    if (st === "running") {
      const el = elapsedOf(rec), lim = rec.limitMin || limitOf(e);
      if (el > lim && !firedMap[e.id + "|over"]) {
        firedMap[e.id + "|over"] = 1;
        notify(`⏰ ${who === "all" ? kidTag(e) + " " : ""}${e.title} 제한시간 초과`, `${lim}분이 지났어요. 지금 ${human(el)} 경과`);
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
    "METHOD:PUBLISH", "X-WR-CALNAME:" + icsEsc((who === "all" ? "" : (kidById(who) || {}).name + " ") + "스케줄"),
    "X-WR-TIMEZONE:Asia/Seoul", "BEGIN:VTIMEZONE", "TZID:Asia/Seoul", "BEGIN:STANDARD",
    "DTSTART:19700101T000000", "TZOFFSETFROM:+0900", "TZOFFSETTO:+0900", "TZNAME:KST",
    "END:STANDARD", "END:VTIMEZONE"];
  const put = (e, dateStr, rrule) => {
    const k = kindOf(e.kind), lim = limitOf(e);
    const endT = e.end || hhmm(mins(e.start) + lim);
    L.push("BEGIN:VEVENT", `UID:${e.id}-${dateStr}@kid-schedule`, `DTSTAMP:${stamp}`,
      `DTSTART;TZID=Asia/Seoul:${dtL(dateStr, e.start)}`, `DTEND;TZID=Asia/Seoul:${dtL(dateStr, endT)}`,
      `SUMMARY:${icsEsc((who === "all" ? kidTag(e) + " " : "") + k.emoji + " " + e.title)}`,
      `DESCRIPTION:${icsEsc("제한시간 " + lim + "분")}`);
    if (e.place) L.push(`LOCATION:${icsEsc(e.place)}`);
    L.push(`CATEGORIES:${icsEsc(k.name)}`);
    if (rrule) L.push(rrule);
    // 제외일 = 수동 off + (공휴일에 쉬는 일정이면) 그 요일에 걸리는 공휴일
    const ex = new Set(e.off || []);
    if (rrule && e.onHoliday !== "keep") {
      const dow = e.day;
      for (const k of Object.keys(holidays)) {
        if (k >= dateStr && new Date(k + "T12:00:00").getDay() === dow) ex.add(k);
      }
    }
    if (ex.size) L.push("EXDATE;TZID=Asia/Seoul:" + [...ex].sort().map(d => dtL(d, e.start)).join(","));
    if (before > 0) L.push("BEGIN:VALARM", "ACTION:DISPLAY", `TRIGGER:-PT${before}M`,
      "DESCRIPTION:" + icsEsc(`${before}분 뒤 ${e.title}`), "END:VALARM");
    L.push("END:VEVENT");
  };
  const today = nowDate(), mon = new Date(today);
  mon.setDate(today.getDate() - ((today.getDay() + 6) % 7));
  const want = scopeKids().map(k => k.id);
  for (const e of sched.weekly) {
    if (!want.includes(e.kid)) continue;
    const first = new Date(mon); first.setDate(mon.getDate() + ((e.day + 6) % 7));
    put(e, ymd(first), `RRULE:FREQ=WEEKLY;BYDAY=${BYDAY[e.day]}`);
  }
  for (const e of sched.once) if (want.includes(e.kid)) put(e, e.date, null);
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
    const onHoliday = $("fHoli").checked ? "keep" : "skip";

    if (editing) {
      // 수정 — 고른 일정 하나만 바꿉니다. 여러 요일을 한 번에 옮길 수는 없습니다.
      if (days.length > 1) { toast("수정할 때는 요일을 하나만 고르세요"); return; }
      if (days.length && date) { toast("요일과 날짜 중 하나만 고르세요"); return; }
      const cur = sched[editing.bucket].find(x => x.id === editing.id);
      if (!cur) { toast("수정할 일정을 찾지 못했습니다"); cancelEdit(true); return; }

      const moved = date && editing.bucket === "weekly" ? "once"
                  : days.length && editing.bucket === "once" ? "weekly" : null;
      const next = { ...cur, start, end, limitMin, title, kind, place, track, onHoliday, geo: formGeo };
      if (days.length) { next.day = days[0]; delete next.date; }
      if (date) { next.date = date; delete next.day; delete next.off; }

      if (moved) {                       // 반복 ↔ 하루짜리 사이를 옮긴 경우
        sched[editing.bucket] = sched[editing.bucket].filter(x => x.id !== editing.id);
        sched[moved].push(next);
      } else {
        Object.assign(cur, next);
      }
      writeLS(LS.sched, sched);
      cancelEdit(true);
      renderWeek(); renderToday();
      toast(`${withEul(title)} 고쳤습니다. 아래 저장 버튼으로 저장소에 반영하세요.`);
      return;
    }

    if (!oneKid()) { toast("아이를 한 명 고른 뒤 추가하세요"); return; }
    if (days.length) for (const d of days) sched.weekly.push({ id: uid(), kid: who, day: d, start, end, limitMin, title, kind, place, track, onHoliday, geo: formGeo, off: [] });
    if (date) sched.once.push({ id: uid(), kid: who, date, start, end, limitMin, title, kind, place, track, geo: formGeo });
    writeLS(LS.sched, sched);
    ev.target.reset(); $("fStart").value = start; $("fTrack").checked = true; $("fHoli").checked = false;
    formGeo = null; paintFormGeo();
    renderEdit(); renderWeek(); renderToday();

    // 방금 넣은 일정이 기존 것과 겹치는지 바로 알려 줍니다(막지는 않습니다).
    const hits = new Set();
    for (const d of days) {
      const items = sched.weekly.filter(x => x.kid === who && x.day === d);
      const m = overlapMap(items);
      for (const x of items) if (x.title === title && m.has(x.id)) m.get(x.id).forEach(t => hits.add(`${DOW[d]} ${t}`));
    }
    if (date) {
      const dow = new Date(date + "T12:00:00").getDay();
      const items = sched.once.filter(x => x.kid === who && x.date === date)
        .concat(sched.weekly.filter(w => w.kid === who && w.day === dow && !(w.off || []).includes(date)));
      const m = overlapMap(items);
      for (const x of items) if (x.title === title && m.has(x.id)) m.get(x.id).forEach(t => hits.add(t));
    }
    toast(hits.size
      ? `추가했습니다 — ${withGwa([...hits].join(", "))} 시간이 겹칩니다`
      : "추가했습니다. 아래 저장 버튼으로 저장소에 반영하세요.");
  });

  $("fCancel").addEventListener("click", () => cancelEdit());

  // ---- 장소 등록 ----
  $("geoSet").addEventListener("click", async () => {
    toast("위치를 읽는 중…");
    try {
      const pos = await readPosition();
      // 소수점 3자리 = 약 110m 격자. 정확한 주소가 드러나지 않게 반올림해 저장합니다.
      formGeo = {
        lat: Math.round(pos.lat * 1000) / 1000,
        lng: Math.round(pos.lng * 1000) / 1000,
        radius: Math.max(50, Math.min(2000, Number($("fRadius").value) || 300))
      };
      paintFormGeo();
      toast(`장소를 지정했습니다 (측정 오차 약 ${Math.round(pos.acc || 0)}m)`);
    } catch (e) {
      toast("위치를 읽지 못했습니다. 브라우저 위치 권한을 확인하세요.");
    }
  });
  $("geoClear").addEventListener("click", () => { formGeo = null; paintFormGeo(); toast("장소를 지웠습니다"); });
  $("fRadius").addEventListener("change", e => {
    const v = Math.max(50, Math.min(2000, Number(e.target.value) || 300));
    e.target.value = v;
    if (formGeo) { formGeo.radius = v; paintFormGeo(); }
  });

  // ---- 설정: 장소 확인 켜기/끄기 ----
  $("geoToggle").addEventListener("click", async () => {
    if (geoOn()) { writeLS(LS_GEO, false); paintGeoSettings(); toast("장소 확인을 껐습니다"); return; }
    try {
      await readPosition();                  // 권한 요청을 겸합니다
      writeLS(LS_GEO, true); paintGeoSettings(); toast("장소 확인을 켰습니다");
    } catch (e) {
      toast("위치 권한이 없어 켤 수 없습니다");
    }
  });
  $("geoTest").addEventListener("click", async () => {
    const today = eventsOn(nowDate()).filter(e => e.geo);
    if (!today.length) { toast("오늘 일정 중 장소가 등록된 것이 없습니다"); return; }
    toast("위치를 읽는 중…");
    try {
      const pos = await readPosition();
      const lines = today.map(e => `${e.title} ${Math.round(distM(pos, e.geo))}m`);
      $("geoInfo").textContent = `지금 위치 기준 — ${lines.join(" · ")} (측정 오차 약 ${Math.round(pos.acc || 0)}m)`;
    } catch (e) { $("geoInfo").textContent = "위치를 읽지 못했습니다."; }
  });
  $("fName").addEventListener("change", e => {
    const k = kidById(who); if (!k) return;
    k.name = e.target.value.trim() || k.name;
    writeLS(LS.sched, sched); render();
  });
  $("kidAdd").addEventListener("click", () => {
    if (kids().length >= 6) { toast("아이는 6명까지입니다"); return; }
    const i = kids().length;
    const k = { id: "kid" + (i + 1) + uid().slice(0, 3), name: `아이 ${i + 1}`,
                emoji: KID_EMOJI[i % KID_EMOJI.length], color: KID_COLOR[i % KID_COLOR.length] };
    sched.kids.push(k); who = k.id; conn.who = who; writeLS(LS.conn, conn);
    writeLS(LS.sched, sched); render();
    toast(`${k.emoji} ${k.name} 을(를) 추가했습니다. 이름을 바꾸고 일정을 넣으세요.`);
  });
  $("kidDel").addEventListener("click", () => {
    const k = kidById(who); if (!k) return;
    if (kids().length < 2) { toast("마지막 아이는 지울 수 없습니다"); return; }
    const cnt = sched.weekly.concat(sched.once).filter(e => e.kid === k.id).length;
    if (!confirm(`${k.name} 과(와) 그 일정 ${cnt}개를 지울까요? 이미 쌓인 기록 파일은 남습니다.`)) return;
    sched.weekly = sched.weekly.filter(e => e.kid !== k.id);
    sched.once = sched.once.filter(e => e.kid !== k.id);
    sched.kids = sched.kids.filter(x => x.id !== k.id);
    who = sched.kids[0].id; conn.who = who; writeLS(LS.conn, conn);
    writeLS(LS.sched, sched); render();
    toast("지웠습니다. 저장소에 반영하려면 저장 버튼을 누르세요.");
  });
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
    if (who === "all" && !isParent()) who = (kids()[0] || {}).id || "";
    conn.who = who; writeLS(LS.conn, conn);
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
  window.addEventListener("beforeunload", () => { if (Object.values(dirtyMap).some(x => x.size)) flush(); });
}

/* ===================== 시작 ===================== */
async function boot() {
  wire();
  await loadConfig();
  await loadHolidays();
  await loadSchedule();
  who = (conn.who && kidById(conn.who)) ? conn.who
      : (conn.role === "parent" && kids().length > 1 ? "all" : (kids()[0] || {}).id || "");
  lastDayKey = ymd(nowDate());
  await loadDay(true);
  notifyOn = !!readLS(LS.notify, false) && ("Notification" in window) && Notification.permission === "granted";
  render();
  syncNativeAlarms();
  tick();
  setInterval(tick, 5000);
  setInterval(() => {
    if (!document.hidden && statusRepo.authed && !Object.values(dirtyMap).some(x => x.size)) loadDay(true).then(render);
  }, 60000);
  try { navigator.serviceWorker?.register("./sw.js", { scope: "./" }).catch(() => { }); } catch (e) { }
}
if (typeof document !== "undefined") boot();
