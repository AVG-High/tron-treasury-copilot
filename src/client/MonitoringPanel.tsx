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
    ? "확인 불가"
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
        if (!current) throw new Error("관측이 중지되었습니다.");
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
          throw new Error("조회한 지갑이 관측 대상과 다릅니다.");
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
            error: e instanceof Error ? e.message : "관측 기록 저장 실패",
          }));
        }
      }
    };
    const onError = (e: unknown, failures = 1) => {
      if (!current) return;
      setError(
        `${e instanceof Error ? e.message : "관측 실패"}${enabled ? ` (${failures}/3회)` : ""}`,
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
    <section className="card monitoring-panel" aria-label="실시간 계획 관측">
      <div className="section-heading">
        <h2>
          <Activity size={18} /> 계획 변화 관측
        </h2>
        <span className="tag">
          {paused
            ? "거래 작업 중 일시 정지"
            : enabled
              ? "자동 조회 중"
              : "자동 조회 꺼짐"}
        </span>
      </div>
      <p className="small muted">
        실시간 금리·회수 유동성·예약금을 원래 계획과 비교합니다. 이 브라우저가
        보이는 동안만 조회하며, 새로고침 후에는 꺼집니다. 자금 이동 없이 검토할
        조건을 제안합니다.
      </p>
      {owner && <p className="wallet-address">관측 지갑 {owner}</p>}
      {!owner && (
        <p className="small muted">
          현재는 상품 조건만 관측합니다. 지갑 연결 후에는 예약금과 포지션도
          확인할 수 있습니다.
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
          자동 조회
        </label>
        <label>
          주기{" "}
          <select
            aria-label="자동 조회 주기"
            value={intervalMs}
            disabled={paused}
            onChange={(e) => setIntervalMs(Number(e.target.value))}
          >
            <option value={60_000}>1분</option>
            <option value={300_000}>5분</option>
            <option value={900_000}>15분</option>
          </select>
        </label>
        <button
          className="secondary"
          disabled={paused || querying}
          onClick={() => setRequestId((n) => n + 1)}
        >
          <RefreshCw size={14} />
          지금 관측
        </button>
      </div>
      <p className="small muted">
        연속 실패 시 간격을 늘리고 3회 실패하면 멈춥니다. 현재 조회 상태:{" "}
        {querying ? "조회 중" : "대기"}.
      </p>
      {error && (
        <p className="inline-warning" role="status">
          {error} 이전 성공 결과를 최신 값으로 사용하지 마세요.
        </p>
      )}
      {stale && (
        <p className="inline-warning">
          마지막 관측 이후 5분이 지났습니다. 재검토하려면 새로 조회해 주세요.
        </p>
      )}
      {report && (
        <>
          <p className="small muted">
            최근 관측 {new Date(report.checkedAt).toLocaleString("ko-KR")} ·
            계획 경과 {report.elapsedDays ?? "확인 불가"}일 / 잔여{" "}
            {report.remainingDays ?? "확인 불가"}일
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
              예약금·비용 필요액 {show(report.reserve.requiredUSDT, 2)} USDT ·
              지갑 {show(report.reserve.walletUSDT, 2)} USDT · 부족액{" "}
              {show(report.reserve.shortfallUSDT, 2)} USDT
            </p>
          )}
          {report.rateComparisons.length > 0 && (
            <div className="table-scroll">
              <table aria-label="동일 원금과 기간의 기본 이자 비교">
                <thead>
                  <tr>
                    <th>전략</th>
                    <th>계획 당시 기본 이자</th>
                    <th>현재 금리 가정</th>
                    <th>예상 차이</th>
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
                          동일 원금 {show(rate.principalUSDT, 2)} /{" "}
                          {rate.originalHorizonDays}일
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
            금리 비교는 같은 원금·원래 전체 기간에 대한 가정입니다. 이미 발생한
            이자·순수익이 아니며, 인센티브·거래 비용은 이 표에서 제외합니다.
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
            남은 기간 조건 검토
          </button>
          <p className="small muted">
            원래 계획 자금을 기준으로 입력을 열어 줍니다. 실제 가용 자금·지급
            완료 지출을 직접 수정하고 다시 계산해야 합니다. 만기가 지난 지출도
            자동으로 사용 완료 처리하지 않습니다.
          </p>
        </>
      )}
      <div className="monitor-ledger">
        <h3>포지션 관측 기록</h3>
        <p className="small muted">
          최근 96회 관측을 이 브라우저에 저장합니다. 외부 앱 입출금과 토큰 이전
          내역 전체를 수집한 원장이 아니므로 실제 순수익은 계산하지 않습니다.
        </p>
        <p className="small">
          실제 순수익: 산출 불가 · 외부 입출금·비용 전체 확인 필요
        </p>
        {journal.error && <p className="inline-warning">{journal.error}</p>}
        {movement?.status === "comparable" ? (
          movement.positions.map((p) => (
            <div className="position-row" key={p.marketId}>
              <div>
                {p.asset} 포지션 평가액 변화
                <small>
                  {p.sharesChanged === null
                    ? "한 관측에 없는 포지션 · 수량 비교 불가"
                    : p.sharesChanged
                      ? "jToken 수량 변화 있음 · 입출금/이전 구분 필요"
                      : "두 관측의 jToken 수량 동일 · 중간 거래는 미확인"}
                </small>
              </div>
              <strong>
                {show(p.underlyingDelta)} {p.asset}
              </strong>
            </div>
          ))
        ) : (
          <p className="small muted">
            {movement?.reason ?? "같은 지갑의 유효한 관측이 두 번 필요합니다."}
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
          <Download size={14} /> 관측 기록 내보내기
        </button>
        <p className="small muted">
          내보낸 파일에는 지갑 주소와 잔고가 포함됩니다.
        </p>
      </div>
    </section>
  );
}
