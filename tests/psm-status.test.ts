import { afterEach, describe, expect, it, vi } from "vitest";
import { TronWeb } from "tronweb";
import { getPsmStatus } from "../src/chain/psm-status";
import {
  MAINNET_GENESIS_BLOCK_ID,
  REGISTRY,
  TRON_RPC,
} from "../src/chain/registry";

const word = (value: bigint) => value.toString(16).padStart(64, "0");
const addressWord = (address: string) =>
  TronWeb.address.toHex(address).slice(2).padStart(64, "0");

function mockRpc(
  options: {
    override?: Record<string, string | null>;
    wrongGenesis?: boolean;
    stale?: boolean;
  } = {},
) {
  const responses: Record<string, string> = {
    [`${REGISTRY.psmUsdt}:usdd()`]: addressWord(REGISTRY.usdd),
    [`${REGISTRY.psmUsdt}:gemJoin()`]: addressWord(REGISTRY.psmUsdtJoin),
    [`${REGISTRY.psmUsdtJoin}:gem()`]: addressWord(REGISTRY.usdt),
    [`${REGISTRY.usdt}:decimals()`]: word(6n),
    [`${REGISTRY.usdd}:decimals()`]: word(18n),
    [`${REGISTRY.psmUsdt}:sellEnabled()`]: word(1n),
    [`${REGISTRY.psmUsdt}:buyEnabled()`]: word(0n),
    [`${REGISTRY.psmUsdt}:tin()`]: word(1_000_000_000_000_000n),
    [`${REGISTRY.psmUsdt}:tout()`]: word(2_500_000_000_000_000n),
  };
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    expect(url.startsWith(`${TRON_RPC}/wallet/`)).toBe(true);
    const body = JSON.parse(String(init?.body));
    let data: unknown;
    if (url.endsWith("getblockbynum"))
      data = {
        blockID: options.wrongGenesis ? "wrong" : MAINNET_GENESIS_BLOCK_ID,
      };
    else if (url.endsWith("getnowblock"))
      data = {
        block_header: {
          raw_data: { timestamp: Date.now() - (options.stale ? 180_000 : 0) },
        },
      };
    else if (url.endsWith("triggerconstantcontract")) {
      expect(body.owner_address).toBe(REGISTRY.usdt);
      expect(body.parameter).toBe("");
      const key = `${body.contract_address}:${body.function_selector}`;
      expect(responses[key]).toBeDefined();
      const value =
        options.override && key in options.override
          ? options.override[key]
          : responses[key];
      data =
        value === null
          ? { result: { result: false } }
          : { result: { result: true }, constant_result: [value] };
    } else throw new Error(`Unexpected read ${url}`);
    return new Response(JSON.stringify(data), { status: 200 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => vi.unstubAllGlobals());

describe("PSM read-only status — simulated public RPC, no signing or transfer", () => {
  it("checks current identities and reports both fee directions with precise WAD scaling", async () => {
    const fetchMock = mockRpc();
    const result = await getPsmStatus();
    expect(result).toMatchObject({
      quality: "verified",
      chain: "tron-mainnet",
      usddAddress: REGISTRY.usdd,
      psmAddress: REGISTRY.psmUsdt,
      joinAddress: REGISTRY.psmUsdtJoin,
      sellEnabled: true,
      buyEnabled: false,
      toUSDDFeePct: "0.1",
      fromUSDDFeePct: "0.25",
      availableUSDT: null,
    });
    expect(fetchMock).toHaveBeenCalledTimes(11);
    expect(result.evidence).toHaveLength(3);
    expect(result.warnings.join(" ")).toContain("동일 블록");
    expect(result).not.toHaveProperty("available");
  });

  it("preserves a verified disabled direction and zero fee instead of unknown", async () => {
    mockRpc({
      override: {
        [`${REGISTRY.psmUsdt}:sellEnabled()`]: word(0n),
        [`${REGISTRY.psmUsdt}:tin()`]: word(0n),
        [`${REGISTRY.psmUsdt}:tout()`]: word(0n),
      },
    });
    expect(await getPsmStatus()).toMatchObject({
      quality: "verified",
      sellEnabled: false,
      buyEnabled: false,
      toUSDDFeePct: "0",
      fromUSDDFeePct: "0",
    });
  });

  it("scales one WAD to 100 percent and keeps one raw fee unit exact", async () => {
    mockRpc({
      override: {
        [`${REGISTRY.psmUsdt}:tin()`]: word(1_000_000_000_000_000_000n),
        [`${REGISTRY.psmUsdt}:tout()`]: word(1n),
      },
    });
    const result = await getPsmStatus();
    expect(result.toUSDDFeePct).toBe("100");
    expect(result.fromUSDDFeePct).toBe("0.0000000000000001");
    expect(result.warnings.join(" ")).toContain("100% 이상");
  });

  it.each([
    [`${REGISTRY.psmUsdt}:usdd()`, addressWord(REGISTRY.usdt)],
    [`${REGISTRY.psmUsdt}:gemJoin()`, addressWord(REGISTRY.psmUsdt)],
    [`${REGISTRY.psmUsdtJoin}:gem()`, addressWord(REGISTRY.usdd)],
    [`${REGISTRY.usdt}:decimals()`, word(18n)],
    [`${REGISTRY.usdd}:decimals()`, word(6n)],
    [`${REGISTRY.psmUsdt}:sellEnabled()`, word(2n)],
    [`${REGISTRY.psmUsdt}:buyEnabled()`, word(2n)],
    [`${REGISTRY.psmUsdt}:tin()`, ""],
    [`${REGISTRY.psmUsdt}:tout()`, null],
    [`${REGISTRY.psmUsdt}:usdd()`, "1" + addressWord(REGISTRY.usdd).slice(1)],
  ])(
    "fails closed for missing or invalid %s without exposing partial state",
    async (key, value) => {
      mockRpc({ override: { [key as string]: value } });
      expect(await getPsmStatus()).toMatchObject({
        quality: "unavailable",
        sellEnabled: null,
        buyEnabled: null,
        toUSDDFeePct: null,
        fromUSDDFeePct: null,
        availableUSDT: null,
      });
    },
  );

  it.each([{ wrongGenesis: true }, { stale: true }])(
    "requires mainnet and a fresh head: %j",
    async (options) => {
      const fetchMock = mockRpc(options);
      expect((await getPsmStatus()).quality).toBe("unavailable");
      expect(
        fetchMock.mock.calls.some(([url]) =>
          url.endsWith("triggerconstantcontract"),
        ),
      ).toBe(false);
    },
  );

  it("reports unavailable during an upstream failure without exposing internals or a demo fallback", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("private internal details")),
    );
    const result = await getPsmStatus();
    expect(result.quality).toBe("unavailable");
    expect(result.sellEnabled).toBeNull();
    expect(result.warnings.join(" ")).toContain(
      "조회 중단 단계: 메인넷 genesis·head 확인",
    );
    expect(result.warnings.join(" ")).not.toContain("private internal");
  });

  it("identifies the last failing read while discarding earlier successful values", async () => {
    mockRpc({ override: { [`${REGISTRY.psmUsdt}:tout()`]: null } });
    const result = await getPsmStatus();
    expect(result.warnings.join(" ")).toContain(
      "조회 중단 단계: PSM.tout 수수료 조회",
    );
    expect(result.sellEnabled).toBeNull();
    expect(result.toUSDDFeePct).toBeNull();
  });
});
