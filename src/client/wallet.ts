import { MAINNET_GENESIS_BLOCK_ID } from "../chain/registry";
import type { TransactionPreview } from "../domain/types";
type Tx = {
  txID: string;
  raw_data_hex: string;
  signature?: string[];
  [key: string]: unknown;
};
interface TronWallet {
  defaultAddress: { base58: string };
  trx: {
    getBlock: (n: number) => Promise<{ blockID: string }>;
    sign: (tx: unknown) => Promise<Tx>;
    sendRawTransaction: (
      tx: unknown,
    ) => Promise<{ result?: boolean; txid?: string; code?: string }>;
  };
}
declare global {
  interface Window {
    tronLink?: { request: (request: { method: string }) => Promise<unknown> };
    tronWeb?: TronWallet;
  }
}
export async function connectWallet(): Promise<string> {
  if (!window.tronLink || !window.tronWeb)
    throw new Error(
      "TronLink 확장 프로그램이 필요합니다. 설치 후 TRON Mainnet을 선택하고 다시 연결해 주세요.",
    );
  await window.tronLink.request({ method: "tron_requestAccounts" });
  const owner = window.tronWeb.defaultAddress.base58;
  if (!owner) throw new Error("지갑 연결이 승인되지 않았습니다.");
  await assertWallet(owner);
  return owner;
}
export async function assertWallet(owner: string): Promise<TronWallet> {
  const wallet = window.tronWeb;
  if (!wallet || wallet.defaultAddress.base58 !== owner)
    throw new Error(
      "지갑 계정이 바뀌었습니다. 다시 연결하고 거래를 준비해 주세요.",
    );
  const genesis = await wallet.trx.getBlock(0);
  if (genesis.blockID !== MAINNET_GENESIS_BLOCK_ID)
    throw new Error(
      "TRON Mainnet에서만 지원합니다. 지갑 네트워크를 확인해 주세요.",
    );
  if (window.tronWeb !== wallet || wallet.defaultAddress.base58 !== owner)
    throw new Error("검증 중 지갑이 변경되었습니다. 다시 연결해 주세요.");
  return wallet;
}
export async function signAndBroadcast(
  preview: TransactionPreview,
  onSigned: (txid: string) => void,
): Promise<string> {
  const wallet = await assertWallet(preview.owner);
  if (
    !Number.isFinite(Date.parse(preview.expiresAt)) ||
    Date.parse(preview.expiresAt) <= Date.now()
  )
    throw new Error("견적이 만료되었습니다. 거래를 다시 준비해 주세요.");
  const transaction = preview.unsignedTransaction as Tx;
  if (
    !transaction.raw_data_hex ||
    transaction.raw_data_hex.length % 2 !== 0 ||
    !/^[0-9a-f]+$/i.test(transaction.raw_data_hex)
  )
    throw new Error("거래 데이터가 올바르지 않습니다.");
  const bytes = Uint8Array.from(
    transaction.raw_data_hex.match(/.{2}/g)!,
    (byte) => parseInt(byte, 16),
  );
  const digest = Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
  )
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
  if (digest !== preview.digest || digest !== transaction.txID)
    throw new Error("거래 검증값이 일치하지 않습니다. 다시 준비해 주세요.");
  const originalHex = transaction.raw_data_hex;
  const originalId = transaction.txID;
  const originalRaw = JSON.stringify(transaction.raw_data);
  const signed = await wallet.trx.sign(structuredClone(transaction));
  if (
    !signed.signature?.length ||
    signed.raw_data_hex !== originalHex ||
    signed.txID !== originalId ||
    JSON.stringify(signed.raw_data) !== originalRaw
  )
    throw new Error(
      "서명된 거래가 확인한 거래와 다릅니다. 전송을 중단했습니다.",
    );
  if ((await assertWallet(preview.owner)) !== wallet)
    throw new Error("서명 도중 지갑 제공자가 변경되어 전송하지 않았습니다.");
  if (Date.parse(preview.expiresAt) <= Date.now())
    throw new Error(
      "서명 도중 견적이 만료되었습니다. 전송하지 않았습니다. 다시 준비해 주세요.",
    );
  // Persist the transaction ID before broadcasting. On any ambiguous response, query this ID; never auto-resubmit.
  onSigned(signed.txID);
  const result = await wallet.trx.sendRawTransaction(signed);
  if (!result.result)
    throw new Error(
      "전송 결과가 확정되지 않았습니다. 기록의 거래 상태를 확인해 주세요. 자동 재전송하지 않습니다.",
    );
  if (result.txid && result.txid !== originalId)
    throw new Error(
      "응답의 거래 ID가 일치하지 않습니다. 기록에 저장된 원래 거래 ID로 상태를 확인해 주세요.",
    );
  return signed.txID;
}
