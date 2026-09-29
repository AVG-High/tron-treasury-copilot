# TRON Treasury Copilot — reviewer guide

**Team:** AVG_High · **Track:** GWDC 2026 Korea / TRON Challenge B

Plan around when you need your money, then compare TRON yield after costs and liquidity constraints.

## Open the project

- [Interactive demo](https://web-production-33c98.up.railway.app)
- [35-second English demo video](https://github.com/AVG-High/tron-treasury-copilot/releases/download/gwdc-2026-submission/treasury-demo-en.mp4)
- [English pitch deck PDF (8 slides)](https://github.com/AVG-High/tron-treasury-copilot/releases/download/gwdc-2026-submission/tron-treasury-copilot-pitch.pdf)
- [Editable pitch deck PPTX](https://github.com/AVG-High/tron-treasury-copilot/releases/download/gwdc-2026-submission/tron-treasury-copilot-pitch.pptx)
- [Source ZIP and release materials](https://github.com/AVG-High/tron-treasury-copilot/releases/tag/gwdc-2026-submission)
- [Verified application commit](https://github.com/AVG-High/tron-treasury-copilot/tree/ae7a63579c4a45abf37cd96fe89f2881447db713)
- [Remote tests and Docker startup verification](https://github.com/AVG-High/tron-treasury-copilot/actions/runs/36609364449)

## Try it in one minute

1. Choose **Reserve expenses first**, review the input amounts, and select **Confirm and compare**.
2. See 4,500 USDT reserved for expenses and emergencies. Compare holding cash with viable allocations after costs.
3. Select **Extra expense +3,000** to see how an additional obligation reduces investable capital.
4. Return to **Original conditions**, wait for the updated result, and **Save plan**.
5. Open **Positions and review** to compare original assumptions with a clearly labeled rate/cost simulation.
6. Return to **Treasury plan** and choose **Short-term cost check**. Holding cash is the only plan when expected interest cannot cover the round-trip cost.

## What is implemented

The optional AI layer extracts requirements for user confirmation. A separate Decimal/BigInt engine reserves expenses, applies exposure caps, checks liquidity, and compares net outcomes. JustLend and USDD adapters include sources and timestamps. Missing live data stays unavailable.

The prototype prepares exact USDT approvals and JustLend supply or redemption transactions. Users review each transaction and sign through TronLink. The server has no private keys and cannot sign. Plans and financial history remain in the user's browser; this is not an authenticated multi-user database.

## Validation and limits

- 187 unit/integration tests and 14 browser tests pass, including the remote GitHub run.
- Production compilation and Docker startup/health-check verification pass.
- The public deployment uses manual inputs. No paid AI credentials are configured.
- The English video uses sample data. It is not a recording of a live AI response or funded transaction.
- Live AI responses and a funded wallet round trip remain unverified.
- USDD conversion and investment execution remain disabled. No autonomous fund management or complete realized-profit ledger is claimed.

For local setup and implementation details, see [README](../README.md), [architecture and submission description](SUBMISSION-TEXT.md), and [chain integration](CHAIN-INTEGRATION.md).

Publication and deployment are complete review materials. Acceptance of the project by the organizer is a separate step; this page is not a submission receipt.

## Final form fields confirmed by the submitter

Select **Demo Stage**. A public prototype alone does not establish live user adoption.

The final form requires a demo of at most 3 minutes and a PDF/PPT pitch deck. The English MP4 is 34.64 seconds. Where a file-upload field is provided, upload that MP4. If a hosted video URL is required, use a publicly accessible Notion, Google Drive, or YouTube link as requested by the organizer; acceptance of the GitHub download URL has not been confirmed.

The current video demonstrates the manual planning workflow with sample data. It does not demonstrate a live AI response, so the form's AI decision-making demonstration requirement remains a submission gap. The pitch deck explains the architecture but does not substitute for a live AI demonstration.
