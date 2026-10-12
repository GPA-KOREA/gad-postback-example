# GAD 서버 API·포스트백 예제

Android·iOS 앱의 서버에서 공통으로 사용하는 **서버 API 호출·포스트백 수신 예제**입니다. SDK 설치 없이 Node.js 20 이상에서 실행하며 외부 패키지가 필요하지 않습니다.

- **서버 API를 호출하려면:** [비공개 설정 생성·목록 조회·참여·완료 예제](SERVER_API.md)
- **포스트백을 받으려면:** 아래 수신기 실행 안내
- **API 스펙을 확인하려면:** [OpenAPI](openapi.yaml) · [공식 서버 API 가이드](https://developers.gpakorea.com/developers/guide/api)
- **실제 검증 범위를 확인하려면:** [검증 기록](VALIDATION.md)

**수신기는 테스트 전용**입니다. 일반 GAD 포스트백을 받아 중복을 구분하고 HTTP 200으로 응답하며 실제 사용자에게 포인트를 지급하지 않습니다. API 클라이언트는 테스트·운영을 지원합니다. CLI의 운영 검증은 조회만 허용합니다.

Node.js 20 이상을 사용합니다. GAD 서버 프로젝트나 Android/iOS 프로젝트를 받을 필요가 없으며, `npm install`, 운영 환경 파일, DB 접속도 필요하지 않습니다.

- [포스트백 규격](https://developers.gpakorea.com/developers/guide/postback)
- [테스트 미디어키·콜백 설정](https://developers.gpakorea.com/developers/console#callbacks)
- [SDK 테스트 방법](https://developers.gpakorea.com/developers/guide/testing)

## 실행

이 저장소만 복제하고 루트에서 실행합니다.

```bash
git clone https://github.com/GPA-KOREA/gad-postback-example.git
cd gad-postback-example
node --test *.test.mjs
```

먼저 비공개 임시 디렉터리에 설정을 만듭니다. 아래 명령은 실제 키나 콜백 경로를 출력하지 않습니다.

```bash
umask 077
EXAMPLE_PRIVATE_DIR="$(mktemp -d)"
export EXAMPLE_PRIVATE_DIR

node --input-type=module <<'NODE'
import {randomBytes} from "node:crypto";
import {writeFileSync} from "node:fs";
import {join} from "node:path";

const directory = process.env.EXAMPLE_PRIVATE_DIR;
writeFileSync(join(directory, "receiver.json"), JSON.stringify({
  mediaKeys: ["REPLACE_WITH_YOUR_TEST_MEDIA_KEY"],
  pathToken: randomBytes(32).toString("base64url"),
  port: 3800,
  evidenceFile: join(directory, "receipts.jsonl"),
  allowedUids: ["synthetic-test-user"],
  runMarker: "synthetic-test-run",
  failFirst: 0
}, null, 2), {mode: 0o600});
console.log("비공개 설정 파일을 생성했습니다.");
NODE
```

`receiver.json`의 `mediaKeys`를 콘솔의 **테스트 키**로 바꿉니다. 실제 키·설정·콜백 경로를 Git에 올리거나 명령행 인자로 넘기지 마세요.

```bash
GAD_POSTBACK_CONFIG="$EXAMPLE_PRIVATE_DIR/receiver.json" node server.mjs
```

수신기는 기본적으로 `127.0.0.1:3800`에서만 동작합니다. 시작 로그에는 포트만 나옵니다. `GET /healthz`는 비밀 정보 없이 상태를 확인합니다.

외부 HTTPS 터널이나 역방향 프록시로 이 로컬 포트를 연결합니다. 콘솔에 등록할 주소는 `https://<공개 호스트>/postback/<설정의 pathToken>`입니다. 전체 주소도 비공개로 취급하며 접근 로그에서 숨기세요.

테스트 콜백은 공개 도메인·HTTPS·443 포트여야 합니다. 스테이징 서버의 **정확한 외부 호스트 허용**이 별도로 필요합니다. 콘솔에서 `허용됨`을 확인한 후 참여를 완료하세요. 콜백을 등록하기 전에 완료된 건은 발송되지 않습니다.

`allowedUids`와 `runMarker`는 선택 사항입니다. 넣었다면 참여의 사용자 ID와 `data` 값이 각각 설정과 일치해야 합니다. SDK 테스트에서 임의 `data`를 넘길 수 없다면 `runMarker` 항목을 생략하세요. 운영 키·실제 사용자 데이터를 이 테스트 수신기로 보내지 마세요.

## 설정

| 항목 | 의미 |
|---|---|
| `mediaKeys` | 수신을 허용할 테스트 미디어키 배열, 1~10개 |
| `pathToken` | 무작위 비공개 경로, base64url 문자 32~128자 |
| `host` | 생략하면 `127.0.0.1`; 루프백 `127.0.0.1` 또는 `::1`만 가능 |
| `port` | 생략하면 3800 |
| `evidenceFile` | 비공개 JSONL 파일의 절대 경로 |
| `allowedUids` | 선택. 합성 테스트 사용자 ID 허용 목록, 각 48자 이내 |
| `runMarker` | 선택. `publisher_data`에 정확히 일치해야 하는 합성 실행 표식 |
| `failFirst` | 기본 0. 각 새 `seq`의 첫 N회를 HTTP 503으로 실패시킴, 0~3 |

설정 파일과 기존 증거 파일은 일반 파일이어야 하며 macOS/Linux에서는 그룹·다른 사용자의 접근 권한이 없어야 합니다(예: 0600). 설정 파일은 16 KiB 이하입니다.

`failFirst: 1`은 첫 요청에 **503 + Retry-After: 30**을 응답합니다. 같은 이벤트가 재전송되어 200으로 처리되는지 확인할 때만 사용합니다. 켜면 시작 경고가 나오며 기본값은 꺼짐입니다. 503/429는 일반 실패와 달리 GAD의 재시도 횟수를 차감하지 않습니다.

## 수신·ACK·중복 처리

현재 일반 포스트백의 `seq`, `media`, `adKey`, `adTitle`, `uid`, `publisher_data`, `point` 7개 필드를 검사합니다.

- `Content-Type: application/json` 또는 UTF-8 charset만 받고, 압축 본문은 받지 않습니다.
- `media`는 설정된 키와 정확히 같아야 합니다. `point`는 0 이상의 안전한 정수여야 합니다.
- 최대 본문은 16 KiB입니다. 잘못된 JSON·필드·초과 본문은 성공 응답하지 않습니다.
- 처음 받은 이벤트는 비식별 수신 증거를 기록한 뒤 **정확히 HTTP 200**으로 응답합니다.
- 같은 `seq`와 같은 내용이면 다시 처리하지 않고 200으로 응답합니다. JSON 필드 순서는 달라도 됩니다.
- 같은 `seq`에 내용이 달라지면 409로 거절합니다. 실패 응답을 시험 중인 이벤트도 같습니다.
- HTTP 204는 GAD에서 성공이 아닙니다. GAD는 3초 안의 HTTP 200을 성공으로 판단하고 응답 본문은 확인하지 않습니다.

일반 GAD 포스트백에는 현재 요청 서명이 없습니다. 이 예제는 GAD HMAC 검증을 구현했다고 주장하지 않습니다. 비공개 경로·미디어키 일치 검사는 발신자 신원을 증명하지 않습니다. 운영에서는 별도 발신 IP 정책 등 검증된 인증 수단이 필요합니다.

**이 예제는 메모리에만 중복 상태를 보관합니다. 재시작·다중 프로세스 사이에서 중복을 막지 못하며, 이벤트 10,000개에 도달하면 503으로 거절합니다.** 실제 지급 시스템에서는 `seq` 고유 제약과 포인트 지급을 같은 영속 DB 트랜잭션으로 처리해야 합니다. 이 예제의 파일 로그를 지급 원장으로 사용하면 안 됩니다.

## 수신 증거

증거 파일에는 다음처럼 기록됩니다. 실제 키, UID, 원문 seq, 광고명, 콜백 경로, 요청 본문은 저장하지 않습니다.

```json
{"at":"2026-10-12T00:00:00.000Z","seqHash":"0123456789abcdef","mediaIndex":0,"uidIndex":0,"outcome":"accepted","status":200,"point":5,"attempt":1}
```

- `seqHash`: seq의 SHA-256 앞 16자리. 수신 증거 연결용이며 실제 중복 판정은 원문 seq로 합니다.
- `mediaIndex`: 비공개 설정 `mediaKeys`의 0부터 시작하는 순서.
- `uidIndex`: `allowedUids`를 설정한 경우에만 나오는 0부터 시작하는 순서.
- `outcome`: `accepted`, `duplicate`, `conflict`, `simulated_failure`.

잘못된 요청은 증거 파일에 본문이나 필드 값을 남기지 않습니다.

## 스테이징 통신 자동 검증

`verify-staging.mjs`는 고정된 스테이징 API와 설치형 시험 광고 `staging-ad-3`만 호출합니다. 목록 → 참여 → 완료 → 보상 한 건 → 완료 상태 22 → 실제 웹훅 수신을 확인합니다. **서버 포스트백 통신 검증이며, 네이티브 SDK 실행·실제 앱 설치·운영 광고 검증은 포함하지 않습니다.** [서버 API 호출 예제](SERVER_API.md)와 [공식 가이드](https://developers.gpakorea.com/developers/guide/api)를 함께 확인하세요.

자동 검증을 선택하면 **수신기 시작 전에** 아래 설정을 생성합니다. 앞에서 실행했다면 수신기를 종료하고, 이 설정 생성 후 다시 시작합니다. `receiver.json`의 테스트 키를 먼저 입력해 두세요.

```bash
node --input-type=module <<'NODE'
import {randomUUID} from "node:crypto";
import {readFileSync, writeFileSync} from "node:fs";
import {join} from "node:path";

const directory = process.env.EXAMPLE_PRIVATE_DIR;
const path = join(directory, "receiver.json");
const receiver = JSON.parse(readFileSync(path, "utf8"));
const media = receiver.mediaKeys.map(key => ({
  key,
  uid: "webhook-" + randomUUID(),
  adid: randomUUID()
}));
const runMarker = "webhook-" + randomUUID();
receiver.allowedUids = media.map(item => item.uid);
receiver.runMarker = runMarker;
receiver.failFirst = 1;
writeFileSync(path, JSON.stringify(receiver, null, 2), {mode: 0o600});
writeFileSync(join(directory, "verify.json"), JSON.stringify({
  media, runMarker,
  receiverEvidenceFile: receiver.evidenceFile,
  privateResultFile: join(directory, "verification-private.json")
}, null, 2), {mode: 0o600});
console.log("자동 검증 설정을 생성했습니다. 수신기를 시작하고 콜백을 등록하세요.");
NODE
```

각 키에는 서로 다른 합성 UID와 광고 ID를 사용합니다. 설정 배열의 순서는 수신기의 `mediaKeys`·`allowedUids`와 같아야 합니다. 재시험할 때는 새 UID·광고 ID로 설정을 다시 만들고 수신기를 다시 시작합니다. 완료된 광고의 사용자·기기 이력은 미디어키만 바꿔도 초기화되지 않습니다.

수신기를 실행하고 모든 시험 매체의 콜백을 저장한 뒤 `허용됨` 상태를 확인합니다. 같은 임시 수신 URL에 여러 키를 연결할 수 있습니다.

```bash
GAD_STAGING_VERIFY_CONFIG="$EXAMPLE_PRIVATE_DIR/verify.json" \
  node verify-staging.mjs --verify-staging-postback
```

최대 10개 키를 순서대로 검사하며, 기본 수신 대기는 매체당 120초입니다. 최초 503 후 재전송도 이 시간에 포함됩니다. 명시적 실행 옵션이 없으면 요청하지 않으며 운영 주소·리다이렉트는 거절합니다. CLI에는 식별정보 없는 결과만 출력합니다. 원문 API 응답은 비공개 `verification-private.json`에 저장되므로 공유하지 마세요.

실제 수행 결과는 [검증 기록](VALIDATION.md)에서 확인할 수 있습니다.

## 검증과 종료

```bash
node --test *.test.mjs
```

테스트는 합성 값으로 임시 루프백 서버를 열며 DB나 GAD 서버에 접속하지 않습니다. 실제 검증에서는 아래를 확인합니다.

1. 콘솔에서 테스트 키의 콜백을 저장한 뒤 다시 불러와 같은 URL과 `허용됨` 상태를 확인합니다.
2. 합성 사용자로 테스트 광고를 실제 완료하고, 해당 매체 순서의 `accepted` 증거·HTTP 200·기대 포인트를 확인합니다.
3. 필요하면 `failFirst: 1`로 첫 503 이후 **같은 seqHash**의 200 재전송을 확인합니다.
4. 같은 요청 재전송이 `duplicate`로 200이고 수락은 한 번인지 확인합니다. 다른 키·UID·표식은 거절되고, 이미 본 같은 `seq`의 `point` 등 본문을 바꾸면 409인지 확인합니다.
5. 모든 합성 테스트 포스트백이 처리된 것을 확인하고 콘솔의 원래 콜백을 복원합니다.
6. 추가했던 외부 호스트 허용을 원복하고 터널과 수신기를 종료합니다. `Ctrl+C` 또는 SIGTERM으로 수신기를 종료할 수 있습니다.
7. 공개 주소·로컬 포트가 닫혔는지 확인하고 비공개 설정을 지웁니다. 공유할 증거에는 비식별 기록만 사용합니다.

서버를 먼저 끄면 미처리 테스트 포스트백이 재시도될 수 있습니다. 미처리 건을 남긴 채 원래 콜백으로 되돌리지 마세요.
