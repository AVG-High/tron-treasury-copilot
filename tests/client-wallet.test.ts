import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash, webcrypto } from "node:crypto";
import {
  assertWallet,
  connectWallet,
  signAndBroadcast,
} from "../src/client/wallet";
import { MAINNET_GENESIS_BLOCK_ID } from "../src/chain/registry";
import type { TransactionPreview } from "../src/domain/types";

const owner = "TJRabPrwbZy45sbavfcjinPJC18kjpRTv8";
const otherOwner = "TLa2f6VPqDgRE67v1736s7bJ8Ray5wYjU7";
const rawHex = "0a020001220800000000000000004080a094a58a3068e09392a58a30";
const digest = createHash("sha256")
  .update(Buffer.from(rawHex, "hex"))
  .digest("hex");
const transaction = {
  txID: digest,
  raw_data_hex: rawHex,
  raw_data: {
    contract: [
      { type: "TriggerSmartContract", parameter: { value: { amount: "100" } } },
    ],
  },
};

function preview(
  changes: Partial<TransactionPreview> = {},
): TransactionPreview {
  return {
    action: "supply-usdt",
    owner,
    to: owner,
    spender: null,
    amount: "100",
    asset: "USDT",
    functionSelector: "mint(uint256)",
    parameters: ["100000000"],
    feeLimitSun: 100000000,
    estimatedEnergy: 100,
    estimatedFeeTRX: "1",
    expiresAt: new Date(Date.now() + 60000).toISOString(),
    warnings: [],
    unsignedTransaction: structuredClone(transaction),
    digest,
    ...changes,
  };
}

function setupWallet() {
  const wallet = {
    defaultAddress: { base58: owner },
    trx: {
      getBlock: vi
        .fn()
        .mockResolvedValue({ blockID: MAINNET_GENESIS_BLOCK_ID }),
      sign: vi
        .fn()
        .mockImplementation(async (value) => ({
          ...value,
          signature: ["a".repeat(130)],
        })),
      sendRawTransaction: vi
        .fn()
        .mockResolvedValue({ result: true, txid: digest }),
    },
  };
  const tronLink = { request: vi.fn().mockResolvedValue({ code: 200 }) };
  vi.stubGlobal("window", { tronWeb: wallet, tronLink });
  vi.stubGlobal("crypto", webcrypto);
  return { wallet, tronLink };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("user wallet signing boundary", () => {
  it("connects only after user permission and a verified mainnet genesis", async () => {
    const { wallet, tronLink } = setupWallet();
    expect(await connectWallet()).toBe(owner);
    expect(tronLink.request).toHaveBeenCalledWith({
      method: "tron_requestAccounts",
    });
    expect(wallet.trx.getBlock).toHaveBeenCalledWith(0);
    expect(wallet.trx.sign).not.toHaveBeenCalled();
    expect(wallet.trx.sendRawTransaction).not.toHaveBeenCalled();
  });

  it("does not sign from a different account or network", async () => {
    const { wallet } = setupWallet();
    wallet.defaultAddress.base58 = otherOwner;
    await expect(signAndBroadcast(preview(), vi.fn())).rejects.toThrow("계정");
    wallet.defaultAddress.base58 = owner;
    wallet.trx.getBlock.mockResolvedValue({ blockID: "testnet-genesis" });
    await expect(signAndBroadcast(preview(), vi.fn())).rejects.toThrow(
      "Mainnet",
    );
    expect(wallet.trx.sign).not.toHaveBeenCalled();
    expect(wallet.trx.sendRawTransaction).not.toHaveBeenCalled();
  });

  it("rejects missing, invalid or expired quote times before signing", async () => {
    const { wallet } = setupWallet();
    for (const expiresAt of [
      "",
      "not-a-date",
      new Date(Date.now() - 1).toISOString(),
    ]) {
      await expect(
        signAndBroadcast(preview({ expiresAt }), vi.fn()),
      ).rejects.toThrow("만료");
    }
    expect(wallet.trx.sign).not.toHaveBeenCalled();
  });

  it("rejects malformed bytes and mismatched displayed transaction hashes", async () => {
    const { wallet } = setupWallet();
    for (const raw_data_hex of ["0", "zz", ""]) {
      await expect(
        signAndBroadcast(
          preview({ unsignedTransaction: { ...transaction, raw_data_hex } }),
          vi.fn(),
        ),
      ).rejects.toThrow("데이터");
    }
    await expect(
      signAndBroadcast(preview({ digest: "0".repeat(64) }), vi.fn()),
    ).rejects.toThrow("검증값");
    await expect(
      signAndBroadcast(
        preview({
          unsignedTransaction: { ...transaction, txID: "0".repeat(64) },
        }),
        vi.fn(),
      ),
    ).rejects.toThrow("검증값");
    expect(wallet.trx.sign).not.toHaveBeenCalled();
  });

  it("persists the transaction ID before sending exactly once", async () => {
    const { wallet } = setupWallet();
    const events: string[] = [];
    wallet.trx.sendRawTransaction.mockImplementation(async () => {
      events.push("broadcast");
      return { result: true, txid: digest };
    });
    const prepared = preview();
    expect(
      await signAndBroadcast(prepared, (id) => {
        expect(id).toBe(digest);
        events.push("persist");
      }),
    ).toBe(digest);
    expect(events).toEqual(["persist", "broadcast"]);
    expect(wallet.trx.sign).toHaveBeenCalledTimes(1);
    expect(wallet.trx.sign.mock.calls[0][0]).not.toBe(
      prepared.unsignedTransaction,
    );
    expect(wallet.trx.sendRawTransaction).toHaveBeenCalledTimes(1);
  });

  it("does not broadcast if the user rejects signing or durable recording fails", async () => {
    const { wallet } = setupWallet();
    wallet.trx.sign.mockRejectedValueOnce(new Error("User rejected"));
    await expect(signAndBroadcast(preview(), vi.fn())).rejects.toThrow(
      "User rejected",
    );
    await expect(
      signAndBroadcast(preview(), () => {
        throw new Error("Storage quota exceeded");
      }),
    ).rejects.toThrow("Storage quota");
    expect(wallet.trx.sendRawTransaction).not.toHaveBeenCalled();
  });

  it("does not broadcast a wallet-mutated raw transaction even if its original hash fields remain", async () => {
    const { wallet } = setupWallet();
    wallet.trx.sign.mockImplementation(async (value) => {
      value.raw_data.contract[0].parameter.value.amount = "999";
      value.signature = ["a".repeat(130)];
      return value;
    });
    const prepared = preview();
    await expect(signAndBroadcast(prepared, vi.fn())).rejects.toThrow(
      "확인한 거래와 다릅니다",
    );
    expect(prepared.unsignedTransaction).toEqual(transaction);
    expect(wallet.trx.sendRawTransaction).not.toHaveBeenCalled();
  });

  it("does not broadcast a changed account, network, or expired quote after signing", async () => {
    const { wallet } = setupWallet();
    wallet.trx.sign.mockImplementationOnce(async (value) => {
      wallet.defaultAddress.base58 = otherOwner;
      return { ...value, signature: ["a".repeat(130)] };
    });
    await expect(signAndBroadcast(preview(), vi.fn())).rejects.toThrow("계정");
    wallet.defaultAddress.base58 = owner;
    wallet.trx.getBlock
      .mockResolvedValueOnce({ blockID: MAINNET_GENESIS_BLOCK_ID })
      .mockResolvedValueOnce({ blockID: "another-chain" });
    await expect(signAndBroadcast(preview(), vi.fn())).rejects.toThrow(
      "Mainnet",
    );
    const now = Date.now();
    wallet.trx.getBlock.mockResolvedValue({
      blockID: MAINNET_GENESIS_BLOCK_ID,
    });
    wallet.trx.sign.mockImplementationOnce(async (value) => {
      vi.spyOn(Date, "now").mockReturnValue(now + 120000);
      return { ...value, signature: ["a".repeat(130)] };
    });
    await expect(signAndBroadcast(preview(), vi.fn())).rejects.toThrow("만료");
    expect(wallet.trx.sendRawTransaction).not.toHaveBeenCalled();
  });

  it("keeps ambiguous submission recoverable by ID and never retries automatically", async () => {
    const { wallet } = setupWallet();
    const persisted = vi.fn();
    wallet.trx.sendRawTransaction.mockResolvedValue({ result: false });
    await expect(signAndBroadcast(preview(), persisted)).rejects.toThrow(
      "자동 재전송하지 않습니다",
    );
    expect(persisted).toHaveBeenCalledWith(digest);
    expect(wallet.trx.sendRawTransaction).toHaveBeenCalledTimes(1);
  });

  it("detects an account change while the genesis request is outstanding", async () => {
    const { wallet } = setupWallet();
    wallet.trx.getBlock.mockImplementationOnce(async () => {
      wallet.defaultAddress.base58 = otherOwner;
      return { blockID: MAINNET_GENESIS_BLOCK_ID };
    });
    await expect(assertWallet(owner)).rejects.toThrow("지갑");
  });

  it("rejects provider replacement while a request or signing prompt is outstanding", async () => {
    const { wallet } = setupWallet();
    const replacement = {
      ...wallet,
      defaultAddress: { base58: owner },
      trx: { ...wallet.trx },
    };
    wallet.trx.getBlock.mockImplementationOnce(async () => {
      window.tronWeb = replacement;
      return { blockID: MAINNET_GENESIS_BLOCK_ID };
    });
    await expect(assertWallet(owner)).rejects.toThrow("지갑");
    window.tronWeb = wallet;
    wallet.trx.sign.mockImplementationOnce(async (value) => {
      window.tronWeb = replacement;
      return { ...value, signature: ["a".repeat(130)] };
    });
    await expect(signAndBroadcast(preview(), vi.fn())).rejects.toThrow("지갑");
    expect(wallet.trx.sendRawTransaction).not.toHaveBeenCalled();
  });

  it("rejects a broadcast acknowledgment for a different transaction", async () => {
    const { wallet } = setupWallet();
    wallet.trx.sendRawTransaction.mockResolvedValue({
      result: true,
      txid: "0".repeat(64),
    });
    await expect(signAndBroadcast(preview(), vi.fn())).rejects.toThrow();
    expect(wallet.trx.sendRawTransaction).toHaveBeenCalledTimes(1);
  });
});
