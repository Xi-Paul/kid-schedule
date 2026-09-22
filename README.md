# 오늘 뭐 하지 — 초등학생 주간 스케줄 (GitHub 저장소 백엔드)

일정을 보고, **시작·완료를 눌러 제한시간 안에 끝냈는지 기록**하는 웹앱입니다.
별도 서버 없이 GitHub 저장소 자체를 데이터베이스로 씁니다.

- 일정 정의 → `schedule.json` (부모가 편집·커밋)
- 진행 기록 → `status/YYYY-MM-DD.json` (아이가 체크하면 커밋)

---

## 1. 먼저 읽어야 할 보안 제약

**토큰은 절대 저장소에 커밋하지 마세요.** GitHub Pages는 JS를 그대로 브라우저에 내려줍니다.
코드에 PAT를 박으면 페이지를 연 누구나 읽어서 저장소에 쓸 수 있습니다.
이 앱은 토큰을 각 기기의 `localStorage` 에만 두고, 저장소에는 어떤 형태로도 담지 않습니다.

**GitHub 토큰은 경로별 권한을 나눌 수 없습니다.** Fine-grained PAT의 최소 단위는 저장소입니다.
같은 저장소에 `Contents: write` 를 주면 `status/` 뿐 아니라 `schedule.json` 도 쓸 수 있습니다.
앱의 역할(보기만 / 아이 / 부모)은 **화면 구분일 뿐 권한 경계가 아닙니다.**

진짜로 분리하려면 저장소를 둘로 나누세요. 이 앱이 지원합니다.

| 저장소 | 내용 | 부모 토큰 | 아이 토큰 |
|---|---|---|---|
| `kid-schedule` | 앱 코드 + `schedule.json` | Contents: Read and write | **권한 주지 않음** |
| `kid-schedule-status` | `status/*.json` 만 | Contents: Read and write | Contents: Read and write |

아이 기기 토큰이 새도 일정은 건드릴 수 없고, 유출 시 기록 저장소 토큰만 폐기하면 됩니다.

---

## 2. 설치

### 2-1. 저장소 만들기

```bash
git init
git add .
git commit -m "초등학생 주간 스케줄 앱"
git branch -M main
git remote add origin https://github.com/Xi-Paul/kid-schedule.git
git push -u origin main
```

Settings → Pages → Source `Deploy from a branch`, 브랜치 `main / (root)`.
`https://xi-paul.github.io/kid-schedule/` 에서 열립니다.
HTTPS라야 알림 권한과 서비스 워커가 동작합니다.

기록을 분리하려면 빈 저장소 `kid-schedule-status` 를 하나 더 만들고, 그 안에 `status/` 폴더만 두세요.
(`status/README.md` 같은 파일 하나를 커밋하면 폴더가 생깁니다.)

### 2-2. `config.json` 고치기

```jsonc
{
  "owner": "Xi-Paul",
  "repo": "kid-schedule",          // 앱과 일정이 있는 저장소
  "branch": "main",

  "statusOwner": "Xi-Paul",        // 기록 저장소 (한 곳에 다 둘 거면 null)
  "statusRepo": "kid-schedule-status",
  "statusBranch": "main",
  "statusDir": "status",

  "check": { "beforeMin": 10, "afterMin": 30 }   // 체크 허용 시간창
}
```

### 2-3. 토큰 발급

GitHub → Settings → Developer settings → Personal access tokens → **Fine-grained tokens** → Generate new token

1. **Repository access** → Only select repositories → 해당 저장소만 선택
2. **Repository permissions** → **Contents: Read and write** (다른 항목은 건드리지 않음)
3. Expiration을 정하고 생성. 만료되면 다시 발급해 넣어야 합니다.

앱 → 설정 탭 → 소유자·저장소·역할을 넣고 토큰 붙여넣기 → `저장하고 연결 확인`.
쓰기 권한이 없으면 그 자리에서 알려 줍니다.

---

## 3. 제한시간과 체크 시간창

### 제한시간
일정마다 `limitMin` 을 줍니다. 비우면 `끝 − 시작`, 끝도 없으면 60분입니다.

- `시작` 을 누르면 그 순간부터 잽니다. 진행바가 제한시간 대비로 차오릅니다.
- 제한시간을 넘기면 진행바가 노란색이 되고, 알림이 한 번 울립니다.
- `완료` 를 누르면 경과시간이 기록되고, 제한 초과면 상태가 `over`(시간 초과)가 됩니다.
- `시작` 없이 `바로 완료` 를 누르면 완료로만 남고 경과시간은 기록되지 않습니다.
  소요시간 통계에 넣으려면 반드시 `시작` 을 눌러야 합니다.

### 체크 허용 시간창
`시작 − beforeMin` 부터 `종료 + afterMin` 까지만 아이가 체크할 수 있습니다.
창이 열리기 전에는 `아직`(버튼 잠김), 창이 닫힌 뒤에는 `놓침` 으로 고정됩니다.
저녁에 몰아서 전부 체크하는 걸 막기 위한 장치입니다.
부모 역할은 이 제한을 받지 않고 `완료로 표시` 를 쓸 수 있습니다.

### 체크 대상이 아닌 일정
학교처럼 체크할 성질이 아닌 일정은 `"track": false` 로 두세요.
시간만 보이고 배지·버튼·통계에서 빠집니다.

---

## 3-2. 장소 확인 (좌표를 저장하지 않는 방식)

"학원 간다고 하고 진짜 갔는지" 를 확인하는 기능입니다. **실시간 위치 추적이 아닙니다.**

- 부모가 그 장소에 가서 일정 편집의 `지금 위치로 지정` 을 누르면, **소수점 3자리(약 110m 격자)** 로 반올림한
  좌표가 `schedule.json` 에 들어갑니다. 반경은 기본 300m입니다.
- 아이가 `시작`·`완료` 를 누를 때 기기에서 거리를 재고, 결과만 기록합니다.
  저장되는 값은 `here` / `away` / `unknown` 셋 중 하나이며 **좌표는 어디에도 남지 않습니다.**
- 기기마다 설정 탭에서 따로 켜야 합니다. 꺼져 있으면 위치를 아예 읽지 않습니다.
- 장소가 등록되지 않은 일정은 위치를 읽지 않습니다.

기록에는 이렇게만 남습니다.

```jsonc
"taekwon": { "state": "running", "limitMin": 60, "by": "child", "atStart": "here" }
```

### 상시 위치 추적을 넣지 않은 이유

1. **좌표가 git 이력에 영구히 쌓입니다.** 아이 동선을 저장소에 적립하는 셈이고, 그 저장소에 쓰는 토큰이 아이 폰에 있습니다.
2. **앱을 닫은 상태의 위치**는 `ACCESS_BACKGROUND_LOCATION` 과 `location` 타입 포그라운드 서비스가 필요하고,
   상시 알림이 뜹니다. Play Console 별도 선언·심사 대상이며 "포그라운드로 충분하다"고 판단되면 거부됩니다.
   iOS PWA는 아예 불가능합니다.
3. **배터리**가 눈에 띄게 닳습니다.

실시간 위치가 필요하면 OS 기능(안드로이드 Find Hub·Family Link, 삼성 Find, iOS 가족 공유)을 쓰세요.
배터리 최적화가 OS 수준에서 되어 있고, 우리가 데이터를 보관하지 않습니다.

이 앱은 `ACCESS_COARSE_LOCATION` / `ACCESS_FINE_LOCATION` 만 넣고 **앱을 쓰는 동안에만** 위치를 읽습니다.
`ACCESS_BACKGROUND_LOCATION` 은 넣지 않습니다.

**저장소가 Public이면 등록한 장소의 대략 위치가 공개됩니다. 집 주소는 넣지 마세요.**
기상·취침처럼 집에서 하는 일정에는 장소를 등록하지 않으면 됩니다.

## 3-3. 숙제 세부 기록

일정마다 **무엇을 적게 할지** 따로 고릅니다. 완료 체크만 필요한 숙제와, 범위·채점까지 남겨야 하는 숙제를 구분하기 위해서입니다.

| 항목 | `detail` 값 | 입력 모양 |
|---|---|---|
| 페이지 | `pages` | 몇 쪽 ~ 몇 쪽 |
| 채점 | `graded` | 체크 |
| 오답 다시 풀기 | `redo` | 체크 |
| 읽은 책 | `book` | 책 제목 |
| 듣기 | `listen` | 체크 |
| 낭독 | `speak` | 체크 |
| 단어 | `words` | 숫자 (개) |
| 메모 | `memo` | 한 줄 |

쓰는 예입니다.

```jsonc
{ "title": "영어 (아이보람)",   "kind": "study", "detail": ["book", "listen", "speak"] }
{ "title": "수학 (연산·교과)",  "kind": "study", "detail": ["pages", "graded", "redo"] }
{ "title": "독서",             "kind": "read",  "detail": ["book", "pages"] }
```

`시작`을 누르면 카드 안에 입력 칸이 펼쳐지고, 적은 내용은 완료한 뒤에도 한 줄 요약으로 남습니다.
종류를 **독서**로 고르면 `읽은 책`과 `페이지`가 자동으로 켜집니다.

기록 탭에는 최근 7일 **읽은 책 목록**(날짜·제목·쪽)과 **숙제 기록**(범위·채점·오답)이 따로 나옵니다.

## 3-4. 자기주도 — 아이가 스스로 적는 부분

이 앱의 목표는 부모가 짠 일정을 소화시키는 것이 아니라 **아이가 스스로 정하고 돌아보게 하는 것**입니다.
그래서 아이 화면에는 부모 일정과 별개인 두 칸이 있습니다.

**🌱 내가 정한 것** — 아이가 오늘 할 일을 직접 적고, 원하면 제한시간도 스스로 정합니다.
시작·완료를 눌러 걸린 시간이 남습니다.

**오늘 돌아보기** — 스스로 별점(1~5), 오늘 잘한 것, 내일 해볼 것을 한 줄씩.

둘 다 `status/<아이>/<날짜>.json` 에 들어갑니다. **아이 토큰만으로 쓸 수 있고
부모의 `schedule.json` 은 건드리지 않습니다.** 기록 저장소를 분리했다면 권한 경계도 그대로 지켜집니다.

```jsonc
{
  "items": { /* 부모가 짠 일정의 진행 기록 */ },
  "own": {
    "own_k3f9a1": { "title": "과학책 읽기", "kind": "read", "limitMin": 20,
                    "state": "done", "elapsedMin": 12, "madeAt": "..." }
  },
  "reflect": { "rating": 4, "good": "수학 안 미루고 했다", "next": "영어 낭독 크게" }
}
```

리포트에는 **스스로 정한 것 n/N** 과 **하루 돌아보기 평균 점수**가 따로 나옵니다.
부모가 시킨 일의 완료율보다 이 숫자가 늘어나는지를 보는 편이 목표에 맞습니다.

아이를 **모두**로 놓고 보는 화면에서는 누구 것인지 모호해서 두 칸이 숨겨집니다.
한 명을 고르면 나타납니다.

## 3-5. 주간·월간 리포트

`기록` 탭에서 **주간 / 월간**을 고르고 ◀▶ 로 기간을 넘깁니다. 한 명씩 봅니다.

담기는 내용:

- 완료율, 완료/계획, 제한시간 초과 횟수, 평균 소요
- 요일별(주간) 또는 날짜별(월간) 완료 막대 — 공휴일은 🎌 로 표시
- **일정별** 완료/계획, 평균 소요 vs 제한시간, 초과 횟수
  — 같은 이름의 일정은 요일마다 id 가 달라도 한 줄로 묶습니다
- **읽은 책** 목록과 권수
- **숙제 누계** — 푼 분량(쪽), 채점 n/N, 오답 다시 풀기, 듣기, 낭독, 단어
- **스스로 정한 것** 수행 현황, **하루 돌아보기** 점수와 메모
- 메모

`글로 복사` 를 누르면 그대로 카톡·메일에 붙여 넣을 수 있는 글이 됩니다.
클립보드가 막힌 환경이면 `파일로 저장` 을 쓰세요.

```
■ 첫째 주간 공부 리포트 (9.14 ~ 9.20)

완료율 60%  (12/20)
제한시간 초과 1회
평균 소요 36분

[일정별]
 - 영어 (아이보람)  5/5  평균 28분 / 제한 30분
 - 수학 (연산·교과)  5/5  평균 38분 / 제한 40분  초과 1회
...
```

월간은 하루에 파일 하나씩 최대 31번을 읽습니다. 6개씩 병렬로 가져오고 한 번 읽은 날짜는
캐시하므로, 주간↔월간을 오가도 같은 날짜를 다시 받지 않습니다.
인증 요청 한도는 시간당 5,000회라 여유가 큽니다.

> `schedule.json` 의 `id` 는 **저장소 안에서 겹치면 안 됩니다.** 기록이 id 로 묶이기 때문에
> 같은 id 를 두 일정이 쓰면 기록이 섞입니다.

## 3-6. 화면 크기

폰·태블릿·PC 폭에 따라 자동으로 바뀝니다.

| 폭 | 본문 | 주간 | 요일 그룹 | 오늘 화면 |
|---|---|---|---|---|
| ~559 (폰 세로) | 820 | 1칸 | 1칸 | 세로 |
| 560~719 | 820 | 2칸 | 2칸 | 세로 |
| 720~999 (태블릿 세로) | 820 | 3칸 | 2칸 | 세로 |
| 1000~1219 (태블릿 가로) | 1000 | 4칸 | 3칸 | **2단** |
| 1220~1439 | 1180 | 7칸 | 4칸 | 2단 |
| 1440~ | 1280 | 7칸 | 4칸 | 2단 |

태블릿 가로부터는 오늘 화면이 2단이 됩니다. 왼쪽이 시간표, 오른쪽이 아이가 스스로 적는 칸입니다.

손가락으로 쓰는 기기(`pointer: coarse`)에서는 버튼 최소 높이 44px, 입력 칸 44px,
요일 버튼 46px, 별점 34px로 커집니다. 마우스를 쓰는 PC에서는 그대로입니다.

태블릿 가로처럼 세로가 짧을 때(높이 820px 이하)는 헤더가 줄어 목록 공간을 더 씁니다.
표는 좁은 화면에서 가로 스크롤되어 화면 밖으로 밀리지 않습니다.

## 4. 데이터 형식

### `schedule.json`

```jsonc
{
  "version": 3,
  "kids": [                          // 아이 목록. 6명까지
    { "id": "kid1", "name": "첫째", "emoji": "🐯", "color": "#3B82F6" },
    { "id": "kid2", "name": "둘째", "emoji": "🐰", "color": "#EC4899" }
  ],
  "notifyBeforeMin": 10,             // 아이 구분 없이 공통
  "weekly": [
    {
      "id": "hw1",                   // 저장소 안에서 겹치지 않게
      "kid": "kid1",                 // 누구 일정인지
      "day": 1,                      // 0=일 1=월 … 6=토
      "start": "19:00",
      "end": "19:40",
      "limitMin": 40,                // 제한시간. 없으면 끝−시작
      "title": "숙제",
      "kind": "study",               // school academy study sport life play read
      "place": "",
      "track": true,                 // false면 진행 체크 대상 아님
      "onHoliday": "skip",           // "keep" 이면 공휴일에도 진행
      "geo": { "lat": 37.566, "lng": 126.978, "radius": 300 },   // 없으면 장소 확인 안 함
      "detail": ["pages", "graded", "redo"],   // 아이가 적을 항목. 비우면 완료 체크만
      "off": ["2026-10-06"]          // 이 날짜는 건너뜀
    }
  ],
  "once": [
    { "id": "dent", "kid": "kid2", "date": "2026-09-24", "start": "14:00", "end": "15:00",
      "limitMin": 60, "title": "치과", "kind": "life" }
  ]
}
```

예전 형식(`student` 하나, `kid` 없음)을 그대로 두어도 앱이 첫 실행 때 아이 한 명으로 옮깁니다.

### `status/<아이 id>/2026-09-21.json`

앱이 자동으로 만듭니다. 사람이 읽을 수 있는 형태로 커밋됩니다.

```jsonc
{
  "date": "2026-09-21",
  "kid": "kid1",
  "name": "첫째",
  "updatedAt": "2026-09-21T10:50:00.000Z",
  "items": {
    "hw1": {
      "state": "over",                          // todo running done over missed
      "startedAt": "2026-09-21T10:02:00.000Z",  // UTC
      "doneAt":    "2026-09-21T10:50:00.000Z",
      "elapsedMin": 48,
      "limitMin": 40,
      "by": "parent"                            // 마지막으로 바꾼 역할
    }
  }
}
```

---

## 5. 동시 편집은 어떻게 처리되는가

GitHub Contents API(PUT)는 대상 파일의 blob `sha` 를 요구하고, 최신이 아니면 `409` 를 돌려줍니다.
그래서 모든 쓰기는 **읽기 → 수정 → sha 동봉 쓰기** 이고, 409면 다시 읽어 최대 4회 재시도합니다.
아이 기기와 부모 기기가 같은 날짜 파일을 동시에 건드려도, 나중 쓰기가 앞의 기록을 **덮지 않고 합칩니다.**

- 아이마다 파일이 다릅니다(`status/<아이 id>/날짜.json`). 두 아이가 같은 시각에 체크해도 서로 충돌하지 않습니다.
- 커밋은 조작마다 하지 않고 **2.5초 디바운스**로 묶습니다. 하루 대략 10건 안팎입니다.
- 앱이 열려 있으면 60초마다 원격을 다시 읽어 다른 기기의 체크를 반영합니다.
  아직 못 보낸 로컬 변경은 그대로 지킵니다.
- 인증된 요청 한도는 시간당 5,000회입니다. 60초 폴링은 시간당 60회라 여유가 큽니다.
  남은 요청 수는 설정 탭에 표시됩니다.

`schedule.json` 과 `status/` 는 서비스 워커가 캐시하지 않습니다. 오래된 상태를 보여주면 안 되기 때문입니다.
토큰이 없는 기기는 `raw.githubusercontent.com` 으로 읽습니다. 이 경로는 약 5분 캐시가 있어 반영이 늦습니다.

---

## 6. 알림

| 방식 | 조건 | 용도 |
|---|---|---|
| 앱 내 알림 | 앱이 열려 있거나 PWA가 실행 중일 때 | 일정 10분 전, 시작, **제한시간 초과** |
| 캘린더 파일(.ics) | 항상. OS가 알람을 담당 | 놓치면 안 되는 일정 |

GitHub Pages에는 백엔드가 없어 Web Push(VAPID 서명 필요)를 쓸 수 없고,
브라우저 예약 알림 API(Notification Triggers)는 정식 채택되지 않았습니다.
**앱을 닫으면 앱 내 알림은 울리지 않습니다.** 일정 탭의 `캘린더 파일 내려받기` 로
`.ics` 를 폰 기본 캘린더에 등록해 두세요. 반복 일정은 `RRULE:FREQ=WEEKLY` 로 들어갑니다.

iOS는 16.4부터 **홈 화면에 추가한 PWA**에서만 알림 권한을 요청할 수 있습니다.

---

## 7. 파일 구성

```
index.html              화면 구조
styles.css              스타일
github.js               GitHub Contents API 계층 (읽기/쓰기, sha 충돌 재시도, UTF-8 base64)
app.js                  일정·제한시간·시간창·동기화 로직
sw.js                   서비스 워커 (앱 껍데기만 캐시)
config.json             저장소 연결 기본값
schedule.json           일정 정의
status/                 진행 기록이 날짜별로 쌓임
manifest.webmanifest    PWA 설치 정보
icon-*.png              아이콘
.nojekyll               Jekyll 처리 비활성화
```

앱 코드를 고쳐 푸시하면 서비스 워커가 네트워크 우선이라 바로 반영됩니다.
확실히 하려면 `sw.js` 의 `CACHE = "kidsched-v2"` 를 올려서 커밋하세요.

---

## 8. 이 구성의 한계 (알고 쓰세요)

1. **역할은 권한이 아닙니다.** 아이 기기에서 개발자 도구로 `localStorage` 의 역할을 `parent` 로 바꾸면 시간창 제한을 우회할 수 있습니다. 기록 저장소를 분리하면 일정 변조는 막히지만, 시간창 우회 자체는 클라이언트에서 막을 수 없습니다. 진짜 강제가 필요하면 검증을 서버에서 해야 합니다.
2. **커밋 이력이 쌓입니다.** 하루 10건 남짓이라 문제는 아니지만, 저장소 이력이 체크 기록으로 채워집니다. 그래서 기록 저장소 분리를 권합니다.
3. **토큰 만료.** Fine-grained PAT은 만료일이 있습니다. 만료되면 앱이 401을 그대로 문장으로 알려 주니 재발급해 설정에 다시 넣으세요.
4. **오프라인.** 앱 화면은 열리지만 체크는 저장되지 않습니다. 네트워크가 돌아오면 다시 눌러야 합니다.

---

# 부록 — Android APK 빌드

주행 계측 앱(`elevator-ride-meter-android`)과 **같은 파이프라인**입니다.
main 에 push 하면 Actions Artifacts 에, `v*` 태그를 붙이면 Release 에 APK가 붙습니다.
고정 키스토어로 서명하므로 다음 버전을 지우지 않고 덮어 설치할 수 있습니다.

달라진 점은 하나입니다. 주행 계측은 200~500 Hz 센서 접근 때문에 Kotlin 네이티브였고
소스를 `android-src.zip` 으로 커밋했지만, 이 앱은 이미 HTML/JS 로 완성돼 있고
필요한 네이티브 기능이 알림 하나뿐이라 **Capacitor 로 감싸고 `android/` 는 CI 가 매번 생성**합니다.
저장소에 안드로이드 프로젝트를 두지 않으니 Capacitor 버전을 올려도 손댈 곳이 없습니다.

## APK로 가는 이유

PWA에 남아 있던 한 가지 한계가 풀립니다.

| | PWA | APK (Capacitor) |
|---|---|---|
| 앱 열려 있을 때 알림 | ✅ | ✅ |
| **앱 닫은 상태 알림** | ❌ | ✅ `AlarmManager` 예약 |
| 재부팅 후 알람 유지 | ❌ | ✅ |
| `.ics` 우회 필요 | 필요 | 불필요 |

`native.js` 가 `@capacitor/local-notifications` 로 알람을 겁니다.

- **주간 반복** — `schedule.on = { weekday, hour, minute }` 으로 한 번 등록하면 매주 반복됩니다.
  Capacitor 의 `Weekday` 는 일요일=1 … 토요일=7 이라 `schedule.json` 의 `day`(일=0)에 1을 더합니다.
- **제한시간 초과** — `시작` 을 누른 순간 `startedAt + limitMin` 시각에 일회성 알람을 걸고,
  `완료`/`취소` 때 취소합니다.
- 안드로이드는 앱당 예약 알림 수에 상한(약 500)이 있어 400개에서 자릅니다.

웹에서는 `Capacitor` 객체가 없어 `native.js` 가 전부 건너뛰고, 기존 웹 알림이 그대로 돕니다.
한 소스로 PWA와 APK를 같이 냅니다.

## 권한

`scripts/patch-android.mjs` 가 매니페스트에 주입합니다.

| 권한 | 필요한 이유 |
|---|---|
| `POST_NOTIFICATIONS` | Android 13+ 알림 표시. 앱에서 `requestPermissions()` 호출 필요 |
| `SCHEDULE_EXACT_ALARM` | Android 12~13. 없으면 예약 알림이 정확하지 않게 묶여서 울림 |
| `USE_EXACT_ALARM` | Android 14+. 사용자 승인 없이 정확한 알람. 알람이 앱의 핵심 기능일 때만 허용되는 권한이라 스케줄 앱은 해당됨 |
| `RECEIVE_BOOT_COMPLETED` | 재부팅 후 예약 알람 복원 |

`SCHEDULE_EXACT_ALARM` 은 권한이 있어도 사용자가 앱 설정에서 끌 수 있습니다.
끄면 앱이 재시작되고 **예약된 알람이 전부 삭제됩니다.** 그래서 `native.js` 는 시작할 때마다
`checkExactNotificationSetting()` 으로 확인하고, 꺼져 있으면 설정 화면으로 보냅니다.

Android 15 이상에서는 앱을 Private space 에 설치할 수 있는데, 잠긴 동안에는 알림이 뜨지 않고
앱이 그걸 감지할 방법이 없습니다. **이 앱은 Private space 에 설치하지 마세요.**

## 빌드 흐름

```
push
 └ npm ci
 └ npm run build            루트의 앱 파일 → www/   (Pages 루트 배포는 그대로 유지)
 └ npx cap add android      android/ 생성 (커밋하지 않음)
 └ patch-android.mjs        권한 4종 + 고정 키 서명 + 버전 주입
 └ npx cap sync android
 └ ./gradlew assembleRelease
 └ out/kid-schedule.apk     → Artifacts, 태그면 Release 에도
```

버전은 태그에서 뽑습니다. `v1.2.0` → `versionName 1.2.0`, `versionCode` 는 Actions 실행 번호입니다.
태그 없이 main 에 push 하면 `0.0.0-<sha7>` 로 붙습니다.

빌드 환경은 Capacitor 8 요구사항에 맞췄습니다 — Node 22, JDK 21, AGP 8.13.0, Gradle 8.14.3.

## 받는 곳

1. **Actions Artifacts** — main 에 push 할 때마다 생성. 저장소 → Actions → 초록 체크된 실행 → 아래 Artifacts → `kid-schedule-apk`. zip 을 풀면 `kid-schedule.apk`. **GitHub 로그인이 필요**해서 본인 테스트용입니다.
2. **Releases** — 태그를 붙였을 때만. 저장소 → Releases → Create a new release → Tag 에 `v1.0` → Publish. 빌드가 끝나면 그 Release 에 APK 가 붙고, **로그인 없이 받는 링크**가 됩니다. 아이 폰에 보낼 때 이쪽을 쓰세요.

## 미리 보기 — APK 안 깔고 확인하기

APK 안에 들어가는 파일과 Pages 에 올라가는 파일은 같은 소스입니다.
화면과 기능은 웹에서 다 확인하고, APK 는 **앱 닫은 상태 알림**을 실제로 받아볼 때만 빌드하세요.

| 방법 | 반영 속도 | 쓰는 때 |
|---|---|---|
| `npm start` → `http://localhost:8080` | 새로고침 즉시 | 고치면서 볼 때 |
| GitHub Pages | push 후 1분 내외 | 폰에서 볼 때 |
| APK | 태그 → 빌드 3~5분 → 설치 | 알림 확인할 때만 |

`index.html` 을 `file://` 로 직접 열면 안 됩니다. `config.json`, `schedule.json` 을 `fetch` 로
읽는데 브라우저가 로컬 파일 요청을 막습니다. `npm start` 가 그래서 있습니다.
외부 패키지 없이 Node 내장 모듈만 씁니다.

서버가 뜨면 같은 와이파이의 폰에서 접속할 주소도 같이 찍어 줍니다.
그 주소로 들어가면 폰 화면에서도 바로 확인할 수 있습니다.

## 로컬에서 만들려면

```bash
npm install
npm run android:apk          # android/ 생성 → 패치 → debug APK
# android/app/build/outputs/apk/debug/app-debug.apk
```

Android Studio Otter 2025.2.1 이상, JDK 21, Node 22 가 필요합니다.

## 서명 키

`keystore/kidschedule.p12` 를 저장소에 함께 둡니다. 비밀번호는 `kidschedule` 로 평문입니다.
가족 배포용이라 문제없지만, **저장소가 Public 이면 누구나 같은 서명의 APK 를 만들 수 있습니다.**
신경 쓰이면 저장소를 Private 으로 바꾸세요 — Actions 와 Releases 는 그대로 동작하고,
Release 파일은 링크를 아는 사람만 받게 됩니다.

설치할 때 "출처를 알 수 없는 앱" 경고가 뜹니다. Play 스토어를 거치지 않는 배포라 정상입니다.
