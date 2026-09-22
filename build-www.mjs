/* scripts/build-www.mjs
 *
 * 저장소 루트에 있는 앱 파일을 www/ 로 복사합니다.
 * 루트를 그대로 두는 이유: GitHub Pages가 루트에서 배포되고 있어서,
 * 소스를 www/ 로 옮기면 Pages 주소가 깨집니다. 한 소스로 웹과 APK를 같이 냅니다.
 *
 * APK 안에서는 GitHub Pages를 거치지 않고 로컬 파일을 읽으므로
 * schedule.json / config.json 도 함께 넣습니다(최초 기본값). 이후엔 API로 받아옵니다.
 */
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const OUT = path.join(ROOT, "www");

const FILES = [
  "index.html", "styles.css", "github.js", "app.js", "native.js",
  "manifest.webmanifest", "config.json", "schedule.json", "holidays.json",
  "icon-192.png", "icon-512.png", "icon-512-maskable.png"
];
// 서비스 워커는 APK에 넣지 않습니다. 웹뷰에서 캐시가 겹치면 갱신이 꼬입니다.
const WEB_ONLY = ["sw.js"];

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

let n = 0;
for (const f of FILES) {
  const src = path.join(ROOT, f);
  if (!fs.existsSync(src)) {
    console.error(`  없음: ${f}`);
    process.exitCode = 1;
    continue;
  }
  fs.copyFileSync(src, path.join(OUT, f));
  n++;
}

// index.html 은 이미 native.js 를 app.js 앞에서 불러옵니다.
// APK 안에서는 서비스 워커를 쓰지 않으므로 등록 코드가 있어도 무해합니다(웹뷰에서 실패하고 넘어감).

console.log(`www/ 생성 — ${n}개 파일 (${WEB_ONLY.join(", ")} 제외)`);
