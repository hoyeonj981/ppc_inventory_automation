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

Slack 앱의 Slash Commands 설정에서 Request URL을 `https://<Worker 도메인>/slack/commands`로 지정한다.
Worker에는 `SLACK_SIGNING_SECRET`과 `SLACK_BOT_TOKEN`이 설정되어 있어야 한다.

`POST /slack/commands`는 서명을 검증한 뒤 `application/x-www-form-urlencoded` 본문에서
`command`를 읽는다. `/report` 요청의 `trigger_id`로 Slack `views.open`을 호출하고,
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
| 소비기한 | 필수 날짜 선택, 이미 지난 날짜도 허용 |
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

`저장 완료`는 채널 게시·링크 조회 후 Sheets API가 한 행(8개 셀)의 추가를 확인한 경우에만 표시한다.
게시 결과가 불명확하거나 링크 조회에 실패하면 시트에는 행을 추가하지 않는다.
채널 보고가 게시된 뒤 시트 저장이 실패하면 `채널 보고는 게시되었습니다. 시트 저장 여부를 확인하지 못했습니다`로 안내한다.
시간 초과 시 이미 메시지나 행이 만들어졌을 수 있으므로, 중복 입력을 피하려면 채널과 시트를 확인한 뒤 다시 제출한다.
모달을 닫아 결과 화면을 표시할 수 없더라도 확인된 처리 결과는 Worker 로그에 남는다.

사진은 Slack에만 보관한다. 시트의 링크를 열려면 해당 Slack 채널 접근 권한이 필요하며,
메시지·사진 삭제 및 워크스페이스 보존 정책에 따라 나중에 열리지 않을 수 있다.
규격: [사진 입력](https://docs.slack.dev/reference/block-kit/block-elements/file-input-element/),
[Slack 이미지 참조](https://docs.slack.dev/reference/block-kit/composition-objects/slack-file-object/),
[메시지 링크 조회](https://docs.slack.dev/reference/methods/chat.getPermalink/).

## Google Sheets 행 변환

`parseInventoryValues`가 모달 입력을 검증하고 정규화한 `InventoryRecord`를 만든다.
`src/sheets/inventory.ts`의 `toInventorySheetRow(record, foundByName, reportUrl)`는 이 레코드를 시트 한 행으로 변환한다.
발견자 이름은 기존 `getSlackUserName` 조회 결과를 전달하며, 생략하거나 공백이면 Slack ID로 대체한다.

| 열 | 값 | 자료형 |
| --- | --- | --- |
| A | 바코드 | 문자열, 앞자리 0 유지 |
| B | 수량 | 숫자 |
| C | 소비기한 | `YYYY-MM-DD` 문자열 |
| D | 발견로케이션 | 입력한 하이픈을 유지한 문자열, 예: `A-01-02` |
| E | 발견자 | 프로필 이름, 조회 실패 시 Slack ID |
| F | 발견시각 | 서울(UTC+09:00) ISO 8601 문자열, 예: `2027-01-16T08:30:00.000+09:00` |
| G | 유형 | `과재고` 또는 `부족재고` |
| H | 보고 메시지 링크 | Slack 보고 메시지의 HTTPS URL |

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
매 제출 시 대상 탭의 A1:H1을 조회하고, 모두 비어 있으면 위 열 순서대로 헤더를 자동 입력한다.
기존 시트는 A1:G1을 유지하고 H1이 비어 있으면 `보고 메시지 링크`만 추가한다.
H1에 다른 값이 있으면 덮어쓰거나 행을 추가하지 않고 오류를 표시한다. H열은 보고 메시지 링크 전용으로 비워 두어야 한다.
기존 데이터 행에 메시지 링크를 소급해서 채우지는 않는다. A1:G1의 부분적으로 빠진 헤더도 자동 보충하지 않는다.
기존 헤더의 순서는 위 표와 맞춰야 한다. 수식은 표시 결과가 비어 있어도 기존 값으로 취급한다.
헤더 조회·생성에 실패하면 데이터 행을 추가하지 않는다. 탭 자체는 자동 생성하지 않는다.
행은 해당 탭의 A:H 데이터 표 아래에 `INSERT_ROWS`로 추가한다.

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
