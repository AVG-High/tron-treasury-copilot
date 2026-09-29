import { createHash } from "node:crypto";
import { TronWeb, utils } from "tronweb";
import type {
  TransactionAction,
  TransactionPreview,
  TransactionRecord,
} from "../domain/types";
import { REGISTRY } from "./registry";
import {
  assertAddress,
  ChainError,
  constant,
  decodeWords,
  encodeParameters,
  humanUnits,
  type JsonObject,
  rawUnits,
  rpc,
  safeInteger,
  uintCall,
  verifyMainnet,
} from "./rpc";
import { getWalletState } from "./wallet";
import { verifyLendingContracts } from "./guards";

export const ACTIONS = {
  "approve-usdt": {
    to: REGISTRY.usdt,
    selector: "approve(address,uint256)",
    types: ["address", "uint256"],
  },
  "supply-usdt": {
    to: REGISTRY.jUsdt,
    selector: "mint(uint256)",
    types: ["uint256"],
  },
  "withdraw-usdt": {
    to: REGISTRY.jUsdt,
    selector: "redeemUnderlying(uint256)",
    types: ["uint256"],
  },
} as const;
export function actionArguments(
  action: TransactionAction,
  amountRaw: bigint,
): string[] {
  return action === "approve-usdt"
    ? [REGISTRY.jUsdt, amountRaw.toString()]
    : [amountRaw.toString()];
}
export function callData(action: TransactionAction, amountRaw: bigint): string {
  const spec = ACTIONS[action];
  return (
    TronWeb.sha3(spec.selector, false).slice(0, 8) +
    encodeParameters([...spec.types], actionArguments(action, amountRaw))
  );
}
export function validateUnsignedTransaction(
  transaction: JsonObject,
  input: {
    action: TransactionAction;
    owner: string;
    amountRaw: bigint;
    feeLimitSun: number;
  },
  now = Date.now(),
): string {
  const raw = transaction.raw_data;
  const spec = ACTIONS[input.action];
  const contract = raw?.contract?.[0];
  const value = contract?.parameter?.value;
  if (
    !spec ||
    !raw ||
    raw.contract?.length !== 1 ||
    contract.type !== "TriggerSmartContract" ||
    contract.parameter?.type_url !==
      "type.googleapis.com/protocol.TriggerSmartContract" ||
    (contract.Permission_id ?? 0) !== 0 ||
    (contract.permission_id ?? 0) !== 0
  )
    throw new ChainError(
      "TRANSACTION_MISMATCH",
      "예상한 단일 컨트랙트 호출이 아닙니다.",
    );
  if (
    value.owner_address?.toLowerCase() !==
      TronWeb.address.toHex(input.owner).toLowerCase() ||
    value.contract_address?.toLowerCase() !==
      TronWeb.address.toHex(spec.to).toLowerCase() ||
    value.data?.toLowerCase() !==
      callData(input.action, input.amountRaw).toLowerCase() ||
    (value.call_value ?? 0) !== 0 ||
    (value.call_token_value ?? 0) !== 0 ||
    (value.token_id ?? 0) !== 0 ||
    raw.fee_limit !== input.feeLimitSun ||
    raw.data ||
    raw.auths?.length ||
    raw.scripts ||
    transaction.signature?.length
  )
    throw new ChainError(
      "TRANSACTION_MISMATCH",
      "거래 대상·수량·수수료·서명 상태가 미리보기와 다릅니다.",
    );
  if (
    !Number.isSafeInteger(raw.timestamp) ||
    Math.abs(now - raw.timestamp) > 60_000 ||
    !Number.isSafeInteger(raw.expiration) ||
    raw.expiration <= now + 5_000 ||
    raw.expiration > now + 180_000
  )
    throw new ChainError(
      "TRANSACTION_EXPIRED",
      "거래의 생성·만료 시각이 유효하지 않습니다.",
    );
  if (
    typeof transaction.raw_data_hex !== "string" ||
    !/^[0-9a-f]+$/i.test(transaction.raw_data_hex) ||
    transaction.raw_data_hex.length % 2 !== 0
  )
    throw new ChainError(
      "TRANSACTION_MISMATCH",
      "직렬화된 거래가 올바르지 않습니다.",
    );
  let serialized: string;
  try {
    serialized = utils.transaction.txPbToRawDataHex(
      utils.transaction.txJsonToPb(transaction),
    );
  } catch {
    throw new ChainError(
      "TRANSACTION_MISMATCH",
      "거래 직렬화를 검증할 수 없습니다.",
    );
  }
  if (serialized.toLowerCase() !== transaction.raw_data_hex.toLowerCase())
    throw new ChainError(
      "TRANSACTION_MISMATCH",
      "표시된 거래와 실제 서명 바이트가 다릅니다.",
    );
  const digest = createHash("sha256")
    .update(Buffer.from(transaction.raw_data_hex, "hex"))
    .digest("hex");
  if (digest !== transaction.txID?.toLowerCase())
    throw new ChainError(
      "TRANSACTION_MISMATCH",
      "거래 식별자 검증이 실패했습니다.",
    );
  return digest;
}
export function assertSimulationSuccess(
  action: TransactionAction,
  simulation: JsonObject,
): void {
  if (
    simulation.result?.result !== true ||
    !Array.isArray(simulation.constant_result)
  )
    throw new ChainError(
      "SIMULATION_FAILED",
      "거래 시뮬레이션이 실패했습니다.",
    );
  const output = simulation.constant_result[0];
  if (action === "approve-usdt") {
    // TRON USDT is a legacy token; successful approve may have no return bytes.
    if (output !== "" && output !== undefined && decodeWords(output)[0] !== 1n)
      throw new ChainError("TOKEN_REJECTED", "USDT 승인이 거부되었습니다.");
  } else if (decodeWords(output)[0] !== 0n)
    throw new ChainError(
      "PROTOCOL_REJECTED",
      "JustLend가 예치·회수 요청을 실패 코드로 거부했습니다.",
    );
}
export function estimateFees(
  energy: number,
  bytes: number,
  parameters: JsonObject,
  energyRemaining: number,
): { feeLimitSun: number; estimatedFeeSun: bigint } {
  const list = parameters.chainParameter;
  if (!Array.isArray(list))
    throw new ChainError(
      "FEE_UNKNOWN",
      "네트워크 자원 단가를 확인할 수 없습니다.",
    );
  const param = (key: string) => {
    const value = list.find((p: JsonObject) => p.key === key)?.value;
    const checked = safeInteger(value, key);
    if (checked === 0)
      throw new ChainError("FEE_UNKNOWN", "자원 단가가 유효하지 않습니다.");
    return checked;
  };
  const energyPrice = param("getEnergyFee"),
    bandwidthPrice = param("getTransactionFee");
  // 30% explicit energy headroom is a cap; never label it as the expected fee.
  const feeLimitSun = Math.ceil(energy * 1.3) * energyPrice;
  if (
    !Number.isSafeInteger(feeLimitSun) ||
    feeLimitSun <= 0 ||
    feeLimitSun > 1_000_000_000
  )
    throw new ChainError(
      "FEE_TOO_HIGH",
      "추정 실행 비용이 앱의 1,000 TRX 상한을 벗어났습니다.",
    );
  // Conservatively price all bandwidth; free/staked buckets are not combinable per tx.
  const estimatedFeeSun =
    BigInt(Math.max(0, energy - energyRemaining)) * BigInt(energyPrice) +
    BigInt(bytes) * BigInt(bandwidthPrice);
  return { feeLimitSun, estimatedFeeSun };
}
export async function prepareTransaction(input: {
  action: TransactionAction;
  owner: string;
  amount: string;
}): Promise<TransactionPreview> {
  if (!Object.hasOwn(ACTIONS, input.action))
    throw new ChainError("UNSUPPORTED_ACTION", "지원하지 않는 거래입니다.");
  assertAddress(input.owner);
  const amountRaw = rawUnits(input.amount, 6, input.action === "approve-usdt");
  const wallet = await getWalletState(input.owner);
  await verifyLendingContracts();
  const allowance = await uintCall(
    REGISTRY.usdt,
    "allowance(address,address)",
    ["address", "address"],
    [input.owner, REGISTRY.jUsdt],
    input.owner,
  );
  if (input.action === "approve-usdt" && allowance > 0n && amountRaw > 0n)
    throw new ChainError(
      "RESET_ALLOWANCE",
      "기존 허용량이 있습니다. 먼저 승인 수량 0으로 초기화한 다음 필요한 정확한 수량을 승인하세요.",
    );
  if (input.action === "supply-usdt" && allowance < amountRaw)
    throw new ChainError(
      "ALLOWANCE_REQUIRED",
      "예치 수량에 대한 USDT 승인이 먼저 필요합니다.",
    );
  if (
    input.action !== "withdraw-usdt" &&
    rawUnits(wallet.usdt, 6, true) < amountRaw
  )
    throw new ChainError(
      "INSUFFICIENT_USDT",
      "USDT 잔고가 요청 수량보다 적습니다.",
    );
  if (input.action === "withdraw-usdt") {
    if (wallet.hasBorrow)
      throw new ChainError(
        "BORROW_POSITION",
        "차입이 있는 계정의 회수는 이 MVP에서 지원하지 않습니다.",
      );
    const position = wallet.positions.find(
      (p) => p.marketId === "justlend-usdt",
    );
    if (!position || rawUnits(position.underlyingAmount, 6, true) < amountRaw)
      throw new ChainError(
        "INSUFFICIENT_POSITION",
        "회수 가능한 관측 예치 수량보다 큰 요청입니다.",
      );
    if ((await uintCall(REGISTRY.jUsdt, "getCash()")) < amountRaw)
      throw new ChainError(
        "INSUFFICIENT_LIQUIDITY",
        "시장 가용 USDT가 요청 회수량보다 적습니다.",
      );
  }
  const spec = ACTIONS[input.action];
  const args = actionArguments(input.action, amountRaw);
  const simulation = await constant(
    spec.to,
    spec.selector,
    [...spec.types],
    args,
    input.owner,
  );
  assertSimulationSuccess(input.action, simulation);
  const energy = safeInteger(simulation.energy_used, "시뮬레이션 Energy");
  if (energy === 0)
    throw new ChainError("FEE_UNKNOWN", "시뮬레이션 Energy 추정이 없습니다.");
  const parameters = await rpc("wallet/getchainparameters");
  const firstEstimate = estimateFees(
    energy,
    0,
    parameters,
    wallet.energyRemaining,
  );
  const response = await rpc("wallet/triggersmartcontract", {
    owner_address: TronWeb.address.toHex(input.owner),
    contract_address: TronWeb.address.toHex(spec.to),
    function_selector: spec.selector,
    parameter: encodeParameters([...spec.types], args),
    fee_limit: firstEstimate.feeLimitSun,
    call_value: 0,
    visible: false,
  });
  // visible:false uses hex request addresses; response is always checked against pinned identities.
  if (response.result?.result !== true || !response.transaction)
    throw new ChainError("BUILD_FAILED", "서명 전 거래 생성이 실패했습니다.");
  const tx = response.transaction as JsonObject;
  const digest = validateUnsignedTransaction(tx, {
    ...input,
    amountRaw,
    feeLimitSun: firstEstimate.feeLimitSun,
  });
  // Raw-data protobuf + signature and transaction/result envelopes, conservatively bounded.
  const bytes = tx.raw_data_hex.length / 2 + 128;
  const estimate = estimateFees(
    energy,
    bytes,
    parameters,
    wallet.energyRemaining,
  );
  if (
    rawUnits(wallet.trx, 6, true) <
    BigInt(estimate.feeLimitSun) +
      BigInt(bytes) *
        BigInt(
          safeInteger(
            parameters.chainParameter.find(
              (p: JsonObject) => p.key === "getTransactionFee",
            )?.value,
            "Bandwidth 단가",
          ),
        )
  )
    throw new ChainError(
      "INSUFFICIENT_TRX",
      "비용 상한과 Bandwidth 여유분을 충당할 TRX가 부족합니다.",
    );
  return {
    action: input.action,
    owner: input.owner,
    to: spec.to,
    spender: input.action === "approve-usdt" ? REGISTRY.jUsdt : null,
    amount: humanUnits(amountRaw, 6),
    asset: "USDT",
    functionSelector: spec.selector,
    parameters: args,
    feeLimitSun: estimate.feeLimitSun,
    estimatedEnergy: energy,
    estimatedFeeTRX: humanUnits(estimate.estimatedFeeSun, 6),
    expiresAt: new Date(
      Math.min(tx.raw_data.expiration, Date.now() + 60_000),
    ).toISOString(),
    warnings: [
      "사용자 지갑에서만 서명합니다. 서버는 개인키·서명·브로드캐스트를 취급하지 않습니다.",
      "Energy 상한에는 30% 여유분을 적용했습니다. 예상 비용은 현재 가용 Energy를 반영하고 Bandwidth는 전액 유료로 보수적으로 계산합니다.",
      "금리·유동성·자원 비용은 변할 수 있습니다. 이 미리보기는 60초 이내에 만료됩니다.",
    ],
    unsignedTransaction: tx,
    digest,
  };
}
export function interpretReceipt(
  info: JsonObject,
  transaction: JsonObject,
): Pick<TransactionRecord, "status" | "actualFeeTRX" | "error"> {
  if (!info.id) return { status: "pending" };
  const fee =
    info.fee === undefined
      ? undefined
      : humanUnits(BigInt(safeInteger(info.fee, "실제 비용")), 6);
  const result = info.receipt?.result;
  if (result !== "SUCCESS")
    return {
      status: result ? "failed" : "unknown",
      actualFeeTRX: fee,
      error: result
        ? "체인 실행이 실패했습니다."
        : "최종 실행 결과를 확인하지 못했습니다.",
    };
  const contract = transaction.raw_data?.contract?.[0];
  const value = contract?.parameter?.value;
  if (
    transaction.raw_data?.contract?.length !== 1 ||
    contract.type !== "TriggerSmartContract"
  )
    return {
      status: "unknown",
      actualFeeTRX: fee,
      error: "지원 범위 밖의 거래입니다.",
    };
  const to = String(value?.contract_address ?? "").toLowerCase();
  const data = String(value?.data ?? "").toLowerCase();
  const isLend =
    to === TronWeb.address.toHex(REGISTRY.jUsdt).toLowerCase() &&
    ["supply-usdt", "withdraw-usdt"].some(
      (action) =>
        data.slice(0, 8) ===
        TronWeb.sha3(
          ACTIONS[action as TransactionAction].selector,
          false,
        ).slice(0, 8),
    );
  const isApprove =
    to === TronWeb.address.toHex(REGISTRY.usdt).toLowerCase() &&
    data.slice(0, 8) ===
      TronWeb.sha3(ACTIONS["approve-usdt"].selector, false).slice(0, 8);
  if (!isLend && !isApprove)
    return {
      status: "unknown",
      actualFeeTRX: fee,
      error: "지원하는 예치·회수·승인 거래가 아닙니다.",
    };
  try {
    assertSimulationSuccess(isLend ? "supply-usdt" : "approve-usdt", {
      result: { result: true },
      constant_result: info.contractResult,
    });
  } catch (e) {
    const incomplete =
      e instanceof ChainError &&
      ["INVALID_RETURN", "SIMULATION_FAILED"].includes(e.code);
    return {
      status: incomplete ? "unknown" : "failed",
      actualFeeTRX: fee,
      error: incomplete
        ? "체인에 포함되었지만 프로토콜 반환값을 확인하지 못했습니다."
        : "체인에는 포함되었지만 토큰·프로토콜이 실패 코드를 반환했습니다.",
    };
  }
  return { status: "confirmed", actualFeeTRX: fee };
}
export async function getTransactionStatus(
  txid: string,
): Promise<Pick<TransactionRecord, "status" | "actualFeeTRX" | "error">> {
  if (!/^[0-9a-f]{64}$/i.test(txid))
    throw new ChainError(
      "INVALID_TXID",
      "유효한 TRON 거래 식별자가 필요합니다.",
    );
  await verifyMainnet();
  const info = await rpc("walletsolidity/gettransactioninfobyid", {
    value: txid,
  });
  if (!info.id) return { status: "pending" };
  const transaction = await rpc("walletsolidity/gettransactionbyid", {
    value: txid,
  });
  if (
    info.id.toLowerCase() !== txid.toLowerCase() ||
    transaction.txID?.toLowerCase() !== txid.toLowerCase()
  )
    throw new ChainError(
      "TRANSACTION_MISMATCH",
      "조회된 거래 식별자가 요청과 다릅니다.",
    );
  return interpretReceipt(info, transaction);
}
