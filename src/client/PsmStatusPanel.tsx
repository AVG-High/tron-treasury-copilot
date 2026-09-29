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
    value === null ? "확인 불가" : value ? "컨트랙트 활성" : "컨트랙트 중지";
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
        setError(e instanceof Error ? e.message : "전환 상태 조회 실패");
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  return (
    <section className="psm-status" aria-label="USDD 온체인 전환 관측">
      <div className="section-heading">
        <h3>USDD 온체인 전환 관측</h3>
        <button className="secondary" disabled={busy} onClick={refresh}>
          <RefreshCw size={14} />
          {busy ? "컨트랙트 조회 중…" : "USDD 전환 상태 조회"}
        </button>
      </div>
      <p className="small muted">
        공식 TRON RPC에서 토큰·Join·PSM 관계, 양방향 토글과 수수료를 확인합니다.
        현재 교환 가능액과 전체 거래 경로는 별도 검증이 필요하며 이 화면은
        거래를 실행하지 않습니다.
      </p>
      {error && (
        <p className="inline-warning" role="status">
          {error}
        </p>
      )}
      {status && (
        <>
          <p className="small muted">
            조회 {new Date(status.fetchedAt).toLocaleString("ko-KR")} ·{" "}
            {status.quality === "verified"
              ? "조회 항목 확인됨"
              : "조회 항목 확인 불가"}
          </p>
          <div className="psm-grid">
            <div>
              <small>USDT → USDD</small>
              <strong>{displayToggle(status.sellEnabled)}</strong>
              <small>
                전환 수수료{" "}
                {status.toUSDDFeePct === null
                  ? "확인 불가"
                  : `${status.toUSDDFeePct}%`}
              </small>
            </div>
            <div>
              <small>USDD → USDT</small>
              <strong>{displayToggle(status.buyEnabled)}</strong>
              <small>
                전환 수수료{" "}
                {status.fromUSDDFeePct === null
                  ? "확인 불가"
                  : `${status.fromUSDDFeePct}%`}
              </small>
            </div>
          </div>
          <p className="inline-warning">
            현재 교환 가능액: 산출 미지원 · 앱의 USDD 전환 실행: 미지원
          </p>
          <details>
            <summary className="small">검증 대상 전체 주소</summary>
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
