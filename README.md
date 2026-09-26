# Design Inspector Tool

로컬 웹 UI를 실제 브라우저에서 실시간으로 검사하고, 선택한 컴포넌트를 로컬 Ollama와 함께 UI/UX 개선 방향을 토론하며, 임시 CSS를 즉시 적용·되돌리는 워크스페이스입니다.

## 핵심 기능

- 별도 타깃 수정 없이 격리 loopback proxy를 통해 로컬 웹 앱 실행
- Freeze 후 DOM 요소 선택, 번호 오버레이, 논리 anchor와 `file:line` citation
- 선택 요소의 **측정된 스타일 사실**을 프롬프트에 함께 전송 (§9e)
  - 색상 10 / 타이포 11 / 박스 19 / 레이아웃 12 / 모션 4 = longhand 56개 속성
  - 기본값은 프로퍼티별로 제거되므로 이상한 값만 남는다 (`display:block`, `rgba(0,0,0,0)` 등)
  - `oklch()`, `color(srgb …)` 같은 현대 색상 문법은 1×1 캔버스를 거쳐 `#rrggbb`로 변환된다. 변환 불가 값은 원문 통과 없이 **버려진다**
  - 프롬프트에서 `untrusted-evidence` 펜스로 감싸고, 이미지가 없더라도 항상 전송된다
  - 이미지와 수치가 충돌하면 수치를 따르도록 시스템 프롬프트에 명시
  - 이미지 미전송 시 프롬프트에 "이 요청에는 이미지가 첨부되지 않았습니다"를 한 줄 명시 — 모델이 근거 없이 시각을 지어내는 대신 정직하게 밝힌다
- 입력창 안에서 태그와 문장을 자유롭게 섞어 쓰기
  - 썸네일, 요소명, 상세 보기, `×` 즉시 삭제
  - 태그는 **커서 위치에** 삽입되므로 `make ({1}) and ({2}) more compact` 처럼 문장 한가운데 놓입니다
  - Backspace 두 번으로 실수 방지 삭제 (삭제하면 대상 페이지의 선택도 함께 해제)
    - 길게 누르고 있으면 arm이 풀려서 뒤쪽 글자가 계속 지워집니다
    - 드래그로 태그를 걸쳐 선택하면 두 번째 확인 없이 바로 삭제됩니다
  - `Ctrl+Z` 로 태그와 대상 페이지 하이라이트가 함께 되살아납니다
  - 삭제 시 대상이 선택을 유지하면 태그가 복구되고 안내 문구가 표시됩니다
- 인용 기호 `({1})` 은 어떤 언어·템플릿 문법에도 속하지 않아 파싱이 모호하지 않습니다
  - 전송 문장, 인용 목록, 이미지 매핑, 모델 시스템 프롬프트가 모두 같은 표기를 씁니다
  - 전송된 내 말은 사용자 채팅에서 `({1})` 자리가 실제 컴포넌트 칩으로 다시 렌더링됩니다
  - 모델이 쓴 전달문에 있는 `({1})` 도 클릭 가능한 칩이 되고, 누르면 대상 페이지에서 그 컴포넌트를 다시 선택해줍니다
  - 코드 블록·인라인 코드·수식 안의 표기는 그대로 보존되고, 해당 컴포넌트가 없는 번호는 칩으로 바뀌지 않고 텍스트로 남습니다
- 자연스러운 모션
  - 태그 등장·퇴장,armed 펄스, 캡처 스켈레톤, Send 시 태그→채팅 전환
  - `prefers-reduced-motion`을 존중해 모션이 필요한 만큼만 축약됩니다
- 선택 컴포넌트 자동 crop과 Contact Sheet를 로컬 Vision Ollama로 전송
- 영어 system role, 한국어 디자이너 전달문 출력
- 검증된 CSS proposal을 iframe DOM에 자동 runtime preview
  - 프로젝트 소스 파일은 변경하지 않음
  - 응답별 transaction Undo와 전체 Reset
  - 세션·route·reload 후 논리 anchor 재바인딩
- `Accept / Revise / Reject` 디자인 결정의 지속 및 다음 요청 반영
- Desktop / Tablet / Mobile viewport 프리셋
- 동일 target 세션 간 selection, capture, preview 완전 격리

## 실행

```bash
npm install
npm run dev
```

`npm run dev`는 App A, Supervisor, Launcher를 시작합니다. 대상 프로젝트는 Launcher에서 선택합니다.

```bash
npm run dev:web   # 저장된 대상과 App A만 실행
npm test
npm run typecheck
npm run lint
npm run build
```

## 사용 흐름

1. Launcher에서 로컬 프로젝트를 실행합니다.
2. `Ctrl/Cmd+Shift+F` 또는 Freeze 버튼으로 검사 모드를 켭니다.
3. 대상 화면에서 컴포넌트를 선택합니다.
4. 입력창 상단의 태그를 확인하고 개선안을 요청합니다.
5. Ollama의 한국어 답변과 선택 스타일을 확인합니다.
6. 각 답변의 Undo 또는 Header의 Reset으로 미리보기를 되돌립니다.

## 안전 경계

- 검사 대상 프로젝트 파일은 읽기만 하며 CSS preview도 런타임 DOM에만 적용됩니다.
- 이미지 crop과 preview 이미지 바이트는 localStorage에 저장하지 않습니다.
- **엔드포인트는 loopback Ollama로만 제한됩니다.** 다만 Ollama의 `:cloud` 모델은
  loopback 엔드포인트에서도 Ollama 클라우드를 경유하므로, 이 경우 이미지와 측정된
  스타일 값이 기계를 떠납니다. 전송은 계속되고 (§9e) 프롬프트와 컴포저에 그 사실이
  명시됩니다 — 차단이 아니라 고지입니다.
- 선택 요소의 스타일 값과 요소 텍스트는 대상 페이지가 제어하는 데이터이므로 프롬프트
  인젝션 경로로 취급합니다. Bridge에서 1×1 캔버스로 sRGB 정규화(변환 불가 값은
  원문 통과 없이 제거), wire에서 부분집합 allowlist 검증, 상태 저장 직전에 재검증,
  프롬프트에서 `untrusted-evidence` 펜스로 감싸고 untrusted 규칙에 명시합니다.
- `font-family`는 §9e에서 새로 추가된 유출面입니다 — 설치된 폰트 이름이 프롬프트에
  들어갑니다. 로컬 Ollama에는 무해하지만 원격 모델을 구성하기 전에 재검토하십시오.
- 측정된 스타일 값은 모델 전송에만 포함되며, 사람이 다른 도구에 붙여넣는
  "Copy agent prompt" 출력에는 들어가지 않습니다.
- model이 생성한 selector나 임의 CSS는 허용하지 않고 visual-only allowlist만 검증합니다.
- 실제 소스 수정은 별도 diff 승인·백업·undo 단계로 제공하지 않습니다.

## 문서

- `docs/ARCHITECTURE.md` — 상태 소유권, Bridge, preview transaction
- `docs/MANUAL_INTEGRATION_CHECKLIST.md` — native Bridge 및 R3F/Konva 통합
- `docs/VERIFICATION_REPORT.md` — 자동 테스트와 실제 브라우저 검증 결과
