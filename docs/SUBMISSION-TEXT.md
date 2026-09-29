# 제출 폼에 사용할 소개문

아래 한국어·영어 소개는 현재 구현 범위에 맞춘 초안입니다. 제출 폼의 글자 수에 맞춰 선택합니다. 실제 공개 URL·Git 원격·팀 정보는 추정하지 않았습니다. 로컬 무음 데모 영상과 소스 묶음은 `artifacts/submission`에 준비합니다. 미검증 항목을 삭제하여 완료한 것처럼 제출하지 않습니다.

## 프로젝트 이름과 한 문장

**TRON Treasury Copilot**

한국어: 돈이 필요한 날짜부터 계획하고, 남는 USDT의 비용 차감 후 수익과 회수 조건을 비교하는 TRON 자금 운용 도구.

English: Plan around when you need your money, then compare TRON yield after costs and liquidity constraints.

트랙: GWDC Korea — TRON Challenge B, AI Asset Allocation and Yield Planning Assistant.

## 한국어 소개

TRON Treasury Copilot은 높은 APY보다 사용자의 자금 사용 일정을 먼저 고려합니다. 10,000 USDT 중 다음 주 3,000, 한 달 뒤 1,000, 비상금 500이 필요하다면 먼저 4,500 USDT를 예약합니다. 남는 5,500에서도 진입·회수 비용을 확보한 뒤 보유 기준안과 운용 대안을 비교합니다. 이자가 비용보다 작으면 투자하지 않는 보유안을 남깁니다.

자연어 입력을 구조화하는 AI와 실제 금액을 계산하는 엔진을 분리했습니다. 사용자는 추출된 조건을 확인·수정하고, Decimal/BigInt 계산과 노출 한도가 적용된 계획을 비교합니다. 기본 이자·인센티브·운영 비용·회수 조건·제외 사유를 구분해 보여 줍니다. JustLend와 USDD의 공식 데이터에 출처와 조회 시각을 붙이며, 검증되지 않은 전환 경로는 추천하지 않습니다.

USDT의 정확한 승인·JustLend 예치·회수를 준비하고, 거래 전문을 확인한 사용자가 TronLink에서 직접 서명하도록 구현했습니다. 서버는 개인키를 보관하거나 거래를 서명하지 않습니다. 원계획과 가정을 저장한 뒤 금리·유동성·예약금 변화를 관측하고, 명시적인 가상 회고로 예상과 이후 시나리오를 비교합니다.

**현재 검증 범위:** 로컬 프로토타입과 자동화 검사를 제공하며, 실제 AI 응답 및 실자금 왕복 거래는 아직 검증 전입니다. USDD 데이터는 연동했지만 USDD 전환·예치 왕복 실행은 비활성입니다. 개인 실현 수익과 자동 자금 운용을 제공한다고 주장하지 않습니다.

## English description

TRON Treasury Copilot starts with when users need their money. If a user has 10,000 USDT, needs 3,000 next week and 1,000 next month, and wants a 500 emergency reserve, it reserves 4,500 first. It then compares holding cash with investment alternatives for the remaining capital, accounting for entry and exit costs. When projected interest does not cover costs, holding cash remains the appropriate outcome.

The optional AI layer extracts structured requirements for the user to review. A separate deterministic engine uses Decimal/BigInt arithmetic to enforce reserves, exposure limits, and liquidity constraints. Plans separate base yield, incentives, operating costs, exit conditions, and rejection reasons. Official JustLend and USDD data include sources and retrieval timestamps. Unsupported conversion routes remain unavailable.

The prototype prepares exact USDT approvals and JustLend deposit or redemption transactions. Users inspect each transaction and sign through TronLink; the server holds no private keys and cannot sign transactions. Saved assumptions, browser-based monitoring, and explicitly labeled simulated review connect the original plan to changing conditions.

**Validation status:** This submission provides a working local prototype and automated tests. Live AI responses and a funded wallet round trip have not yet been verified. USDD data integration is implemented, while USDD conversion and investment execution remain disabled. The product does not claim autonomous fund management or a complete realized-profit ledger.

## 차별점 / What makes it different

- **지출부터 계산 / Expenses first:** 예정 지출·비상금을 먼저 확보하고 남는 자금만 검토합니다.
- **APY가 아닌 비용 차감 후 결과 / Net outcome:** 비용 때문에 보유가 유리하면 투자 대안을 꾸며내지 않습니다.
- **이유와 제외 근거 / Explainable boundaries:** 데이터 부족, 노출 한도, 지원하지 않는 회수 경로를 명시합니다.
- **사용자 확인 / User control:** AI가 직접 금액을 결정하거나 서명하지 않습니다. 계산·확인·거래를 분리합니다.
- **원계획에서 회고까지 / Reviewable assumptions:** 저장한 가정, 읽기 전용 관측, 가상 회고를 구분합니다.

## 기술 구조 / Architecture

```text
Natural-language input (optional OpenAI Responses) or manual input
                         ↓
              User-reviewed requirements
                         ↓
     Decimal/BigInt planning and constraint engine
        ↑                                 ↓
Official JustLend / USDD data     Hold + viable alternatives
                                          ↓
                     Server-validated unsigned transaction
                                          ↓
                      User confirmation + TronLink signature
                                          ↓
                    Transaction status and local plan history
                                          ↓
                Browser monitoring + labeled simulated review
```

UI: React + Vite + TypeScript. API: Express. On-chain reads and transaction serialization: TronWeb. Validation: Zod. Financial calculations: Decimal.js and BigInt. Tests: Vitest and Playwright. No custom vault, bridge, custody service, or database is required. Financial history lives in the user's browser; it is not a multi-user authenticated account system.

## 심사위원 실행 안내 / Reviewer setup

Node.js 22.12 이상이 필요합니다. 개발·검증 환경은 Node 24입니다.

```sh
npm ci
npm run build
npm start
```

http://127.0.0.1:4187 을 엽니다. 기본 데모는 키·지갑 없이 동작합니다. `npm run dev`를 사용하면 UI는 4177, API는 4187입니다.

For an optional live AI demo, copy `.env.example` to `.env`, set a dedicated `OPENAI_API_KEY` and a supported `OPENAI_MODEL`, and restart the server. Both values are required. Without them the interface remains explicitly manual. A `TRONGRID_API_KEY` is optional for RPC access limits. Never supply a private key or seed phrase to the server.

Live mode reads official protocol data and shows failures explicitly. User-signed actions require TronLink on TRON Mainnet, an appropriate USDT balance, TRX/resources for fees, and confirmation for every transaction. Merely opening the app or generating a plan does not move funds. Actual funded validation has not yet been performed by this project.

배포·접근 방법은 [DEPLOYMENT.md](DEPLOYMENT.md), 3분 시연 준비안은 [DEMO-SCRIPT.md](DEMO-SCRIPT.md), 공식 요구 판정은 [SUBMISSION-READY.md](SUBMISSION-READY.md), 최신 검증 결과는 [RESUME.md](RESUME.md)를 참조합니다. 3분은 준비용 제안이며 공식 영상 길이가 확인됐다는 뜻은 아닙니다.

## 제출 폼에 별도로 채울 실제 자료

- 팀 이름·구성원·연락처: 제출자가 입력.
- 코드 저장소: 아직 원격 저장소 없음. 생성 후 접근 가능한 실제 URL을 입력.
- 실행 링크: 현재 로컬 실행. 공개 배포 후 실제 HTTPS URL을 입력하거나 제출 형식이 허용하는 로컬 실행 안내를 사용.
- 시연 영상: `artifacts/submission/treasury-demo.mp4`는 실제 앱의 짧은 무음 데모 화면 녹화입니다. 데이터는 명시적인 예시이며 AI 응답·실자금 거래 시연이 아닙니다. 제출 폼이 영상 링크를 요구하면 별도로 업로드해야 합니다.
- 검증 커밋·테스트 결과: 최종 `RESUME.md`와 실제 Git 커밋을 기준으로 입력.

접속 권한과 링크의 실제 작동을 제출 후에도 확인합니다. 이 문서 작성이나 코드 커밋 자체가 해커톤 제출 완료를 뜻하지 않습니다.
