import Decimal from "decimal.js";
import { TronWeb } from "tronweb";
import type { Evidence } from "../domain/types";
import { REGISTRY, SOURCE_URLS, TRON_RPC } from "./registry";
import { ChainError, constant, uintCall, verifyMainnet } from "./rpc";

/** Read-only observations. These fields never authorize planning or execution. */
export interface PsmStatus {
  quality: "verified" | "unavailable";
  fetchedAt: string;
  chain: "tron-mainnet";
  usddAddress: string;
  psmAddress: string;
  joinAddress: string;
  sellEnabled: boolean | null;
  buyEnabled: boolean | null;
  toUSDDFeePct: string | null;
  fromUSDDFeePct: string | null;
  availableUSDT: null;
  evidence: Evidence[];
  warnings: string[];
}

const Exact = Decimal.clone({ precision: 100 });
const PSM_SOURCE =
  "https://github.com/decentralized-usd/psm/blob/fce1b44a8ca12c9ff302eb374527d65ed04f165d/src/psm.sol";

async function assertReturnedAddress(
  contract: string,
  selector: string,
  expected: string,
): Promise<void> {
  const data: unknown = (await constant(contract, selector)).constant_result[0];
  // An ABI address is exactly one word, including twelve zero padding bytes.
  if (
    typeof data !== "string" ||
    !/^0{24}[0-9a-fA-F]{40}$/.test(data) ||
    `41${data.slice(24)}`.toLowerCase() !==
      TronWeb.address.toHex(expected).toLowerCase()
  )
    throw new ChainError(
      "PSM_IDENTITY",
      "PSM의 USDD·Join·USDT 연결이 고정 등록부와 일치하지 않습니다.",
    );
}

function enabled(value: bigint): boolean {
  if (value !== 0n && value !== 1n)
    throw new ChainError(
      "PSM_TOGGLE",
      "PSM 활성화 값이 검증 가능한 0 또는 1 형식이 아닙니다.",
    );
  return value === 1n;
}

function feePercent(value: bigint): string {
  return new Exact(value.toString())
    .times(100)
    .div("1000000000000000000")
    .toFixed();
}

export async function getPsmStatus(): Promise<PsmStatus> {
  const warnings = [
    "PSM 토글과 수수료의 읽기 전용 관측입니다. 활성 토글만으로 전환·투자가 가능하다고 판단하지 않습니다.",
    "조회는 순차적인 최신 상태 읽기이며 동일 블록의 원자적 스냅샷이 아닙니다. fetchedAt은 조회 완료 시각입니다.",
    "Join/Vat 상태·부채 한도·왕복 경로·현재 교환 가능액은 미검증이며 USDD 실행과 투자 추천은 계속 비활성입니다.",
  ];
  const base = {
    chain: "tron-mainnet" as const,
    usddAddress: REGISTRY.usdd,
    psmAddress: REGISTRY.psmUsdt,
    joinAddress: REGISTRY.psmUsdtJoin,
    availableUSDT: null,
  };
  let values: Pick<
    PsmStatus,
    "sellEnabled" | "buyEnabled" | "toUSDDFeePct" | "fromUSDDFeePct"
  > = {
    sellEnabled: null,
    buyEnabled: null,
    toUSDDFeePct: null,
    fromUSDDFeePct: null,
  };
  let quality: PsmStatus["quality"] = "unavailable";
  let stage = "메인넷 genesis·head 확인";
  try {
    await verifyMainnet();
    // No caller-supplied address or selector; avoid parallel contract-read bursts.
    stage = "PSM.usdd 식별";
    await assertReturnedAddress(REGISTRY.psmUsdt, "usdd()", REGISTRY.usdd);
    stage = "PSM.gemJoin 식별";
    await assertReturnedAddress(
      REGISTRY.psmUsdt,
      "gemJoin()",
      REGISTRY.psmUsdtJoin,
    );
    stage = "Join.gem 식별";
    await assertReturnedAddress(REGISTRY.psmUsdtJoin, "gem()", REGISTRY.usdt);
    stage = "USDT·USDD decimals 확인";
    if (
      (await uintCall(REGISTRY.usdt, "decimals()")) !== 6n ||
      (await uintCall(REGISTRY.usdd, "decimals()")) !== 18n
    )
      throw new ChainError(
        "PSM_DECIMALS",
        "USDT·USDD 소수점이 등록부와 다릅니다.",
      );
    stage = "PSM.sellEnabled 조회";
    const sellEnabled = enabled(
      await uintCall(REGISTRY.psmUsdt, "sellEnabled()"),
    );
    stage = "PSM.buyEnabled 조회";
    const buyEnabled = enabled(
      await uintCall(REGISTRY.psmUsdt, "buyEnabled()"),
    );
    stage = "PSM.tin 수수료 조회";
    const toUSDDFeePct = feePercent(await uintCall(REGISTRY.psmUsdt, "tin()"));
    stage = "PSM.tout 수수료 조회";
    const fromUSDDFeePct = feePercent(
      await uintCall(REGISTRY.psmUsdt, "tout()"),
    );
    values = { sellEnabled, buyEnabled, toUSDDFeePct, fromUSDDFeePct };
    quality = "verified";
    if (new Exact(toUSDDFeePct).gte(100))
      warnings.push(
        "USDT→USDD 수수료가 100% 이상입니다. 활성 토글과 별개로 정상 수령을 가정할 수 없습니다.",
      );
  } catch (error) {
    warnings.unshift(
      error instanceof ChainError
        ? error.message
        : "PSM 상태 조회를 완료하지 못했습니다. 이전 관측이나 데모 수치로 대체하지 않습니다.",
      `조회 중단 단계: ${stage}.`,
    );
    if (error instanceof ChainError && error.code === "UPSTREAM_HTTP")
      warnings.push(
        "TronGrid는 키 없는 요청을 엄격히 제한하거나 거절할 수 있습니다. 서버의 이 프로젝트 전용 TRONGRID_API_KEY와 서비스 한도를 확인하세요. 반복 클릭은 피하세요.",
      );
  }
  const fetchedAt = new Date().toISOString();
  return {
    ...base,
    ...values,
    quality,
    fetchedAt,
    evidence: [
      {
        label: "TRON 공식 RPC: PSM 식별·토글·수수료",
        url: `${TRON_RPC}/wallet/triggerconstantcontract`,
        fetchedAt,
        note:
          quality === "verified"
            ? "메인넷·신선한 head·PSM/Join/토큰 식별·decimals 검증 후 9개 컨트랙트 읽기를 완료했습니다. 실행 가능액은 검증하지 않았습니다."
            : "이번 조회를 완료하지 못했습니다. 일부 성공 응답도 유효 상태로 표시하지 않습니다.",
      },
      {
        label: "USDD 공식 배포 목록",
        url: SOURCE_URLS.usddRegistry,
        fetchedAt,
        note: "고정 주소의 근거 문서입니다. 이 요청은 문서를 재수집하지 않고 온체인 연결을 확인합니다.",
      },
      {
        label: "USDD PSM 공식 코드: 방향·WAD 단위",
        url: PSM_SOURCE,
        fetchedAt,
        note: "고정 커밋의 sellGem/tin은 USDT→USDD, buyGem/tout은 USDD→USDT입니다. 이 요청의 배포 코드 감사나 재현 컴파일은 아닙니다.",
      },
    ],
    warnings,
  };
}
