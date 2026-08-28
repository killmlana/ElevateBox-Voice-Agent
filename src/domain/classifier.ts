import type { IntentClassification, LeadState } from "../contracts.ts";

function evidenceTurns(state: LeadState): string[] {
  return [
    ...state.customerType.sourceTurnIds,
    ...state.locations.flatMap((item) => item.sourceTurnIds),
    ...(state.budgetInr?.sourceTurnIds ?? []),
    ...(state.timeline?.sourceTurnIds ?? []),
    ...state.buyingSignals.flatMap((item) => item.sourceTurnIds),
    ...state.negativeSignals.flatMap((item) => item.sourceTurnIds),
    ...state.blockers.flatMap((item) => item.sourceTurnIds),
  ].filter((value, index, values) => values.indexOf(value) === index);
}

export class DeterministicLeadClassifier {
  classify(state: LeadState): IntentClassification {
    const signals = new Set(state.buyingSignals.map((item) => item.value));
    const blockers = new Set(state.blockers.map((item) => item.value));
    const negativeSignals = new Set(
      state.negativeSignals.map((item) => item.value),
    );
    const hasConcreteNeed =
      signals.has("clear_need") ||
      state.requirements.length > 0;
    const hasTimingBarrier =
      blockers.has("timing_barrier") ||
      blockers.has("timing_or_interest_barrier");
    const isJustLooking =
      blockers.has("just_looking") ||
      blockers.has("no_clear_need") ||
      (
        !hasConcreteNeed &&
        signals.has("pricing_interest") &&
        state.budgetInr === undefined &&
        state.timeline === undefined &&
        !signals.has("start_soon")
      ) ||
      (hasTimingBarrier && !hasConcreteNeed);
    const turns = evidenceTurns(state);
    const scoreBreakdown: IntentClassification["scoreBreakdown"] = [];
    const add = (factor: string, delta: number): void => {
      scoreBreakdown.push({ factor, delta });
    };

    if (state.budgetInr) add("budget stated", 2);
    if (state.timeline) add("timeline stated", 1);
    if (signals.has("clear_need")) add("clear need", 1);
    if (signals.has("pricing_interest")) add("pricing interest", 2);
    if (signals.has("start_soon")) add("wants to start soon", 2);
    if (signals.has("send_details")) add("asked for details", 2);
    if (state.requirements.length >= 2) add("multiple requirements", 1);
    if (state.customerType.value === "INDIVIDUAL") {
      add("no existing business", -1);
    }
    if (hasTimingBarrier) {
      add("not ready or no current interest", -2);
    }
    if (negativeSignals.has("hostile_or_abusive")) {
      add("hostile or abusive response", -4);
    }
    if (negativeSignals.has("repeated_call_complaint")) {
      add("complaint about repeated calls", -12);
    }
    if (negativeSignals.has("not_interested")) {
      add("explicitly not interested", -15);
    }
    if (negativeSignals.has("do_not_contact")) {
      add("asked not to be contacted", -20);
    }
    const score = scoreBreakdown.reduce((total, item) => total + item.delta, 0);

    if (state.callback.declinedWithoutAlternative) {
      return {
        intent: "COLD",
        score,
        scoreBreakdown,
        confidence: 0.94,
        evidenceTurnIds: turns,
        rationale: "The lead declined the proposed callback and did not offer another time.",
      };
    }

    if (
      negativeSignals.has("do_not_contact") ||
      negativeSignals.has("not_interested") ||
      negativeSignals.has("repeated_call_complaint")
    ) {
      return {
        intent: "COLD",
        score,
        scoreBreakdown,
        confidence: negativeSignals.has("do_not_contact") ? 0.99 : 0.95,
        evidenceTurnIds: turns,
        rationale: negativeSignals.has("do_not_contact")
          ? "The lead explicitly asked not to be contacted, which overrides sales qualification evidence."
          : "The lead expressed clear negative intent or frustration about repeated outreach.",
      };
    }

    if (negativeSignals.has("hostile_or_abusive") && score <= 0) {
      return {
        intent: "COLD",
        score,
        scoreBreakdown,
        confidence: 0.9,
        evidenceTurnIds: turns,
        rationale: "The lead responded with hostility and provided no countervailing buying intent.",
      };
    }

    if (isJustLooking) {
      return {
        intent: "COLD",
        score,
        scoreBreakdown,
        confidence: 0.9,
        evidenceTurnIds: turns,
        rationale: "The lead is only exploring and has not expressed a concrete need or buying commitment.",
      };
    }

    if (
      hasConcreteNeed &&
      (
        state.decisionMaker.value === "OTHER" ||
        blockers.has("budget_barrier") ||
        hasTimingBarrier ||
        blockers.has("other_decision_maker")
      )
    ) {
      return {
        intent: "WARM",
        score,
        scoreBreakdown,
        confidence: 0.86,
        evidenceTurnIds: turns,
        rationale: "There is a real need, but budget, timing, or another decision-maker is a material blocker.",
      };
    }

    const asksPriceAndTimeline =
      hasConcreteNeed &&
      signals.has("pricing_interest") &&
      (state.timeline !== undefined || signals.has("start_soon"));
    if (
      asksPriceAndTimeline ||
      (score >= 6 && hasConcreteNeed && (state.budgetInr || state.timeline))
    ) {
      return {
        intent: "HOT",
        score,
        scoreBreakdown,
        confidence: Math.min(0.97, 0.72 + score * 0.03),
        evidenceTurnIds: turns,
        rationale: "Accumulated budget/timeline evidence and active buying signals indicate near-term purchase intent.",
      };
    }

    if (
      hasConcreteNeed &&
      (score >= 1 || (score >= 0 && signals.has("clear_need")))
    ) {
      return {
        intent: "WARM",
        score,
        scoreBreakdown,
        confidence: Math.min(0.88, 0.62 + score * 0.04),
        evidenceTurnIds: turns,
        rationale: "The lead has a plausible need or commercial signal, but commitment evidence is incomplete.",
      };
    }

    return {
      intent: "UNKNOWN",
      score,
      scoreBreakdown,
      confidence: 0.4,
      evidenceTurnIds: turns,
      rationale: "The conversation does not yet contain enough evidence to qualify the lead.",
    };
  }
}
