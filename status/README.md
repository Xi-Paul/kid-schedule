# status

아이별 폴더 아래에 하루치 진행 기록이 쌓입니다. 앱이 자동으로 만들고 갱신하니 손댈 필요 없습니다.

```
status/
  kid1/2026-09-21.json     ← 첫째
  kid2/2026-09-21.json     ← 둘째
```

아이마다 파일이 달라서, 두 아이가 같은 시각에 체크해도 커밋이 충돌하지 않습니다.
폴더 이름은 `schedule.json` 의 `kids[].id` 와 같습니다.

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
      "atStart": "here",                        // 장소 확인 결과. 좌표는 저장하지 않습니다
      "by": "parent"
    }
  }
}
```
