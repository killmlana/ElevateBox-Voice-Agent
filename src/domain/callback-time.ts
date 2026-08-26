import type { CallbackResolution } from "../contracts.ts";

const IST_OFFSET_MINUTES = 330;

function localDatePartsInIst(base: Date): {
  year: number;
  month: number;
  day: number;
} {
  const local = new Date(base.getTime() + IST_OFFSET_MINUTES * 60_000);
  return {
    year: local.getUTCFullYear(),
    month: local.getUTCMonth(),
    day: local.getUTCDate(),
  };
}

function istLocalToIso(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
): string {
  return new Date(
    Date.UTC(year, month, day, hour, minute) - IST_OFFSET_MINUTES * 60_000,
  ).toISOString();
}

function parseHour(raw: string): { hour: number; minute: number } | undefined {
  const match = raw.match(/\b(?:at\s+)?([0-9]{1,2})(?::([0-9]{2}))?\s*(am|pm)\b/i);
  if (!match?.[1]) return undefined;
  let hour = Number(match[1]);
  const minute = match[2] ? Number(match[2]) : 0;
  const meridiem = match[3]?.toLowerCase();
  if (hour < 1 || hour > 12 || minute > 59) return undefined;
  if (meridiem === "pm" && hour !== 12) hour += 12;
  if (meridiem === "am" && hour === 12) hour = 0;
  return { hour, minute };
}

const NUMBER_WORD_HOURS: ReadonlyArray<readonly [string, number]> = [
  ["ग्यारह", 11], ["बारह", 12], ["పన్నెండు", 12], ["పదకొండు", 11],
  ["एक", 1], ["दो", 2], ["तीन", 3], ["चार", 4], ["पांच", 5], ["पाँच", 5],
  ["छह", 6], ["छः", 6], ["सात", 7], ["आठ", 8], ["नौ", 9], ["दस", 10],
  ["ఒకటి", 1], ["ఒక", 1], ["రెండు", 2], ["మూడు", 3], ["నాలుగు", 4],
  ["ఐదు", 5], ["ఆరు", 6], ["ఏడు", 7], ["ఎనిమిది", 8], ["తొమ్మిది", 9],
  ["పది", 10],
];

function normalizeLocalizedDigits(value: string): string {
  const devanagari = "०१२३४५६७८९";
  const telugu = "౦౧౨౩౪౫౬౭౮౯";
  return [...value].map((character) => {
    const devanagariIndex = devanagari.indexOf(character);
    if (devanagariIndex >= 0) return String(devanagariIndex);
    const teluguIndex = telugu.indexOf(character);
    return teluguIndex >= 0 ? String(teluguIndex) : character;
  }).join("");
}

function localizedHour(
  raw: string,
  period: "morning" | "afternoon" | "evening" | undefined,
): { hour: number; minute: number } | undefined {
  if (!period) return undefined;
  const normalized = normalizeLocalizedDigits(raw);
  const numeric = normalized.match(
    /(?:\bat\s+)?([0-9]{1,2})(?::([0-9]{2}))?\s*(?:बजे|గంట(?:లకు)?|గంటలకి)/iu,
  );
  let hour = numeric?.[1] ? Number(numeric[1]) : undefined;
  const minute = numeric?.[2] ? Number(numeric[2]) : 0;
  if (hour === undefined) {
    hour = NUMBER_WORD_HOURS.find(([word]) => normalized.includes(word))?.[1];
  }
  if (hour === undefined || hour < 1 || hour > 12 || minute > 59) return undefined;
  if (period !== "morning" && hour !== 12) hour += 12;
  if (period === "morning" && hour === 12) hour = 0;
  return { hour, minute };
}

export function resolveCallbackTime(rawTime: string, base: Date): CallbackResolution {
  const normalized = normalizeLocalizedDigits(rawTime.trim().toLowerCase());
  if (!normalized) return { status: "not_requested" };

  const isMorning = /\bmorning\b|सुबह|ఉదయం/iu.test(normalized);
  const isAfternoon = /\b(?:afternoon|after lunch)\b|दोपहर|మధ్యాహ్నం/iu.test(normalized);
  const isEvening = /\b(?:evening|tonight)\b|शाम|रात|సాయంత్రం|రాత్రి/iu.test(normalized);
  const period = isMorning
    ? "morning"
    : isAfternoon
    ? "afternoon"
    : isEvening
    ? "evening"
    : undefined;
  const explicitHour = parseHour(normalized) ?? localizedHour(normalized, period);
  const isTomorrow = /\btomorrow\b|कल|రేపు/iu.test(normalized);
  const isToday = /\b(?:today|this evening|tonight)\b|आज|ఈరోజు|నేడు/iu.test(normalized);
  if (!isTomorrow && !isToday) {
    return {
      status: "needs_clarification",
      rawTime,
      reason: "A relative day or explicit supported date is required.",
    };
  }

  let time = explicitHour;
  if (!time && isMorning) time = { hour: 10, minute: 0 };
  if (!time && isAfternoon) {
    time = { hour: 15, minute: 0 };
  }
  if (!time && isEvening) {
    time = { hour: 18, minute: 0 };
  }
  if (!time) {
    return {
      status: "needs_clarification",
      rawTime,
      reason: "The callback day is known, but the time or time window is missing.",
    };
  }

  const local = localDatePartsInIst(base);
  const dayOffset = isTomorrow ? 1 : 0;
  const targetDate = new Date(Date.UTC(local.year, local.month, local.day + dayOffset));
  return {
    status: "resolved",
    rawTime,
    resolvedAt: istLocalToIso(
      targetDate.getUTCFullYear(),
      targetDate.getUTCMonth(),
      targetDate.getUTCDate(),
      time.hour,
      time.minute,
    ),
  };
}
