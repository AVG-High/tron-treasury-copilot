# 독립 배포 실행서

이 문서는 `tron-treasury-copilot` 전용 배포 준비입니다. 현재 배포 완료를 뜻하지 않습니다. 기존 RANGE·따리봇·Canton의 Railway 프로젝트, 서비스, 환경 변수, 도메인, DB는 재사용하지 않습니다. 같은 Railway 계정 안에 새 프로젝트와 서비스를 만들면 되며, 계정 구독과 실제 추가 서비스 사용량은 구분해서 확인합니다.

## 준비된 배포 구성

- 저장소 루트의 `Dockerfile`이 UI를 빌드하고 같은 Node 서버에서 UI와 `/api`를 제공합니다. 별도 프런트 서버, DB, 볼륨은 필요하지 않습니다.
- `railway.json`은 Docker 빌드, `/healthz` 헬스체크, 60초 시작 대기와 실패 시 최대 3회 재시도를 지정합니다. Railway의 [Dockerfile 탐지](https://docs.railway.com/builds/dockerfiles), [설정 파일](https://docs.railway.com/config-as-code/reference) 방식을 따릅니다.
- 서버는 플랫폼이 주입한 `PORT`를 읽습니다. 컨테이너 기본값은 4187이며, Railway의 도메인 대상 포트와 서비스 `PORT`가 일치해야 합니다. `EXPOSE` 값만 바꿔서는 서버 포트가 바뀌지 않습니다. [Railway 포트·헬스체크 문서](https://docs.railway.com/deployments/healthchecks)
- `/healthz`는 외부 RPC·AI를 호출하지 않고 `{ "ok": true }`만 반환합니다. 실제 상품 데이터, AI 응답 성공, 지갑 거래 성공을 보증하는 엔드포인트가 아닙니다.
- Railway의 `Host: healthcheck.railway.app`은 공개 HTTPS origin을 설정한 production 실행에서 **정확히 GET/HEAD `/healthz`만** 허용합니다. 다른 경로, POST, 로컬 실행에는 이 예외가 적용되지 않습니다. [공식 헬스체크 Host 설명](https://docs.railway.com/deployments/healthchecks)

현재 서버 시작은 `tsx`를 사용하고 `tsx`가 개발 의존성에 있으므로 Docker 이미지는 개발 의존성도 설치합니다. 이미지 크기를 줄이려고 `npm ci --omit=dev` 또는 `npm prune --omit=dev`만 추가하면 서버가 시작하지 않습니다. 향후 서버를 JavaScript로 별도 빌드하거나 런타임 의존성을 조정한 후 바꿔야 합니다.

## 서비스 설정값

처음 공개하는 버전은 아래와 같이 유료 AI를 끈 수동 입력 모드로 설정합니다. 데모 계획 비교와 실시간 시장 조회는 AI 키 없이도 작동합니다.

| 변수               | 값                         | 비고                                              |
| ------------------ | -------------------------- | ------------------------------------------------- |
| `NODE_ENV`         | `production`               | Docker에도 기본 설정됨                            |
| `HOST`             | `0.0.0.0`                  | Docker에도 기본 설정됨                            |
| `PORT`             | Railway가 제공한 값        | 임의로 다른 서비스 포트를 복사하지 않음           |
| `PUBLIC_ORIGIN`    | `https://실제-배포-도메인` | 경로·query·fragment 없이 실제 브라우저 origin 1개 |
| `OPENAI_API_KEY`   | 미설정                     | 공개 수동 데모는 유료 모델을 호출하지 않음        |
| `OPENAI_MODEL`     | 미설정                     | 키와 모델을 모두 설정해야 AI 해석 활성화          |
| `TRONGRID_API_KEY` | 선택, 서버 전용            | 공개 RPC 제한이 문제일 때 이 프로젝트용 키 사용   |

설정 화면에 개인키·시드·기존 프로젝트의 `.env`를 넣지 않습니다. `VITE_` 접두어는 공개 번들에 들어갈 수 있으므로 비밀 키에 사용하지 않습니다. 서비스 시작 전에 도메인을 만들고 정확한 `PUBLIC_ORIGIN`을 설정합니다. HTTPS 도메인에 임의 하위 경로를 붙이거나 구형 도메인으로 접속하면 요청이 거절될 수 있습니다.

## Railway에 반영할 순서

1. 배포 대상 Git 저장소와 브랜치를 확인합니다. 저장소 루트의 `package.json` 이름은 `tron-treasury-copilot`이어야 합니다. 이 저장소에 실제 `.env`, 지갑 기록 JSON, 비밀 파일이 포함되지 않았는지 변경 목록을 검토합니다.
2. 같은 계정의 **새 프로젝트** `tron-treasury-copilot`에 이 저장소 전용 서비스 하나를 준비합니다. 다른 서비스의 환경 변수를 통째로 가져오거나 공유 DB를 연결하지 않습니다.
3. 새 서비스의 배포 소스·루트·Dockerfile 경로가 이 저장소인지 확인합니다. Dockerfile의 `CMD`를 사용하므로 별도 start command는 필요하지 않습니다.
4. 서비스 도메인을 생성하고 위 환경 변수를 설정합니다. 처음에는 단일 replica로 유지합니다. 앱의 요청 제한과 캐시는 메모리에 있으며 replica 간에 공유되지 않습니다.
5. 사용자 승인 범위 안에서 새 서비스만 배포합니다. `/healthz` 확인 후 아래 읽기 검증을 수행합니다. 이 문서를 작성하면서 Railway 리소스를 만들거나 변경한 것은 아닙니다.

```sh
# 예시 도메인을 실제 배포 주소로 바꿉니다. 아래 요청에는 지갑 주소가 없습니다.
curl --fail --silent --show-error https://YOUR-SERVICE.up.railway.app/healthz
curl --fail --silent --show-error https://YOUR-SERVICE.up.railway.app/api/health
curl --fail --silent --show-error 'https://YOUR-SERVICE.up.railway.app/api/markets?mode=demo'
curl --fail --silent --show-error 'https://YOUR-SERVICE.up.railway.app/api/markets?mode=live'
```

`/api/health`의 `app`은 `tron-treasury-copilot`, `signing`은 `user-wallet-only`, 수동 배포의 `aiConfigured`는 `false`여야 합니다. 실시간 조회가 실패하면 공개 RPC·상위 API·계약 검증 상태를 조사하고 데모 응답으로 성공 처리하지 않습니다. 브라우저에서 조건 확인→계획 비교→저장→새로고침→복원도 확인합니다. 저장 기록은 도메인별 브라우저 localStorage이므로 로컬 기록이 배포 사이트로 자동 이전되지 않습니다.

## AI를 실제로 연결할 때

자연어 해석을 심사위원에게 제공하려면 별도 OpenAI 프로젝트의 키와 사용 가능한 모델을 설정한 뒤 정상 응답·누락 조건 질문·오류 표시를 직접 검증합니다. `aiConfigured: true`는 설정 존재 여부이며 실제 호출 성공 증거가 아닙니다.

현재 API에는 사용자 인증이 없습니다. Origin 검사와 분당 호출 제한은 인증이나 금액 예산이 아니며, 외부 클라이언트가 유효한 Origin 헤더를 보낼 수 있습니다. 공개 사이트에 유료 키를 넣기 전 접근 제한이나 서버에서 강제하는 사용 예산이 필요합니다. 그것이 준비되지 않으면 공개 서비스는 수동 모드로 두고, 본인만 접근하는 로컬에서 AI를 시연합니다. 인프라 비용과 TronGrid 요청 비용도 별개입니다.

서버는 `trust proxy=false`를 유지합니다. Railway 프록시 뒤에서는 여러 방문자가 같은 연결 IP로 집계되어 요청 한도를 공유할 수 있습니다. 이는 무제한 호출을 허용하기보다 보수적으로 막는 현재 선택입니다. 이를 해소하려고 임의 `X-Forwarded-For`를 곧바로 신뢰하지 말고 플랫폼의 실제 프록시 구성을 검증한 후 별도 변경합니다.

## CI와 실패 복구

`.github/workflows/ci.yml`은 typecheck, 단위/API 테스트, 빌드, Chromium UI 검사, Docker production 시작과 Railway Host 검사를 준비합니다. API 키를 전달하지 않으며 외부 거래를 실행하거나 서비스를 배포하지 않습니다. Playwright의 [공식 CI 설치 절차](https://playwright.dev/docs/ci)를 사용합니다. 로컬 테스트 통과와 GitHub Actions 실제 실행 성공은 별도입니다.

배포가 실패하면 먼저 `PUBLIC_ORIGIN`, `HOST`, `PORT`, `/healthz` 경로, Docker 의존성을 확인합니다. Railway 헬스체크는 배포 시의 검사이며 상시 운영 모니터가 아닙니다. [공식 동작 설명](https://docs.railway.com/deployments/healthchecks)

이전 버전으로 되돌릴 때는 이 서비스의 이전 배포만 선택합니다. 문제가 있는 새 서비스를 중단해도 온체인 포지션은 자동으로 회수되지 않습니다. 사용자가 연결 지갑과 공식 프로토콜 화면에서 별도로 관리해야 합니다. 실제 주소·규모가 담긴 브라우저 내보내기나 거래 로그를 공개 이슈/영상에 올리지 않습니다.

## 아직 남은 배포 증거

- 로컬 Docker CLI가 없어 이 작업 환경에서 Docker build/run은 실행하지 못했습니다. CI에 이를 확인하는 단계를 준비했습니다.
- GitHub 원격 실행, Railway 배포, 공개 HTTPS 접속 결과는 아직 없습니다.
- 실제 지갑 연결·예치·회수, 실제 OpenAI 호출은 사용자 설정 후 따로 검증해야 합니다.
