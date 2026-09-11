# PPC inventory automation

## todo

1. Slack 요청 서명 검증
2. 가짜 Slack 요청을 이용한 로컬 테스트
3. /slack/commands 라우트
4. /inventory 실행 시 모달 열기
5. /slack/interactions에서 제출값 파싱
6. 입력값 검증
7. Google Sheets 연동

## Slack command 수신

Slack 앱의 Slash Commands 설정에서 Request URL을 `https://<Worker 도메인>/slack/commands`로 지정한다.
Worker에는 `SLACK_SIGNING_SECRET`과 `SLACK_BOT_TOKEN`이 설정되어 있어야 한다.

`POST /slack/commands`는 서명을 검증한 뒤 `application/x-www-form-urlencoded` 본문에서
`command`를 읽는다. `/inventory` 요청의 `trigger_id`로 Slack `views.open`을 호출하고,
성공하면 빈 HTTP 200 응답을 반환한다. 모달 API 요청에는 2초 제한을 적용하며,
실패하면 명령어를 실행한 사용자에게 오류 안내를 반환한다.

서명 검증 실패는 401, 잘못된 command는 400, 지원하지 않는 Content-Type은 415,
POST 이외의 메서드는 405를 반환한다.

## 재고 발견 모달

Slack 앱의 Interactivity & Shortcuts Request URL은 `https://<Worker 도메인>/slack/interactions`로 설정한다.
Socket Mode는 끈 상태로 사용한다. 로컬에서는 `.dev.vars`, 운영에서는 Worker Secret에
Bot User OAuth Token(`xoxb-…`)을 `SLACK_BOT_TOKEN`으로 설정한다.

| 항목 | 처리 방식 |
| --- | --- |
| 바코드 | 필수 문자열, 앞자리 0 유지, 최대 100자 |
| 수량 | 필수, 1 이상의 정수 |
| 소비기한 | 필수 날짜 선택, 이미 지난 날짜도 허용 |
| 발견로케이션 | 필수, 하이픈(-) 제거 및 양끝 공백 정리, 최대 100자 |
| 발견자 | 제출 요청의 `user.id`로 자동 설정 |
| 발견시각 | 제출 요청 수신 시각, 내부 ISO UTC / 화면 한국시간 |
| 유형 | 필수 선택: 과재고 / 부족재고 |

제출 요청도 Slack 서명 검증 후 처리한다. 입력 오류는 모달의 해당 항목에 표시한다.
정상 제출 시 입력값과 자동 항목을 확인 화면에 표시한다.
**현재는 입력 확인 단계이며, Google Sheets나 다른 저장소에 데이터를 저장하지 않는다.**
화면의 버튼도 `저장` 대신 `확인`으로 표시한다.

검증: `npm run typecheck`, `npm test`. 테스트는 Slack API를 모킹하므로 실제 모달이나 메시지를 보내지 않는다.

규격: [Slack slash command 공식 문서](https://docs.slack.dev/interactivity/implementing-slash-commands/).
