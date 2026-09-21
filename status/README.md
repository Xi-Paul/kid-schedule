# status

하루치 진행 기록이 `YYYY-MM-DD.json` 으로 쌓입니다. 앱이 자동으로 만들고 갱신합니다.
손으로 고칠 필요는 없지만, 내용은 사람이 읽을 수 있는 JSON입니다.

```jsonc
{
  "date": "2026-09-21",
  "updatedAt": "2026-09-21T10:47:02.113Z",
  "items": {
    "hw1": {
      "state": "over",          // todo running done over missed
      "startedAt": "2026-09-21T10:02:00.000Z",
      "doneAt":    "2026-09-21T10:55:00.000Z",
      "elapsedMin": 53,
      "limitMin": 40,           // 제한시간
      "by": "child"             // 마지막으로 바꾼 쪽
    }
  }
}
```
