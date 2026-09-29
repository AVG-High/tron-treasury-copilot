/** Independently pinned from official protocol registries. Do not infer identity from symbols. */
export const TRON_RPC = "https://api.trongrid.io";
export const MAINNET_GENESIS_BLOCK_ID =
  "00000000000000001ebf88508a03865c71d452e25f4d51194196a1d22b6653dc";
export const REGISTRY = {
  usdt: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t",
  usdd: "TCrEVahRbhDFB6uRXEWUg7wkptXvg47GKs",
  // Official JustLend registry and live API disagree with USDD's own token registry.
  // Keep this identity separate; a PSM -> JustLend USDD route is disabled.
  justlendUsddUnderlying: "TXDk8mbtRbXeYuMNS83CfKPaYYT8XWv9Hz",
  jUsdt: "TXJgMdjVX5dKiQaUi9QobwNxtSQaFqccvd",
  jUsdtImplementation: "TLjn59xNM7VEK6VZ3VQ8Y1ipxsdsFka5wZ",
  jUsdd: "TKFRELGGoRgiayhwJTNNLqCNjFoLBh3Mnf",
  comptroller: "TGjYzgCyPobsNS9n6WcbdLVR9dH7mWqFx7",
  psmCollateral: "TSUYvQ5tdd3DijCD1uGunGLpftHuSZ12sQ",
} as const;
/** SHA256 of bytecode bytes returned by official wallet/getcontract, observed 2026-09-28. */
export const CODE_FINGERPRINTS = {
  [REGISTRY.usdt]:
    "2866816060782939f36b0f42dd695c197b72d4ea133f433a08575c9a528a93b5",
  [REGISTRY.jUsdt]:
    "87fbdccf8fda7933644d4933f2a8acd58e5242274f29b9bbf37f2e92614d9d4f",
  [REGISTRY.jUsdtImplementation]:
    "db94e89ebe7c3a69b7cbb1690ddce2345169f6af7c1ab8b4da22f0c5594e1aae",
} as const;
export const SOURCE_URLS = {
  justlendRegistry: "https://docs.justlend.org/developers/contracts.json",
  justlendMarkets: "https://openapi.just.network/lend/jtoken",
  justlendMining: "https://openapi.just.network/mining/apy",
  justlendDocs: "https://docs.justlend.org/developers/apis/",
  usddRegistry: "https://docs.usdd.io/developers/deployment-addresses",
  usddSnapshot:
    "https://openapi.usdd.io/api/v1/data-platform/latest-collateral?chain=tron",
  usddDocs: "https://docs.usdd.io/developers/usdd-public-api",
} as const;
