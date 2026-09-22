/* scripts/patch-android.mjs
 *
 * `npx cap add android` 가 만든 안드로이드 프로젝트에 이 앱에 필요한 설정을 주입합니다.
 * android/ 는 저장소에 커밋하지 않고 CI에서 매번 새로 만들기 때문에,
 * 손으로 고치는 대신 스크립트로 재현합니다. 여러 번 돌려도 결과가 같습니다.
 *
 *  1) 알림 권한 4종
 *  2) 고정 키스토어 서명  — 다음 버전을 기존 앱 위에 덮어 설치할 수 있게
 *  3) versionName / versionCode 를 CI 값으로
 *  4) 런처 아이콘(캡시터 기본 → 우리 아이콘)
 *  5) 상태표시줄 알림 아이콘

 * 위치는 "앱을 쓰는 동안"만 읽습니다. ACCESS_BACKGROUND_LOCATION 은 넣지 않습니다.
 *
 * build.gradle 은 템플릿 내부를 정규식으로 헤집지 않고, 파일 끝에 android{} 블록을
 * 한 번 더 열어 덮어씁니다. Capacitor 버전이 올라가도 깨지지 않는 방식입니다.
 */
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const AND = path.join(ROOT, "android");
if (!fs.existsSync(AND)) {
  console.error("android/ 가 없습니다. 먼저 `npx cap add android` 를 실행하세요.");
  process.exit(1);
}

/* ---------- 1. AndroidManifest.xml : 권한 ---------- */
const manifestPath = path.join(AND, "app/src/main/AndroidManifest.xml");
let m = fs.readFileSync(manifestPath, "utf8");
const PERMS = [
  ["android.permission.POST_NOTIFICATIONS",    "Android 13+ 알림 표시"],
  ["android.permission.SCHEDULE_EXACT_ALARM",  "Android 12~13 정확한 예약 알람"],
  ["android.permission.USE_EXACT_ALARM",       "Android 14+ 승인 없이 정확한 알람"],
  ["android.permission.RECEIVE_BOOT_COMPLETED","재부팅 후 알람 복원"],
  ["android.permission.ACCESS_COARSE_LOCATION", "장소 확인(대략) — 앱을 쓰는 동안만"],
  ["android.permission.ACCESS_FINE_LOCATION",   "장소 확인(정밀) — 앱을 쓰는 동안만"]
];
const missing = PERMS.filter(([p]) => !m.includes(`"${p}"`));
if (missing.length) {
  const block = missing.map(([p, why]) => `    <!-- ${why} -->\n    <uses-permission android:name="${p}" />`).join("\n");
  m = m.replace(/<\/manifest>/, `${block}\n</manifest>`);
  fs.writeFileSync(manifestPath, m);
  console.log(`권한 ${missing.length}개 추가: ${missing.map(([p]) => p.split(".").pop()).join(", ")}`);
} else {
  console.log("권한 이미 적용됨");
}

/* ---------- 2~3. app/build.gradle : 서명 + 버전 ---------- */
const gradlePath = path.join(AND, "app/build.gradle");
let g = fs.readFileSync(gradlePath, "utf8");
const MARK = "// >>> patch-android.mjs";

// 키스토어는 저장소에 커밋해도 되고(A안), CI Secrets에서 풀어 써도 됩니다(B안).
// 어느 쪽이든 빌드 시점에 keystore/kidschedule.p12 가 있으면 됩니다.
const ksRel = "../../keystore/kidschedule.p12";   // android/app 기준 → 저장소 루트/keystore
if (!fs.existsSync(path.join(ROOT, "keystore/kidschedule.p12"))) {
  console.error("keystore/kidschedule.p12 가 없습니다.");
  console.error("저장소에 커밋하거나, CI에서 KEYSTORE_B64 시크릿을 풀어 두세요.");
  process.exit(1);
}
const ksPass  = process.env.KEYSTORE_PASSWORD || "kidschedule";
const ksAlias = process.env.KEYSTORE_ALIAS    || "kidschedule";
const vName = process.env.APP_VERSION_NAME || "";
const vCode = process.env.APP_VERSION_CODE || "";

const injected = `
${MARK}
// 사내·가족 배포용 고정 키. Play 스토어 업로드용이 아닙니다.
// 같은 키로 서명해야 다음 버전을 지우지 않고 덮어 설치할 수 있습니다.
android {
    signingConfigs {
        shared {
            storeFile file("${ksRel}")
            storePassword "${ksPass}"
            keyAlias "${ksAlias}"
            keyPassword "${ksPass}"
            storeType "PKCS12"
        }
    }
    buildTypes {
        debug   { signingConfig signingConfigs.shared }
        release { signingConfig signingConfigs.shared }
    }
${vName || vCode ? `    defaultConfig {
${vCode ? `        versionCode ${Number(vCode)}\n` : ""}${vName ? `        versionName "${vName}"\n` : ""}    }
` : ""}}
${MARK} end
`;

// 이전에 주입한 블록이 있으면 통째로 교체 (멱등)
const re = new RegExp(`\\n?${MARK}[\\s\\S]*?${MARK} end\\n?`, "m");
g = re.test(g) ? g.replace(re, injected) : g + injected;
fs.writeFileSync(gradlePath, g);
console.log(`서명 설정 주입 · 버전 ${vName || "(템플릿 값 유지)"} / code ${vCode || "(유지)"}`);

/* ---------- 4. 런처 아이콘 ---------- */
// Capacitor 가 만든 기본 아이콘(캡시터 로고)을 우리 아이콘으로 덮어씁니다.
// android/ 를 커밋하지 않으므로 android-res/ 에 미리 만들어 두고 여기서 복사합니다.
{
  const SRC = path.join(ROOT, "android-res");
  const RES = path.join(AND, "app/src/main/res");
  if (fs.existsSync(SRC)) {
    // 템플릿의 벡터 아이콘과 이름이 겹치면 어느 쪽을 쓸지 애매해집니다. 먼저 치웁니다.
    for (const f of ["drawable-v24/ic_launcher_foreground.xml", "drawable/ic_launcher_background.xml"]) {
      const t = path.join(RES, f);
      if (fs.existsSync(t)) fs.rmSync(t);
    }
    let n = 0;
    for (const dir of fs.readdirSync(SRC)) {
      const from = path.join(SRC, dir), to = path.join(RES, dir);
      if (!fs.statSync(from).isDirectory()) continue;
      fs.mkdirSync(to, { recursive: true });
      for (const f of fs.readdirSync(from)) { fs.copyFileSync(path.join(from, f), path.join(to, f)); n++; }
    }
    console.log(`런처 아이콘 ${n}개 교체`);
  } else {
    console.log("android-res/ 가 없어 런처 아이콘은 Capacitor 기본값을 씁니다");
  }
}

/* ---------- 5. 상태표시줄 아이콘 ---------- */
// capacitor.config.json 의 smallIcon 이름과 맞춥니다. 단색 실루엣이어야 합니다.
const drawable = path.join(AND, "app/src/main/res/drawable");
fs.mkdirSync(drawable, { recursive: true });
const iconPath = path.join(drawable, "ic_stat_icon.xml");
if (!fs.existsSync(iconPath)) {
  fs.writeFileSync(iconPath, `<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="24dp" android:height="24dp"
    android:viewportWidth="24" android:viewportHeight="24">
  <path android:fillColor="#FFFFFFFF"
        android:pathData="M12,2C6.48,2 2,6.48 2,12s4.48,10 10,10 10,-4.48 10,-10S17.52,2 12,2zM12,20c-4.41,0 -8,-3.59 -8,-8s3.59,-8 8,-8 8,3.59 8,8 -3.59,8 -8,8zM12.5,7L11,7v6l5.25,3.15 0.75,-1.23 -4.5,-2.67z"/>
</vector>
`);
  console.log("알림 아이콘 ic_stat_icon.xml 생성");
}
console.log("android/ 패치 완료");
