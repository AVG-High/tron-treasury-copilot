import { TronWeb, utils } from "tronweb";
import type { WalletState, WalletPosition } from "../domain/types";
import { REGISTRY } from "./registry";
import {
  assertAddress,
  ChainError,
  constant,
  decodeWords,
  humanUnits,
  rpc,
  safeInteger,
  uintCall,
  verifyMainnet,
} from "./rpc";

export async function readAccountSnapshots(owner: string) {
  const encoded = (
    await constant(
      REGISTRY.comptroller,
      "getAssetsIn(address)",
      ["address"],
      [owner],
      owner,
    )
  ).constant_result[0];
  let entered: string[];
  try {
    const result = utils.abi.decodeParams([], ["address[]"], `0x${encoded}`);
    entered = Array.from(result[0] as string[]).map((x) =>
      TronWeb.address.fromHex(`41${x.replace(/^0x/, "").slice(-40)}`),
    );
  } catch {
    throw new ChainError(
      "ACCOUNT_SCHEMA",
      "담보 시장 목록을 검증할 수 없습니다.",
    );
  }
  if (entered.length > 50)
    throw new ChainError(
      "ACCOUNT_COMPLEX",
      "지원 범위를 넘는 담보 시장 수입니다.",
    );
  const markets = [...new Set([...entered, REGISTRY.jUsdt, REGISTRY.jUsdd])];
  const snapshots = new Map<string, bigint[]>();
  // Sequential calls avoid exhausting public TronGrid's anonymous quota.
  for (const market of markets) {
    assertAddress(market);
    const words = decodeWords(
      (
        await constant(
          market,
          "getAccountSnapshot(address)",
          ["address"],
          [owner],
          owner,
        )
      ).constant_result[0],
      4,
    );
    if (words[0] !== 0n)
      throw new ChainError(
        "ACCOUNT_SNAPSHOT",
        "포지션 스냅샷 반환 코드가 실패입니다.",
      );
    snapshots.set(market, words);
  }
  return {
    entered,
    snapshots,
    hasBorrow: [...snapshots.values()].some((words) => words[2] > 0n),
  };
}
export async function getWalletState(address: string): Promise<WalletState> {
  assertAddress(address);
  await verifyMainnet();
  const [account, resources] = await Promise.all([
    rpc("wallet/getaccount", { address, visible: true }),
    rpc("wallet/getaccountresource", { address, visible: true }),
  ]);
  if (!account.address)
    throw new ChainError(
      "ACCOUNT_NOT_ACTIVATED",
      "TRON 메인넷에서 활성화된 계정을 찾지 못했습니다.",
    );
  const usdtDecimals = await uintCall(REGISTRY.usdt, "decimals()");
  if (usdtDecimals !== 6n)
    throw new ChainError(
      "DECIMALS_CHANGED",
      "USDT 소수점 자릿수가 예상과 다릅니다.",
    );
  const usdt = await uintCall(
    REGISTRY.usdt,
    "balanceOf(address)",
    ["address"],
    [address],
    address,
  );
  let usdd: string | null = null;
  const warnings: string[] = [];
  try {
    const usddDecimals = await uintCall(REGISTRY.usdd, "decimals()");
    if (usddDecimals !== 18n)
      throw new ChainError(
        "DECIMALS_CHANGED",
        "USDD 소수점 자릿수가 예상과 다릅니다.",
      );
    usdd = humanUnits(
      await uintCall(
        REGISTRY.usdd,
        "balanceOf(address)",
        ["address"],
        [address],
        address,
      ),
      18,
    );
  } catch {
    warnings.push(
      "검증된 USDD 토큰 주소의 현재 잔고를 조회하지 못했습니다. 잔고는 0이 아닌 확인 불가로 표시합니다. USDT 기능은 별도로 검증합니다.",
    );
  }
  const { entered, snapshots, hasBorrow } = await readAccountSnapshots(address);
  const positions: WalletPosition[] = [];
  for (const [market, id, asset, decimals] of [
    [REGISTRY.jUsdt, "justlend-usdt", "USDT", 6],
    [REGISTRY.jUsdd, "justlend-usdd", "USDD", 18],
  ] as const) {
    const words = snapshots.get(market)!;
    if (words[1] > 0n)
      positions.push({
        marketId: id,
        underlyingAmount: humanUnits(
          (words[1] * words[3]) / 10n ** 18n,
          decimals,
        ),
        underlyingAsset: asset,
        jTokenBalanceRaw: words[1].toString(),
        collateral: entered.includes(market),
      });
  }
  // Protobuf omits zero numeric fields; those absences mean zero after a valid account response.
  const number = (key: string) => safeInteger(resources[key] ?? 0, key);
  const energyRemaining = Math.max(
    0,
    number("EnergyLimit") - number("EnergyUsed"),
  );
  const bandwidthRemaining =
    Math.max(0, number("freeNetLimit") - number("freeNetUsed")) +
    Math.max(0, number("NetLimit") - number("NetUsed"));
  return {
    address,
    network: "tron-mainnet",
    usdt: humanUnits(usdt, 6),
    usdd,
    trx: humanUnits(BigInt(safeInteger(account.balance ?? 0, "TRX 잔고")), 6),
    energyRemaining,
    bandwidthRemaining,
    positions,
    hasBorrow,
    fetchedAt: new Date().toISOString(),
    warnings: [
      ...warnings,
      "여러 최신 블록 조회를 사용한 관측값입니다. 서명 직전 다시 검증합니다.",
      "USDD 지갑 잔고와 JustLend USDD 포지션은 같은 기초자산의 별도 보유 위치입니다. USDT 평가액으로 자동 합산하지 않습니다.",
      ...(hasBorrow
        ? [
            "차입이 있는 계정은 이 MVP에서 회수를 준비할 수 없습니다. 공식 프로토콜 화면에서 담보를 확인하세요.",
          ]
        : []),
    ],
  };
}
