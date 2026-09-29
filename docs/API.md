# API and AI boundary

The API binds to `127.0.0.1:4187` by default. Vite serves the UI at `127.0.0.1:4177`
and proxies `/api`. Production serves the built `dist` directory from the same server.
No service stores private keys, signs transactions or broadcasts transactions.

| Method and path                  | Input                                  | Response                                                     |
| -------------------------------- | -------------------------------------- | ------------------------------------------------------------ |
| `GET /api/health`                | None                                   | `ok`, `app`, `version`, `aiConfigured`, `network`, `signing` |
| `GET /api/markets?mode=live`     | `live` (default) or explicit `demo`    | `MarketSnapshot`                                             |
| `POST /api/intent`               | `{ text }`, maximum 6,000 characters   | `ParseResult`                                                |
| `POST /api/plan`                 | `{ mode, intent, costs }`              | `PlanningResult`                                             |
| `GET /api/wallet/:address`       | TRON Base58 address                    | `WalletState`                                                |
| `POST /api/transactions/prepare` | `{ action, owner, amount, planning? }` | `TransactionPreview`, unsigned only                          |
| `GET /api/transactions/:txid`    | 64-character hexadecimal ID            | `{ status, actualFeeTRX?, error? }`                          |

Amounts are decimal strings; no binary floating-point amounts or scientific notation.
The common domain schemas validate intent and cost requests. Errors are `{ error: string }`.
An infeasible but valid financial request returns a `PlanningResult` with `feasible: false`;
malformed requests return 400. Unknown API paths return 404. Oversized JSON returns 413.
Live requests never substitute fixture data when an upstream service fails.
Market reads cache for at most 30 seconds; execution preparation refetches relevant data.

## Confirmed supply context

`action` is one of `approve-usdt`, `supply-usdt`, `withdraw-usdt`. Only supported
allowlisted contracts/functions can be prepared by the chain adapter. No arbitrary URL,
contract, spender, calldata, network or private key is accepted from a request.
Supply and withdrawal amounts must be positive. An exact zero `approve-usdt` amount
is permitted to reset an existing allowance before granting the required new amount.

For `supply-usdt`, `planning` is required:

```json
{
  "mode": "live",
  "planId": "the selected plan ID",
  "intent": "the confirmed TreasuryIntent object",
  "costs": "the confirmed CostAssumptions object"
}
```

The server rereads the wallet and markets, recalculates that plan and verifies the
requested supply is within its USDT allocation. Planned capital cannot exceed current
wallet USDT, and expense/emergency reserves plus the planned cost allowance must remain after supply. A changed or
unverifiable plan is rejected with 409. This check does not reserve funds on-chain:
the wallet and transaction must be checked again when signing. The user wallet remains
the execution authority. The UI must not describe a preview or approval as a completed deposit.
Submitted cost provenance must remain `user-assumption`: the client cannot label it
`wallet-estimate`. The chain adapter estimates this individual transaction separately;
future withdrawal costs remain unknown. An indicative multi-step plan is not made
fully executable merely by preparing its USDT portion. The preview includes that warning.
When a plan is supplied with a nonzero approval, its amount also cannot exceed the
selected USDT allocation. A second wallet read after construction detects balance
changes during preparation. This remains a quote-time observation, not an on-chain
reservation; the browser rechecks before user signing.

## AI extraction, not financial math

Set **both** `OPENAI_API_KEY` and `OPENAI_MODEL` in this project's private `.env` to
enable the optional AI route. No model is chosen implicitly. API keys must never use
a `VITE_` prefix or appear in frontend settings. Without both settings, the response is
`source: "manual"`, an empty partial intent and explicit follow-up questions. No AI
call or fake parser result is produced.

The server sends only the user's submitted text to the OpenAI Responses endpoint.
It does not attach wallet balances, transaction history or account addresses.
Requests use `store: false`, strict JSON Schema structured output and a timeout. They
are not zero-retention guarantees; the provider's separate retention policies apply.
The model extracts explicitly stated conditions, leaves missing values null and asks
follow-up questions. A low-risk adjective is not a numeric risk limit. An upcoming
expense deadline is not the investment horizon of the residual capital.

The returned object is independently validated, and the user must confirm it before
calculating a plan. Incomplete, refused, malformed and failed responses are rejected;
the server does not fall back to invented AI output. APY conversion, reserve arithmetic,
allocation, costs and breakeven are computed by the domain engine, not by the model.

Primary reference: [OpenAI Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs).
No production OpenAI call was required by the automated tests; the transport is mocked.

## Request boundaries

Mutating API requests require `Content-Type: application/json` and an exact allowed
`Origin`. Browser same-origin fetch sets Origin automatically. Local tools must supply
the UI Origin explicitly. Other origins and unexpected Host headers are rejected.
The JSON body limit is 30 KB; default in-memory limits are 120 API requests per minute
per connection IP, 6 intent requests per minute per IP and 30 globally.
Forwarded IP headers are not trusted. Behind a proxy, this conservative limiter can
treat users as one IP; configure an ingress limiter/authentication for a public release.

Non-loopback `HOST` requires an exact `PUBLIC_ORIGIN`; non-loopback public origins must
use HTTPS. These origin checks prevent browser cross-origin use and DNS rebinding but
are not user authentication. Rate limits reset on restart and are not a spending cap.
Protect a publicly exposed paid AI endpoint with authentication and provider budgets.

There is no server-side history database. Plans and transaction tracking use the
browser's project-specific local storage; it is not a secure multi-user account system.
Request bodies, wallet addresses, balances, upstream error bodies and API keys are not
logged. Demo and live data remain explicitly distinguished.
