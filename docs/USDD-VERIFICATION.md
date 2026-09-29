# USDD 주소 및 PSM 역할 재검증

검증일: 2026-09-29 UTC / 2026-09-28 America/Los_Angeles. 공개 프로토콜 주소와 공식 자료만 조회했다. 개인 지갑·키·다른 프로젝트 환경을 사용하지 않았으며, 서명·전송·자금 이동은 없다.

## 결론과 적용 범위

**USDD 토큰의 일치는 확인했다.** 현재 공식 배포 목록의 USDD, JustLend 공식 등록부의 jUSDD 기초자산, 실제 `jUSDD.underlying()`, 실제 PSM의 `usdd()`가 모두 `TXDk8mbtRbXeYuMNS83CfKPaYYT8XWv9Hz`를 가리킨다. 해당 토큰의 `decimals()`는 18이다. 따라서 읽기용 USDD 주소를 정정했다.

이전 `TCrEVahRbhDFB6uRXEWUg7wkptXvg47GKs`를 별도 USDD 토큰 또는 마이그레이션이 필요한 토큰이라고 단정할 근거는 없다. 이번 RPC 조회에서 컨트랙트가 없다는 오류를 반환했다. 공식 담보 소개 페이지에는 이 주소가 여전히 나타나지만, 현재 개발자용 배포 목록은 `TXDk...`를 명시한다. 과거 검색 캐시에는 개발자 문서도 `TCrEV...`로 보인다. **문서 변경 시각·오류 원인은 확인하지 못했으며, 별도 마이그레이션을 추정하지 않는다.**

**USDD 투자·전환 경로는 계속 비활성화한다.** 토큰 식별 확인과 앱의 실행 지원은 별개다. 앱에는 PSM 양방향 한도의 실시간 검증, 해당 경로의 정확한 승인·교환·예치·회수 및 부분 실패 복구가 아직 없다. 한 번 읽은 `enabled=1`, `fee=0`을 상수로 저장하거나 실시간 실행 허가로 사용하지 않는다.

## 근거 자료

| 근거                                                                                                                                                | 확인 내용                                                                                                                                               |
| --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [USDD 개발자 배포 목록](https://docs.usdd.io/developers/deployment-addresses) / [Markdown](https://docs.usdd.io/developers/deployment-addresses.md) | USDD는 `TXDk...`; `JOIN_PSM_USDT_A`와 `MCD_PSM_USDT_A`를 구분한다. 직접 HTML도 조회했고 `TXDk...`는 있으며 `TCrEV...`는 없었다.                         |
| [USDD 담보 주소 설명](https://docs.usdd.io/introduction/collateral-asset-contract-addresses.md)                                                     | 아직 `TCrEV...`를 담보 주소로 표시하며, PSM/Join 명칭은 실제 ABI 역할과 다르게 읽힐 수 있다. 이 페이지의 제목·토큰명만으로 실행 대상을 결정하지 않는다. |
| [JustLend 공식 등록부](https://docs.justlend.org/developers/contracts.json)                                                                         | `networks.mainnet.jtokens.jUSDD.status=active`; underlying `TXDk...`, underlying_decimals=18, jToken decimals=8.                                        |
| [USDD 공식 담보 API](https://openapi.usdd.io/api/v1/data-platform/latest-collateral?chain=tron)                                                     | `PSM-USDT-A.contractAddress=TSUY...`는 담보 Join이다. `psmFee` 단일 값과 담보 규모만으로 양방향 운용 가능액을 확정할 수 없다.                           |
| [USDD 공식 PSM 코드, 고정 커밋](https://github.com/decentralized-usd/psm/blob/fce1b44a8ca12c9ff302eb374527d65ed04f165d/src/psm.sol)                 | `gemJoin`, `usddJoin`, `usdd`, 양방향 토글·수수료 및 서로 다른 승인 경로를 확인했다. 배포 바이트코드와 재현 컴파일까지 대조한 감사는 아니다.            |

이번 별도 JustLend 시장 API 직접 조회는 HTTP 403이었다. 과거 성공했던 응답을 이번 최신 응답이라고 재사용하지 않았다. 토큰 식별 결론은 이번에 성공한 공식 등록부와 RPC 읽기에 근거한다. USDD 배포 Markdown도 터미널에서는 403이 있었지만 웹 문서 조회 및 User-Agent를 지정한 공식 HTML 직접 조회는 성공했다.

## 실제 RPC 결과

RPC: `https://api.trongrid.io`. 읽기 호출은 각각 최신 상태를 조회했으며 하나의 동일 블록 스냅샷은 아니다.

- 메인넷 genesis: `00000000000000001ebf88508a03865c71d452e25f4d51194196a1d22b6653dc`.
- 조회 중 head: `86663823`, `2026-09-29T06:39:00Z`.
- 해당 head ID: `00000000052a628ff2e7fa28c5331244beaa5e6c631588bff5d968c4d4dca1a4`.

| 대상                                           | 읽기 함수 / API                  | 결과                                                                                                                    |
| ---------------------------------------------- | -------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `TCrEVahRbhDFB6uRXEWUg7wkptXvg47GKs`           | `decimals()` 및 `symbol()`       | `CONTRACT_VALIDATE_ERROR`, `Smart contract is not exist.`                                                               |
| `TXDk8mbtRbXeYuMNS83CfKPaYYT8XWv9Hz`           | `decimals()` / `symbol()`        | 18 / USDD                                                                                                               |
| jUSDD `TKFRELGGoRgiayhwJTNNLqCNjFoLBh3Mnf`     | `underlying()`                   | `TXDk8mbtRbXeYuMNS83CfKPaYYT8XWv9Hz`                                                                                    |
| PSM `TBXW4hS5KYjjbJXDpnrPf4zhkLwrpUjbyz`       | `usdd()`                         | 동일한 `TXDk8mbtRbXeYuMNS83CfKPaYYT8XWv9Hz`                                                                             |
| 같은 PSM                                       | `gemJoin()`                      | `TSUYvQ5tdd3DijCD1uGunGLpftHuSZ12sQ`                                                                                    |
| 같은 PSM                                       | `usddJoin()`                     | `TUajR7CbXU6hX8n3XtNkitFAD25JvP99K6`                                                                                    |
| 같은 PSM                                       | `sellEnabled()` / `buyEnabled()` | 각각 1                                                                                                                  |
| 같은 PSM                                       | `tin()` / `tout()`               | 각각 0                                                                                                                  |
| USDT Join `TSUYvQ5tdd3DijCD1uGunGLpftHuSZ12sQ` | `gem()`                          | USDT `TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t`                                                                               |
| USDT Join                                      | `wallet/getcontract`             | 이름 `AuthGemJoin5`; `gem`, `join`, `exit`, `live`, `vat`, `ilk`, `wards` ABI 확인                                      |
| PSM                                            | `wallet/getcontract`             | 이름 `UsddPsm`; `sellGem`, `buyGem`, `gemJoin`, `usdd`, `usddJoin`, `tin`, `tout`, `sellEnabled`, `buyEnabled` ABI 확인 |

`underlying()`와 `usdd()`의 ABI 원시 반환값은 모두 아래와 같았다. 앞의 0 패딩을 제거하고 TRON 주소 접두사 `41`을 붙여 Base58Check로 변환하면 `TXDk...`다.

```text
000000000000000000000000e91a7411e56ce79e83570570f49b9fc35b7727c5
```

`wallet/getcontract`가 USDD 및 UsddJoin에 대해 ABI/bytecode를 생략하고 `code_hash`만 반환한 경우도 있었다. 이를 빈 코드·없는 계약으로 오해하지 않았다. USDD 존재·식별은 실제 읽기 함수 응답으로 검증했다. RPC 제공 `code_hash`와 아래의 직접 계산한 SHA256은 서로 다른 필드이므로 혼용하지 않는다.

### 재현 입력

아래는 읽기 전용 호출이다. `owner_address`는 공개 USDT 프로토콜 주소이며 사용자 주소가 아니다. `triggerconstantcontract` 응답의 unsigned transaction 객체는 시뮬레이션 부산물이고 전송되지 않는다.

```sh
curl -sS https://api.trongrid.io/wallet/triggerconstantcontract \
  -H 'Content-Type: application/json' \
  -d '{"owner_address":"TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t","contract_address":"TKFRELGGoRgiayhwJTNNLqCNjFoLBh3Mnf","function_selector":"underlying()","visible":true}'

curl -sS https://api.trongrid.io/wallet/triggerconstantcontract \
  -H 'Content-Type: application/json' \
  -d '{"owner_address":"TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t","contract_address":"TXDk8mbtRbXeYuMNS83CfKPaYYT8XWv9Hz","function_selector":"decimals()","visible":true}'

curl -sS https://api.trongrid.io/wallet/getcontract \
  -H 'Content-Type: application/json' \
  -d '{"value":"TBXW4hS5KYjjbJXDpnrPf4zhkLwrpUjbyz","visible":true}'
```

나머지 결과는 첫 요청의 `contract_address`와 `function_selector`를 표대로 바꿔 재현할 수 있다. 재조회 결과가 달라지거나 RPC가 거부하면 이전 관측을 현재 상태로 대체하지 않는다.

### 조회 자료 지문

| 자료                          | SHA256                                                             |
| ----------------------------- | ------------------------------------------------------------------ |
| 직접 받은 공식 배포 HTML      | `61b518eaec54570d0df08659127b7982997f5df8579dcd76df399bcf08a7d11d` |
| JustLend 공식 JSON 등록부     | `e134f6fea60ae2a9264c56eb04c156d0d39a3ffa55ce4a8979aa713bbf6a7eba` |
| 고정 커밋의 `src/psm.sol`     | `e2404fca346e4c840c9e4b636715e7d4eb157e7473b50721bcd8107cb12dc19e` |
| RPC PSM bytecode 바이트       | `d8c0e4d26e4b4ca445218dae50b1fbddec29e89190bc3e1dbc9adb0264aeeb00` |
| RPC USDT Join bytecode 바이트 | `e9eb58a758333e23f162bfa958479d210e35b5ed450d3b4290eafb02e61bdc7e` |

문서는 HTTP 응답 전체를 저장한 데이터 아카이브는 아니며, 위 지문은 이번 조회 결과의 식별 보조 자료다. 사용자 주소나 비밀을 포함한 로그를 저장하지 않았다.

## 이후 경로 구현 시 지켜야 할 구분

1. `sellGem`은 USDT → USDD다. USDT 전송은 담보 Join에서 수행하므로 정확한 USDT 승인 대상은 **USDT Join**이다.
2. `buyGem`은 USDD → USDT다. 공식 코드에서 PSM 자체가 USDD `transferFrom`을 호출하므로 정확한 USDD 승인 대상은 **PSM**이다. `usddJoin` 또는 담보 Join이라고 추측하지 않는다.
3. 토글과 양방향 수수료뿐 아니라 Join/Vat 상태, 담보·부채·전역 및 개별 한도, 실제 출금 가능량, 사용자 잔고·승인·거래 시뮬레이션이 필요하다. 보유 담보 총액만으로 왕복 가능액을 계산하지 않는다.
4. PSM 전환과 jUSDD 예치·회수는 여러 사용자 서명 거래가 된다. 중간 실패·중단 시 보유 자산과 원래 계획의 차이를 기록해야 한다. 실제 USDD 경로 준비 코드·검증·사용자 지갑 왕복 시험이 완료되기 전 추천 가능 표시를 켜지 않는다.
5. 이번에 읽은 양방향 `1`과 수수료 `0`은 조사 사실이다. 앱의 `PsmState.available`은 여전히 false, 미검증 운영 숫자는 null을 유지한다.
