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
          예상과 결과, 무엇이 달라졌을까요?
        </h2>
        <span className="tag">가상 회고</span>
      </div>
      <p className="small muted">
        현재 선택한 배분을 유지한 채 금리·비용이 달라진 경우를 재생합니다. 실제
        포지션이나 실현 수익이 아닙니다.
      </p>
      <div className="replay-controls">
        <label>
          금리 변화 <strong>{Math.round(rate * 100)}%</strong>
          <input
            aria-label="회고 금리 비율"
            type="range"
            min="0"
            max="2"
            step="0.1"
            value={rate}
            onChange={(e) => setRate(Number(e.target.value))}
          />
        </label>
        <label>
          비용 변화 <strong>{Math.round(cost * 100)}%</strong>
          <input
            aria-label="회고 비용 비율"
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
          <span>원래 계획 순수익</span>
          <strong>
            {show(replay.expectedNetUSDT)}
            <small> USDT</small>
          </strong>
        </div>
        <div>
          <span>가상 결과 순수익</span>
          <strong>
            {show(replay.simulatedNetUSDT)}
            <small> USDT</small>
          </strong>
        </div>
        <div>
          <span>계획 대비 차이</span>
          <strong className={Number(replay.deltaUSDT) < 0 ? "negative" : ""}>
            {show(replay.deltaUSDT)}
            <small> USDT</small>
          </strong>
        </div>
      </div>
      <p className="small muted">
        금리·비용을 모두 100%로 되돌리면 원래 계획과 같은 결과가 나옵니다. 추가
        입출금·디페그·손실은 이 시나리오에 포함하지 않습니다.
      </p>
    </section>
  );
}
