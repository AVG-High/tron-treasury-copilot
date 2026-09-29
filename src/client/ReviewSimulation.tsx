import { useState } from "react";
import { FlaskConical } from "lucide-react";
import { replayPlan } from "../domain/replay";
import type { PlanningResult } from "../domain/types";
export function ReviewSimulation({
  result,
  planId,
}: {
  result: PlanningResult;
  planId: string;
}) {
  const [rate, setRate] = useState(0.5),
    [cost, setCost] = useState(1.5);
  const replay = replayPlan(result, planId, {
    rateMultiplier: rate,
    costMultiplier: cost,
  });
  const show = (value: string) =>
    Number(value).toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  return (
    <section className="card review-simulation">
      <div className="section-heading">
        <h2>
          <FlaskConical size={18} />
          What changed from the original plan?
        </h2>
        <span className="tag">Simulated review</span>
      </div>
      <p className="small muted">
        Replay the selected allocation with different rates and costs. These are
        not real positions or realized returns.
      </p>
      <div className="replay-controls">
        <label>
          Rate multiplier <strong>{Math.round(rate * 100)}%</strong>
          <input
            aria-label="Review rate multiplier"
            type="range"
            min="0"
            max="2"
            step="0.1"
            value={rate}
            onChange={(e) => setRate(Number(e.target.value))}
          />
        </label>
        <label>
          Cost multiplier <strong>{Math.round(cost * 100)}%</strong>
          <input
            aria-label="Review cost multiplier"
            type="range"
            min="0"
            max="3"
            step="0.1"
            value={cost}
            onChange={(e) => setCost(Number(e.target.value))}
          />
        </label>
      </div>
      <div className="replay-results">
        <div>
          <span>Original estimated net return</span>
          <strong>
            {show(replay.expectedNetUSDT)}
            <small> USDT</small>
          </strong>
        </div>
        <div>
          <span>Simulated net return</span>
          <strong>
            {show(replay.simulatedNetUSDT)}
            <small> USDT</small>
          </strong>
        </div>
        <div>
          <span>Difference from plan</span>
          <strong className={Number(replay.deltaUSDT) < 0 ? "negative" : ""}>
            {show(replay.deltaUSDT)}
            <small> USDT</small>
          </strong>
        </div>
      </div>
      <p className="small muted">
        Reset both multipliers to 100% to reproduce the original plan.
        Additional cash flows, depegging, and losses are outside this scenario.
      </p>
    </section>
  );
}
