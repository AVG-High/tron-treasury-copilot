import { useEffect, useRef, useState } from "react";
import { Activity, Download, RefreshCw } from "lucide-react";
import { monitorPlan, compareWalletObservations } from "../domain/monitor";
import type {
  CostAssumptions,
  MarketSnapshot,
  PlanningResult,
  TreasuryIntent,
  WalletState,
} from "../domain/types";
import { api } from "./api";
import { exportJson } from "./history";
import {
  appendObservation,
  readObservations,
  observedWalletSchema,
} from "./observations";
import { startMonitorLoop } from "./monitor-loop";

type Report = ReturnType<typeof monitorPlan>;
const show = (value: string | null, digits = 6) =>
  value === null
    ? "Unavailable"
    : Number(value).toLocaleString("en-US", { maximumFractionDigits: digits });

export function MonitoringPanel({
  result,
  selectedPlanId,
  wallet,
  paused,
  onReview,
  onWallet,
  onSnapshot,
}: {
  result: PlanningResult;
  selectedPlanId: string;
  wallet: WalletState | null;
  paused: boolean;
  onReview: (intent: TreasuryIntent, costs: CostAssumptions) => void;
  onWallet: (wallet: WalletState) => void;
  onSnapshot: (snapshot: MarketSnapshot) => void;
}) {
  const [enabled, setEnabled] = useState(false);
  const [intervalMs, setIntervalMs] = useState(300_000);
  const [requestId, setRequestId] = useState(0);
  const consumedRequest = useRef(0);
  const [report, setReport] = useState<Report | null>(null);
  const [journal, setJournal] = useState(readObservations);
  const [error, setError] = useState("");
  const [querying, setQuerying] = useState(false);
  const [lastWallet, setLastWallet] = useState<WalletState | null>(null);
  const [viewTime, setViewTime] = useState(Date.now());
  const owner = wallet?.address;

  // Mounted for a single immutable plan/account pair. An input or account change remounts it stopped.
  useEffect(() => {
    const manuallyRequested = requestId > consumedRequest.current;
    consumedRequest.current = requestId;
    if ((!enabled && !manuallyRequested) || paused) {
      setQuerying(false);
      return;
    }
    let current = true;
    const controller = new AbortController();
    setError("");
    const load = async () => {
      if (current) setQuerying(true);
      try {
        const market = await api<MarketSnapshot>(
          "/markets?mode=live",
          undefined,
          controller.signal,
        );
        if (!current) throw new Error("Monitoring stopped.");
        const observed = owner
          ? observedWalletSchema.parse(
              await api<WalletState>(
                `/wallet/${owner}`,
                undefined,
                controller.signal,
              ),
            )
          : null;
        if (observed && observed.address !== owner)
          throw new Error(
            "The retrieved wallet differs from the monitored wallet.",
          );
        const now = Date.now();
        const next = monitorPlan({
          original: result,
          selectedPlanId,
          savedAt: result.createdAt,
          snapshot: market,
          wallet: observed,
          now,
        });
        return { next, observed, now, market };
      } finally {
        if (current) setQuerying(false);
      }
    };
    const onValue = ({
      next,
      observed,
      now,
      market,
    }: Awaited<ReturnType<typeof load>>) => {
      if (!current) return;
      setReport(next);
      setViewTime(now);
      setError("");
      setLastWallet(observed);
      if (market.mode === "live") onSnapshot(market);
      if (observed) {
        onWallet(observed);
        try {
          setJournal(appendObservation(observed, localStorage, now));
        } catch (e) {
          setJournal((j) => ({
            ...j,
            error:
              e instanceof Error ? e.message : "Failed to save observations",
          }));
        }
      }
    };
    const onError = (e: unknown, failures = 1) => {
      if (!current) return;
      setError(
        `${e instanceof Error ? e.message : "Observation failed"}${enabled ? ` (${failures}/3 failures)` : ""}`,
      );
    };
    if (!enabled) {
      void load().then(onValue).catch(onError);
      return () => {
        current = false;
        controller.abort();
      };
    }
    const stop = startMonitorLoop({
      intervalMs,
      load,
      onValue,
      onError,
      onStop: () => setEnabled(false),
      isVisible: () => document.visibilityState === "visible",
    });
    return () => {
      current = false;
      controller.abort();
      stop();
    };
  }, [
    enabled,
    intervalMs,
    requestId,
    paused,
    owner,
    result,
    selectedPlanId,
    onWallet,
    onSnapshot,
  ]);

  useEffect(() => {
    const timer = setInterval(() => setViewTime(Date.now()), 15_000);
    return () => clearInterval(timer);
  }, []);

  const previous = lastWallet
    ? journal.wallets.find(
        (w) =>
          w.address === lastWallet.address &&
          Date.parse(w.fetchedAt) < Date.parse(lastWallet.fetchedAt),
      )
    : undefined;
  const movement =
    previous && lastWallet
      ? compareWalletObservations(previous, lastWallet, viewTime)
      : null;
  const stale = !!report && viewTime - Date.parse(report.checkedAt) > 300_000;
  const proposal = report?.proposal;
  return (
    <section
      className="card monitoring-panel"
      aria-label="Live plan monitoring"
    >
      <div className="section-heading">
        <h2>
          <Activity size={18} /> Monitor plan changes
        </h2>
        <span className="tag">
          {paused
            ? "Paused during transaction"
            : enabled
              ? "Auto-refresh active"
              : "Auto-refresh off"}
        </span>
      </div>
      <p className="small muted">
        Compare live rates, withdrawal liquidity, and reserves with the original
        plan. Runs only while this browser is visible and resets to off on
        reload. Suggests conditions to review without moving funds.
      </p>
      {owner && <p className="wallet-address">Monitored wallet {owner}</p>}
      {!owner && (
        <p className="small muted">
          Currently monitoring product conditions only. Connect a wallet to
          include reserves and positions.
        </p>
      )}
      <div className="monitor-controls">
        <label>
          <input
            type="checkbox"
            checked={enabled}
            disabled={paused}
            onChange={(e) => setEnabled(e.target.checked)}
          />{" "}
          Auto-refresh
        </label>
        <label>
          Interval{" "}
          <select
            aria-label="Auto-refresh interval"
            value={intervalMs}
            disabled={paused}
            onChange={(e) => setIntervalMs(Number(e.target.value))}
          >
            <option value={60_000}>1 minute</option>
            <option value={300_000}>5 minutes</option>
            <option value={900_000}>15 minutes</option>
          </select>
        </label>
        <button
          className="secondary"
          disabled={paused || querying}
          onClick={() => setRequestId((n) => n + 1)}
        >
          <RefreshCw size={14} />
          Check now
        </button>
      </div>
      <p className="small muted">
        Slows down after failures and stops after 3 consecutive failures. Query
        status: {querying ? "Checking" : "Idle"}.
      </p>
      {error && (
        <p className="inline-warning" role="status">
          {error} Do not treat an earlier successful result as current data.
        </p>
      )}
      {stale && (
        <p className="inline-warning">
          The last observation is over 5 minutes old. Refresh before reviewing.
        </p>
      )}
      {report && (
        <>
          <p className="small muted">
            Last observation{" "}
            {new Date(report.checkedAt).toLocaleString("en-US")} · Elapsed{" "}
            {report.elapsedDays ?? "Unavailable"} days / Remaining{" "}
            {report.remainingDays ?? "Unavailable"} days
          </p>
          <div className="monitor-alerts" aria-live="polite">
            {report.alerts.map((alert, index) => (
              <p
                key={`${alert.code}-${index}`}
                className={`monitor-alert ${alert.severity}`}
              >
                {alert.message}
              </p>
            ))}
          </div>
          {report.reserve && (
            <p className="inline-warning">
              Required reserves and costs {show(report.reserve.requiredUSDT, 2)}{" "}
              USDT · Wallet {show(report.reserve.walletUSDT, 2)} USDT ·
              Shortfall {show(report.reserve.shortfallUSDT, 2)} USDT
            </p>
          )}
          {report.rateComparisons.length > 0 && (
            <div className="table-scroll">
              <table aria-label="Base interest with the same principal and horizon">
                <thead>
                  <tr>
                    <th>Strategy</th>
                    <th>Original base interest</th>
                    <th>At current rates</th>
                    <th>Estimated difference</th>
                  </tr>
                </thead>
                <tbody>
                  {report.rateComparisons.map((rate) => (
                    <tr key={rate.strategy}>
                      <td>
                        {rate.strategy === "justlend-usdt"
                          ? "JustLend USDT"
                          : "JustLend USDD"}
                        <small>
                          Same principal {show(rate.principalUSDT, 2)} /{" "}
                          {rate.originalHorizonDays} days
                        </small>
                      </td>
                      <td>{show(rate.originalBaseYieldUSDT)} USDT</td>
                      <td>{show(rate.currentBaseYieldUSDT)} USDT</td>
                      <td>{show(rate.deltaBaseYieldUSDT)} USDT</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="small muted">
            Compares rates using the same principal and original full horizon.
            Not accrued interest or net profit. Incentives and transaction costs
            are excluded.
          </p>
          <button
            className="secondary"
            disabled={!proposal || stale || !!error || paused || querying}
            onClick={() => {
              if (proposal) {
                setEnabled(false);
                onReview(proposal.intent, proposal.costs);
              }
            }}
          >
            Review remaining horizon
          </button>
          <p className="small muted">
            Opens inputs using the original capital. Update available funds and
            paid expenses, then recalculate. Past-due expenses are not
            automatically marked as paid.
          </p>
        </>
      )}
      <div className="monitor-ledger">
        <h3>Position observations</h3>
        <p className="small muted">
          Stores the latest 96 observations in this browser. This is not a full
          ledger of external cash flows and token transfers, so actual net
          profit is not calculated.
        </p>
        <p className="small">
          Actual net profit: unavailable · requires all external cash flows and
          costs
        </p>
        {journal.error && <p className="inline-warning">{journal.error}</p>}
        {movement?.status === "comparable" ? (
          movement.positions.map((p) => (
            <div className="position-row" key={p.marketId}>
              <div>
                {p.asset} position value change
                <small>
                  {p.sharesChanged === null
                    ? "Position missing from one observation · amounts cannot be compared"
                    : p.sharesChanged
                      ? "jToken amount changed · distinguish deposits, withdrawals, and transfers"
                      : "Same jToken amount in both observations · intervening activity unknown"}
                </small>
              </div>
              <strong>
                {show(p.underlyingDelta)} {p.asset}
              </strong>
            </div>
          ))
        ) : (
          <p className="small muted">
            {movement?.reason ??
              "Two valid observations of the same wallet are required."}
          </p>
        )}
        {movement?.warnings.map((warning, index) => (
          <p className="small muted" key={index}>
            {warning}
          </p>
        ))}
        <button
          className="text-button"
          disabled={!journal.wallets.length}
          onClick={() =>
            exportJson(
              {
                version: 1,
                kind: "incomplete-wallet-observations",
                wallets: journal.wallets,
              },
              "treasury-observations.json",
            )
          }
        >
          <Download size={14} /> Export observations
        </button>
        <p className="small muted">
          Exports include wallet addresses and balances.
        </p>
      </div>
    </section>
  );
}
