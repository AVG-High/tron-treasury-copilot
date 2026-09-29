import { TronWeb, utils } from "tronweb";
import { MAINNET_GENESIS_BLOCK_ID, REGISTRY, TRON_RPC } from "./registry";

export class ChainError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = "ChainError";
  }
}
export type JsonObject = Record<string, any>;
export async function fetchJson(
  url: string,
  body?: unknown,
): Promise<JsonObject> {
  try {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (url.startsWith(`${TRON_RPC}/`) && process.env.TRONGRID_API_KEY)
      headers["TRON-PRO-API-KEY"] = process.env.TRONGRID_API_KEY;
    const request = () =>
      fetch(url, {
        method: body === undefined ? "GET" : "POST",
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(12_000),
      });
    let response = await request();
    for (
      let attempt = 0;
      attempt < 2 && [429, 502, 503, 504].includes(response.status);
      attempt++
    ) {
      const retryAfter = Number(response.headers.get("Retry-After"));
      const delay =
        Number.isFinite(retryAfter) && retryAfter > 0
          ? Math.min(retryAfter * 1_000, 5_000)
          : 1_000 * 2 ** attempt;
      await new Promise((resolve) => setTimeout(resolve, delay));
      response = await request();
    }
    if (!response.ok)
      throw new ChainError(
        "UPSTREAM_HTTP",
        `공식 데이터 제공자가 HTTP ${response.status}를 반환했습니다. 잠시 후 다시 조회하세요.`,
      );
    const value: unknown = await response.json();
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new ChainError(
        "UPSTREAM_SCHEMA",
        "공식 데이터 응답 형식이 변경되었습니다.",
      );
    return value as JsonObject;
  } catch (e) {
    if (e instanceof ChainError) throw e;
    throw new ChainError(
      "UPSTREAM_UNAVAILABLE",
      "공식 데이터 제공자에 연결할 수 없습니다. 네트워크와 서버 설정을 확인하세요.",
    );
  }
}
export async function rpc(
  method: string,
  body: unknown = {},
): Promise<JsonObject> {
  const value = await fetchJson(`${TRON_RPC}/${method}`, body);
  if (value.Error || value.error || value.code)
    throw new ChainError(
      "RPC_REJECTED",
      "공식 RPC가 요청을 거부했습니다. 빈 잔고·대기 중 거래로 해석하지 않습니다.",
    );
  return value;
}
export function assertAddress(address: string): void {
  if (
    typeof address !== "string" ||
    !/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(address) ||
    !TronWeb.isAddress(address)
  )
    throw new ChainError(
      "INVALID_ADDRESS",
      "유효한 TRON Base58 주소가 필요합니다.",
    );
}
export function encodeParameters(types: string[], values: unknown[]): string {
  return utils.abi.encodeParams(types, [...values]).replace(/^0x/, "");
}
export async function constant(
  contract: string,
  selector: string,
  types: string[] = [],
  values: unknown[] = [],
  owner: string = REGISTRY.usdt,
): Promise<JsonObject> {
  const result = await rpc("wallet/triggerconstantcontract", {
    owner_address: owner,
    contract_address: contract,
    function_selector: selector,
    parameter: encodeParameters(types, values),
    visible: true,
  });
  if (result.result?.result !== true || !Array.isArray(result.constant_result))
    throw new ChainError(
      "READ_REVERTED",
      "컨트랙트 조회·시뮬레이션이 실패했습니다. 거래를 준비하지 않았습니다.",
    );
  return result;
}
export function decodeWords(value: unknown, count = 1): bigint[] {
  if (
    typeof value !== "string" ||
    !new RegExp(`^[0-9a-fA-F]{${64 * count}}$`).test(value)
  )
    throw new ChainError(
      "INVALID_RETURN",
      "컨트랙트 반환값을 검증할 수 없습니다.",
    );
  return Array.from({ length: count }, (_, i) =>
    BigInt(`0x${value.slice(i * 64, (i + 1) * 64)}`),
  );
}
export async function uintCall(
  contract: string,
  selector: string,
  types: string[] = [],
  values: unknown[] = [],
  owner?: string,
): Promise<bigint> {
  return decodeWords(
    (await constant(contract, selector, types, values, owner))
      .constant_result[0],
  )[0];
}
export async function verifyMainnet(): Promise<void> {
  const [genesis, head] = await Promise.all([
    rpc("wallet/getblockbynum", { num: 0 }),
    rpc("wallet/getnowblock"),
  ]);
  const timestamp = head.block_header?.raw_data?.timestamp;
  if (genesis.blockID !== MAINNET_GENESIS_BLOCK_ID)
    throw new ChainError(
      "WRONG_NETWORK",
      "TRON 메인넷 제네시스 블록 검증이 실패했습니다.",
    );
  if (
    !Number.isSafeInteger(timestamp) ||
    Math.abs(Date.now() - timestamp) > 90_000
  )
    throw new ChainError(
      "STALE_CHAIN",
      "RPC의 최신 블록이 오래되어 실행을 중단했습니다.",
    );
}
export function rawUnits(
  value: string,
  decimals: number,
  allowZero = false,
): bigint {
  if (
    typeof value !== "string" ||
    value.length > 90 ||
    !new RegExp(`^(0|[1-9][0-9]*)(\\.[0-9]{1,${decimals}})?$`).test(value)
  )
    throw new ChainError(
      "INVALID_AMOUNT",
      `수량은 음수가 아닌 십진수이며 소수점 ${decimals}자리 이하여야 합니다.`,
    );
  const [whole, fraction = ""] = value.split(".");
  const result =
    BigInt(whole) * 10n ** BigInt(decimals) +
    BigInt(fraction.padEnd(decimals, "0"));
  if ((!allowZero && result === 0n) || result >= 2n ** 256n)
    throw new ChainError(
      "INVALID_AMOUNT",
      "거래 수량이 허용 범위를 벗어났습니다.",
    );
  return result;
}
export function humanUnits(value: bigint, decimals: number): string {
  const scale = 10n ** BigInt(decimals);
  const fraction = (value % scale)
    .toString()
    .padStart(decimals, "0")
    .replace(/0+$/, "");
  return `${value / scale}${fraction ? `.${fraction}` : ""}`;
}
export function safeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw new ChainError("INVALID_NUMBER", `${label} 값을 검증할 수 없습니다.`);
  return value;
}
