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
import {
  getIntentReviewRequirements,
  isIntentReviewComplete,
} from "./intent-confirmation";
import { PsmStatusPanel } from "./PsmStatusPanel";
import { assertWallet, connectWallet, signAndBroadcast } from "./wallet";
import { exportJson, readHistory, toSavedPlan, writeHistory } from "./history";

const money = (value: string | number | undefined, digits = 2) =>
  Number(value ?? 0).toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
const pct = (value: string | null) =>
  value === null ? "Unavailable" : `${money(Number(value) * 100)}%`;
const labels: Record<string, string> = {
  wallet: "USDT in wallet",
  "justlend-usdt": "JustLend · USDT",
  "justlend-usdd": "USDD conversion + JustLend",
};
const sample =
  "I have 10,000 USDT. I need 3,000 in 7 days and 1,000 in 30 days. Keep 500 as an emergency reserve. Invest the remainder for 30 days, limit USDD to 20% of my total capital, and use no leverage.";
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
  const [aiConditionsReviewed, setAiConditionsReviewed] = useState(false);
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
  const aiReview = getIntentReviewRequirements(parse);
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
    setAiConditionsReviewed(false);
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
          "Browser storage is unavailable. You can export the current records as JSON.",
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
      setError(e instanceof Error ? e.message : "Request failed.");
    } finally {
      pendingRef.current = false;
      setBusy("");
    }
  }
  async function calculate(input = intent, stress = "") {
    if (!isIntentReviewComplete(parse, aiConditionsReviewed))
      throw new Error(
        "Review the missing AI conditions and questions, then confirm the current inputs.",
      );
    const revision = inputRevision.current;
    const output = await api<PlanningResult>("/plan", {
      intent: input,
      costs,
      mode,
    });
    if (revision !== inputRevision.current) {
      setNotice(
        "Conditions changed during calculation. Please review the updated inputs.",
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
    await run("Interpret request", async () => {
      const revision = inputRevision.current;
      const value = await api<ParseResult>("/intent", { text });
      if (revision !== inputRevision.current)
        throw new Error(
          "Inputs changed during interpretation. Please interpret the new request again.",
        );
      setParse(value);
      if (value.source === "ai") {
        setIntent((i) => ({ ...i, ...value.intent }));
        intentDirty();
      } else setNotice(value.message);
    });
  }
  async function connect() {
    await run("Connect wallet", async () => {
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
    setNotice("Saved this plan and its assumptions in this browser.");
  }
  function loadExample(shortTerm: boolean) {
    intentDirty();
    const example = structuredClone(defaultIntent);
    if (shortTerm) {
      example.capitalUSDT = "2000";
      example.expenses = [];
      example.emergencyUSDT = "0";
      example.horizonDays = 7;
      example.maxUSDDExposurePct = 0;
      example.maxProtocolExposurePct = 100;
    }
    setIntent(example);
    setCosts({ ...defaultCosts });
    setParse(null);
    setResult(null);
    setMode("demo");
    setText(
      shortTerm
        ? "I have 2,000 USDT to invest for 7 days, with no scheduled expenses or emergency reserve. No USDD, volatile assets, or leverage. Allow up to 100% exposure to JustLend."
        : sample,
    );
    setNotice(
      "Demo example loaded. Review the amounts, timing, and cost assumptions, then compare plans.",
    );
  }
  async function prepare(action: TransactionAction, resetAllowance = false) {
    await run("Preparing transaction", async () => {
      const revision = inputRevision.current;
      if (mode !== "live" || !wallet)
        throw new Error("Connect your wallet in live mode first.");
      await assertWallet(wallet.address);
      const amount = resetAllowance
        ? "0"
        : action === "withdraw-usdt"
          ? txAmount
          : plan?.allocations.find((a) => a.strategy === "justlend-usdt")
              ?.amountUSDT;
      if (!amount || (!resetAllowance && new Decimal(amount).lte(0)))
        throw new Error("Check the USDT transaction amount.");
      if (
        action !== "withdraw-usdt" &&
        !resetAllowance &&
        (!confirmed || !result || stressNote)
      )
        throw new Error(
          "Confirm the latest conditions and recalculate the base plan.",
        );
      const current = await api<WalletState>(`/wallet/${wallet.address}`);
      setWallet(current);
      if (
        action === "supply-usdt" &&
        result &&
        new Decimal(current.usdt).minus(amount).lt(result.reserveUSDT)
      )
        throw new Error(
          "This transaction would leave insufficient funds for expenses and reserves. Update your plan.",
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
          "Conditions or allocation changed while preparing the transaction. Prepare it again.",
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
    await run("Wallet signature", async () => {
      if (mode !== "live" || previewRevision.current !== inputRevision.current)
        throw new Error(
          "Conditions changed after preparation. Prepare the transaction again.",
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
            "The wallet balance changed and no longer covers reserved funds. Prepare the transaction again.",
          );
      }
      if (previewRevision.current !== inputRevision.current)
        throw new Error(
          "Conditions changed during validation. Prepare the transaction again.",
        );
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
            throw new Error(
              "Transaction not sent because its record could not be preserved.",
            );
          try {
            writeHistory(latest.plans, [record, ...latest.transactions]);
          } catch {
            throw new Error(
              "Transaction not sent because its record could not be saved.",
            );
          }
        });
        setNotice(
          "Transaction submitted. Check its status in the transaction history.",
        );
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
    await run("Checking transaction", async () => {
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
          aria-label="Treasury home"
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
              { id: "plan", label: "Treasury plan", icon: Layers3 },
              { id: "markets", label: "Products and data", icon: BarChart3 },
              { id: "review", label: "Positions and review", icon: Clock3 },
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
            Plan around
            <br />
            when you need it.
          </strong>
          <p>
            Reserve what you need.
            <br />
            Put the remainder to work.
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
                ? "Treasury plan"
                : tab === "markets"
                  ? "Products and data"
                  : "Positions and review"}
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
                : "Connect wallet"}
            </button>
          </div>
        </header>
        <main>
          <div className="page-title">
            <div>
              <div className="eyebrow">YOUR CAPITAL, WITH A PLAN</div>
              <h1>
                {tab === "plan"
                  ? "Your money, ready when you need it."
                  : tab === "markets"
                    ? "Look beyond the headline yield."
                    : "From your plan to its outcome."}
              </h1>
              <p>
                {tab === "plan"
                  ? "Compare plans for your surplus, accounting for spending dates and exit costs."
                  : tab === "markets"
                    ? "Check data sources, timestamps, and the conditions for withdrawing your funds."
                    : "Save your original assumptions and review positions and transaction outcomes."}
              </p>
            </div>
            <div className="mode-switch" aria-label="Data mode">
              <button
                className={mode === "demo" ? "selected" : ""}
                onClick={() => setMode("demo")}
                disabled={!!busy}
              >
                <FlaskConical size={14} />
                Demo
              </button>
              <button
                className={mode === "live" ? "selected" : ""}
                onClick={() => setMode("live")}
                disabled={!!busy}
              >
                <span className="live-dot" />
                Live
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
                {mode === "demo" ? "Demo data" : "Live data mode"}
              </strong>
              {mode === "demo"
                ? "Illustrative rates and liquidity. No transactions are executed."
                : "Unverified products are excluded. Rates can change."}
            </span>
            {snapshot && (
              <small>
                As of {new Date(snapshot.fetchedAt).toLocaleTimeString("en-US")}
              </small>
            )}
          </div>
          {error && (
            <div className="message error" role="alert">
              {error}
              <button aria-label="Dismiss error" onClick={() => setError("")}>
                <X size={16} />
              </button>
            </div>
          )}
          {notice && (
            <div className="message success" role="status">
              {notice}
              <button
                aria-label="Dismiss notification"
                onClick={() => setNotice("")}
              >
                <X size={16} />
              </button>
            </div>
          )}
          {history.error && (
            <div className="message error">{history.error}</div>
          )}

          {tab === "plan" && (
            <>
              <section className="demo-quickstart" aria-label="Quick demo">
                <div>
                  <strong>Explore the workflow in one minute</strong>
                  <p>
                    Choose an example → Compare plans → Explore changes and
                    review
                  </p>
                </div>
                <div className="quickstart-actions">
                  <button
                    className="secondary"
                    disabled={!!busy}
                    onClick={() => loadExample(false)}
                  >
                    Reserve expenses first
                  </button>
                  <button
                    className="secondary"
                    disabled={!!busy}
                    onClick={() => loadExample(true)}
                  >
                    Short-term cost check
                  </button>
                </div>
                <small>
                  These buttons load sample inputs. They are not real funds or
                  AI-generated results.
                </small>
              </section>
              <section className="summary-grid" aria-label="Treasury overview">
                <Metric
                  label="Total planned capital"
                  value={money(intent.capitalUSDT, 0)}
                  sub="In USDT · separate from wallet balance"
                  icon={<Wallet size={17} />}
                />
                <Metric
                  label="Reserved for spending"
                  value={money(totalReserved, 0)}
                  sub="Expenses and emergency funds held aside"
                  icon={<LockKeyhole size={17} />}
                />
                <Metric
                  label="Available to optimize"
                  value={money(available, 0)}
                  sub="Before entry and exit costs"
                  icon={<ArrowUpRight size={18} />}
                  accent
                />
              </section>
              <div className="planning-grid">
                <div className="input-column">
                  <section className="card intent-card">
                    <div className="section-heading">
                      <div className="step-label">
                        01 <span>Your requirements</span>
                      </div>
                      <span className={`small-status ${aiReady ? "good" : ""}`}>
                        <span />
                        {aiReady ? "AI configured" : "Manual input available"}
                      </span>
                    </div>
                    <h2>What are your funds for?</h2>
                    <p className="muted">
                      Enter your capital, spending dates, and investment
                      horizon.
                    </p>
                    <label className="sr-only" htmlFor="intent-text">
                      Describe your requirements
                    </label>
                    <textarea
                      id="intent-text"
                      value={text}
                      onChange={(e) => {
                        setText(e.target.value);
                        setParse(null);
                        intentDirty();
                      }}
                      maxLength={4000}
                    />
                    <div className="prompt-footer">
                      <small>
                        Your text is sent only when you request AI
                        interpretation.
                      </small>
                      <button
                        className="text-button"
                        onClick={parseIntent}
                        disabled={!!busy}
                      >
                        <Sparkles size={15} />
                        {busy === "Interpret request"
                          ? "Interpreting…"
                          : "Interpret request"}
                      </button>
                    </div>
                    {parse && (
                      <div className="parse-note">
                        <strong>
                          {parse.source === "ai"
                            ? "Review the interpreted conditions below."
                            : "AI not connected · manual input"}
                        </strong>
                        <p>{parse.message}</p>
                        {parse.questions.map((q, i) => (
                          <p key={i}>• {q}</p>
                        ))}
                      </div>
                    )}
                    <div className="form-grid">
                      <Field label="Total planned capital" suffix="USDT">
                        <input
                          aria-label="Total planned capital"
                          inputMode="decimal"
                          value={intent.capitalUSDT}
                          onChange={(e) =>
                            edit({ capitalUSDT: e.target.value })
                          }
                        />
                      </Field>
                      <Field label="Investment horizon" suffix="days">
                        <input
                          aria-label="Investment horizon"
                          type="number"
                          min="1"
                          max="3650"
                          value={intent.horizonDays}
                          onChange={(e) =>
                            edit({ horizonDays: Number(e.target.value) })
                          }
                        />
                      </Field>
                      <Field label="Emergency reserve" suffix="USDT">
                        <input
                          aria-label="Emergency reserve"
                          inputMode="decimal"
                          value={intent.emergencyUSDT}
                          onChange={(e) =>
                            edit({ emergencyUSDT: e.target.value })
                          }
                        />
                      </Field>
                      <Field label="USDD exposure cap" suffix="%">
                        <input
                          aria-label="USDD exposure cap"
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
                      <strong>Scheduled expenses</strong>
                      <button
                        className="text-button"
                        onClick={() =>
                          edit({
                            expenses: [
                              ...intent.expenses,
                              {
                                id: crypto.randomUUID(),
                                label: "New expense",
                                amountUSDT: "0",
                                dueInDays: 7,
                              },
                            ],
                          })
                        }
                      >
                        <Plus size={14} />
                        Add
                      </button>
                    </div>
                    <div className="expense-list">
                      {intent.expenses.map((expense, index) => (
                        <div className="expense-row" key={expense.id}>
                          <div className="timeline-dot" />
                          <div className="expense-fields">
                            <input
                              aria-label={`Expense ${index + 1} name`}
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
                                aria-label={`Expense ${index + 1} days`}
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
                              <span>days from now</span>
                            </div>
                          </div>
                          <div className="expense-amount">
                            <input
                              aria-label={`Expense ${index + 1} amount`}
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
                            aria-label={`Remove expense ${index + 1}`}
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
                        Costs and allocation limits <CircleHelp size={13} />
                      </summary>
                      <div className="form-grid">
                        <Field
                          label="USDT round-trip cost assumption"
                          suffix="USDT"
                        >
                          <input
                            aria-label="USDT round-trip cost assumption"
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
                        <Field label="USDD route cost assumption" suffix="USDT">
                          <input
                            aria-label="USDD route cost assumption"
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
                        <Field label="Combined JustLend cap" suffix="%">
                          <input
                            aria-label="Combined JustLend cap"
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
                        Include estimated incentives (prices and reward terms
                        may change)
                      </label>
                      <p className="small muted">
                        Costs are your planning assumptions, not wallet fee
                        quotes. Exposure caps are percentages of total planned
                        capital.
                      </p>
                    </details>
                    <div className="policy-line">
                      <ShieldCheck size={14} />
                      No leverage
                      <span />
                      No TRX price exposure
                    </div>
                    {aiReview.required && (
                      <div className="ai-review-gate">
                        <p>
                          Some conditions are still unconfirmed. Replace any
                          remaining sample values or explicitly confirm them.
                        </p>
                        {aiReview.missingLabels.length > 0 && (
                          <p>
                            Unconfirmed fields:{" "}
                            {aiReview.missingLabels.join(" · ")}
                          </p>
                        )}
                        <label className="check-row">
                          <input
                            type="checkbox"
                            checked={aiConditionsReviewed}
                            onChange={(e) =>
                              setAiConditionsReviewed(e.target.checked)
                            }
                          />
                          I have reviewed the questions and current inputs, and
                          confirm these conditions without volatile assets or
                          leverage.
                        </label>
                      </div>
                    )}
                    <button
                      className="primary full"
                      disabled={
                        !!busy ||
                        !isIntentReviewComplete(parse, aiConditionsReviewed)
                      }
                      onClick={() => run("Calculating plan", () => calculate())}
                    >
                      {busy === "Calculating plan" ? (
                        <Loader2 className="spin" size={17} />
                      ) : (
                        <CheckCircle2 size={17} />
                      )}
                      Confirm and compare
                      <ArrowRight size={16} />
                    </button>
                  </section>
                </div>
                <div className="results-column">
                  <section className="card results-card">
                    <div className="section-heading">
                      <div className="step-label">
                        02 <span>Compare plans</span>
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
                        <h2>Your schedule comes first.</h2>
                        <p>
                          Confirm your conditions to compare holding cash and
                          investing
                          <br />
                          by cost, liquidity, and estimated net return.
                        </p>
                        <div className="empty-checks">
                          <span>
                            <Check size={14} />
                            Reserve expenses first
                          </span>
                          <span>
                            <Check size={14} />
                            Include entry and exit costs
                          </span>
                          <span>
                            <Check size={14} />
                            Explain excluded options
                          </span>
                        </div>
                      </div>
                    ) : (
                      <>
                        {!confirmed && (
                          <div className="inline-warning">
                            Conditions changed. Please recalculate.
                          </div>
                        )}
                        {stressNote && (
                          <div className="stress-result">
                            <FlaskConical size={17} />
                            <div>
                              <strong>Simulated scenario</strong>
                              <p>{stressNote}</p>
                            </div>
                            <button
                              onClick={() =>
                                run("Calculating plan", () => calculate())
                              }
                              className="text-button"
                            >
                              Original conditions
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
                                  <span className="tag">Net return first</span>
                                )}
                              </div>
                              <div className="option-yield">
                                <span>
                                  {Number(p.netYieldUSDT) > 0 ? "+" : ""}
                                  {money(p.netYieldUSDT)} <small>USDT</small>
                                </span>
                                <small>
                                  {result.intent.horizonDays}-day estimated net
                                  return
                                </small>
                              </div>
                              <p>{p.objective}</p>
                            </button>
                          ))}
                        </div>
                        {plan && (
                          <>
                            <div className="allocation-heading">
                              <h3>Capital allocation</h3>
                              <span>
                                {result.intent.horizonDays} days · assumes
                                unchanged rates
                              </span>
                            </div>
                            <div
                              className="allocation-bar"
                              aria-label="Allocation weights"
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
                                          ? `Reserved ${money(plan.reserveUSDT, 0)} + Extra cash ${money(plan.freeCashUSDT, 0)}`
                                          : `Base interest ${money(a.grossYieldUSDT)} · Incentives ${money(a.incentiveYieldUSDT)} USDT`}
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
                                <span>Base interest</span>
                                <strong>+{money(plan.grossYieldUSDT)}</strong>
                              </div>
                              <div>
                                <span>Estimated incentives</span>
                                <strong>
                                  +{money(plan.incentiveYieldUSDT)}
                                </strong>
                              </div>
                              <div>
                                <span>Round-trip cost assumption</span>
                                <strong>−{money(plan.costUSDT)}</strong>
                              </div>
                              <div className="net">
                                <span>
                                  Estimated net return <small>USDT</small>
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
                                Break-even{" "}
                                {plan.breakevenDays === null
                                  ? "Not applicable"
                                  : `${plan.breakevenDays} days`}
                              </span>
                              <span>
                                <LockKeyhole size={14} />
                                Reserved expenses stay uninvested
                              </span>
                            </div>
                            <details className="reason-details">
                              <summary>
                                Why this plan, and its limits{" "}
                                <CircleHelp size={14} />
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
                                A scenario estimate using current rates and your
                                cost assumptions. Future returns and withdrawals
                                are not guaranteed.
                              </p>
                            </details>
                            <div className="plan-actions">
                              <button
                                className="secondary"
                                disabled={!confirmed || !!history.error}
                                onClick={savePlan}
                              >
                                <CheckCircle2 size={15} />
                                Save plan
                              </button>
                              <button
                                className="icon-button"
                                title="Export calculation details as JSON"
                                aria-label="Export plan"
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
                        What if things change?
                      </h3>
                      <span className="tag">SIMULATION</span>
                    </div>
                    <p className="muted">
                      Keep the allocation when existing reserves cover the
                      change.
                    </p>
                    <div className="stress-buttons">
                      <button
                        disabled={!result || !confirmed || !!busy}
                        onClick={() =>
                          run("Calculating scenario", () =>
                            calculate(
                              {
                                ...intent,
                                expenses: intent.expenses.map((e) => ({
                                  ...e,
                                  dueInDays: Math.min(e.dueInDays, 1),
                                })),
                              },
                              "An existing expense is now due tomorrow. Investment stays unchanged when reserved funds cover it.",
                            ),
                          )
                        }
                      >
                        Expense due tomorrow
                        <ArrowRight size={14} />
                      </button>
                      <button
                        disabled={!result || !confirmed || !!busy}
                        onClick={() =>
                          run("Calculating scenario", () =>
                            calculate(
                              {
                                ...intent,
                                expenses: [
                                  ...intent.expenses,
                                  {
                                    id: "stress-extra",
                                    label: "Simulated extra expense",
                                    amountUSDT: "3000",
                                    dueInDays: 1,
                                  },
                                ],
                              },
                              "Added an unplanned 3,000 USDT expense. Check whether all expenses and emergency funds remain covered.",
                            ),
                          )
                        }
                      >
                        Extra expense +3,000
                        <ArrowRight size={14} />
                      </button>
                      <button
                        disabled={!result || !confirmed || !!busy}
                        onClick={() =>
                          run("Calculating scenario", () =>
                            calculate(
                              { ...intent, horizonDays: 7 },
                              "Reduced the investment horizon to 7 days. Strategies that cannot cover round-trip costs are excluded.",
                            ),
                          )
                        }
                      >
                        7-day horizon
                        <ArrowRight size={14} />
                      </button>
                    </div>
                  </section>
                  {result && result.exclusions.length > 0 && (
                    <section className="card exclusions">
                      <h3>Considered, then excluded</h3>
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
                      03 <span>Review and execute</span>
                    </div>
                    <span className="tag">USER SIGNED</span>
                  </div>
                  <h2>Supply USDT from your selected plan</h2>
                  <p className="muted">
                    Supports JustLend USDT supply and withdrawal. The USDD route
                    is comparison only. Approval is a separate transaction for
                    the exact required amount.
                  </p>
                  {mode === "demo" ? (
                    <div className="inline-warning">
                      Transactions cannot be prepared or signed in demo mode.
                    </div>
                  ) : !wallet ? (
                    <button
                      className="secondary"
                      onClick={connect}
                      disabled={!!busy}
                    >
                      <Wallet size={16} />
                      Connect TronLink
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
                        1. Prepare USDT approval
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
                        2. Review supply quote
                        <ArrowRight size={15} />
                      </button>
                      <button
                        className="text-button"
                        disabled={!!busy || !!history.error}
                        onClick={() => prepare("approve-usdt", true)}
                      >
                        Reset existing USDT approval
                      </button>
                      <small>
                        Wallet USDT {money(wallet.usdt)} · TRX{" "}
                        {money(wallet.trx)}
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
                <h2>Products and exit conditions</h2>
                <button
                  className="secondary"
                  disabled={!!busy}
                  onClick={() =>
                    run("Refreshing data", async () =>
                      setSnapshot(
                        await api<MarketSnapshot>(`/markets?mode=${mode}`),
                      ),
                    )
                  }
                >
                  <RefreshCw size={14} />
                  Refresh
                </button>
              </div>
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Product</th>
                      <th>Base APY</th>
                      <th>Incentive APY</th>
                      <th>Available liquidity</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {snapshot?.markets.map((m) => (
                      <tr key={m.id}>
                        <td>
                          <strong>{m.name}</strong>
                          <small>{m.asset} supply</small>
                        </td>
                        <td>{pct(m.baseApy)}</td>
                        <td>{pct(m.rewardApy)}</td>
                        <td>
                          {m.cashUSDT === null
                            ? "Unavailable"
                            : `${money(m.cashUSDT, 0)} ${m.asset}`}
                        </td>
                        <td>
                          <span className={`status-badge ${m.quality}`}>
                            {m.quality === "demo"
                              ? "Demo"
                              : m.quality === "verified"
                                ? "Verified"
                                : m.quality === "stale"
                                  ? "Needs refresh"
                                  : "Unavailable"}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {!snapshot && <p className="muted">Loading market data…</p>}
              <div className="data-notes">
                <h3>USDD conversion and exit route</h3>
                <p>
                  {snapshot?.psm.available
                    ? "PSM route data is available. Conversion fees and capacity are included in the allocation."
                    : "The USDD entry and exit route is unverified and excluded from live allocations."}
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
                  Current market cash does not guarantee future withdrawals.
                  Accounts with borrowing require additional collateral checks.
                </p>
              </div>
              {mode === "live" && <PsmStatusPanel />}
              <div className="evidence-grid">
                {snapshot?.markets.map((m) => (
                  <div key={m.id}>
                    <h3>{m.name} · Sources</h3>
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
                    "Loaded conditions for the remaining period. Review available funds and paid expenses, then recalculate.",
                  );
                }}
              />
            </div>
          )}
          {tab === "review" && (
            <>
              {(!result || !confirmed || mode !== "live" || !!stressNote) && (
                <p className="inline-warning">
                  Plan monitoring is available after confirming conditions and
                  calculating a base plan in live mode.
                </p>
              )}
              {result && plan && (
                <ReviewSimulation result={result} planId={plan.id} />
              )}
              <section className="card">
                <div className="section-heading">
                  <h2>Wallet and positions</h2>
                  <button
                    className="secondary"
                    disabled={!!busy}
                    onClick={() =>
                      wallet
                        ? run("Loading positions", refreshWallet)
                        : connect()
                    }
                  >
                    <RefreshCw size={14} />
                    {wallet ? "Refresh" : "Connect wallet"}
                  </button>
                </div>
                {wallet ? (
                  <>
                    <p className="wallet-address">{wallet.address}</p>
                    <p className="small muted">
                      Last checked{" "}
                      {new Date(wallet.fetchedAt).toLocaleString("en-US")} · A
                      current snapshot, not realized profit statistics.
                    </p>
                    <div className="balance-row">
                      <span>
                        USDT <strong>{money(wallet.usdt)}</strong>
                      </span>
                      <span>
                        USDD{" "}
                        <strong>
                          {wallet.usdd === null
                            ? "Unavailable"
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
                                ? "JustLend USDD · supplied assets"
                                : labels[p.marketId]}
                            </strong>
                            <small>
                              {p.collateral
                                ? "Used as collateral"
                                : "Not used as collateral"}
                            </small>
                          </div>
                          <strong>
                            {money(p.underlyingAmount)} {p.underlyingAsset}
                          </strong>
                        </div>
                      ))
                    ) : (
                      <div className="empty-small">
                        No supply positions found.
                      </div>
                    )}
                    {wallet.warnings.map((w, i) => (
                      <p className="small muted" key={i}>
                        {w}
                      </p>
                    ))}
                    <div className="withdraw-row">
                      <Field label="USDT withdrawal amount" suffix="USDT">
                        <input
                          value={txAmount}
                          aria-label="USDT withdrawal amount"
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
                        Review withdrawal quote
                      </button>
                    </div>
                  </>
                ) : (
                  <div className="empty-small">
                    <Wallet size={25} />
                    <p>
                      Connect a wallet to view real balances and JustLend
                      positions.
                    </p>
                    <small>
                      Demo funds and real balances are shown separately.
                    </small>
                  </div>
                )}
              </section>
              <section className="card">
                <div className="section-heading">
                  <h2>Saved plans</h2>
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
                    Export history
                  </button>
                </div>
                <p className="small muted">
                  Stored only in this browser. Exports may contain planned
                  amounts and connected wallet transaction details.
                </p>
                {history.plans.length ? (
                  history.plans.map((p) => (
                    <div className="saved-plan" key={p.id}>
                      <div>
                        <span className={`status-badge ${p.mode}`}>
                          {p.mode === "demo" ? "Demo plan" : "Live plan"}
                        </span>
                        <h3>{p.name}</h3>
                        <small>
                          {new Date(p.createdAt).toLocaleString("en-US")} ·{" "}
                          {p.horizonDays} days
                        </small>
                        <p className="small muted">{p.assumptions}</p>
                      </div>
                      <div>
                        <span>Estimated net return</span>
                        <strong>{money(p.expectedNetUSDT)} USDT</strong>
                        <small>
                          Actual net return requires a complete cash-flow ledger
                        </small>
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
                                  ? "The original horizon has ended. Set a new horizon, review paid expenses, and recalculate."
                                  : `Loaded conditions ${restored.elapsedDays} days after the original plan. Review available funds and paid expenses, then recalculate.`,
                              );
                            } catch {
                              setError(
                                "The saved plan format could not be verified.",
                              );
                            }
                          }}
                        >
                          Restore conditions <ArrowRight size={13} />
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
                          View assumptions <Download size={13} />
                        </button>
                      </div>
                    </div>
                  ))
                ) : (
                  <div className="empty-small">
                    Select Save plan in the allocation panel to preserve the
                    original assumptions.
                  </div>
                )}
              </section>
              <section className="card">
                <div className="section-heading">
                  <h2>Transaction history</h2>
                  <span className="small muted">
                    Only signed transactions are recorded
                  </span>
                </div>
                {history.transactions.length ? (
                  history.transactions.map((t) => (
                    <div className="transaction" key={t.id}>
                      <div>
                        <strong>
                          {
                            {
                              "approve-usdt": "USDT spending approval",
                              "supply-usdt": "JustLend supply",
                              "withdraw-usdt": "JustLend withdrawal",
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
                            ? `Actual network fee ${money(t.actualFeeTRX, 6)} TRX`
                            : "Network fee pending"}
                        </small>
                        {t.planId && (
                          <small>Linked plan {t.planId.slice(0, 8)}</small>
                        )}
                        {t.error && (
                          <small className="negative">{t.error}</small>
                        )}
                      </div>
                      <div>
                        <span className={`status-badge ${t.status}`}>
                          {
                            {
                              pending: "Pending",
                              confirmed: "Verified",
                              failed: "Failed",
                              unknown: "Needs review",
                            }[t.status]
                          }
                        </span>
                        <button
                          className="text-button"
                          disabled={!!busy}
                          onClick={() => refreshTransaction(t)}
                        >
                          Check status
                          <RefreshCw size={13} />
                        </button>
                      </div>
                    </div>
                  ))
                ) : (
                  <div className="empty-small">
                    No transactions submitted yet.
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
            <span>Transparent calculations. Execution under your control.</span>
          </footer>
        </main>
      </div>
      {busy && (
        <div className="working-indicator" role="status">
          <Loader2 size={15} className="spin" />
          {busy}…
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
              aria-label="Close transaction preview"
              onClick={() => setPreview(null)}
            >
              <X size={20} />
            </button>
            <div className="eyebrow">REVIEW BEFORE YOU SIGN</div>
            <h2 id="transaction-title">Review your transaction</h2>
            <p>TRON Mainnet · {preview.functionSelector}</p>
            <dl>
              <dt>Amount</dt>
              <dd>{money(preview.amount, 6)} USDT</dd>
              <dt>My wallet</dt>
              <dd>{preview.owner}</dd>
              <dt>Target contract</dt>
              <dd>{preview.to}</dd>
              {preview.spender && (
                <>
                  <dt>Approval spender</dt>
                  <dd>{preview.spender}</dd>
                </>
              )}
              <dt>Estimated network fee</dt>
              <dd>
                {preview.estimatedFeeTRX === null
                  ? "Unavailable"
                  : `${preview.estimatedFeeTRX} TRX`}
              </dd>
              <dt>Energy fee cap</dt>
              <dd>
                {money(preview.feeLimitSun / 1e6, 6)} TRX (Not the estimated
                fee)
              </dd>
              <dt>Quote expires at</dt>
              <dd>{new Date(preview.expiresAt).toLocaleTimeString("en-US")}</dd>
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
              I have reviewed the amount, contract, fees, and approval scope.
            </label>
            <button
              className="primary full"
              disabled={!previewConsent || !!busy || !!history.error}
              onClick={execute}
            >
              <Wallet size={17} />
              Sign and submit in TronLink
            </button>
            <p className="small muted">
              If the result is unclear after signing, check the transaction ID.
              No automatic resubmission.
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
