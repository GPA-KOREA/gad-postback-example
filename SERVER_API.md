# 서버 API 호출 예제

Android·iOS 앱의 서버에서 같은 HTTP 규격으로 연동합니다. SDK 설치는 필요하지 않습니다. **미디어키는 서버에 보관**하며 앱·브라우저에 넣지 않습니다.

[공식 가이드](https://developers.gpakorea.com/developers/guide/api) · [OpenAPI 스펙](openapi.yaml) · [콜백 설정](https://developers.gpakorea.com/developers/console#callbacks) · [포스트백 수신기](README.md)

## 먼저 목록을 조회하세요

Node.js 20 이상에서 외부 패키지 없이 실행합니다. 저장소 루트에서 비공개 설정 파일을 만듭니다. 실제 키는 아래 명령의 자리표시자 대신 **파일 편집기로** 입력하세요.

```bash
umask 077
EXAMPLE_PRIVATE_DIR="$(mktemp -d)"
export EXAMPLE_PRIVATE_DIR

node --input-type=module <<'NODE'
import {writeFileSync} from "node:fs";
import {join} from "node:path";
import {randomUUID} from "node:crypto";

const directory = process.env.EXAMPLE_PRIVATE_DIR;
writeFileSync(join(directory, "api.json"), JSON.stringify({
  environment: "staging",
  mediaKey: "REPLACE_WITH_YOUR_TEST_SERVER_API_MEDIA_KEY",
  request: {
    adKey: "staging-ad-3",
    uid: "api-test-" + randomUUID(),
    adid: randomUUID(),
    ip: "198.51.100.42",
    data: "synthetic-server-api-test"
  },
  privateResultFile: join(directory, "api-response.private.json")
}, null, 2), {mode: 0o600});
console.log("비공개 API 설정을 생성했습니다.");
NODE

GAD_API_CONFIG="$EXAMPLE_PRIVATE_DIR/api.json" node api-example.mjs list
```

`environment`는 `staging`(기본) 또는 `production`입니다. 운영을 조회할 때는 환경과 키를 **함께** 바꿉니다. 예제는 키가 어느 환경에서 발급됐는지 추측하지 않습니다.

터미널에는 `itemCount`·HTTP 상태·결과 코드만 출력합니다. 광고키·URL 등 원문 응답은 설정의 비공개 결과 파일에서 확인합니다. 파일에는 개인정보가 포함될 수 있어 공유하거나 Git에 올리면 안 됩니다. GET 규격에는 키가 쿼리에 포함되므로 프록시·APM의 요청 URL도 마스킹하세요.

## 요청 규격

| 환경 | API 기본 주소 |
|---|---|
| 테스트 | `https://gad-staging.gpakorea.com` |
| 운영 | `https://gad.api.gpakorea.com` |

키는 `media` 필드로 보냅니다. GET은 쿼리, POST는 JSON 본문을 사용합니다. Bearer 토큰·커스텀 인증 헤더는 이 규격에 없습니다.

| 호출 | 메서드·경로 | 필수 필드 | 선택 필드 |
|---|---|---|---|
| `client.list()` | `GET /campaign/list` | `media` | `adid`, 반복 `include`, 반복 `exclude` |
| `client.status()` | `GET /campaign/status` | `media`, `adKey`, `adid` | `uid` |
| `client.join()` | `POST /campaign/join` | `media`, `adKey`, `uid`, `adid` | `data`, `ip` |
| `client.complete()` | `POST /campaign/complete` | `media`, `adKey`, `uid`, `adid` | `ip` |
| `client.rewards()` | `GET /campaign/reward/list` | `media`, `uid` | 없음 |

`media`는 클라이언트가 설정에서 자동으로 넣습니다. `uid`는 매체의 사용자 ID(1~48자), `adid`는 사용자 기기의 광고·참여 식별자입니다. Android는 ADID를 사용하며, iOS는 광고 공급사가 지원하는 식별값과 연동 범위를 확인하세요. 이 호출 예제는 빈 값·제어문자·0 광고 ID를 거절하며 식별자 길이를 64자로 제한합니다(예제의 입력 제한). `ip`에는 사용자 IP를 넣으며 서버 IP로 대체하지 않습니다. 위 TEST-NET IP와 무작위 ID는 **스테이징 합성 시험 전용**입니다.

- `include: [0, 1]`은 `include=0&include=1`로 보냅니다. `include`가 있으면 서버는 `exclude`를 무시합니다.
- 참여 응답의 `join.url`을 변경 없이 사용자에게 엽니다. 참여 성공은 적립 완료가 아닙니다.
- `status`는 **기기 기준**입니다. `uid`를 보내도 사용자별 판정으로 바뀌지 않습니다. 코드 0은 완료 기록이 없다는 뜻이며, 사용자 중복·IP 제한·광고 소진까지 통과했다는 보장은 아닙니다. CLI는 `no_completion_record`로 표시합니다.
- `complete`는 매체가 설치를 확인한 **GAD 설치형 광고**에 사용합니다. 모든 광고를 끝내는 호출이 아닙니다. 방문형은 안내 페이지, 미션형은 제출·검수, 외부 광고망은 각 광고망 포스트백으로 완료됩니다. CPS 주문·구매확정은 이 예제 범위에 없습니다.
- `rewards`는 해당 `media`·`uid`의 **최근 1개월** 적립을 조회합니다. 전체 지급 원장이나 포스트백 재발송 API가 아닙니다.

### 요청 모양

실제 키를 명령행에 넣지 않고, `api-example.mjs`가 아래 형태로 요청합니다. 값은 모두 예시입니다.

```http
GET /campaign/list?media=YOUR_MEDIA_KEY&include=0&include=1
Accept: application/json
```

```http
POST /campaign/join
Content-Type: application/json

{"media":"YOUR_MEDIA_KEY","adKey":"staging-ad-3","uid":"synthetic-user","adid":"11111111-1111-4111-8111-111111111111","data":"synthetic-run","ip":"198.51.100.42"}
```

```http
GET /campaign/status?media=YOUR_MEDIA_KEY&adKey=staging-ad-3&adid=11111111-1111-4111-8111-111111111111
```

```http
POST /campaign/complete
Content-Type: application/json

{"media":"YOUR_MEDIA_KEY","adKey":"staging-ad-3","uid":"synthetic-user","adid":"11111111-1111-4111-8111-111111111111","ip":"198.51.100.42"}
```

```http
GET /campaign/reward/list?media=YOUR_MEDIA_KEY&uid=synthetic-user
```

### HTTP와 결과 코드를 함께 확인하세요

HTTP 200도 성공을 보장하지 않습니다. 응답 JSON의 `code`를 확인합니다. 클라이언트는 200 이외 HTTP 응답·리다이렉트·잘못된 JSON·예상 밖 결과 코드를 거절합니다.

| `code` | 처리 |
|---|---|
| `0` | 정상. 목록은 `items`, 참여는 `join`, 완료는 `reward` 확인 |
| `22` | 이미 완료. `status`에서는 완료 상태, `join`에서는 재참여 거절 |
| `24` | 미션 검수 중. `status`에서 검수 상태 |
| `30` | 이미 적립됨. `complete`의 22·30은 추가 지급하지 않음 |
| `20`·`21`·`25` | 각각 잘못된 매체·광고·참여 내역 없음 |
| `26`·`100`·`200`·`300`·`900` | 소진·파라미터 오류·참여 제한·기타 거절·미지원. [공식 스펙](openapi.yaml) 확인 |

`ApiError`에는 고정된 오류 코드와 숫자 `httpStatus`·`resultCode`만 담습니다. 서버가 반환한 `message`·원래 예외·URL은 로그로 내보내지 않습니다. `status`의 0·22·24와 `complete`의 22·30은 반환값으로 구분합니다. 그 밖의 비정상 결과는 예외입니다.

## 내 서버에서 가져다 쓰기

```js
import {createClient, readPrivateJson} from "./api-client.mjs";

const config = readPrivateJson(process.env.GAD_API_CONFIG);
const client = createClient(config); // 기본: 조회만 허용
const result = await client.list({include: [0, 1]});
// result.httpStatus === 200, result.resultCode === 0
// result.data.items를 사용합니다. result 전체를 로그에 남기지 마세요.
```

실제 사용자의 참여를 처리하는 서버는 쓰기 호출을 명시적으로 켭니다. 운영 환경도 지원하지만 자동 검증 CLI에서는 운영 쓰기를 허용하지 않습니다.

```js
const client = createClient({...config, allowMutations: true});
const joined = await client.join({
  adKey: campaign.key,
  uid: user.id,
  adid: device.advertisingId,
  ip: userIp,
  data: yourCorrelationId
});
// joined.data.join.url을 사용자에게 전달합니다.
// 설치가 실제 확인된 GAD 설치형 광고에만 client.complete(...)를 호출합니다.
```

기본 제한 시간은 10초(최대 30초), 응답 본문은 최대 256 KiB입니다. 키를 다른 호스트로 보내지 않도록 API 호스트가 고정돼 있고 리다이렉트를 따라가지 않습니다. 자동 재시도는 하지 않습니다. 특히 참여·완료의 응답 유실 후에는 상태와 보상을 확인해 중복 요청 여부를 판단하세요.

## 스테이징 연동 확인

CLI의 기본 동작은 조회입니다. 설정의 광고키가 정확히 `staging-ad-3`일 때만 명시적 옵션으로 참여·완료할 수 있습니다. 새 시험은 새 합성 UID·광고 ID로 진행하세요.

```bash
GAD_API_CONFIG="$EXAMPLE_PRIVATE_DIR/api.json" node api-example.mjs status
GAD_API_CONFIG="$EXAMPLE_PRIVATE_DIR/api.json" node api-example.mjs join --allow-staging-mutations
GAD_API_CONFIG="$EXAMPLE_PRIVATE_DIR/api.json" node api-example.mjs complete --allow-staging-mutations
GAD_API_CONFIG="$EXAMPLE_PRIVATE_DIR/api.json" node api-example.mjs reward-list
GAD_API_CONFIG="$EXAMPLE_PRIVATE_DIR/api.json" node api-example.mjs status
```

설치할 실제 앱이 없는 **고정 설치형 시험 광고**입니다. 마지막 상태 22·보상 1건만으로 웹훅 수신을 성공이라고 판단하지 않습니다. 콘솔의 콜백을 먼저 저장하고 수신기를 실행한 뒤, 실제 HTTPS 수신까지 확인하세요.

[README의 통신 자동 검증](README.md#스테이징-통신-자동-검증)은 위 흐름과 웹훅 수신 증거를 함께 검사합니다. CLI와 자동 검증기를 같은 UID·광고 ID로 연속 실행하면 완료 이력이 겹치므로 새 ID를 사용하세요. 수신기 `runMarker`를 설정했다면 참여 `data`와 같아야 합니다.

## 운영 검증과 종료

운영 키·주소로는 CLI의 `list`, `status`, `reward-list` 조회만 가능합니다. 운영 광고에 합성 사용자로 참여하거나 설치를 가정해 완료하지 않습니다. 스테이징 fixture는 운영에 존재한다고 가정하지 않습니다. 공개 문서·콘솔·키·목록·상태의 운영 읽기 검증과 스테이징 포스트백 전체 검증을 구분해 기록합니다.

```bash
node --test *.test.mjs
```

단위 테스트는 fetch 주입으로 요청·응답·실패·리다이렉트·시간 제한·원문 비공개를 검증하며 GAD API와 DB에 연결하지 않습니다. [실제 검증 기록](VALIDATION.md)은 실행 환경과 확인 범위를 별도로 기록합니다.

포스트백 검증 후에는 미처리 시험 이벤트가 없음을 확인하고 원래 콜백·임시 호스트 허용을 복원한 뒤 수신기와 터널을 종료합니다. 비공개 설정·결과 파일은 필요한 검증이 끝나면 지웁니다.
