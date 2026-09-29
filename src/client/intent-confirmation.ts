import type { ParseResult, TreasuryIntent } from "../domain/types.js";

const intentFields: Array<[keyof TreasuryIntent, string]> = [
  ["capitalUSDT", "총 계획 자금"],
  ["horizonDays", "남는 돈 운용 기간"],
  ["emergencyUSDT", "비상금"],
  ["expenses", "예정 지출"],
  ["maxUSDDExposurePct", "USDD 노출 상한"],
  ["maxProtocolExposurePct", "JustLend 노출 상한"],
  ["allowVolatile", "변동 자산 투자 제외"],
  ["allowLeverage", "차입·레버리지 제외"],
];

/**
 * Parsing must not turn values retained from an example or an earlier plan into
 * conditions supplied by the user. Explicit false, zero and [] remain answers.
 * Provider questions can also describe conflicts in otherwise complete fields.
 */
export function getIntentReviewRequirements(parse: ParseResult | null) {
  if (!parse || parse.source !== "ai") {
    return {
      required: false,
      missingFields: [] as Array<keyof TreasuryIntent>,
      missingLabels: [] as string[],
      questions: [] as string[],
    };
  }
  const missing = intentFields.filter(
    ([field]) =>
      parse.intent[field] === undefined || parse.intent[field] === null,
  );
  return {
    required: missing.length > 0 || parse.questions.length > 0,
    missingFields: missing.map(([field]) => field),
    missingLabels: missing.map(([, label]) => label),
    questions: [...parse.questions],
  };
}

/** The UI must reset reviewed whenever it changes the current input or parse. */
export function isIntentReviewComplete(
  parse: ParseResult | null,
  reviewed: boolean,
): boolean {
  return !getIntentReviewRequirements(parse).required || reviewed;
}
