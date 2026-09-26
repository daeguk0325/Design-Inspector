# Launcher & Supervisor — 사용자 안내 (한국어)

코딩 프로그램이나 터미널 입력 없이 검사 대상 프로젝트를 실행하는 방법입니다.
"검사 대상"은 특정 앱이 아니라 **아무 로컬 개발 프로젝트나** 됩니다.

## 평소 사용법 (매번)

1. Design Inspector 폴더의 **`start-inspector.bat` 더블클릭**
   (또는 터미널에서 `npm run dev` — 같은 동작).
2. 작은 **Launcher 창**이 뜹니다 (App A와 같은 테마·아이콘, borderless).
   - 이전 대상 서버가 이미 떠 있으면 "이미 실행 중입니다 ✓" → 자동 종료.
   - 아니면 폴더를 고르고 **[확인하고 시작]** (최근 대상은 목록 클릭).
3. 창이 **최소화**되고, 해당 폴더에서 개발 서버가 실행됩니다.
4. 브라우저가 `?target=` 주소로 열리며 App A에 자동 연결됩니다.
5. **창을 닫으면 서버도 함께 꺼집니다.** 확인 전 닫기는 그냥 App A만 실행.

## 처음 1회

Launcher에서 **[찾아보기…]** 로 프로젝트 폴더를 고르면 됩니다.
`package.json`의 `dev` (없으면 `start`) 스크립트를 자동 감지합니다.
Node.js 22 이상과 `npm`이 설치된 Windows면 별도 준비물이 없습니다.
Supervisor는 대상 앱을 전용 격리 `127/8` 프록시를 통해 iframe에 연결합니다.
따라서 대상 프로젝트의 `X-Frame-Options`나 CSP `frame-ancestors`를 수정할
필요가 없으며, HTTP API·리소스·WebSocket/HMR도 같은 로컬 프록시를 통과합니다.
Launcher는 대상 프로세스의 stdin을 즉시 닫습니다. Windows의 `tsx watch`가
부모 stdin 파이프를 기다리며 일부 의존성 로드에서 멈추는 문제를 막기 위한
것이며, 파일 감시 기능은 그대로 유지됩니다.

## 로그 보기 (2곳)

- Launcher 창 안의 서버 로그 (최근 60줄).
- App A 우상단 **⋯ → Target dev server** 패널 (상태·에러·최근 로그).

## 문제 해결

| 증상 | 조치 |
|---|---|
| Launcher 창이 안 뜸 | 바이너리 확인: `launcher/dist/design-inspector-launcher/`에 exe 존재 여부. 없으면 아래 "다시 빌드" 후 `npm run dev` 재실행 |
| "시작 요청" 후 서버가 안 뜸 | Launcher 창의 에러 + 로그 확인 (`npm install` 누락이 가장 흔함). [다시 시작] 버튼으로 재시도 |
| iframe에서 localhost 연결 거부 | `npm run dev`로 Supervisor를 실행했는지 확인하고 브라우저의 ⟳ 재연결을 누르세요. `dev:web`만으로는 범용 대상 프록시가 없습니다 |
| target에 X-Frame-Options 오류 | 대상 프로젝트를 수정하지 마세요. 최신 Supervisor가 프록시 응답에서 해당 헤더를 제거합니다 |
| 포트가 이미 사용 중 | 대상 dev 서버가 이미 실행 중이면 Launcher가 자동 건너뜀. 그래도 안 되면 해당 포트 프로세스 종료 후 재시도 |
| 창을 닫았는데 서버가 계속 돎 | `taskkill` 실패 시 발생 가능 — 해당 포트 프로세스를 작업 관리자에서 종료 후, 재현되면 이슈로 보고 |

## 다시 빌드 (개발자용)

Launcher 소스는 `launcher/resources/` (순수 HTML/CSS/JS, 빌드 불필요),
설정은 `launcher/neutralino.config.json` (Neutralino v6.9.0 고정)입니다.

```powershell
cd launcher
npx @neutralinojs/neu@latest build --release
```

산출물: `launcher/dist/design-inspector-launcher/` (exe + resources.neu).
`npm run dev`는 이 위치의 exe를 찾습니다 (`launcher/bin/` 관례: exe 원본 보관).

아이콘은 `scripts/make-icon.mjs`가 생성합니다 (pure-Node, 의존성 제로):
`launcher/resources/icon.png` (창·작업표시줄·exe) + `public/app-icon.svg`
(App A 파비콘). 같은 지오메트리라 양쪽이 항상 일치합니다.

## 테마 동기화 메모 (App A ↔ Launcher)

Launcher 스타일은 App A 컴포넌트를 이식한 것입니다 (`pill`, `sess`,
`field`, 버튼, 그림자, radius, 토큰). App A(`src/index.css`)의 토큰·치수를
바꾸면 `launcher/resources/styles.css` 상단의 토큰 표도 함께 맞춰 주세요.

## 알려진 Neutralino v6.9.0 특성 (코드 대응됨)

- `filesystem.readFile`이 파일 내용을 JSON 인코딩된 문자열로 반환할 수 있음
  → `main.js`의 `lenientJsonParse`와 `scripts/jobfile.mjs`가 방어적으로 해제.
- `tokenSecurity`는 `none` 사용: 단일 사용자·단기 실행 런처이며 네이티브
  허용목록을 메서드 단위로 제한했으므로, `one-time` 토큰의 실행 간
  stale 문제가 더 큼 (검증 과정에서 확인).

## 문제 해결

| 증상 | 조치 |
|---|---|
| Launcher 창이 안 뜸 | 바이너리 확인: `launcher/dist/design-inspector-launcher/`에 exe 존재 여부. 없으면 아래 "다시 빌드" 후 `npm run dev` 재실행 |
| "시작 요청" 후 서버가 안 뜸 | ⋯ → Target dev server 패널의 에러·로그 확인 (`npm install` 누락이 가장 흔함) |
| iframe에서 localhost 연결 거부 | `npm run dev`의 Supervisor가 필요합니다. 브라우저의 ⟳ 재연결을 누르세요 |
| target에 X-Frame-Options 오류 | 대상을 수정하지 마세요. Supervisor 프록시가 응답 헤더를 정리합니다 |
| 포트가 이미 사용 중 | 대상 dev 서버가 이미 실행 중이면 Launcher가 자동 건너뜀. 그래도 안 되면 해당 포트 프로세스 종료 후 재시도 |
| 창을 닫았는데 서버가 계속 돎 | supervisor 콘솔이 살아있는지 확인. supervisor를 강제종료하면 자식이 고아가 될 수 있음 → 해당 포트 프로세스를 작업 관리자에서 종료 |

## 다시 빌드 (개발자용)

Launcher 소스는 `launcher/resources/` (순수 HTML/CSS/JS, 빌드 불필요),
설정은 `launcher/neutralino.config.json` (Neutralino v6.9.0 고정)입니다.

```powershell
cd launcher
npx @neutralinojs/neu@latest build --release
```

산출물: `launcher/dist/design-inspector-launcher/` (exe + resources.neu).
`npm run dev`는 이 위치의 exe를 찾습니다.

알려진 Neutralino v6.9.0 특성 (코드 대응됨):
- `filesystem.readFile`이 파일 내용을 JSON 인코딩된 문자열로 반환할 수 있음
  → `main.js`의 `lenientJsonParse`와 `scripts/jobfile.mjs`가 방어적으로 해제.
- `tokenSecurity`는 `none` 사용: 단일 사용자·단기 실행 런처이며 네이티브
  허용목록을 6개 메서드로 제한했으므로, `one-time` 토큰의 실행 간
  stale 문제가 더 큼 (검증 과정에서 확인).
