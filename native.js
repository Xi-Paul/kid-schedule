/* native.js — APK(Capacitor)에서만 동작하는 네이티브 알림 다리.
 *
 * 웹(PWA)에서는 Capacitor 가 없으므로 전부 무시되고, app.js 의 기존 웹 알림이 그대로 돕니다.
 * APK에서는 안드로이드 AlarmManager 에 알람을 미리 걸어 두므로
 * 앱을 닫아도, 화면이 꺼져 있어도 울립니다. 이게 APK로 가는 유일한 실익입니다.
 *
 * app.js 는 아래 세 곳에서만 이 파일을 부릅니다(없으면 그냥 건너뜁니다):
 *   NativeAlarms.syncSchedule(sched, cfg)  일정이 바뀔 때 — 주간 반복 알람 재등록
 *   NativeAlarms.armLimit(event, rec)      "시작"을 눌렀을 때 — 제한시간 초과 알람 예약
 *   NativeAlarms.disarmLimit(event)        "완료"/"취소" 때 — 그 알람 취소
 */
(function (global) {
  "use strict";

  const Cap = global.Capacitor;
  const native = !!(Cap && typeof Cap.isNativePlatform === "function" && Cap.isNativePlatform());
  const LN = native ? Cap.Plugins.LocalNotifications : null;

  const CHANNEL = "schedule";
  const PRE = 0x00000000;   // 일정 예고 알람 id 대역
  const LIMIT = 0x40000000; // 제한시간 초과 알람 id 대역

  /** 문자열 → 30비트 정수. 알림 id 는 정수여야 합니다. */
  function hash30(s) {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
    return (h >>> 0) & 0x3FFFFFFF;
  }
  const preId = e => hash30("pre:" + e.id) | PRE;
  const limId = e => hash30("lim:" + e.id) | LIMIT;

  const mins = hm => { const [h, m] = String(hm).split(":").map(Number); return h * 60 + m; };

  let ready = false;
  let lastError = null;

  async function init() {
    if (!native || ready) return native;
    try {
      let p = await LN.checkPermissions();
      if (p.display !== "granted") p = await LN.requestPermissions();
      if (p.display !== "granted") { lastError = "알림 권한이 거부됐습니다."; return false; }

      // Android 12+ : 정확한 알람 설정이 꺼져 있으면 알람이 늦게 울리거나 묶입니다.
      if (typeof LN.checkExactNotificationSetting === "function") {
        const ex = await LN.checkExactNotificationSetting();
        if (ex.exact_alarm !== "granted") {
          lastError = "정확한 알람이 꺼져 있습니다. 설정에서 켜 주세요.";
          // 사용자를 설정 화면으로 보냅니다. 돌아오면 앱이 재시작될 수 있습니다.
          if (typeof LN.changeExactNotificationSetting === "function") {
            try { await LN.changeExactNotificationSetting(); } catch (e) { }
          }
        }
      }

      await LN.createChannel({
        id: CHANNEL, name: "일정 알림",
        description: "일정 시작과 제한시간 초과를 알립니다",
        importance: 5, visibility: 1, vibration: true
      });
      ready = true;
      return true;
    } catch (e) {
      lastError = String(e && e.message || e);
      return false;
    }
  }

  /** 예약해 둔 우리 알람을 전부 지웁니다(제한시간 알람은 남깁니다). */
  async function clearScheduled() {
    const pend = await LN.getPending();
    const mine = (pend.notifications || []).filter(n => (n.id & LIMIT) === 0);
    if (mine.length) await LN.cancel({ notifications: mine.map(n => ({ id: n.id })) });
  }

  /**
   * 주간 반복 + 단발 일정을 안드로이드 알람으로 등록합니다.
   * 주간 반복은 on:{weekday,hour,minute} 로 걸어 한 번 등록하면 매주 반복됩니다.
   * Capacitor 의 weekday 는 일요일=1 … 토요일=7 이라 우리 day(일=0)에 1을 더합니다.
   */
  async function syncSchedule(sched, cfg) {
    if (!(await init())) return { ok: false, error: lastError };
    try {
      await clearScheduled();
      const before = Number(sched.notifyBeforeMin || 0);
      const list = [];

      for (const e of sched.weekly || []) {
        let total = mins(e.start) - before;
        let day = e.day;
        if (total < 0) { total += 1440; day = (day + 6) % 7; }   // 전날로 넘어가는 경우
        list.push({
          id: preId(e),
          channelId: CHANNEL,
          title: `${e.title}`,
          body: before > 0
            ? `${before}분 뒤 시작${e.track === false ? "" : ` · 제한 ${limitOf(e)}분`}`
            : `지금 시작${e.track === false ? "" : ` · 제한 ${limitOf(e)}분`}`,
          schedule: {
            on: { weekday: day + 1, hour: Math.floor(total / 60), minute: total % 60 },
            allowWhileIdle: true
          },
          extra: { eventId: e.id }
        });
      }

      const now = Date.now();
      for (const e of sched.once || []) {
        const at = new Date(`${e.date}T${e.start}:00`);
        at.setMinutes(at.getMinutes() - before);
        if (at.getTime() <= now) continue;      // 지난 건 등록하지 않습니다
        list.push({
          id: preId(e), channelId: CHANNEL, title: e.title,
          body: before > 0 ? `${before}분 뒤 시작` : "지금 시작",
          schedule: { at, allowWhileIdle: true },
          extra: { eventId: e.id }
        });
      }

      // 안드로이드는 앱당 예약 알림 수에 상한(약 500)이 있습니다. 넉넉하지만 잘라 둡니다.
      if (list.length > 400) list.length = 400;
      if (list.length) await LN.schedule({ notifications: list });
      return { ok: true, count: list.length };
    } catch (e) {
      lastError = String(e && e.message || e);
      return { ok: false, error: lastError };
    }
  }

  function limitOf(e) {
    if (e.limitMin != null && e.limitMin !== "") return Number(e.limitMin);
    if (e.end) return Math.max(1, mins(e.end) - mins(e.start));
    return 60;
  }

  /** "시작"을 누른 순간 → 제한시간이 끝나는 시각에 일회성 알람을 겁니다. */
  async function armLimit(e, rec) {
    if (!(await init())) return;
    try {
      const lim = Number(rec && rec.limitMin) || limitOf(e);
      const at = new Date(new Date(rec.startedAt).getTime() + lim * 60000);
      if (at.getTime() <= Date.now()) return;
      await LN.schedule({
        notifications: [{
          id: limId(e), channelId: CHANNEL,
          title: `⏰ ${e.title} 제한시간`,
          body: `${lim}분이 지났어요. 다 했으면 완료를 눌러 주세요.`,
          schedule: { at, allowWhileIdle: true },
          extra: { eventId: e.id, kind: "limit" }
        }]
      });
    } catch (err) { lastError = String(err && err.message || err); }
  }

  async function disarmLimit(e) {
    if (!native || !ready) return;
    try { await LN.cancel({ notifications: [{ id: limId(e) }] }); } catch (err) { }
  }

  global.NativeAlarms = {
    available: native,
    init, syncSchedule, armLimit, disarmLimit,
    get lastError() { return lastError; }
  };
})(typeof window !== "undefined" ? window : globalThis);
