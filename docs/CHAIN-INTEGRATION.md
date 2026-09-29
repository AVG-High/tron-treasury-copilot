# TRON chain integration — 2026-09-28

This is a separate project. No RANGE, Canton, or ddaribot settings, wallets, keys or contracts are used.

## Official sources and live observations

- JustLend registry: https://docs.justlend.org/developers/contracts.json
- JustLend API contract: https://docs.justlend.org/developers/apis/
- Live GET `https://openapi.just.network/lend/jtoken`: `{code:0,data:{tokenList:[...]}}`. API failures can still have HTTP 200. `supplyRate` is annualized decimal; `cash` is already in underlying human units. jToken balances use 8 decimals, USDT 6, USDD 18. Never re-scale `cash` or read the displayed token symbol as identity.
- Live GET `https://openapi.just.network/mining/apy`: `{code:0,data:{[jTokenAddress]:{USDD:"0.03987090"}}}`. The field is **USDD**, not `apy`. Rewards are separate from supply interest, claimed by phases. Zero is retained; missing data is unknown.
- USDD source: https://docs.usdd.io/developers/deployment-addresses
- USDD data contract: https://docs.usdd.io/developers/usdd-public-api
- Live GET `https://openapi.usdd.io/api/v1/data-platform/latest-collateral?chain=tron`: `{code:0,data:{items:[...]}}`. PSM-USDT-A identifies contract `TSUYvQ5tdd3DijCD1uGunGLpftHuSZ12sQ`, scalar `psmFee`, `lockedValue`, and `line`. These do **not** establish bilateral enabled state or currently exchangeable USDT. The adapter records actual source evidence and leaves those operational fields null/disabled.

Live responses above were fetched read-only during implementation. No user wallet was queried and no transaction was sent. Unit tests use synthetic fixtures with matching response shapes; they do not call live networks.

## Unresolved asset identity — execution deliberately blocked

USDD's official deployment list pins USDD to `TCrEVahRbhDFB6uRXEWUg7wkptXvg47GKs`. Both JustLend's official registry **and** the actually fetched market response report active jUSDD (`TKFRELGGoRgiayhwJTNNLqCNjFoLBh3Mnf`) underlying as `TXDk8mbtRbXeYuMNS83CfKPaYYT8XWv9Hz`. The names matching is insufficient. No verified conversion/migration route between them has been established.

The app may show the independently observed jUSDD base and reward rates, but marks that strategy unavailable and excludes PSM→JustLend USDD planning/execution. Wallet USDD balance refers only to the USDD official token. A live read-only probe found `decimals()` at the USDD-document address fails, while jUSDD `underlying()` returned `TXDk8...`, with token decimals 18. The wallet balance therefore remains null/unknown when this verification fails, and does not block independently verified USDT operations. JustLend USDD positions refer to JustLend's distinct registry asset and are not silently aggregated into that wallet balance. This blocks a dangerous same-symbol substitution while retaining genuine read-only USDD integration.

## Execution boundary

Only USDT `approve(address,uint256)` to pinned jUSDT, jUSDT `mint(uint256)`, and jUSDT `redeemUnderlying(uint256)` are built. Approve uses exactly the entered amount; a non-zero existing allowance requires zero reset first. Supply requires adequate balance and allowance. Withdrawal requires sufficient position and current market cash and rejects any JustLend V1 borrowing position.

`getWalletState` checks official TRON RPC genesis and a head within 90 seconds; token decimals are read; `getAccountSnapshot` values use bigint and exchange-rate mantissa arithmetic. Individual reads use latest state and are not an atomic snapshot. Execution also verifies on-chain jUSDT underlying, implementation, Comptroller and decimals, then simulates the full action and checks its return code. SHA256 fingerprints of official RPC `getcontract` bytecode are pinned for USDT, jUSDT proxy, and its registered implementation. All were fetched read-only during implementation; future code/implementation changes block preparation pending review. These are change-detection checks, not a contract audit. Compound-style error codes can occur even when TVM succeeds, so both preparation and receipt tracking inspect return bytes.

RPC is pinned to `https://api.trongrid.io`. The optional `TRONGRID_API_KEY` is server-only. No arbitrary URL or private key is accepted. Verified genesis from public `wallet/getblockbynum {num:0}`:

`00000000000000001ebf88508a03865c71d452e25f4d51194196a1d22b6653dc`

`prepareTransaction` returns unsigned bytes only. It cannot sign or broadcast. Before return it checks one TriggerSmartContract, owner, target, exact calldata, no native/token value, no extra permission, no memo, no existing signature, timestamps, fee cap, and protobuf serialization. `digest` is SHA256 of decoded `raw_data_hex` bytes and equals TRON `txID`. The browser must recheck these bytes/txID, show the full preview, require an explicit user click, verify wallet mainnet, sign with the wallet, and reject any changed raw bytes after signing.

Fees use current `getEnergyFee` and `getTransactionFee`, simulated Energy, and currently available wallet Energy. `feeLimitSun` is a separate cap with an explicit 30% Energy headroom, capped at 1,000 TRX; it is not called expected spend. Bandwidth is conservatively charged fully instead of combining incompatible free/staked buckets. Preparation requires TRX covering cap plus bandwidth allowance. This can conservatively decline an account that relies entirely on staked resources. Missing simulation or unit-price data blocks preparation, with no guessed fees.

Read-only references: https://developers.tron.network/docs/set-feelimit and https://developers.tron.network/reference/gettransactioninfobyid . Receipt tracking uses solidity endpoints and distinguishes failure, pending, and missing-return-data unknown. It never automatically retries a transaction.

## Not validated by implementation tests

No user signing, broadcast, funded mainnet deposit, or funded mainnet withdrawal has been performed. A successful unit/build check is not proof of a mainnet round trip. Public RPC may throttle without a TronGrid key. Live JustLend API does not expose the source block timestamp; `fetchedAt` is the fetch time only. Rate changes, future redemption liquidity, and future protocol upgrades are not guaranteed.
