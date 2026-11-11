# 설치 순서 (약 15분, 한 번만)

## 1. 구독 신청 페이지 켜기 (GitHub Pages)

1. https://github.com/yalli2/auto_marketing → **Settings → Pages**
2. Source: `Deploy from a branch`, Branch: `main` / `/ (root)` → **Save**
3. 1~2분 뒤 https://yalli2.github.io/auto_marketing/ 에서 페이지가 열리는지 확인

## 2. 구글 시트와 Apps Script 만들기

1. https://sheets.new 로 새 시트를 만들고 이름을 `다인에듀 뉴스레터` 로 바꿉니다.
   **이 시트는 누구와도 공유하지 마세요.** 구독자 개인정보가 들어갑니다.
2. 메뉴 **확장 프로그램 → Apps Script**
3. 기본으로 있는 코드를 모두 지우고, 이 저장소의 [`apps_script/Code.gs`](apps_script/Code.gs) 내용을 통째로 붙여넣습니다.
4. 왼쪽 톱니바퀴(프로젝트 설정) → 시간대를 `(GMT+09:00) 서울` 로 맞춥니다.
5. 위쪽 함수 선택 칸에서 `setup` 을 고르고 **실행**. 권한 요청 창이 뜨면 본인 계정으로 허용합니다.
   - "확인되지 않은 앱" 경고가 나오면 `고급 → (프로젝트 이름)(으)로 이동` 을 누릅니다. 본인이 만든 스크립트이기 때문에 나오는 안내입니다.
6. 시트로 돌아가면 `Subscribers`, `Campaigns`, `SendLog`, `Settings` 탭이 생겨 있습니다.

## 3. 웹 앱으로 배포하기

1. Apps Script 화면 오른쪽 위 **배포 → 새 배포**
2. 유형: **웹 앱** / 실행 계정: **나** / 액세스 권한: **모든 사용자**
3. **배포**를 누르고 나오는 **웹 앱 URL** (`https://script.google.com/macros/s/…/exec`) 을 복사합니다.

> 나중에 `Code.gs` 를 고치면 **배포 → 배포 관리 → 연필 아이콘 → 버전: 새 버전 → 배포** 를 해야 반영됩니다. URL은 그대로입니다.

## 4. 설정 채우기

### 구글 시트 `Settings` 탭
| key | 넣을 값 |
|---|---|
| `WEBAPP_URL` | 3단계에서 복사한 URL |
| `SENDER_ADDRESS` | 사업장 주소 (필수) |
| `SENDER_PHONE` | 대표 전화번호 (필수) |
| `SENDER_LEGAL_NAME` | 사업자등록증의 정식 명칭인지 확인 |
| `SENDER_EMAIL` | 문의를 받을 이메일인지 확인 |
| `WELCOME_GIFT_URL` | (선택) 구독 확인 직후 보여줄 무료 자료 링크 |

주소와 전화번호가 비어 있으면 광고 메일은 발송되지 않고 원장님께 알림만 갑니다.

### 저장소의 `config.js`
GitHub에서 `config.js` → 연필 아이콘 → `WEBAPP_URL` 에 같은 URL을 붙여넣고, 연락처·주소를 채운 뒤 **Commit changes**.
(Claude에게 URL을 알려주고 "config.js에 반영해줘"라고 해도 됩니다.)

## 5. 시험해 보기

1. 구독 페이지에서 본인의 다른 이메일로 신청 → 확인 메일의 버튼 클릭 → `Subscribers` 탭에서 `status` 가 `active` 인지 확인
2. `newsletters/queue.json` 에 시험 항목을 추가합니다 (날짜는 오늘로).
   ```json
   { "campaigns": [
     { "id": "test-1", "send_date": "2026-11-12", "subject": "시험 발송", "preheader": "시험입니다", "file": "newsletters/_sample.html", "audience": "all" }
   ] }
   ```
3. Apps Script에서 `checkQueue` 실행 → 원장님 메일로 미리보기 도착 → **발송 승인** 클릭
4. Apps Script에서 `sendApproved` 실행 (9~18시 사이) → 시험 주소로 `(광고) 시험 발송` 메일 도착
5. 받은 메일 맨 아래 **[수신거부]** 클릭 → `status` 가 `unsubscribed` 로 바뀌는지 확인
6. 시험이 끝나면 `queue.json` 의 시험 항목은 그대로 두어도 됩니다 (같은 id는 다시 발송되지 않음).

## 6. 홈페이지(크리에이터링크)에 연결

- 메뉴나 메인 화면에 **"뉴스레터 구독"** 버튼을 만들고 링크를 `https://yalli2.github.io/auto_marketing/?utm_source=homepage` 로 겁니다.
- 블로그·인스타그램·유튜브 설명란에는 `?utm_source=blog`, `?utm_source=instagram` 처럼 끝만 바꿔서 겁니다. 어느 채널에서 구독자가 오는지 시트의 `source` 열에 남습니다.

## 자동 실행 일정

| 언제 | 무엇 | 어디서 |
|---|---|---|
| 매주 월요일 오전 | 잠재고객 리포트 작성 | Claude 예약 작업 |
| 매주 목요일 오후 | 뉴스레터와 유입용 글 작성, 저장소에 커밋 | Claude 예약 작업 |
| 매일 08시 | 새 뉴스레터 확인 → 원장님께 미리보기 | Apps Script `checkQueue` |
| 매시간 (9~18시만 발송) | 승인된 뉴스레터 발송 | Apps Script `sendApproved` |
| 매월 1일 | 수신동의 2년 확인 안내 | Apps Script `reconfirmConsents` |

## 자주 생기는 일

- **승인 없이 자동으로 보내고 싶다** → `Settings` 의 `AUTO_SEND` 를 `TRUE` 로. 다만 AI가 쓴 글이 확인 없이 나가므로 권하지 않습니다.
- **발송을 취소하고 싶다** → `Campaigns` 탭에서 해당 줄의 `status` 를 `cancelled` 로 바꿉니다.
- **구독자가 메일로 수신거부를 요청했다** → `Subscribers` 탭에서 그 주소의 `status` 를 `unsubscribed` 로 바꿉니다.
- **구독자가 100명을 넘었다** → 하루 80통씩 나눠서 며칠에 걸쳐 발송됩니다. 불편해지면 스티비 등 발송 서비스로 이전하세요.
