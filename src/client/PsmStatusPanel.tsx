import { useEffect, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import type { PsmStatus } from "../chain/psm-status";
import { api } from "./api";

export function PsmStatusPanel() {
  const [status, setStatus] = useState<PsmStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);
  const displayToggle = (value: boolean | null) =>
    value === null
      ? "Unavailable"
      : value
        ? "Contract enabled"
        : "Contract paused";
  async function refresh() {
    if (busy) return;
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    setError("");
    setStatus(null);
    try {
      const data = await api<PsmStatus>(
        "/psm-status",
        undefined,
        controller.signal,
      );
      if (!controller.signal.aborted) setStatus(data);
    } catch (e) {
      if (!controller.signal.aborted)
        setError(
          e instanceof Error ? e.message : "Conversion status request failed",
        );
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  return (
    <section
      className="psm-status"
      aria-label="USDD on-chain conversion status"
    >
      <div className="section-heading">
        <h3>USDD on-chain conversion status</h3>
        <button className="secondary" disabled={busy} onClick={refresh}>
          <RefreshCw size={14} />
          {busy ? "Reading contracts…" : "Check USDD conversion status"}
        </button>
      </div>
      <p className="small muted">
        Reads token, Join, and PSM relationships, both direction flags, and fees
        from the official TRON RPC. Current capacity and the complete route need
        separate verification. This panel does not execute transactions.
      </p>
      {error && (
        <p className="inline-warning" role="status">
          {error}
        </p>
      )}
      {status && (
        <>
          <p className="small muted">
            Checked {new Date(status.fetchedAt).toLocaleString("en-US")} ·{" "}
            {status.quality === "verified"
              ? "Read fields verified"
              : "Read fields unavailable"}
          </p>
          <div className="psm-grid">
            <div>
              <small>USDT → USDD</small>
              <strong>{displayToggle(status.sellEnabled)}</strong>
              <small>
                Conversion fee{" "}
                {status.toUSDDFeePct === null
                  ? "Unavailable"
                  : `${status.toUSDDFeePct}%`}
              </small>
            </div>
            <div>
              <small>USDD → USDT</small>
              <strong>{displayToggle(status.buyEnabled)}</strong>
              <small>
                Conversion fee{" "}
                {status.fromUSDDFeePct === null
                  ? "Unavailable"
                  : `${status.fromUSDDFeePct}%`}
              </small>
            </div>
          </div>
          <p className="inline-warning">
            Current conversion capacity: not calculated · USDD execution: not
            supported
          </p>
          <details>
            <summary className="small">Full addresses checked</summary>
            <p className="wallet-address">USDD {status.usddAddress}</p>
            <p className="wallet-address">PSM {status.psmAddress}</p>
            <p className="wallet-address">USDT Join {status.joinAddress}</p>
          </details>
          {status.warnings.map((w, i) => (
            <p className="small muted" key={i}>
              {w}
            </p>
          ))}
          {status.evidence.map((e, i) => (
            <p className="small muted" key={i}>
              <a href={e.url} target="_blank" rel="noreferrer">
                {e.label} ↗
              </a>
            </p>
          ))}
        </>
      )}
    </section>
  );
}
