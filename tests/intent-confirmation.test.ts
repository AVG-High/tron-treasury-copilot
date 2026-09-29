import { describe, expect, it } from "vitest";
import { defaultIntent } from "../src/domain/fixtures";
import type { ParseResult } from "../src/domain/types";
import {
  getIntentReviewRequirements,
  isIntentReviewComplete,
} from "../src/client/intent-confirmation";

const extracted = (
  intent: ParseResult["intent"],
  questions: string[] = [],
): ParseResult => ({ source: "ai", intent, questions, message: "추출 초안" });

describe("explicit confirmation of incomplete AI conditions", () => {
  it("requires acknowledgement before earlier example expenses and horizon become planning inputs", () => {
    const result = extracted({ capitalUSDT: "2000" });
    const prefilled = { ...defaultIntent, ...result.intent };
    expect(prefilled.expenses).toHaveLength(2);
    const review = getIntentReviewRequirements(result);
    expect(review.missingFields).toContain("expenses");
    expect(review.missingFields).toContain("horizonDays");
    expect(review.missingFields).toContain("maxProtocolExposurePct");
    expect(review.missingFields).not.toContain("capitalUSDT");
    expect(isIntentReviewComplete(result, false)).toBe(false);
    expect(isIntentReviewComplete(result, true)).toBe(true);
  });

  it("accepts explicit zero reserves, zero exposure, no expenses and false policies as answers", () => {
    const result = extracted({
      ...defaultIntent,
      emergencyUSDT: "0",
      maxUSDDExposurePct: 0,
      expenses: [],
      allowVolatile: false,
      allowLeverage: false,
    });
    expect(getIntentReviewRequirements(result).missingFields).toEqual([]);
    expect(isIntentReviewComplete(result, false)).toBe(true);
  });

  it("still requires review when a fully populated response has an unresolved conflict", () => {
    const result = extracted(defaultIntent, [
      "7일 뒤 지출과 30일 뒤 지출 중 어느 일정이 맞나요?",
    ]);
    expect(getIntentReviewRequirements(result).missingFields).toEqual([]);
    expect(isIntentReviewComplete(result, false)).toBe(false);
  });

  it("does not claim unsupported leverage was accepted when the parser omits it", () => {
    const { allowLeverage: _unsupported, ...other } = defaultIntent;
    const result = extracted(other, [
      "이 버전은 레버리지를 지원하지 않습니다.",
    ]);
    expect(getIntentReviewRequirements(result).missingLabels).toContain(
      "Exclude borrowing and leverage",
    );
    expect(isIntentReviewComplete(result, false)).toBe(false);
  });

  it("leaves the explicit manual form and initial sample flow available without pretending they were AI extracted", () => {
    expect(isIntentReviewComplete(null, false)).toBe(true);
    expect(
      isIntentReviewComplete(
        { source: "manual", intent: {}, questions: ["직접 입력"], message: "" },
        false,
      ),
    ).toBe(true);
  });

  it("does not alter the extracted draft or its provider questions", () => {
    const result = extracted({ capitalUSDT: "2000" }, [
      "Emergency reserve은 얼마인가요?",
    ]);
    const before = structuredClone(result);
    getIntentReviewRequirements(result).questions.push("local addition");
    expect(result).toEqual(before);
  });
});
