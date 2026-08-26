import type {
  Evidence,
  ExtractedLeadUpdate,
  NegativeLeadSignal,
} from "../contracts.ts";

const PATTERNS: ReadonlyArray<{
  signal: NegativeLeadSignal;
  patterns: readonly RegExp[];
}> = [
  {
    signal: "do_not_contact",
    patterns: [
      /\b(?:do\s+not|don['’]?t|dont|stop|never)\s+(?:call|contact|phone)(?:ing)?\b/iu,
      /\b(?:call|phone)\s+(?:me\s+)?(?:mat|nahi|nahin|na)\b/iu,
      /(?:कॉल|फोन|फ़ोन)\s*(?:मत|नहीं|ना)\s*(?:कर|कीजिए|करना)?/u,
      /(?:కాల్|ఫోన్).*(?:చేయకండి|చేయొద్దు|వద్దు)/u,
    ],
  },
  {
    signal: "not_interested",
    patterns: [
      /\b(?:not interested|no interest|i do not want|i don['’]?t want)\b/iu,
      /(?:दिलचस्पी|इंटरेस्ट)\s*(?:नहीं|नही)|मुझे\s+(?:यह|ये|इसमें)?\s*नहीं\s*चाहिए/u,
      /\b(?:interest|interested)\s+(?:nahi|nahin|na)\b/iu,
      /(?:ఆసక్తి లేదు|నాకు వద్దు)/u,
    ],
  },
  {
    signal: "repeated_call_complaint",
    patterns: [
      /\bwhy\s+(?:do\s+)?(?:you\s+)?(?:keep\s+)?call(?:ing)?\b/iu,
      /(?:क्यों|क्यूँ|क्युं).*(?:बार.?बार|इतनी|इतना|फिर).*(?:कॉल|फोन|फ़ोन)|(?:बार.?बार|इतनी|इतना).*(?:कॉल|फोन|फ़ोन)/u,
      /\b(?:bar\s*bar|baar\s*baar).*(?:call|phone)\b/iu,
      /(?:ఎందుకు|మళ్లీ మళ్లీ).*(?:కాల్|ఫోన్)/u,
    ],
  },
  {
    signal: "hostile_or_abusive",
    patterns: [
      /\b(?:idiot|stupid|moron|useless|asshole|fuck(?:ing)?|chutiya|bewakoof)\b/iu,
      /(?:बेवकूफ|चूतिया|निकम्म|गधा)/u,
      /(?:మూర్ఖుడు|వెధవ|చెత్త)/u,
    ],
  },
];

export function detectNegativeLeadSignals(text: string): NegativeLeadSignal[] {
  return PATTERNS
    .filter(({ patterns }) => patterns.some((pattern) => pattern.test(text)))
    .map(({ signal }) => signal);
}

export function addDeterministicNegativeSignals(
  update: ExtractedLeadUpdate,
  turnId: string,
  turnText: string,
): ExtractedLeadUpdate {
  const merged = new Map<NegativeLeadSignal, Evidence<NegativeLeadSignal>>(
    update.negativeSignals.map((item) => [item.value, item]),
  );
  for (const signal of detectNegativeLeadSignals(turnText)) {
    if (merged.has(signal)) continue;
    merged.set(signal, {
      value: signal,
      sourceTurnIds: [turnId],
      confidence: 1,
    });
  }
  return { ...update, negativeSignals: [...merged.values()] };
}
