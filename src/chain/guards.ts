import { createHash } from "node:crypto";
import { TronWeb } from "tronweb";
import { CODE_FINGERPRINTS, REGISTRY } from "./registry";
import { ChainError, constant, type JsonObject, rpc, uintCall } from "./rpc";

export function assertCodeFingerprint(
  contract: JsonObject,
  expectedAddress: string,
  expectedHash: string,
): void {
  let address: string;
  try {
    address = TronWeb.address.toHex(contract.contract_address).toLowerCase();
  } catch {
    throw new ChainError(
      "CONTRACT_CODE_CHANGED",
      "공개 컨트랙트 코드 주소를 검증할 수 없습니다.",
    );
  }
  if (
    address !== TronWeb.address.toHex(expectedAddress).toLowerCase() ||
    typeof contract.bytecode !== "string" ||
    !/^(?:[0-9a-f]{2})+$/i.test(contract.bytecode) ||
    createHash("sha256")
      .update(Buffer.from(contract.bytecode, "hex"))
      .digest("hex") !== expectedHash
  )
    throw new ChainError(
      "CONTRACT_CODE_CHANGED",
      "등록된 컨트랙트 코드가 변경되었거나 확인되지 않습니다. 재검토 전에는 서명을 준비하지 않습니다.",
    );
}
function returnedAddress(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/i.test(value))
    throw new ChainError(
      "CONTRACT_IDENTITY",
      "컨트랙트 주소 반환값을 검증할 수 없습니다.",
    );
  return `41${value.slice(-40)}`.toLowerCase();
}
export async function verifyLendingContracts(): Promise<void> {
  for (const [address, fingerprint] of Object.entries(CODE_FINGERPRINTS))
    assertCodeFingerprint(
      await rpc("wallet/getcontract", { value: address, visible: true }),
      address,
      fingerprint,
    );
  for (const [selector, address] of [
    ["underlying()", REGISTRY.usdt],
    ["implementation()", REGISTRY.jUsdtImplementation],
    ["comptroller()", REGISTRY.comptroller],
  ] as const) {
    if (
      returnedAddress(
        (await constant(REGISTRY.jUsdt, selector)).constant_result[0],
      ) !== TronWeb.address.toHex(address).toLowerCase()
    )
      throw new ChainError(
        "CONTRACT_IDENTITY",
        "jUSDT의 기초자산·구현체·Comptroller가 등록부와 다릅니다.",
      );
  }
  if ((await uintCall(REGISTRY.jUsdt, "decimals()")) !== 8n)
    throw new ChainError(
      "CONTRACT_IDENTITY",
      "jUSDT 소수점이 등록부와 다릅니다.",
    );
}
