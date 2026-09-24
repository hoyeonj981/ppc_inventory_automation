# PPC inventory automation

## todo

1. Slack 요청 서명 검증
2. 가짜 Slack 요청을 이용한 로컬 테스트
3. /slack/commands 라우트
4. /report 실행 시 모달 열기
5. /slack/interactions에서 제출값 파싱
6. 입력값 검증
7. Google Sheets 연동

## Slack command 수신

Slack 앱의 Slash Commands 설정에서 `/report`와 `/r`을 각각 등록하고, 두 명령어의 Request URL을
동일하게 `https://<Worker 도메인>/slack/commands`로 지정한다. `/r`은 `/report`와 동일하게 재고 발견 입력 모달을 연다.
Worker에는 `SLACK_SIGNING_SECRET`과 `SLACK_BOT_TOKEN`이 설정되어 있어야 한다.

`POST /slack/commands`는 서명을 검증한 뒤 `application/x-www-form-urlencoded` 본문에서
`command`를 읽는다. `/report` 또는 `/r` 요청의 `trigger_id`로 Slack `views.open`을 호출하고,
`channel_id`를 모달의 `private_metadata`에 보관한다. 두 값은 모두 필수이다.
성공하면 빈 HTTP 200 응답을 반환한다. 멤버 조회와 모달 API 요청 전체에 2초 제한을 적용하며,
실패하면 명령어를 실행한 사용자에게 오류 안내를 반환한다.

서명 검증 실패는 401, 잘못된 command는 400, 지원하지 않는 Content-Type은 415,
POST 이외의 메서드는 405를 반환한다.

## 재고 발견 모달

Slack 앱의 Interactivity & Shortcuts Request URL은 `https://<Worker 도메인>/slack/interactions`로 설정한다.
Socket Mode는 끈 상태로 사용한다. 로컬에서는 `.dev.vars`, 운영에서는 Worker Secret에
Bot User OAuth Token(`xoxb-…`)을 `SLACK_BOT_TOKEN`으로 설정한다.

발견자 이름 조회에는 Bot Token Scope `users:read`가 필요하다. Slack 앱의 OAuth & Permissions에서
권한을 추가한 뒤 워크스페이스에 앱을 재설치한다. 토큰이 변경되면 Worker의 `SLACK_BOT_TOKEN`도 갱신한다.
발견자 선택 목록을 불러오려면 다음 설정도 필요하다.

- Bot Token Scope에 공개 채널은 `channels:read`, 비공개 채널은 `groups:read`를 추가하고 앱을 재설치한다.
- 사용할 채널에 앱을 초대한다.

채널 보고 게시에는 `chat:write`, 모달 사진 입력에는 `files:read` Bot Token Scope가 필요하다.
권한을 추가한 뒤 워크스페이스에 앱을 재설치해야 실제 봇 토큰에 반영된다.

발견자 목록은 `/report`를 실행할 때 조회해 모달의 기본 선택 메뉴(`static_select`)에 함께 전달한다.
목록 표시와 이름 검색에는 추가 서버 요청이나 Options Load URL 설정이 필요하지 않다.
`conversations.members`와 `users.list`의 페이지를 순회하여 채널의 활성 사용자만 표시하고,
봇과 비활성 계정은 제외한다. 채널 멤버를 모두 확인하면 나머지 워크스페이스 사용자는 조회하지 않는다.
100명이 넘으면 100명씩 선택 그룹으로 나누며 Slack 제한에 따라 최대 10,000명까지 지원한다.
멤버 조회부터 모달 열기까지 합계 2초 제한을 적용한다. 조회 실패·빈 목록·인원 제한 초과 시
빈 선택 메뉴를 열지 않고 명령어 사용자에게 입력 화면을 열 수 없다는 안내를 반환한다.

제출값 검증 후 선택한 사람이 해당 채널의 멤버인지 최대 1초 동안 확인한다.
채널 정보 누락, 채널 밖의 사용자 선택, 멤버 확인 실패 시 발견자 필드에 오류를 표시하고 저장하지 않는다.
이후 선택한 사용자의 `users.info`를 최대 1초 동안 조회하며, 표시 이름(`display_name`) → 이름(`real_name`) →
Slack ID 순으로 표시한다. 권한 부족이나 시간 초과에도 ID로 표시하여 제출 처리를 계속한다.

| 항목 | 처리 방식 |
| --- | --- |
| 바코드 | 필수 문자열, 앞자리 0 유지, 최대 100자 |
| 수량 | 필수, 1 이상의 정수 |
| 소비기한(제조기한) | 필수 날짜 선택, 이미 지난 날짜도 허용 |
| 발견로케이션 | 필수, 하이픈(-) 등 입력 형태 유지, 양끝 공백만 정리, 최대 100자 |
| 발견자 | 필수 선택, 현재 채널 멤버의 프로필 이름으로 표시, 내부 `foundBy`는 선택한 사용자의 Slack ID |
| 발견시각 | 제출 요청 수신 시각, 내부 ISO UTC / 화면·시트 한국시간 |
| 유형 | 필수 선택: 과재고 / 부족재고 |
| 사진 | 선택, JPG/JPEG/PNG/GIF 1장, Slack 파일 ID만 보관 |

제출 요청도 Slack 서명 검증 후 처리한다. 입력 오류는 모달의 해당 항목에 표시한다.
정상 제출 시 이름을 조회하고 저장 중 화면을 즉시 반환한다. `ctx.waitUntil()`에서 다음 순서로 처리한다.

1. `/report`를 실행한 채널에 유형·바코드·수량·로케이션·소비기한·발견자·한국시간의 발견시각을 간략히 게시한다.
2. 사진이 있으면 이미지 블록의 `slack_file.id`로 함께 표시한다. Worker가 사진을 다운로드하거나 다시 업로드하지 않는다.
3. `chat.getPermalink`로 보고 메시지 링크를 조회한다.
4. Google Sheets에 재고 정보와 보고 메시지 링크를 한 행으로 추가한다.
5. Slack `views.update`로 결과 모달을 표시한다.

`저장 완료`는 채널 게시·링크 조회 후 Sheets API가 한 행(10개 셀)의 추가를 확인한 경우에만 표시한다.
게시 결과가 불명확하거나 링크 조회에 실패하면 시트에는 행을 추가하지 않는다.
채널 보고가 게시된 뒤 시트 저장이 실패하면 `채널 보고는 게시되었습니다. 시트 저장 여부를 확인하지 못했습니다`로 안내한다.
시간 초과 시 이미 메시지나 행이 만들어졌을 수 있으므로, 중복 입력을 피하려면 채널과 시트를 확인한 뒤 다시 제출한다.
모달을 닫아 결과 화면을 표시할 수 없더라도 확인된 처리 결과는 Worker 로그에 남는다.

사진은 Slack에만 보관한다. 시트의 링크를 열려면 해당 Slack 채널 접근 권한이 필요하며,
메시지·사진 삭제 및 워크스페이스 보존 정책에 따라 나중에 열리지 않을 수 있다.
규격: [사진 입력](https://docs.slack.dev/reference/block-kit/block-elements/file-input-element/),
[Slack 이미지 참조](https://docs.slack.dev/reference/block-kit/composition-objects/slack-file-object/),
[메시지 링크 조회](https://docs.slack.dev/reference/methods/chat.getPermalink/).

## 부엉이 반응으로 기존 메시지 저장

사람이 직접 작성한 과재고·부족재고 보고에 🦉 `:owl:` 반응을 추가하면 원본을 읽어 같은 시트에 저장한다.
앱이 접근할 수 있는 과거 메시지와 스레드 답글도 대상이며, 채널에 보고를 다시 게시하지 않는다.
처리 결과는 반응을 추가한 사용자에게만 Slack 임시 메시지로 안내한다. 앱·봇이 작성한 메시지는 변환하지 않는다.
기존 `/r`·`/report` 입력은 계속 자동 저장되므로 부엉이 반응이 필요 없다.

예시:

```text
과재고 발생 보고
• 발견 크루명: 민들레
• 발견일시/위치: 9월 24일 /A11-11-203
• 보증소비기한 경과 여부: N
• 법적소비기한 경과 여부: N
• SKU명: 롯데 찰옥수수 140ml
• 해당 로케이션 전산재고 0, 실재고 1 / 과재고 1개 피박스 이동 완료, 다른 로케이션 재고 일치
```

- 유형은 `과재고` 또는 `부족재고`, 수량은 `과재고 1개`·`부족재고 1개` 또는 `수량: 1`에서 읽는다.
  전산재고·실재고를 수량으로 사용하거나 두 값을 빼서 추정하지 않는다.
- 글머리표, 강조, 줄 순서, 띄어쓰기, `:`·`：`·`=` 차이를 허용한다. 정해진 항목명을 읽는 방식이며 임의의 자연어를 모두 해석하는 기능은 아니다.
- 위치는 `발견일시/위치: 날짜 /A11-11-203` 또는 별도 `발견로케이션: A11-11-203`·`위치:`에서 읽는다.
- `바코드:`가 없으면 `N/A`, `소비기한:` 또는 `법적소비기한:` 날짜가 없으면 `N/A`로 기록한다.
  소비기한 **경과 여부**의 Y/N은 날짜로 해석하지 않는다. 날짜는 연도까지 필요하며 `2026-12-31`, `2026.12.31`, `2026/12/31`, `2026년 12월 31일`을 지원한다.
- 발견자는 `발견 크루명:`·`발견자:`에서 읽고, 없으면 메시지 작성자의 프로필 이름을 사용한다.
- 연도와 시각까지 적힌 `발견일시: 2026-09-24 08:30`은 한국시간으로 해석한다.
  `9월 24일`처럼 불완전하거나 없으면 **원본 메시지 작성시각**을 사용하며 반응을 남긴 시각은 사용하지 않는다.
- B열에는 `SKU명:`(`SKU 명:`)의 값, I열에는 `메시지 변환`, J열에는 원본 메시지 링크를 기록한다. 모달 제출은 I열에 `앱 입력`을 기록한다.
  입력 경로상 값이 없는 셀(모달 제출의 SKU명, 메시지의 바코드·SKU명·소비기한 등)은 모두 `N/A`로 기록한다.
  경과 여부, 이동 내역과 사진은 원본 링크로 확인한다. 기존 시트 행은 변경하지 않는다.
- 한 메시지에 한 건을 저장한다. 유형·수량·위치가 없거나 모호하면 저장하지 않고 안내한다.
  본문을 수정한 뒤 부엉이 반응을 제거하고 다시 추가하면 재시도할 수 있다.

Slack 앱 설정:

1. Bot Token Scopes에 `reactions:read`를 추가하고 워크스페이스에 앱을 재설치한다. 결과 안내에는 기존 `chat:write`, 이름 조회에는 기존 `users:read`를 사용한다.
2. 변경된 Worker를 배포한다. `wrangler.jsonc`의 `MESSAGE_IMPORTS` 바인딩과 SQLite Durable Object 마이그레이션이 함께 적용된다.
3. Event Subscriptions를 켜고 Request URL을 `https://<Worker 도메인>/slack/events`로 설정한다.
4. Subscribe to bot events에 `reaction_added`를 추가하고 저장한다. 사용할 채널에 앱을 초대한다.

Slack 서명을 검증한 이벤트에 바로 응답하고 백그라운드에서 처리한다.
`reactions.get`으로 반응 대상 메시지를 조회하므로 이 기능에 별도의 채널 history 권한은 사용하지 않는다.
이미 붙어 있던 부엉이 반응을 일괄 수집하지는 않는다. 새로 추가되는 반응을 처리한다.
규격: [반응 이벤트](https://docs.slack.dev/reference/events/reaction_added/),
[반응 대상 메시지 조회](https://docs.slack.dev/reference/methods/reactions.get/),
[이벤트 수신 설정](https://docs.slack.dev/apis/events-api/).

중복 방지는 워크스페이스·채널·메시지 식별자로 만든 Durable Object에 처리 상태를 보관한다.
같은 메시지에 여러 사람이 반응하거나 이벤트가 재전송되어도 시트에 다시 추가하지 않는다.
저장 후 본문을 수정하거나 이모지를 제거해도 이미 저장한 행을 수정·삭제하지 않는다.
행 추가 요청 이후 시간 초과·오류가 발생하거나 처리가 중단되면 미확인 상태를 유지하고 자동 재저장하지 않는다.
인증·헤더 확인 등 행 추가 이전의 준비 단계에서 실패하면 설정을 수정한 뒤 다시 반응을 추가해 재시도할 수 있다.
이 경우 관리자가 시트와 로그를 확인해 누락을 수동 보완해야 한다. 성공한 행을 지워도 반응만으로 재등록되지 않는다.
Durable Object는 메시지 본문 대신 처리 상태만 보관하며, 이 중복 방지는 부엉이 변환에만 적용된다.

- `inventory.message_saved`: 메시지 변환 저장 완료
- `inventory.message_import_failed`: 변환 실패, `writeStarted`가 참이면 시트 저장 미확인
- `inventory.message_import_unconfirmed`: 처리 결과를 받지 못함
- `inventory.message_notice_failed`: 사용자 결과 안내 실패, `status`로 처리 결과 확인

로그의 `channelId`와 `messageTs`로 원본 메시지를 추적한다.

## Google Sheets 행 변환

`parseInventoryValues`가 모달 입력을 검증하고 정규화한 `InventoryRecord`를 만든다.
`src/sheets/inventory.ts`의 `toInventorySheetRow(record, foundByName, reportUrl)`는 이 레코드를 시트 한 행으로 변환한다.
발견자 이름은 기존 `getSlackUserName` 조회 결과를 전달하며, 생략하거나 공백이면 Slack ID로 대체한다.

| 열 | 값 | 자료형 |
| --- | --- | --- |
| A | 바코드 | 문자열, 앞자리 0 유지 |
| B | SKU명 | 메시지 변환 시 `SKU명:` 값 |
| C | 수량 | 숫자 |
| D | 소비기한(제조기한) | `YYYY-MM-DD` 문자열 |
| E | 발견로케이션 | 입력한 하이픈을 유지한 문자열, 예: `A-01-02` |
| F | 발견자 | 프로필 이름, 조회 실패 시 Slack ID |
| G | 발견시각 | 서울(UTC+09:00) ISO 8601 문자열, 예: `2027-01-16T08:30:00.000+09:00` |
| H | 유형 | `과재고` 또는 `부족재고` |
| I | 입력경로 | `앱 입력` 또는 `메시지 변환` |
| J | 보고 메시지 링크 | Slack 보고 메시지의 HTTPS URL |

입력 경로에 따라 수집하지 않는 값(바코드, SKU명, 소비기한(제조기한), 보고 메시지 링크)이 비어 있으면 `N/A`로 기록한다.

Sheets API에 전달하는 본문은 다음과 같다.

```ts
const body = {
  majorDimension: "ROWS",
  values: [toInventorySheetRow(record, foundByName, reportUrl)],
};
```

저장 시 `valueInputOption=RAW`를 사용해야 바코드의 앞자리 0을 보존하고,
`=`로 시작하는 입력값을 수식으로 해석하지 않는다. 수량은 숫자로 전달하고 날짜·시각은 텍스트로 저장한다.
발견시각은 시트 행을 만들 때만 서울 시간으로 변환하며 내부 UTC 시각과 소비기한은 변경하지 않는다.
이 변경은 새로 추가되는 행에 적용되며, 기존 시트의 UTC 기록은 자동 수정하지 않는다.
규격: [Google Sheets 값 쓰기](https://developers.google.com/workspace/sheets/api/guides/values).

## Google Sheets 인증 및 배포

Google Cloud에서 Sheets API를 활성화하고, 대상 스프레드시트를 서비스 계정 이메일에 **편집자**로 공유한다.
매 제출 시 대상 탭의 A1:J1을 조회하고, 모두 비어 있으면 위 열 순서대로 헤더를 자동 입력한다.
헤더가 있으면 A1:J1이 위 표와 정확히 일치해야 하며, 다르면 덮어쓰거나 행을 추가하지 않고 오류를 표시한다.
이전 열 순서의 시트는 자동 변환하지 않으므로 빈 탭을 사용한다. 수식은 표시 결과가 비어 있어도 기존 값으로 취급한다.
헤더 조회·생성에 실패하면 데이터 행을 추가하지 않는다. 탭 자체는 자동 생성하지 않는다.
행은 해당 탭의 A:J 데이터 표 아래에 `INSERT_ROWS`로 추가한다.

| 변수 | 값 | 배포 설정 |
| --- | --- | --- |
| `GOOGLE_SERVICE_ACCOUNT_EMAIL` | 서비스 계정 JSON의 `client_email` | Secret |
| `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY` | JSON의 `private_key`, PEM 형식 | Secret |
| `GOOGLE_INVENTORY_SHEET_ID` | 스프레드시트 URL의 `/d/` 뒤 ID | 일반 변수 또는 Secret |
| `GOOGLE_INVENTORY_SHEET_TAB_NAME` | 탭 이름과 정확히 일치하는 문자열 | 일반 변수 또는 Secret |

로컬에서는 `.dev.vars.example`의 키 이름을 참고해 `.dev.vars`에 값을 설정한다.
비공개 키의 실제 줄바꿈과 `\n` 문자열을 모두 지원한다. JSON 파일 경로는 Worker에서 사용하지 않는다.
`.dev.vars`는 Git에 포함하지 않으며 자동으로 배포되지 않는다.

배포할 Worker에 아래 이름으로 등록한다. 각 명령의 입력 프롬프트에 **값만** 붙여 넣는다.
네 항목 모두 Secret으로 등록해도 동작한다. Slack Secret 두 개도 기존과 같이 필요하다.

```bash
npx wrangler secret put GOOGLE_SERVICE_ACCOUNT_EMAIL
npx wrangler secret put GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY
npx wrangler secret put GOOGLE_INVENTORY_SHEET_ID
npx wrangler secret put GOOGLE_INVENTORY_SHEET_TAB_NAME
npm run deploy
```

실제 키·JSON 파일 내용을 소스 코드나 `wrangler.jsonc`에 넣지 않는다.
프로젝트 설정의 `keep_vars: true`는 대시보드에서 관리하는 일반 변수를 유지하기 위한 옵션이다.

인증은 서비스 계정 JWT(`RS256`, Sheets scope)로 액세스 토큰을 발급받는다.
요청 제한은 멤버 조회와 모달 열기 합계 2초, 제출 시 채널 멤버 확인 1초, 사용자 이름 조회 1초,
보고 게시와 링크 조회 각각 2초, Google 토큰 발급 5초, 헤더 조회·생성과 시트 추가 합계 15초이다.
보고 게시부터 시트 저장까지 전체에 22초 제한도 함께 적용한다. 이후 결과 모달 갱신은 시도당 2초, 최대 3회(재시도 간격 200ms)로 제한하여
`waitUntil`의 응답 후 30초 실행 한도 안에 결과 안내 시간을 확보한다.
Google 토큰·시트 응답 본문이나 입력값 전체는 로그로 남기지 않는다.

```bash
npx wrangler tail ppc-inventory-automation --format pretty
```

- `inventory.report_posted`: Slack이 보고 게시를 확인함, `channelId`와 `messageTs`로 게시 위치 확인
- `inventory.saved`: 채널 보고와 메시지 링크를 포함한 Sheets 저장을 확인함
- `inventory.save_unconfirmed`: 처리 오류 또는 결과 불명확, `status`와 `reason` 확인 (`report_unconfirmed`: 게시 불명확, `link_unconfirmed`: 링크 조회 실패, `unconfirmed`: 시트 저장 미확인)
- `inventory.status_update_failed`: 결과 모달 갱신 실패, 함께 기록된 `status`로 저장 결과 확인

로그의 `submissionId`로 한 제출의 저장과 화면 갱신 결과를 연결할 수 있다.
결과 모달이 아직 생성되지 않았으면 **화면 갱신만** 최대 3회 시도한다.
보고 게시와 시트 추가는 자동 재시도하지 않는다. `waitUntil`은 영속 큐가 아니므로 전달·중복 방지를 보장하지 않으며,
같은 입력을 다시 제출하거나 Slack이 요청을 재전송하면 중복 메시지·행이 생길 수 있다.
엄격한 재시도·중복 방지가 필요하면 별도의 영속 큐와 저장된 제출 식별자가 필요하다.

참고: [서비스 계정 인증](https://developers.google.com/identity/protocols/oauth2/service-account),
[Sheets 행 추가](https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets.values/append),
[Worker waitUntil](https://developers.cloudflare.com/workers/runtime-apis/context/#waituntil).

검증: `npm run typecheck`, `npm test`. 테스트는 Slack과 Google API를 모킹하므로 실제 메시지나 시트 행을 만들지 않는다.

규격: [Slack slash command 공식 문서](https://docs.slack.dev/interactivity/implementing-slash-commands/),
[기본 선택 메뉴](https://docs.slack.dev/reference/block-kit/block-elements/select-menu-element/#select-menu-of-static-options),
[채널 멤버 조회](https://docs.slack.dev/reference/methods/conversations.members/).
