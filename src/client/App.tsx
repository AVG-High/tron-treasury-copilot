import { useEffect, useRef, useState } from "react";
import {
  ArrowDownLeft,
  ArrowRight,
  ArrowUpRight,
  BarChart3,
  Check,
  CheckCircle2,
  ChevronRight,
  CircleHelp,
  Clock3,
  Download,
  ExternalLink,
  FlaskConical,
  Layers3,
  Loader2,
  LockKeyhole,
  Plus,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Trash2,
  Wallet,
  X,
} from "lucide-react";
import Decimal from "decimal.js";
import { defaultIntent, defaultCosts } from "../domain/fixtures";
import type {
  Allocation,
  CostAssumptions,
  DataMode,
  MarketSnapshot,
  ParseResult,
  Plan,
  PlanningResult,
  TransactionAction,
  TransactionPreview,
  TransactionRecord,
  TreasuryIntent,
  WalletState,
} from "../domain/types";
import { api } from "./api";
import { ReviewSimulation } from "./ReviewSimulation";
import { MonitoringPanel } from "./MonitoringPanel";
import { restorePlanConditions } from "./restore-plan";
import { assertWallet, connectWallet, signAndBroadcast } from "./wallet";
import { exportJson, readHistory, toSavedPlan, writeHistory } from "./history";

const money = (value: string | number | undefined, digits = 2) =>
  Number(value ?? 0).toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
const pct = (value: string | null) =>
  value === null ? "확인 불가" : `${money(Number(value) * 100)}%`;
const labels: Record<string, string> = {
  wallet: "USDT 지갑 보유",
  "justlend-usdt": "JustLend · USDT",
  "justlend-usdd": "USDD 전환 + JustLend",
};
const sample =
  "10,000 USDT가 있어요. 7일 뒤 3,000 USDT, 30일 뒤 1,000 USDT가 필요하고 비상금은 500 USDT 남겨주세요. 남은 돈은 30일간 운용하고, USDD는 전체 자금의 20% 이내로 제한해주세요. 레버리지는 쓰지 않을게요.";
type Tab = "plan" | "markets" | "review";

export default function App() {
  const [tab, setTab] = useState<Tab>("plan");
  const [mode, setMode] = useState<DataMode>("demo");
  const [intent, setIntent] = useState<TreasuryIntent>(
    structuredClone(defaultIntent),
  );
  const [costs, setCosts] = useState<CostAssumptions>({ ...defaultCosts });
  const [text, setText] = useState(sample);
  const [parse, setParse] = useState<ParseResult | null>(null);
  const [snapshot, setSnapshot] = useState<MarketSnapshot | null>(null);
  const [result, setResult] = useState<PlanningResult | null>(null);
  const [selected, setSelected] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [aiReady, setAiReady] = useState(false);
  const [wallet, setWallet] = useState<WalletState | null>(null);
  const [history, setHistory] = useState(readHistory);
  const [preview, setPreview] = useState<TransactionPreview | null>(null);
  const [previewConsent, setPreviewConsent] = useState(false);
  const [txAmount, setTxAmount] = useState("");
  const [stressNote, setStressNote] = useState("");
  const epoch = useRef(0);
  const inputRevision = useRef(0);
  const previewRevision = useRef(-1);
  const previewPlanId = useRef<string | undefined>(undefined);
  const pendingRef = useRef(false);
  const plan = result?.plans.find((p) => p.id === selected) ?? result?.plans[0];
  const allocationRows: Allocation[] = plan
    ? plan.allocations.some((a) => a.strategy === "wallet")
      ? plan.allocations
      : [
          {
            strategy: "wallet",
            amountUSDT: new Decimal(plan.reserveUSDT)
              .plus(plan.freeCashUSDT)
              .toFixed(6),
            grossYieldUSDT: "0",
            incentiveYieldUSDT: "0",
            costUSDT: "0",
            netYieldUSDT: "0",
            reasons: [],
          },
          ...plan.allocations,
        ]
    : [];
  const intentDirty = () => {
    inputRevision.current++;
    setConfirmed(false);
    setPreview(null);
    setStressNote("");
  };
  const edit = (patch: Partial<TreasuryIntent>) => {
    setIntent((i) => ({ ...i, ...patch }));
    intentDirty();
  };

  useEffect(() => {
    api<{ aiConfigured: boolean }>("/health")
      .then((h) => setAiReady(h.aiConfigured))
      .catch(() => {});
  }, []);
  useEffect(() => {
    const n = ++epoch.current;
    inputRevision.current++;
    setSnapshot(null);
    setResult(null);
    setConfirmed(false);
    setPreview(null);
    setStressNote("");
    setError("");
    api<MarketSnapshot>(`/markets?mode=${mode}`)
      .then((s) => {
        if (n === epoch.current) setSnapshot(s);
      })
      .catch((e) => {
        if (n === epoch.current) setError(e.message);
      });
  }, [mode]);
  useEffect(() => {
    if (history.error) return;
    try {
      writeHistory(history.plans, history.transactions);
    } catch {
      setHistory((h) => ({
        ...h,
        error:
          "브라우저 저장 공간을 사용할 수 없습니다. 현재 기록은 JSON으로 내보낼 수 있습니다.",
      }));
    }
  }, [history]);
  async function run(label: string, fn: () => Promise<void>) {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setBusy(label);
    setError("");
    setNotice("");
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : "요청에 실패했습니다.");
    } finally {
      pendingRef.current = false;
      setBusy("");
    }
  }
  async function calculate(input = intent, stress = "") {
    const revision = inputRevision.current;
    const output = await api<PlanningResult>("/plan", {
      intent: input,
      costs,
      mode,
    });
    if (revision !== inputRevision.current) {
      setNotice(
        "계산 중 조건이 바뀌었습니다. 변경한 조건을 다시 확인해 주세요.",
      );
      return;
    }
    setResult(output);
    setSnapshot(output.snapshot);
    setSelected(
      output.plans.find((p) => p.id === "yield")?.id ??
        output.plans[0]?.id ??
        "",
    );
    setConfirmed(true);
    setStressNote(stress);
    setPreview(null);
  }
  async function parseIntent() {
    await run("조건 해석", async () => {
      const revision = inputRevision.current;
      const value = await api<ParseResult>("/intent", { text });
      if (revision !== inputRevision.current)
        throw new Error(
          "해석 중 입력이 바뀌었습니다. 새 입력으로 다시 해석해 주세요.",
        );
      setParse(value);
      if (value.source === "ai") {
        setIntent((i) => ({ ...i, ...value.intent }));
        intentDirty();
      } else setNotice(value.message);
    });
  }
  async function connect() {
    await run("지갑 연결", async () => {
      const address = await connectWallet();
      setWallet(await api<WalletState>(`/wallet/${address}`));
      setPreview(null);
    });
  }
  async function refreshWallet() {
    if (!wallet) return;
    await assertWallet(wallet.address);
    setWallet(await api<WalletState>(`/wallet/${wallet.address}`));
  }
  function savePlan() {
    if (!result || !plan || !confirmed || history.error) return;
    const saved = toSavedPlan(result, plan);
    setHistory((h) => ({ ...h, plans: [saved, ...h.plans] }));
    setNotice("현재 계획과 계산 가정을 이 브라우저에 저장했습니다.");
  }
  async function prepare(action: TransactionAction, resetAllowance = false) {
    await run("거래 준비", async () => {
      const revision = inputRevision.current;
      if (mode !== "live" || !wallet)
        throw new Error("실시간 모드에서 지갑을 먼저 연결해 주세요.");
      await assertWallet(wallet.address);
      const amount = resetAllowance
        ? "0"
        : action === "withdraw-usdt"
          ? txAmount
          : plan?.allocations.find((a) => a.strategy === "justlend-usdt")
              ?.amountUSDT;
      if (!amount || (!resetAllowance && new Decimal(amount).lte(0)))
        throw new Error("거래할 USDT 금액을 확인해 주세요.");
      if (
        action !== "withdraw-usdt" &&
        !resetAllowance &&
        (!confirmed || !result || stressNote)
      )
        throw new Error("최신 조건을 확인하고 기본 계획을 다시 계산해 주세요.");
      const current = await api<WalletState>(`/wallet/${wallet.address}`);
      setWallet(current);
      if (
        action === "supply-usdt" &&
        result &&
        new Decimal(current.usdt).minus(amount).lt(result.reserveUSDT)
      )
        throw new Error(
          "이 거래를 실행하면 지갑의 예정 지출·비상금이 부족합니다. 자금 계획을 수정해 주세요.",
        );
      const value = await api<TransactionPreview>("/transactions/prepare", {
        action,
        owner: wallet.address,
        amount,
        planning:
          result && !resetAllowance
            ? {
                mode: "live",
                intent: result.intent,
                costs: result.costs,
                planId: plan?.id,
              }
            : undefined,
      });
      if (revision !== inputRevision.current)
        throw new Error(
          "거래 준비 중 조건이나 배분안이 바뀌었습니다. 다시 준비해 주세요.",
        );
      previewRevision.current = revision;
      previewPlanId.current = undefined;
      if (result && plan && !resetAllowance && action !== "withdraw-usdt") {
        const saved = toSavedPlan(result, plan);
        const latest = readHistory();
        if (latest.error) throw new Error(latest.error);
        writeHistory([saved, ...latest.plans], latest.transactions);
        setHistory({ ...latest, plans: [saved, ...latest.plans] });
        previewPlanId.current = saved.id;
      }
      setPreview(value);
      setPreviewConsent(false);
    });
  }
  async function execute() {
    if (!preview || !previewConsent) return;
    await run("지갑 서명", async () => {
      if (mode !== "live" || previewRevision.current !== inputRevision.current)
        throw new Error(
          "거래 준비 이후 조건이 바뀌었습니다. 다시 준비해 주세요.",
        );
      if (preview.action === "supply-usdt" && result) {
        const fresh = await api<WalletState>(`/wallet/${preview.owner}`);
        if (
          new Decimal(fresh.usdt).lt(result.intent.capitalUSDT) ||
          new Decimal(fresh.usdt)
            .minus(preview.amount)
            .lt(new Decimal(result.reserveUSDT).plus(plan?.costUSDT ?? "0"))
        )
          throw new Error(
            "지갑 잔고가 변경되어 예약 자금을 지킬 수 없습니다. 거래를 다시 준비해 주세요.",
          );
      }
      if (previewRevision.current !== inputRevision.current)
        throw new Error("검증 중 조건이 바뀌었습니다. 다시 준비해 주세요.");
      let signedId = "";
      try {
        await signAndBroadcast(preview, (txid) => {
          signedId = txid;
          const record: TransactionRecord = {
            id: crypto.randomUUID(),
            txid,
            action: preview.action,
            amount: preview.amount,
            owner: preview.owner,
            submittedAt: new Date().toISOString(),
            status: "pending",
            planId: previewPlanId.current,
          };
          setHistory((h) => ({
            ...h,
            transactions: [record, ...h.transactions],
          }));
          const latest = readHistory();
          if (latest.error)
            throw new Error("거래 기록을 보존할 수 없어 전송하지 않았습니다.");
          try {
            writeHistory(latest.plans, [record, ...latest.transactions]);
          } catch {
            throw new Error("거래 기록을 저장하지 못해 전송하지 않았습니다.");
          }
        });
        setNotice("거래를 제출했습니다. 기록에서 상태를 확인해 주세요.");
        setPreview(null);
        setTab("review");
      } catch (e) {
        if (signedId) {
          setHistory((h) => ({
            ...h,
            transactions: h.transactions.map((t) =>
              t.txid === signedId ? { ...t, status: "unknown" } : t,
            ),
          }));
          setPreview(null);
          setTab("review");
        }
        throw e;
      }
    });
  }
  async function refreshTransaction(record: TransactionRecord) {
    await run("거래 확인", async () => {
      const status = await api<{
        status: TransactionRecord["status"];
        actualFeeTRX?: string;
        error?: string;
      }>(`/transactions/${record.txid}`);
      setHistory((h) => ({
        ...h,
        transactions: h.transactions.map((t) =>
          t.txid === record.txid ? { ...t, ...status } : t,
        ),
      }));
      if (status.status === "confirmed" && wallet) await refreshWallet();
    });
  }
  const totalReserved =
    result && confirmed
      ? result.reserveUSDT
      : intent.expenses.reduce(
          (a, e) => a + (Number(e.amountUSDT) || 0),
          Number(intent.emergencyUSDT) || 0,
        );
  const available = Math.max(
    0,
    Number(intent.capitalUSDT) - Number(totalReserved),
  );

  return (
    <div className="app-shell">
      <aside className="sidebar" inert={!!preview}>
        <a
          href="#"
          className="brand"
          onClick={() => setTab("plan")}
          aria-label="Treasury 홈"
        >
          <span className="brand-mark">
            <Layers3 size={23} />
          </span>
          <span>
            TREASURY<span className="brand-sub">TRON COPILOT</span>
          </span>
        </a>
        <div className="workspace">
          <span className="workspace-dot" />
          Personal workspace<span className="tag">BETA</span>
        </div>
        <div className="nav-label">WORKSPACE</div>
        <nav>
          {(
            [
              { id: "plan", label: "자금 계획", icon: Layers3 },
              { id: "markets", label: "상품·데이터", icon: BarChart3 },
              { id: "review", label: "포지션·회고", icon: Clock3 },
            ] as const
          ).map((n) => (
            <button
              key={n.id}
              className={`nav-item ${tab === n.id ? "active" : ""}`}
              onClick={() => setTab(n.id)}
            >
              <n.icon size={18} />
              {n.label}
              {tab === n.id && <ChevronRight size={15} />}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="mini-orbit">
            <ShieldCheck size={24} />
          </div>
          <strong>
            내 돈의 다음 일정을
            <br />
            먼저 생각합니다.
          </strong>
          <p>
            필요한 돈은 확보하고,
            <br />
            남는 자금으로 계획하세요.
          </p>
          <a
            href="https://drive.google.com/file/d/1HXLhu1_vCoMD5aN3APEYEjDrh9oVCj7g/view"
            target="_blank"
            rel="noreferrer"
          >
            GWDC · TRON Challenge B <ExternalLink size={12} />
          </a>
        </div>
      </aside>
      <div className="main-shell" inert={!!preview}>
        <header className="topbar">
          <div className="breadcrumb">
            Workspace <ChevronRight size={13} />{" "}
            <strong>
              {tab === "plan"
                ? "자금 계획"
                : tab === "markets"
                  ? "상품·데이터"
                  : "포지션·회고"}
            </strong>
          </div>
          <div className="header-actions">
            <span className="chain-badge">
              <span />
              TRON Mainnet
            </span>
            <button
              className="wallet-button"
              disabled={!!busy}
              onClick={connect}
            >
              <Wallet size={16} />
              {wallet
                ? `${wallet.address.slice(0, 6)}…${wallet.address.slice(-4)}`
                : "지갑 연결"}
            </button>
          </div>
        </header>
        <main>
          <div className="page-title">
            <div>
              <div className="eyebrow">YOUR CAPITAL, WITH A PLAN</div>
              <h1>
                {tab === "plan"
                  ? "돈이 필요할 때, 준비된 자금."
                  : tab === "markets"
                    ? "수익률 뒤의 조건까지."
                    : "계획부터 결과까지."}
              </h1>
              <p>
                {tab === "plan"
                  ? "지출 일정과 회수 비용을 반영해, 남는 자금의 운용안을 비교하세요."
                  : tab === "markets"
                    ? "데이터의 출처와 시각, 실제 회수 조건을 함께 확인하세요."
                    : "원래의 가정을 기록하고, 실제 포지션과 거래 결과를 확인하세요."}
              </p>
            </div>
            <div className="mode-switch" aria-label="데이터 모드">
              <button
                className={mode === "demo" ? "selected" : ""}
                onClick={() => setMode("demo")}
                disabled={!!busy}
              >
                <FlaskConical size={14} />
                데모
              </button>
              <button
                className={mode === "live" ? "selected" : ""}
                onClick={() => setMode("live")}
                disabled={!!busy}
              >
                <span className="live-dot" />
                실시간
              </button>
            </div>
          </div>
          <div className={`mode-banner ${mode}`}>
            <span>
              {mode === "demo" ? (
                <FlaskConical size={16} />
              ) : (
                <ShieldCheck size={16} />
              )}
              <strong>
                {mode === "demo" ? "체험 데이터" : "실시간 데이터 모드"}
              </strong>
              {mode === "demo"
                ? "예시 수익률·유동성으로 계산하며 거래는 실행되지 않습니다."
                : "확인되지 않은 상품은 배분에서 제외합니다. 수익률은 변동됩니다."}
            </span>
            {snapshot && (
              <small>
                {new Date(snapshot.fetchedAt).toLocaleTimeString("ko-KR")} 기준
              </small>
            )}
          </div>
          {error && (
            <div className="message error" role="alert">
              {error}
              <button aria-label="오류 닫기" onClick={() => setError("")}>
                <X size={16} />
              </button>
            </div>
          )}
          {notice && (
            <div className="message success" role="status">
              {notice}
              <button aria-label="알림 닫기" onClick={() => setNotice("")}>
                <X size={16} />
              </button>
            </div>
          )}
          {history.error && (
            <div className="message error">{history.error}</div>
          )}

          {tab === "plan" && (
            <>
              <section className="summary-grid" aria-label="자금 요약">
                <Metric
                  label="총 계획 자금"
                  value={money(intent.capitalUSDT, 0)}
                  sub="USDT 기준 · 지갑 잔고와 별도"
                  icon={<Wallet size={17} />}
                />
                <Metric
                  label="지출·비상금 예약"
                  value={money(totalReserved, 0)}
                  sub="투자하지 않고 확보할 금액"
                  icon={<LockKeyhole size={17} />}
                />
                <Metric
                  label="운용 검토 가능"
                  value={money(available, 0)}
                  sub="실행·회수 비용 차감 전"
                  icon={<ArrowUpRight size={18} />}
                  accent
                />
              </section>
              <div className="planning-grid">
                <div className="input-column">
                  <section className="card intent-card">
                    <div className="section-heading">
                      <div className="step-label">
                        01 <span>운용 조건</span>
                      </div>
                      <span className={`small-status ${aiReady ? "good" : ""}`}>
                        <span />
                        {aiReady ? "AI 설정됨" : "수동 입력 가능"}
                      </span>
                    </div>
                    <h2>어떻게 사용할 돈인가요?</h2>
                    <p className="muted">
                      금액, 지출 일정, 남는 돈의 운용 기간을 알려주세요.
                    </p>
                    <label className="sr-only" htmlFor="intent-text">
                      자연어 운용 조건
                    </label>
                    <textarea
                      id="intent-text"
                      value={text}
                      onChange={(e) => {
                        setText(e.target.value);
                        inputRevision.current++;
                      }}
                      maxLength={4000}
                    />
                    <div className="prompt-footer">
                      <small>입력 내용은 AI 해석 요청 시 처리됩니다.</small>
                      <button
                        className="text-button"
                        onClick={parseIntent}
                        disabled={!!busy}
                      >
                        <Sparkles size={15} />
                        {busy === "조건 해석" ? "해석 중…" : "조건 해석"}
                      </button>
                    </div>
                    {parse && (
                      <div className="parse-note">
                        <strong>
                          {parse.source === "ai"
                            ? "아래 해석 결과를 확인해 주세요."
                            : "AI 미연결 · 직접 입력"}
                        </strong>
                        <p>{parse.message}</p>
                        {parse.questions.map((q, i) => (
                          <p key={i}>• {q}</p>
                        ))}
                      </div>
                    )}
                    <div className="form-grid">
                      <Field label="총 계획 자금" suffix="USDT">
                        <input
                          aria-label="총 계획 자금"
                          inputMode="decimal"
                          value={intent.capitalUSDT}
                          onChange={(e) =>
                            edit({ capitalUSDT: e.target.value })
                          }
                        />
                      </Field>
                      <Field label="남는 돈 운용 기간" suffix="일">
                        <input
                          aria-label="남는 돈 운용 기간"
                          type="number"
                          min="1"
                          max="3650"
                          value={intent.horizonDays}
                          onChange={(e) =>
                            edit({ horizonDays: Number(e.target.value) })
                          }
                        />
                      </Field>
                      <Field label="비상금" suffix="USDT">
                        <input
                          aria-label="비상금"
                          inputMode="decimal"
                          value={intent.emergencyUSDT}
                          onChange={(e) =>
                            edit({ emergencyUSDT: e.target.value })
                          }
                        />
                      </Field>
                      <Field label="USDD 노출 상한" suffix="%">
                        <input
                          aria-label="USDD 노출 상한"
                          type="number"
                          min="0"
                          max="100"
                          value={intent.maxUSDDExposurePct}
                          onChange={(e) =>
                            edit({ maxUSDDExposurePct: Number(e.target.value) })
                          }
                        />
                      </Field>
                    </div>
                    <div className="expense-header">
                      <strong>예정 지출</strong>
                      <button
                        className="text-button"
                        onClick={() =>
                          edit({
                            expenses: [
                              ...intent.expenses,
                              {
                                id: crypto.randomUUID(),
                                label: "새 지출",
                                amountUSDT: "0",
                                dueInDays: 7,
                              },
                            ],
                          })
                        }
                      >
                        <Plus size={14} />
                        추가
                      </button>
                    </div>
                    <div className="expense-list">
                      {intent.expenses.map((expense, index) => (
                        <div className="expense-row" key={expense.id}>
                          <div className="timeline-dot" />
                          <div className="expense-fields">
                            <input
                              aria-label={`지출 ${index + 1} 이름`}
                              value={expense.label}
                              maxLength={80}
                              onChange={(e) =>
                                edit({
                                  expenses: intent.expenses.map((x) =>
                                    x.id === expense.id
                                      ? { ...x, label: e.target.value }
                                      : x,
                                  ),
                                })
                              }
                            />
                            <div className="expense-meta">
                              <input
                                aria-label={`지출 ${index + 1} 일수`}
                                type="number"
                                min="0"
                                value={expense.dueInDays}
                                onChange={(e) =>
                                  edit({
                                    expenses: intent.expenses.map((x) =>
                                      x.id === expense.id
                                        ? {
                                            ...x,
                                            dueInDays: Number(e.target.value),
                                          }
                                        : x,
                                    ),
                                  })
                                }
                              />
                              <span>일 뒤</span>
                            </div>
                          </div>
                          <div className="expense-amount">
                            <input
                              aria-label={`지출 ${index + 1} 금액`}
                              value={expense.amountUSDT}
                              inputMode="decimal"
                              onChange={(e) =>
                                edit({
                                  expenses: intent.expenses.map((x) =>
                                    x.id === expense.id
                                      ? { ...x, amountUSDT: e.target.value }
                                      : x,
                                  ),
                                })
                              }
                            />
                            <small>USDT</small>
                          </div>
                          <button
                            className="icon-button"
                            aria-label={`지출 ${index + 1} 삭제`}
                            onClick={() =>
                              edit({
                                expenses: intent.expenses.filter(
                                  (x) => x.id !== expense.id,
                                ),
                              })
                            }
                          >
                            <Trash2 size={14} />
                          </button>
                        </div>
                      ))}
                    </div>
                    <details className="advanced">
                      <summary>
                        비용 가정·배분 제한 <CircleHelp size={13} />
                      </summary>
                      <div className="form-grid">
                        <Field label="USDT 왕복 비용 가정" suffix="USDT">
                          <input
                            aria-label="USDT 왕복 비용 가정"
                            value={costs.justlendUsdtRoundTripUSDT}
                            onChange={(e) => {
                              setCosts((c) => ({
                                ...c,
                                justlendUsdtRoundTripUSDT: e.target.value,
                              }));
                              intentDirty();
                            }}
                          />
                        </Field>
                        <Field label="USDD 경로 비용 가정" suffix="USDT">
                          <input
                            aria-label="USDD 경로 비용 가정"
                            value={costs.justlendUsddRoundTripUSDT}
                            onChange={(e) => {
                              setCosts((c) => ({
                                ...c,
                                justlendUsddRoundTripUSDT: e.target.value,
                              }));
                              intentDirty();
                            }}
                          />
                        </Field>
                        <Field label="JustLend 합산 상한" suffix="%">
                          <input
                            aria-label="JustLend 합산 상한"
                            type="number"
                            value={intent.maxProtocolExposurePct}
                            onChange={(e) =>
                              edit({
                                maxProtocolExposurePct: Number(e.target.value),
                              })
                            }
                          />
                        </Field>
                      </div>
                      <label className="check-row">
                        <input
                          type="checkbox"
                          checked={costs.includeIncentives}
                          onChange={(e) => {
                            setCosts((c) => ({
                              ...c,
                              includeIncentives: e.target.checked,
                            }));
                            intentDirty();
                          }}
                        />
                        추정 인센티브 포함 (토큰 가격·지급 조건 변동)
                      </label>
                      <p className="small muted">
                        비용은 계획용 사용자 가정입니다. 실제 지갑 비용 견적과
                        다릅니다. 노출 상한은 총 계획 자금 대비 비율입니다.
                      </p>
                    </details>
                    <div className="policy-line">
                      <ShieldCheck size={14} />
                      레버리지 없음
                      <span />
                      TRX 가격 노출 없음
                    </div>
                    <button
                      className="primary full"
                      disabled={!!busy}
                      onClick={() => run("계획 계산", () => calculate())}
                    >
                      {busy === "계획 계산" ? (
                        <Loader2 className="spin" size={17} />
                      ) : (
                        <CheckCircle2 size={17} />
                      )}
                      조건 확인하고 비교
                      <ArrowRight size={16} />
                    </button>
                  </section>
                </div>
                <div className="results-column">
                  <section className="card results-card">
                    <div className="section-heading">
                      <div className="step-label">
                        02 <span>배분안 비교</span>
                      </div>
                      <span className="subtle-label">NET YIELD FIRST</span>
                    </div>
                    {!result ? (
                      <div className="empty-plan">
                        <div className="plan-illustration">
                          <div />
                          <div />
                          <div />
                          <ShieldCheck size={28} />
                        </div>
                        <h2>먼저 일정을 지키는 계획.</h2>
                        <p>
                          조건을 확인하면 지갑 보유와 운용안을
                          <br />
                          비용·유동성·순수익 기준으로 비교합니다.
                        </p>
                        <div className="empty-checks">
                          <span>
                            <Check size={14} />
                            지출액 우선 확보
                          </span>
                          <span>
                            <Check size={14} />
                            왕복 비용 반영
                          </span>
                          <span>
                            <Check size={14} />
                            제외 이유 공개
                          </span>
                        </div>
                      </div>
                    ) : (
                      <>
                        {!confirmed && (
                          <div className="inline-warning">
                            조건이 변경되었습니다. 다시 계산해 주세요.
                          </div>
                        )}
                        {stressNote && (
                          <div className="stress-result">
                            <FlaskConical size={17} />
                            <div>
                              <strong>가상 시나리오</strong>
                              <p>{stressNote}</p>
                            </div>
                            <button
                              onClick={() =>
                                run("계획 계산", () => calculate())
                              }
                              className="text-button"
                            >
                              원래 조건
                            </button>
                          </div>
                        )}
                        {!result.feasible && (
                          <div className="message error">
                            {result.errors.join(" ")}
                          </div>
                        )}
                        <div className="plan-options">
                          {result.plans.map((p, i) => (
                            <button
                              key={p.id}
                              className={`plan-option ${plan?.id === p.id ? "chosen" : ""}`}
                              onClick={() => {
                                inputRevision.current++;
                                setSelected(p.id);
                                setPreview(null);
                              }}
                            >
                              <div className="option-top">
                                <span className="radio-dot" />
                                <strong>{p.name}</strong>
                                {p.id === "yield" && (
                                  <span className="tag">순수익 우선</span>
                                )}
                              </div>
                              <div className="option-yield">
                                <span>
                                  {Number(p.netYieldUSDT) > 0 ? "+" : ""}
                                  {money(p.netYieldUSDT)} <small>USDT</small>
                                </span>
                                <small>
                                  {result.intent.horizonDays}일 순수익 추정
                                </small>
                              </div>
                              <p>{p.objective}</p>
                            </button>
                          ))}
                        </div>
                        {plan && (
                          <>
                            <div className="allocation-heading">
                              <h3>자금 배분</h3>
                              <span>
                                {result.intent.horizonDays}일 운용 · 금리 유지
                                가정
                              </span>
                            </div>
                            <div
                              className="allocation-bar"
                              aria-label="배분 비중"
                            >
                              {allocationRows
                                .filter((a) => Number(a.amountUSDT) > 0)
                                .map((a) => (
                                  <div
                                    key={a.strategy}
                                    className={a.strategy}
                                    style={{ flex: Number(a.amountUSDT) }}
                                    title={`${labels[a.strategy]} ${money(a.amountUSDT)} USDT`}
                                  />
                                ))}
                              {Number(plan.costUSDT) > 0 && (
                                <div
                                  className="cost-bar"
                                  style={{
                                    flex: Number(plan.costUSDT),
                                    minWidth: 3,
                                  }}
                                />
                              )}
                            </div>
                            <div className="allocation-list">
                              {allocationRows
                                .filter((a) => Number(a.amountUSDT) > 0)
                                .map((a) => (
                                  <div
                                    key={a.strategy}
                                    className="allocation-row"
                                  >
                                    <span
                                      className={`asset-dot ${a.strategy}`}
                                    />
                                    <div>
                                      <strong>{labels[a.strategy]}</strong>
                                      <small>
                                        {a.strategy === "wallet"
                                          ? `지출 예약 ${money(plan.reserveUSDT, 0)} + 추가 보유 ${money(plan.freeCashUSDT, 0)}`
                                          : `기본 이자 ${money(a.grossYieldUSDT)} · 인센티브 ${money(a.incentiveYieldUSDT)} USDT`}
                                      </small>
                                    </div>
                                    <strong className="numeric">
                                      {money(a.amountUSDT)}
                                      <small> USDT</small>
                                    </strong>
                                  </div>
                                ))}
                            </div>
                            <div className="yield-breakdown">
                              <div>
                                <span>기본 이자</span>
                                <strong>+{money(plan.grossYieldUSDT)}</strong>
                              </div>
                              <div>
                                <span>추정 인센티브</span>
                                <strong>
                                  +{money(plan.incentiveYieldUSDT)}
                                </strong>
                              </div>
                              <div>
                                <span>왕복 비용 가정</span>
                                <strong>−{money(plan.costUSDT)}</strong>
                              </div>
                              <div className="net">
                                <span>
                                  예상 순수익 <small>USDT</small>
                                </span>
                                <strong>
                                  {Number(plan.netYieldUSDT) > 0 ? "+" : ""}
                                  {money(plan.netYieldUSDT)}
                                </strong>
                              </div>
                            </div>
                            <div className="plan-footnotes">
                              <span>
                                <Clock3 size={14} />
                                손익분기{" "}
                                {plan.breakevenDays === null
                                  ? "해당 없음"
                                  : `${plan.breakevenDays}일`}
                              </span>
                              <span>
                                <LockKeyhole size={14} />
                                지출 예약액 투자 제외
                              </span>
                            </div>
                            <details className="reason-details">
                              <summary>
                                이 계획의 근거와 한계 <CircleHelp size={14} />
                              </summary>
                              {plan.allocations
                                .flatMap((a) => a.reasons)
                                .map((r, i) => (
                                  <p key={i}>• {r}</p>
                                ))}
                              {plan.warnings.map((w, i) => (
                                <p className="muted" key={`w${i}`}>
                                  • {w}
                                </p>
                              ))}
                              <p className="muted">
                                현재 금리와 입력한 비용의 시나리오 추정입니다.
                                미래 수익·회수 가능성을 보장하지 않습니다.
                              </p>
                            </details>
                            <div className="plan-actions">
                              <button
                                className="secondary"
                                disabled={!confirmed || !!history.error}
                                onClick={savePlan}
                              >
                                <CheckCircle2 size={15} />
                                계획 저장
                              </button>
                              <button
                                className="icon-button"
                                title="계산 근거 JSON 내보내기"
                                aria-label="계획 내보내기"
                                onClick={() =>
                                  exportJson(result, "treasury-plan.json")
                                }
                              >
                                <Download size={17} />
                              </button>
                            </div>
                          </>
                        )}
                      </>
                    )}
                  </section>
                  <section className="card stress-card">
                    <div className="section-heading">
                      <h3>
                        <FlaskConical size={17} />
                        상황이 바뀐다면?
                      </h3>
                      <span className="tag">SIMULATION</span>
                    </div>
                    <p className="muted">
                      기존 예약으로 충당되면 배분을 유지합니다.
                    </p>
                    <div className="stress-buttons">
                      <button
                        disabled={!result || !confirmed || !!busy}
                        onClick={() =>
                          run("시나리오 계산", () =>
                            calculate(
                              {
                                ...intent,
                                expenses: intent.expenses.map((e) => ({
                                  ...e,
                                  dueInDays: Math.min(e.dueInDays, 1),
                                })),
                              },
                              "기존 지출을 내일로 앞당겼습니다. 이미 예약한 돈으로 충당되면 투자 금액은 바뀌지 않습니다.",
                            ),
                          )
                        }
                      >
                        지출을 내일로
                        <ArrowRight size={14} />
                      </button>
                      <button
                        disabled={!result || !confirmed || !!busy}
                        onClick={() =>
                          run("시나리오 계산", () =>
                            calculate(
                              {
                                ...intent,
                                expenses: [
                                  ...intent.expenses,
                                  {
                                    id: "stress-extra",
                                    label: "가상 추가 지출",
                                    amountUSDT: "3000",
                                    dueInDays: 1,
                                  },
                                ],
                              },
                              "예정에 없던 3,000 USDT 지출을 추가했습니다. 기존 지출과 비상금을 함께 지킬 수 있는지 계산합니다.",
                            ),
                          )
                        }
                      >
                        추가 지출 +3,000
                        <ArrowRight size={14} />
                      </button>
                      <button
                        disabled={!result || !confirmed || !!busy}
                        onClick={() =>
                          run("시나리오 계산", () =>
                            calculate(
                              { ...intent, horizonDays: 7 },
                              "남는 돈의 운용 기간을 7일로 줄였습니다. 왕복 비용을 회수하지 못하는 전략은 제외합니다.",
                            ),
                          )
                        }
                      >
                        운용 기간 7일
                        <ArrowRight size={14} />
                      </button>
                    </div>
                  </section>
                  {result && result.exclusions.length > 0 && (
                    <section className="card exclusions">
                      <h3>검토했지만 제외한 후보</h3>
                      {result.exclusions.map((e, i) => (
                        <div key={i}>
                          <span className="excluded-icon">
                            <X size={13} />
                          </span>
                          <p>
                            <strong>{labels[e.strategy] ?? e.strategy}</strong>
                            <span>{e.reason}</span>
                          </p>
                        </div>
                      ))}
                    </section>
                  )}
                </div>
              </div>
              {result && plan && (
                <section className="card execution-card">
                  <div className="section-heading">
                    <div className="step-label">
                      03 <span>확인하고 실행</span>
                    </div>
                    <span className="tag">USER SIGNED</span>
                  </div>
                  <h2>선택한 계획에서 USDT 예치하기</h2>
                  <p className="muted">
                    JustLend USDT 예치·회수를 지원합니다. USDD 경로는 비교
                    전용입니다. 승인은 예치와 별도 거래이며 필요한 수량만
                    요청합니다.
                  </p>
                  {mode === "demo" ? (
                    <div className="inline-warning">
                      데모 모드에서는 거래를 준비하거나 서명할 수 없습니다.
                    </div>
                  ) : !wallet ? (
                    <button
                      className="secondary"
                      onClick={connect}
                      disabled={!!busy}
                    >
                      <Wallet size={16} />
                      TronLink 연결
                    </button>
                  ) : (
                    <div className="execution-actions">
                      <button
                        className="secondary"
                        disabled={
                          !!busy ||
                          !confirmed ||
                          !!stressNote ||
                          !!history.error
                        }
                        onClick={() => prepare("approve-usdt")}
                      >
                        1. USDT 승인 준비
                      </button>
                      <button
                        className="primary"
                        disabled={
                          !!busy ||
                          !confirmed ||
                          !!stressNote ||
                          !!history.error
                        }
                        onClick={() => prepare("supply-usdt")}
                      >
                        2. 예치 견적 확인
                        <ArrowRight size={15} />
                      </button>
                      <button
                        className="text-button"
                        disabled={!!busy || !!history.error}
                        onClick={() => prepare("approve-usdt", true)}
                      >
                        기존 USDT 승인 초기화
                      </button>
                      <small>
                        지갑 USDT {money(wallet.usdt)} · TRX {money(wallet.trx)}
                      </small>
                    </div>
                  )}
                </section>
              )}
            </>
          )}

          {tab === "markets" && (
            <section className="card markets-card">
              <div className="section-heading">
                <h2>연동 상품과 회수 조건</h2>
                <button
                  className="secondary"
                  disabled={!!busy}
                  onClick={() =>
                    run("데이터 새로고침", async () =>
                      setSnapshot(
                        await api<MarketSnapshot>(`/markets?mode=${mode}`),
                      ),
                    )
                  }
                >
                  <RefreshCw size={14} />
                  새로고침
                </button>
              </div>
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>상품</th>
                      <th>기본 APY</th>
                      <th>인센티브 APY</th>
                      <th>가용 유동성</th>
                      <th>상태</th>
                    </tr>
                  </thead>
                  <tbody>
                    {snapshot?.markets.map((m) => (
                      <tr key={m.id}>
                        <td>
                          <strong>{m.name}</strong>
                          <small>{m.asset} 공급</small>
                        </td>
                        <td>{pct(m.baseApy)}</td>
                        <td>{pct(m.rewardApy)}</td>
                        <td>
                          {m.cashUSDT === null
                            ? "확인 불가"
                            : `${money(m.cashUSDT, 0)} ${m.asset}`}
                        </td>
                        <td>
                          <span className={`status-badge ${m.quality}`}>
                            {m.quality === "demo"
                              ? "데모"
                              : m.quality === "verified"
                                ? "확인됨"
                                : m.quality === "stale"
                                  ? "갱신 필요"
                                  : "확인 불가"}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {!snapshot && (
                <p className="muted">데이터를 불러오는 중입니다…</p>
              )}
              <div className="data-notes">
                <h3>USDD 전환·회수 경로</h3>
                <p>
                  {snapshot?.psm.available
                    ? "PSM 경로 데이터가 있습니다. 전환 수수료와 가용량을 배분에 반영합니다."
                    : "USDD 전환·회수 경로가 확인되지 않아 실시간 배분에 포함하지 않습니다."}
                </p>
                {snapshot?.psm.warnings.map((w, i) => (
                  <p className="small muted" key={i}>
                    {w}
                  </p>
                ))}
                {snapshot?.psm.evidence.map((e, i) => (
                  <p className="small muted" key={`psm${i}`}>
                    <a href={e.url} target="_blank" rel="noreferrer">
                      {e.label} ↗
                    </a>
                    {e.note && <span> · {e.note}</span>}
                  </p>
                ))}
                <p className="small muted">
                  현재 시장 현금은 미래 출금 보장이 아닙니다. 차입이 있는 계정은
                  담보 조건을 추가 확인해야 합니다.
                </p>
              </div>
              <div className="evidence-grid">
                {snapshot?.markets.map((m) => (
                  <div key={m.id}>
                    <h3>{m.name} · 근거</h3>
                    {m.warnings.map((w, i) => (
                      <p className="small muted" key={i}>
                        {w}
                      </p>
                    ))}
                    {m.evidence.map((e, i) => (
                      <a href={e.url} key={i} target="_blank" rel="noreferrer">
                        {e.label}
                        <ExternalLink size={12} />
                      </a>
                    ))}
                  </div>
                ))}
              </div>
              {snapshot?.warnings.map((w, i) => (
                <p className="inline-warning" key={i}>
                  {w}
                </p>
              ))}
            </section>
          )}

          {result && plan && confirmed && mode === "live" && !stressNote && (
            <div hidden={tab !== "review"}>
              <MonitoringPanel
                key={`${result.createdAt}:${plan.id}:${wallet?.address ?? "markets"}`}
                result={result}
                selectedPlanId={plan.id}
                wallet={wallet}
                onWallet={setWallet}
                onSnapshot={setSnapshot}
                paused={!!preview || !!busy}
                onReview={(nextIntent, nextCosts) => {
                  intentDirty();
                  setIntent(nextIntent);
                  setCosts(nextCosts);
                  setResult(null);
                  setTab("plan");
                  setNotice(
                    "남은 기간의 조건을 불러왔습니다. 실제 가용 자금과 이미 지급한 지출을 확인하고 다시 계산해 주세요.",
                  );
                }}
              />
            </div>
          )}
          {tab === "review" && (
            <>
              {(!result || !confirmed || mode !== "live" || !!stressNote) && (
                <p className="inline-warning">
                  계획 변화 관측은 실시간 모드에서 조건을 확인하고 기본 계획을
                  계산한 뒤 사용할 수 있습니다.
                </p>
              )}
              {result && plan && (
                <ReviewSimulation result={result} planId={plan.id} />
              )}
              <section className="card">
                <div className="section-heading">
                  <h2>현재 지갑·포지션</h2>
                  <button
                    className="secondary"
                    disabled={!!busy}
                    onClick={() =>
                      wallet ? run("포지션 조회", refreshWallet) : connect()
                    }
                  >
                    <RefreshCw size={14} />
                    {wallet ? "새로고침" : "지갑 연결"}
                  </button>
                </div>
                {wallet ? (
                  <>
                    <p className="wallet-address">{wallet.address}</p>
                    <p className="small muted">
                      최근 조회{" "}
                      {new Date(wallet.fetchedAt).toLocaleString("ko-KR")} ·
                      현재 스냅샷이며 실현 수익 통계가 아닙니다.
                    </p>
                    <div className="balance-row">
                      <span>
                        USDT <strong>{money(wallet.usdt)}</strong>
                      </span>
                      <span>
                        USDD{" "}
                        <strong>
                          {wallet.usdd === null
                            ? "확인 불가"
                            : money(wallet.usdd)}
                        </strong>
                      </span>
                      <span>
                        TRX <strong>{money(wallet.trx)}</strong>
                      </span>
                    </div>
                    {wallet.positions.length ? (
                      wallet.positions.map((p) => (
                        <div className="position-row" key={p.marketId}>
                          <div>
                            <strong>
                              {p.marketId === "justlend-usdd"
                                ? "JustLend USDD · 예치 자산"
                                : labels[p.marketId]}
                            </strong>
                            <small>
                              {p.collateral ? "담보로 사용 중" : "담보 미사용"}
                            </small>
                          </div>
                          <strong>
                            {money(p.underlyingAmount)} {p.underlyingAsset}
                          </strong>
                        </div>
                      ))
                    ) : (
                      <div className="empty-small">
                        조회된 공급 포지션이 없습니다.
                      </div>
                    )}
                    {wallet.warnings.map((w, i) => (
                      <p className="small muted" key={i}>
                        {w}
                      </p>
                    ))}
                    <div className="withdraw-row">
                      <Field label="USDT 회수 금액" suffix="USDT">
                        <input
                          value={txAmount}
                          aria-label="USDT 회수 금액"
                          onChange={(e) => {
                            inputRevision.current++;
                            setPreview(null);
                            setTxAmount(e.target.value);
                          }}
                          inputMode="decimal"
                        />
                      </Field>
                      <button
                        className="secondary"
                        disabled={
                          mode !== "live" ||
                          !!busy ||
                          !txAmount ||
                          !!history.error
                        }
                        onClick={() => prepare("withdraw-usdt")}
                      >
                        <ArrowDownLeft size={15} />
                        회수 견적 확인
                      </button>
                    </div>
                  </>
                ) : (
                  <div className="empty-small">
                    <Wallet size={25} />
                    <p>
                      지갑을 연결하면 실제 잔고와 JustLend 포지션을 조회합니다.
                    </p>
                    <small>데모 자금과 실제 잔고는 별도로 표시합니다.</small>
                  </div>
                )}
              </section>
              <section className="card">
                <div className="section-heading">
                  <h2>저장한 계획</h2>
                  <button
                    className="text-button"
                    onClick={() =>
                      exportJson(
                        {
                          plans: history.plans,
                          transactions: history.transactions,
                        },
                        "treasury-history.json",
                      )
                    }
                  >
                    <Download size={15} />
                    기록 내보내기
                  </button>
                </div>
                <p className="small muted">
                  이 브라우저에만 저장됩니다. 내보낸 파일에는 계획 금액과 연결한
                  지갑의 거래 정보가 포함될 수 있습니다.
                </p>
                {history.plans.length ? (
                  history.plans.map((p) => (
                    <div className="saved-plan" key={p.id}>
                      <div>
                        <span className={`status-badge ${p.mode}`}>
                          {p.mode === "demo" ? "데모 계획" : "실시간 계획"}
                        </span>
                        <h3>{p.name}</h3>
                        <small>
                          {new Date(p.createdAt).toLocaleString("ko-KR")} ·{" "}
                          {p.horizonDays}일
                        </small>
                        <p className="small muted">{p.assumptions}</p>
                      </div>
                      <div>
                        <span>예상 순수익</span>
                        <strong>{money(p.expectedNetUSDT)} USDT</strong>
                        <small>실제 순수익: 전체 입출금 원장 필요</small>
                        <button
                          className="text-button"
                          onClick={() => {
                            try {
                              const restored = restorePlanConditions(p.plan);
                              intentDirty();
                              setIntent(restored.intent);
                              setCosts(restored.costs);
                              setMode(p.mode);
                              setConfirmed(false);
                              setResult(null);
                              setTab("plan");
                              setNotice(
                                restored.requiresNewHorizon
                                  ? "원래 운용 기간이 끝났습니다. 새 운용 기간과 이미 지급한 지출을 직접 확인한 뒤 다시 계산해 주세요."
                                  : `원래 계획에서 ${restored.elapsedDays}일 경과한 조건을 불러왔습니다. 실제 가용 자금과 지급 완료 지출을 확인하고 다시 계산해 주세요.`,
                              );
                            } catch {
                              setError(
                                "저장된 계획 형식을 확인하지 못했습니다.",
                              );
                            }
                          }}
                        >
                          조건 불러오기 <ArrowRight size={13} />
                        </button>
                        <button
                          className="text-button"
                          onClick={() =>
                            exportJson(
                              p.plan,
                              `treasury-${p.id.slice(0, 8)}.json`,
                            )
                          }
                        >
                          가정 확인 <Download size={13} />
                        </button>
                      </div>
                    </div>
                  ))
                ) : (
                  <div className="empty-small">
                    배분안에서 ‘계획 저장’을 누르면 원래의 계산 가정을
                    보관합니다.
                  </div>
                )}
              </section>
              <section className="card">
                <div className="section-heading">
                  <h2>거래 기록</h2>
                  <span className="small muted">서명 이후 거래만 기록</span>
                </div>
                {history.transactions.length ? (
                  history.transactions.map((t) => (
                    <div className="transaction" key={t.id}>
                      <div>
                        <strong>
                          {
                            {
                              "approve-usdt": "USDT 사용 승인",
                              "supply-usdt": "JustLend 예치",
                              "withdraw-usdt": "JustLend 회수",
                            }[t.action]
                          }{" "}
                          · {money(t.amount)} USDT
                        </strong>
                        <a
                          href={`https://tronscan.org/#/transaction/${t.txid}`}
                          target="_blank"
                          rel="noreferrer"
                        >
                          {t.txid.slice(0, 12)}…{t.txid.slice(-8)}
                          <ExternalLink size={12} />
                        </a>
                        <small>
                          {t.actualFeeTRX !== undefined
                            ? `실제 네트워크 비용 ${money(t.actualFeeTRX, 6)} TRX`
                            : "네트워크 비용 확인 대기"}
                        </small>
                        {t.planId && (
                          <small>근거 계획 {t.planId.slice(0, 8)}</small>
                        )}
                        {t.error && (
                          <small className="negative">{t.error}</small>
                        )}
                      </div>
                      <div>
                        <span className={`status-badge ${t.status}`}>
                          {
                            {
                              pending: "처리 중",
                              confirmed: "확인됨",
                              failed: "실패",
                              unknown: "확인 필요",
                            }[t.status]
                          }
                        </span>
                        <button
                          className="text-button"
                          disabled={!!busy}
                          onClick={() => refreshTransaction(t)}
                        >
                          상태 확인
                          <RefreshCw size={13} />
                        </button>
                      </div>
                    </div>
                  ))
                ) : (
                  <div className="empty-small">
                    아직 제출한 거래가 없습니다.
                  </div>
                )}
              </section>
            </>
          )}
          <footer>
            <span>
              TRON TREASURY COPILOT <span className="footer-dot">·</span> GWDC
              2026
            </span>
            <span>계산 가능한 근거. 사용자가 결정하는 실행.</span>
          </footer>
        </main>
      </div>
      {busy && (
        <div className="working-indicator" role="status">
          <Loader2 size={15} className="spin" />
          {busy} 중
        </div>
      )}
      {preview && (
        <div className="modal-backdrop">
          <section
            className="transaction-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="transaction-title"
          >
            <button
              className="modal-close icon-button"
              disabled={!!busy}
              aria-label="거래 미리보기 닫기"
              onClick={() => setPreview(null)}
            >
              <X size={20} />
            </button>
            <div className="eyebrow">REVIEW BEFORE YOU SIGN</div>
            <h2 id="transaction-title">거래 내용을 확인하세요</h2>
            <p>TRON Mainnet · {preview.functionSelector}</p>
            <dl>
              <dt>금액</dt>
              <dd>{money(preview.amount, 6)} USDT</dd>
              <dt>내 지갑</dt>
              <dd>{preview.owner}</dd>
              <dt>대상 계약</dt>
              <dd>{preview.to}</dd>
              {preview.spender && (
                <>
                  <dt>승인 대상</dt>
                  <dd>{preview.spender}</dd>
                </>
              )}
              <dt>예상 네트워크 비용</dt>
              <dd>
                {preview.estimatedFeeTRX === null
                  ? "확인 불가"
                  : `${preview.estimatedFeeTRX} TRX`}
              </dd>
              <dt>Energy 비용 상한</dt>
              <dd>
                {money(preview.feeLimitSun / 1e6, 6)} TRX (예상 비용과 다름)
              </dd>
              <dt>견적 유효 시각</dt>
              <dd>{new Date(preview.expiresAt).toLocaleTimeString("ko-KR")}</dd>
            </dl>
            {preview.warnings.map((w, i) => (
              <p className="small muted" key={i}>
                {w}
              </p>
            ))}
            <label className="check-row">
              <input
                type="checkbox"
                autoFocus
                checked={previewConsent}
                onChange={(e) => setPreviewConsent(e.target.checked)}
              />
              금액·계약·비용·승인 범위를 확인했습니다.
            </label>
            <button
              className="primary full"
              disabled={!previewConsent || !!busy || !!history.error}
              onClick={execute}
            >
              <Wallet size={17} />
              TronLink에서 서명하고 제출
            </button>
            <p className="small muted">
              서명 이후 결과가 불명확하면 거래 ID로 확인합니다. 자동 재전송하지
              않습니다.
            </p>
          </section>
        </div>
      )}
    </div>
  );
}

function Field({
  label,
  suffix,
  children,
}: {
  label: string;
  suffix: string;
  children: React.ReactNode;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      <div>
        {children}
        <small>{suffix}</small>
      </div>
    </label>
  );
}
function Metric({
  label,
  value,
  sub,
  icon,
  accent = false,
}: {
  label: string;
  value: string;
  sub: string;
  icon: React.ReactNode;
  accent?: boolean;
}) {
  return (
    <article className={`metric ${accent ? "accent" : ""}`}>
      <div>
        <span>{label}</span>
        {icon}
      </div>
      <strong>
        {value}
        <small>USDT</small>
      </strong>
      <p>{sub}</p>
    </article>
  );
}
