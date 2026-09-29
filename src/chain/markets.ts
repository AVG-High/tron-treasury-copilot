import Decimal from "decimal.js";
import type {
  Evidence,
  Market,
  MarketSnapshot,
  PsmState,
} from "../domain/types";
import { REGISTRY, SOURCE_URLS } from "./registry";
import { ChainError, fetchJson, type JsonObject } from "./rpc";

function decimal(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^\d+(\.\d+)?$/.test(value) ||
    value.length > 100
  )
    throw new ChainError("MARKET_SCHEMA", "시장 수치의 형식이 변경되었습니다.");
  return new Decimal(value).toFixed();
}
export function parseMarkets(
  payload: JsonObject,
  registry: JsonObject,
  mining: JsonObject | null,
  fetchedAt: string,
): Market[] {
  if (payload.code !== 0 || !Array.isArray(payload.data?.tokenList))
    throw new ChainError(
      "MARKET_SCHEMA",
      "JustLend 시장 응답을 검증할 수 없습니다.",
    );
  return (
    [
      {
        id: "justlend-usdt",
        asset: "USDT",
        market: REGISTRY.jUsdt,
        token: REGISTRY.usdt,
        decimals: 6,
      },
      {
        id: "justlend-usdd",
        asset: "USDD",
        market: REGISTRY.jUsdd,
        token: REGISTRY.justlendUsddUnderlying,
        decimals: 18,
      },
    ] as const
  ).map((spec) => {
    const rows = payload.data.tokenList.filter(
      (entry: JsonObject) => entry.address === spec.market,
    );
    const entry = rows[0];
    const pinned = registry.networks?.mainnet?.jtokens?.[`j${spec.asset}`];
    const evidence: Evidence[] = [
      {
        label: "JustLend 공식 시장 API",
        url: SOURCE_URLS.justlendMarkets,
        fetchedAt,
        note: "조회 시각입니다. API는 원본 블록 시각을 제공하지 않습니다.",
      },
      {
        label: "JustLend 공식 계약 등록부",
        url: SOURCE_URLS.justlendRegistry,
        fetchedAt,
      },
    ];
    if (
      rows.length !== 1 ||
      entry.underlyingAddress !== spec.token ||
      entry.underlyingDecimal !== spec.decimals ||
      pinned?.status !== "active" ||
      pinned.delegator?.address?.base58 !== spec.market ||
      pinned.underlying?.address?.base58 !== spec.token
    )
      throw new ChainError(
        "REGISTRY_MISMATCH",
        "시장·자산·공식 계약 등록부의 일치 여부를 확인할 수 없습니다.",
      );
    const warnings = [
      "현재 금리 유지 시의 추정치입니다. 시장 가용 유동성은 미래 출금을 보장하지 않습니다.",
    ];
    let rewardApy: string | null = null;
    const reward =
      mining?.code === 0 ? mining.data?.[spec.market]?.USDD : undefined;
    if (typeof reward === "string") {
      rewardApy = decimal(reward);
      evidence.push({
        label: "JustLend 별도 USDD 보상률",
        url: SOURCE_URLS.justlendMining,
        fetchedAt,
        note: "기간별 보상이며 종료 후 별도 수령이 필요합니다. 자동 복리·기간 내 수령을 보장하지 않습니다.",
      });
    } else
      warnings.push(
        "검증된 별도 보상 수익률이 없어 인센티브 수익을 계산하지 않습니다.",
      );
    if (spec.asset === "USDD")
      warnings.push(
        "USDD 토큰과 JustLend 기초자산의 일치는 확인했습니다. PSM 양방향 한도·현재 상태의 실시간 검증과 왕복 실행 경로가 구현되기 전까지 계획에서 제외합니다.",
      );
    return {
      id: spec.id,
      name: `JustLend ${spec.asset}`,
      asset: spec.asset,
      baseApy: decimal(entry.supplyRate),
      rewardApy,
      cashUSDT: spec.asset === "USDT" ? decimal(entry.cash) : null,
      active: spec.asset === "USDT",
      tokenAddress: spec.token,
      marketAddress: spec.market,
      quality: spec.asset === "USDT" ? "verified" : "unavailable",
      evidence,
      warnings,
    };
  });
}
export function parsePsm(payload: JsonObject, fetchedAt: string): PsmState {
  if (payload.code !== 0 || !Array.isArray(payload.data?.items))
    throw new ChainError(
      "USDD_SCHEMA",
      "USDD 공식 데이터 응답을 검증할 수 없습니다.",
    );
  const row = payload.data.items.find(
    (item: JsonObject) =>
      item.vaultType === "PSM-USDT-A" &&
      item.chain === "tron" &&
      item.contractAddress === REGISTRY.psmUsdtJoin,
  );
  if (!row)
    throw new ChainError(
      "USDD_SCHEMA",
      "등록된 TRON USDD PSM 담보를 찾지 못했습니다.",
    );
  const fee = typeof row.psmFee === "string" ? decimal(row.psmFee) : null;
  return {
    available: false,
    toUSDDEnabled: false,
    fromUSDDEnabled: false,
    toUSDDFeePct: null,
    fromUSDDFeePct: null,
    availableUSDT: null,
    evidence: [
      {
        label: "USDD 공식 TRON 담보·PSM 데이터",
        url: SOURCE_URLS.usddSnapshot,
        fetchedAt,
        note: `PSM-USDT-A 담보 Join 조회 성공. 공시 psmFee=${fee ?? "unknown"} (단일 값). Join은 PSM 실행 계약과 다르며 담보 규모는 현재 교환 가능 금액이 아닙니다.`,
      },
      {
        label: "USDD 공식 계약 주소",
        url: SOURCE_URLS.usddRegistry,
        fetchedAt,
      },
    ],
    warnings: [
      "공식 API는 양방향 활성화 상태와 교환 한도를 제공하지 않습니다. 미확인 값은 0으로 대체하지 않으며 전환 경로를 비활성화합니다.",
      "USDD 토큰 주소 일치는 확인했지만, 현재 PSM 계약 상태·한도와 승인·전환·예치·회수 경로를 앱에서 검증하기 전 USDD 왕복 운용을 추천하지 않습니다.",
    ],
  };
}
function unavailableMarkets(fetchedAt: string, message: string): Market[] {
  return (
    [
      ["justlend-usdt", "USDT", REGISTRY.usdt, REGISTRY.jUsdt],
      [
        "justlend-usdd",
        "USDD",
        REGISTRY.justlendUsddUnderlying,
        REGISTRY.jUsdd,
      ],
    ] as const
  ).map(([id, asset, tokenAddress, marketAddress]) => ({
    id,
    name: `JustLend ${asset}`,
    asset,
    baseApy: null,
    rewardApy: null,
    cashUSDT: null,
    active: false,
    tokenAddress,
    marketAddress,
    quality: "unavailable",
    evidence: [
      {
        label: "조회 시도한 공식 API",
        url: SOURCE_URLS.justlendMarkets,
        fetchedAt,
      },
    ],
    warnings: [message],
  }));
}
export async function getLiveSnapshot(): Promise<MarketSnapshot> {
  const fetchedAt = new Date().toISOString();
  const [marketResult, registryResult, rewardResult, psmResult] =
    await Promise.allSettled([
      fetchJson(SOURCE_URLS.justlendMarkets),
      fetchJson(SOURCE_URLS.justlendRegistry),
      fetchJson(SOURCE_URLS.justlendMining),
      fetchJson(SOURCE_URLS.usddSnapshot),
    ]);
  const warnings: string[] = [];
  let markets: Market[];
  try {
    if (
      marketResult.status !== "fulfilled" ||
      registryResult.status !== "fulfilled"
    )
      throw new ChainError(
        "UNAVAILABLE",
        "JustLend 공식 API 또는 계약 등록부 조회 실패.",
      );
    markets = parseMarkets(
      marketResult.value,
      registryResult.value,
      rewardResult.status === "fulfilled" ? rewardResult.value : null,
      fetchedAt,
    );
  } catch (e) {
    const message =
      e instanceof ChainError ? e.message : "JustLend 시장 데이터 검증 실패.";
    warnings.push(message);
    markets = unavailableMarkets(fetchedAt, message);
  }
  let psm: PsmState;
  try {
    if (psmResult.status !== "fulfilled")
      throw new ChainError("UNAVAILABLE", "USDD 공식 API 조회 실패.");
    psm = parsePsm(psmResult.value, fetchedAt);
  } catch (e) {
    const message =
      e instanceof ChainError ? e.message : "USDD 데이터 검증 실패.";
    warnings.push(message);
    psm = {
      available: false,
      toUSDDEnabled: false,
      fromUSDDEnabled: false,
      toUSDDFeePct: null,
      fromUSDDFeePct: null,
      availableUSDT: null,
      evidence: [],
      warnings: [message],
    };
  }
  return { mode: "live", fetchedAt, markets, psm, warnings };
}
