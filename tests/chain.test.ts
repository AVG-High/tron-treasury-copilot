import { describe, expect, it, vi, afterEach } from "vitest";
import { createHash } from "node:crypto";
import { TronWeb, utils } from "tronweb";
import {
  REGISTRY,
  MAINNET_GENESIS_BLOCK_ID,
  SOURCE_URLS,
} from "../src/chain/registry";
import {
  rawUnits,
  humanUnits,
  decodeWords,
  verifyMainnet,
  assertAddress,
  rpc,
} from "../src/chain/rpc";
import { parseMarkets, parsePsm, getLiveSnapshot } from "../src/chain/markets";
import {
  callData,
  validateUnsignedTransaction,
  assertSimulationSuccess,
  estimateFees,
  interpretReceipt,
  prepareTransaction,
  ACTIONS,
} from "../src/chain/transactions";
import { assertCodeFingerprint } from "../src/chain/guards";
import * as guards from "../src/chain/guards";
import * as walletAdapter from "../src/chain/wallet";
import type { TransactionAction, WalletState } from "../src/domain/types";

const now = Date.now();
const owner = REGISTRY.usdt; // Public contract address used only for synthetic transaction tests, never signed.
const word = (n: bigint) => n.toString(16).padStart(64, "0");
function unsigned(
  action: TransactionAction = "supply-usdt",
  amount = 1_000_001n,
  fee = 1_300_000,
) {
  const transaction: any = {
    raw_data: {
      contract: [
        {
          parameter: {
            value: {
              owner_address: TronWeb.address.toHex(owner),
              contract_address: TronWeb.address.toHex(ACTIONS[action].to),
              data: callData(action, amount),
            },
            type_url: "type.googleapis.com/protocol.TriggerSmartContract",
          },
          type: "TriggerSmartContract",
        },
      ],
      ref_block_bytes: "0001",
      ref_block_hash: "0102030405060708",
      expiration: now + 60_000,
      timestamp: now,
      fee_limit: fee,
    },
  };
  transaction.raw_data_hex = utils.transaction.txPbToRawDataHex(
    utils.transaction.txJsonToPb(transaction),
  );
  transaction.txID = createHash("sha256")
    .update(Buffer.from(transaction.raw_data_hex, "hex"))
    .digest("hex");
  return transaction;
}
const expected = {
  action: "supply-usdt" as const,
  owner,
  amountRaw: 1_000_001n,
  feeLimitSun: 1_300_000,
};
const registry = {
  networks: {
    mainnet: {
      jtokens: {
        jUSDT: {
          status: "active",
          delegator: { address: { base58: REGISTRY.jUsdt } },
          underlying: { address: { base58: REGISTRY.usdt } },
        },
        jUSDD: {
          status: "active",
          delegator: { address: { base58: REGISTRY.jUsdd } },
          underlying: { address: { base58: REGISTRY.justlendUsddUnderlying } },
        },
      },
    },
  },
};
const marketFixture = {
  code: 0,
  data: {
    tokenList: [
      {
        address: REGISTRY.jUsdt,
        underlyingAddress: REGISTRY.usdt,
        underlyingDecimal: 6,
        supplyRate: "0.020172535926048000",
        cash: "90214298.006946000000000000",
      },
      {
        address: REGISTRY.jUsdd,
        underlyingAddress: REGISTRY.justlendUsddUnderlying,
        underlyingDecimal: 18,
        supplyRate: "0.000008501548464000",
        cash: "399758722.791858429491161274",
      },
    ],
  },
};
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
describe("financial chain units and identities", () => {
  it("roundtrips values beyond JS safe integer without rounding", () => {
    const amount = "9007199254740993.123456";
    expect(humanUnits(rawUnits(amount, 6), 6)).toBe(amount);
    expect(rawUnits("0.000001", 6)).toBe(1n);
  });
  it.each(["1e6", "-1", "0.0000001", "01", "Infinity", "1,000", "0"])(
    "rejects unsafe USDT input %s",
    (value) => expect(() => rawUnits(value, 6)).toThrow(),
  );
  it("permits zero solely for explicitly requested approval reset", () =>
    expect(rawUnits("0", 6, true)).toBe(0n));
  it("validates Base58 checksum instead of only address shape", () => {
    expect(() => assertAddress(REGISTRY.usdt)).not.toThrow();
    expect(() => assertAddress(REGISTRY.usdt.slice(0, -1) + "1")).toThrow();
  });
  it("rejects absent return bytes instead of treating them as zero", () =>
    expect(() => decodeWords("")).toThrow());
  it("detects changed contract code independently of unchanged address and ABI", () => {
    const bytecode = "6001600055",
      hash = createHash("sha256")
        .update(Buffer.from(bytecode, "hex"))
        .digest("hex");
    expect(() =>
      assertCodeFingerprint(
        { contract_address: REGISTRY.jUsdt, bytecode },
        REGISTRY.jUsdt,
        hash,
      ),
    ).not.toThrow();
    expect(() =>
      assertCodeFingerprint(
        { contract_address: REGISTRY.jUsdt, bytecode: "6002600055" },
        REGISTRY.jUsdt,
        hash,
      ),
    ).toThrow();
    expect(() =>
      assertCodeFingerprint(
        { contract_address: REGISTRY.usdt, bytecode },
        REGISTRY.jUsdt,
        hash,
      ),
    ).toThrow();
  });
});
describe("preparation orchestration — simulated RPC only, no signing or broadcasting", () => {
  const wallet: WalletState = {
    address: owner,
    network: "tron-mainnet",
    usdt: "1000",
    usdd: null,
    trx: "200",
    energyRemaining: 5000,
    bandwidthRemaining: 0,
    positions: [
      {
        marketId: "justlend-usdt",
        underlyingAmount: "50",
        underlyingAsset: "USDT",
        jTokenBalanceRaw: "500000000000",
        collateral: false,
      },
    ],
    hasBorrow: false,
    fetchedAt: new Date(now).toISOString(),
    warnings: [],
  };
  function mockPreparation(
    action: TransactionAction,
    options: {
      allowance?: bigint;
      hasBorrow?: boolean;
      simulationCode?: bigint;
    } = {},
  ) {
    vi.spyOn(walletAdapter, "getWalletState").mockResolvedValue({
      ...wallet,
      hasBorrow: options.hasBorrow ?? false,
    });
    vi.spyOn(guards, "verifyLendingContracts").mockResolvedValue();
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      let data: unknown;
      if (url.endsWith("/wallet/triggerconstantcontract")) {
        if (body.function_selector === "allowance(address,address)")
          data = {
            result: { result: true },
            constant_result: [word(options.allowance ?? 2_000_000n)],
          };
        else if (body.function_selector === "getCash()")
          data = {
            result: { result: true },
            constant_result: [word(100_000_000n)],
          };
        else
          data = {
            result: { result: true },
            constant_result: [
              action === "approve-usdt"
                ? ""
                : word(options.simulationCode ?? 0n),
            ],
            energy_used: 20_000,
          };
      } else if (url.endsWith("/wallet/getchainparameters"))
        data = {
          chainParameter: [
            { key: "getEnergyFee", value: 100 },
            { key: "getTransactionFee", value: 1000 },
          ],
        };
      else if (url.endsWith("/wallet/triggersmartcontract")) {
        expect(body.owner_address).toBe(TronWeb.address.toHex(owner));
        const amount = BigInt(`0x${body.parameter.slice(-64)}`);
        data = {
          result: { result: true },
          transaction: unsigned(action, amount, body.fee_limit),
        };
      } else throw new Error(`Unexpected RPC method ${url}`);
      return new Response(JSON.stringify(data), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }
  it("builds a simulated validated unsigned USDT deposit with distinct fee estimate/cap", async () => {
    const fetchMock = mockPreparation("supply-usdt");
    const preview = await prepareTransaction({
      action: "supply-usdt",
      owner,
      amount: "1.000001",
    });
    expect(preview.amount).toBe("1.000001");
    expect(preview.feeLimitSun).toBe(2_600_000);
    expect(preview.estimatedEnergy).toBe(20_000);
    expect(preview.unsignedTransaction).not.toHaveProperty("signature");
    expect(
      fetchMock.mock.calls.every(([url]) => !/(broadcast|sign)/i.test(url)),
    ).toBe(true);
  });
  it("requires allowance before building a supply transaction", async () => {
    const fetchMock = mockPreparation("supply-usdt", { allowance: 0n });
    await expect(
      prepareTransaction({ action: "supply-usdt", owner, amount: "1" }),
    ).rejects.toMatchObject({ code: "ALLOWANCE_REQUIRED" });
    expect(
      fetchMock.mock.calls.some(([url]) =>
        url.endsWith("/wallet/triggersmartcontract"),
      ),
    ).toBe(false);
  });
  it("requires reset of an existing nonzero allowance, and supports exact zero reset", async () => {
    mockPreparation("approve-usdt", { allowance: 10n });
    await expect(
      prepareTransaction({ action: "approve-usdt", owner, amount: "1" }),
    ).rejects.toMatchObject({ code: "RESET_ALLOWANCE" });
    const reset = await prepareTransaction({
      action: "approve-usdt",
      owner,
      amount: "0",
    });
    expect(reset.amount).toBe("0");
    expect(reset.parameters).toEqual([REGISTRY.jUsdt, "0"]);
  });
  it("blocks withdrawal from a wallet with outstanding borrowing before building", async () => {
    const fetchMock = mockPreparation("withdraw-usdt", { hasBorrow: true });
    await expect(
      prepareTransaction({ action: "withdraw-usdt", owner, amount: "1" }),
    ).rejects.toMatchObject({ code: "BORROW_POSITION" });
    expect(
      fetchMock.mock.calls.some(([url]) =>
        url.endsWith("/wallet/triggersmartcontract"),
      ),
    ).toBe(false);
  });
  it("fails closed on protocol-level simulation errors even when the node says result=true", async () => {
    const fetchMock = mockPreparation("supply-usdt", { simulationCode: 12n });
    await expect(
      prepareTransaction({ action: "supply-usdt", owner, amount: "1" }),
    ).rejects.toMatchObject({ code: "PROTOCOL_REJECTED" });
    expect(
      fetchMock.mock.calls.some(([url]) =>
        url.endsWith("/wallet/triggersmartcontract"),
      ),
    ).toBe(false);
  });
});
describe("wallet unknown-data isolation", () => {
  it.each([false, true])(
    "reads the verified USDD token with 18 decimals, isolating an unavailable balance (USDD available=%s)",
    async (usddAvailable) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string, init?: RequestInit) => {
          const body = JSON.parse(String(init?.body));
          let data: unknown;
          if (url.endsWith("getblockbynum"))
            data = { blockID: MAINNET_GENESIS_BLOCK_ID };
          else if (url.endsWith("getnowblock"))
            data = { block_header: { raw_data: { timestamp: Date.now() } } };
          else if (url.endsWith("getaccount"))
            data = {
              address: TronWeb.address.toHex(owner),
              balance: 10_000_000,
            };
          else if (url.endsWith("getaccountresource"))
            data = { EnergyLimit: 1000, EnergyUsed: 100, freeNetLimit: 600 };
          else if (url.endsWith("triggerconstantcontract")) {
            let output = "";
            if (body.contract_address === REGISTRY.usdd && !usddAvailable)
              return new Response(
                JSON.stringify({ result: { result: false } }),
                {
                  status: 200,
                },
              );
            if (body.function_selector === "decimals()")
              output = word(body.contract_address === REGISTRY.usdd ? 18n : 6n);
            else if (body.function_selector === "balanceOf(address)")
              output = word(
                body.contract_address === REGISTRY.usdd
                  ? 1_000_000_000_000_000_001n
                  : 1_000_001n,
              );
            else if (body.function_selector === "getAssetsIn(address)")
              output = utils.abi
                .encodeParams(["address[]"], [[]])
                .replace(/^0x/, "");
            else if (body.function_selector === "getAccountSnapshot(address)")
              output = [
                0n,
                body.contract_address === REGISTRY.jUsdt ? 10_000_000_000n : 0n,
                0n,
                100_000_000_000_000n,
              ]
                .map(word)
                .join("");
            else
              throw new Error(`Unexpected function ${body.function_selector}`);
            data = { result: { result: true }, constant_result: [output] };
          } else throw new Error(`Unexpected path ${url}`);
          return new Response(JSON.stringify(data), { status: 200 });
        }),
      );
      const result = await walletAdapter.getWalletState(owner);
      expect(result.usdd).toBe(usddAvailable ? "1.000000000000000001" : null);
      expect(result.usdt).toBe("1.000001");
      expect(result.positions[0].underlyingAmount).toBe("1");
      expect(result.energyRemaining).toBe(900);
      expect(result.warnings.some((x) => x.includes("확인 불가"))).toBe(
        !usddAvailable,
      );
      expect(result.warnings.some((x) => x.includes("다른 등록 토큰"))).toBe(
        false,
      );
    },
  );
  it("does not interpret an HTTP200 RPC error as zero balance or pending transaction", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ Error: "request rejected" }), {
          status: 200,
        }),
      ),
    );
    await expect(rpc("wallet/getaccountresource", {})).rejects.toMatchObject({
      code: "RPC_REJECTED",
    });
  });
});
describe("live-source normalization", () => {
  it("keeps USDD routing disabled after token identity is verified, separating rates, incentives, and cash", () => {
    const data = parseMarkets(
      marketFixture,
      registry,
      {
        code: 0,
        data: {
          [REGISTRY.jUsdt]: { USDD: "0" },
          [REGISTRY.jUsdd]: { USDD: "0.03987090" },
        },
      },
      new Date(now).toISOString(),
    );
    expect(data[0].baseApy).toBe("0.020172535926048");
    expect(data[0].cashUSDT).toBe("90214298.006946");
    expect(data[0].rewardApy).toBe("0");
    expect(data[1].rewardApy).toBe("0.0398709");
    expect(data[1].active).toBe(false);
    expect(data[1].quality).toBe("unavailable");
    expect(data[1].cashUSDT).toBeNull();
    expect(data[1].tokenAddress).toBe(REGISTRY.usdd);
    expect(
      data[1].warnings.some((warning) => warning.includes("왕복 실행 경로")),
    ).toBe(true);
  });
  it("does not confuse HTTP 200/business error with an empty working market", () =>
    expect(() =>
      parseMarkets(
        { code: 1, data: marketFixture.data },
        registry,
        null,
        "now",
      ),
    ).toThrow());
  it("rejects a replaced asset and legacy market", () => {
    const changed = structuredClone(marketFixture);
    changed.data.tokenList[0].underlyingAddress =
      REGISTRY.justlendUsddUnderlying;
    expect(() => parseMarkets(changed, registry, null, "now")).toThrow();
    const legacy = structuredClone(registry);
    legacy.networks.mainnet.jtokens.jUSDT.status = "legacy";
    expect(() => parseMarkets(marketFixture, legacy, null, "now")).toThrow();
  });
  it("does not infer bilateral PSM capacity from locked collateral or a scalar fee", () => {
    const data = parsePsm(
      {
        code: 0,
        data: {
          items: [
            {
              chain: "tron",
              vaultType: "PSM-USDT-A",
              contractAddress: REGISTRY.psmUsdtJoin,
              psmFee: "0",
              lockedValue: 99_000_000,
            },
          ],
        },
      },
      "now",
    );
    expect(data.available).toBe(false);
    expect(data.availableUSDT).toBeNull();
    expect(data.toUSDDFeePct).toBeNull();
    expect(data.evidence).toHaveLength(2);
  });
  it("rejects a collateral API row that substitutes the PSM module for the Join adapter", () => {
    expect(() =>
      parsePsm(
        {
          code: 0,
          data: {
            items: [
              {
                chain: "tron",
                vaultType: "PSM-USDT-A",
                contractAddress: REGISTRY.psmUsdt,
                psmFee: "0",
              },
            ],
          },
        },
        "now",
      ),
    ).toThrow();
  });
  it("keeps live mode unavailable during network failure, without demo fallback", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    const result = await getLiveSnapshot();
    expect(result.mode).toBe("live");
    expect(result.markets.every((m) => m.baseApy === null && !m.active)).toBe(
      true,
    );
    expect(result.psm.available).toBe(false);
  });
});
describe("unsigned transaction integrity", () => {
  it("checks protobuf bytes and SHA256 txID against complete reviewed contract call", () =>
    expect(validateUnsignedTransaction(unsigned(), expected, now)).toBe(
      unsigned().txID,
    ));
  it.each([
    "owner",
    "to",
    "amount",
    "native-value",
    "fee",
    "multi",
    "signed",
    "permission",
    "memo",
  ])("rejects tampered %s", (change) => {
    const tx = unsigned(),
      value = tx.raw_data.contract[0].parameter.value;
    if (change === "owner")
      value.owner_address = TronWeb.address.toHex(REGISTRY.comptroller);
    if (change === "to")
      value.contract_address = TronWeb.address.toHex(REGISTRY.usdd);
    if (change === "amount") value.data = callData("supply-usdt", 2_000_000n);
    if (change === "native-value") value.call_value = 1;
    if (change === "fee") tx.raw_data.fee_limit = 1_000_000_000;
    if (change === "multi") tx.raw_data.contract.push(tx.raw_data.contract[0]);
    if (change === "signed") tx.signature = ["a".repeat(130)];
    if (change === "permission") tx.raw_data.contract[0].Permission_id = 2;
    if (change === "memo") tx.raw_data.data = "1234";
    expect(() => validateUnsignedTransaction(tx, expected, now)).toThrow();
  });
  it("rejects correct display data paired with different serialized signing bytes", () => {
    const tx = unsigned();
    tx.raw_data_hex = tx.raw_data_hex.slice(0, -2) + "00";
    expect(() => validateUnsignedTransaction(tx, expected, now)).toThrow();
  });
  it("rejects expired transactions", () =>
    expect(() =>
      validateUnsignedTransaction(unsigned(), expected, now + 61_000),
    ).toThrow());
  it("encodes exact approval spender and amount without granting unlimited allowance", () => {
    const data = callData("approve-usdt", 123n);
    expect(data.slice(-64)).toBe(word(123n));
    expect(data.slice(8, 72).slice(-40)).toBe(
      TronWeb.address.toHex(REGISTRY.jUsdt).slice(2),
    );
  });
});
describe("fees, protocol success and network verification", () => {
  const parameters = {
    chainParameter: [
      { key: "getEnergyFee", value: 100 },
      { key: "getTransactionFee", value: 1_000 },
    ],
  };
  it("distinguishes cap from estimated fee and includes paid bandwidth", () => {
    const fee = estimateFees(20_000, 400, parameters, 5_000);
    expect(fee.feeLimitSun).toBe(2_600_000);
    expect(fee.estimatedFeeSun).toBe(1_900_000n);
  });
  it("fails closed on missing network fee fields", () =>
    expect(() =>
      estimateFees(20_000, 400, { chainParameter: [] }, 0),
    ).toThrow());
  it("rejects successful TVM execution returning a Compound-style error code", () => {
    expect(() =>
      assertSimulationSuccess("supply-usdt", {
        result: { result: true },
        constant_result: [word(12n)],
      }),
    ).toThrow();
    expect(() =>
      assertSimulationSuccess("withdraw-usdt", {
        result: { result: true },
        constant_result: [word(0n)],
      }),
    ).not.toThrow();
  });
  it("does not mark a receipt success as a successful mint when protocol return is failure", () => {
    const info = {
      id: "x",
      fee: 123456,
      receipt: { result: "SUCCESS" },
      contractResult: [word(12n)],
    };
    expect(interpretReceipt(info, unsigned())).toEqual({
      status: "failed",
      actualFeeTRX: "0.123456",
      error: expect.any(String),
    });
    expect(
      interpretReceipt({ ...info, contractResult: [] }, unsigned()).status,
    ).toBe("unknown");
    expect(
      interpretReceipt({ ...info, contractResult: [word(0n)] }, unsigned())
        .status,
    ).toBe("confirmed");
  });
  it("fails on wrong genesis despite a plausible fresh head", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async (url: string) =>
          new Response(
            JSON.stringify(
              url.endsWith("getblockbynum")
                ? { blockID: "wrong" }
                : { block_header: { raw_data: { timestamp: Date.now() } } },
            ),
            { status: 200 },
          ),
      ),
    );
    await expect(verifyMainnet()).rejects.toThrow("제네시스");
  });
  it("fails on stale mainnet head", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async (url: string) =>
          new Response(
            JSON.stringify(
              url.endsWith("getblockbynum")
                ? { blockID: MAINNET_GENESIS_BLOCK_ID }
                : {
                    block_header: {
                      raw_data: { timestamp: Date.now() - 180_000 },
                    },
                  },
            ),
            { status: 200 },
          ),
      ),
    );
    await expect(verifyMainnet()).rejects.toThrow("오래");
  });
});
