import type { SupportedLanguage } from "../contracts.ts";

/** Only explicit language choices lock the base language; code-switching does not. */
export function explicitLanguageChoice(
  text: string,
  precedingAssistantText?: string,
): Extract<SupportedLanguage, "EN" | "HI" | "TE"> | undefined {
  const normalized = text.trim().toLowerCase().replace(/[.!?,]/g, " ")
    .replace(/\s+/g, " ").trim();
  const preceding = precedingAssistantText?.trim().toLowerCase() ?? "";
  const followsLanguageQuestion =
    /(?:language|भाषा|భాష)/iu.test(preceding) &&
    /(?:comfortable|prefer|which|what|kis|किस|ఏది|ఎలాంటి|में|లో)/iu.test(preceding);
  const explicitLaterSwitch =
    /\b(?:switch|change|continue|speak|talk|prefer)\b.{0,30}\b(?:english|hindi|telugu|telegu)\b/iu.test(normalized) ||
    /(?:हिंदी|हिन्दी|తెలుగు).{0,20}(?:बात|बोल|మాట్లాడ)/iu.test(normalized);

  // The normal lock is accepted only as the answer to the dedicated language
  // question. Outside that exchange, require an explicit request to switch.
  if (!followsLanguageQuestion && !explicitLaterSwitch) return undefined;

  if (
    /^(?:english|english please|i prefer english|speak in english)$/iu.test(normalized) ||
    /\b(?:prefer|comfortable with|fine with|continue in|speak in|talk in|use)\s+english\b/iu.test(normalized) ||
    /\benglish\s+(?:is|would be|will be)?\s*(?:fine|okay|ok|good|comfortable)\b/iu.test(normalized)
  ) {
    return "EN";
  }
  if (
    /^(?:hindi|hindi please|i prefer hindi|speak in hindi|हिंदी|हिन्दी)$/iu.test(normalized) ||
    /\b(?:prefer|comfortable with|fine with|continue in|speak in|talk in|use)\s+(?:hindi|हिंदी|हिन्दी)\b/iu.test(normalized) ||
    /(?:hindi|हिंदी|हिन्दी)(?:\s+mein|\s+me|\s+में)?\s+(?:baat|बात|ठीक|theek|fine|okay|ok)/iu.test(normalized)
  ) {
    return "HI";
  }
  if (
    /^(?:telugu|telegu|telugu please|telegu please|i prefer telugu|speak in telugu|తెలుగు)$/iu.test(normalized) ||
    /\b(?:prefer|comfortable with|fine with|continue in|speak in|talk in|use)\s+(?:telugu|telegu)\b/iu.test(normalized) ||
    /(?:telugu|telegu|తెలుగు)(?:\s+lo|లో)?\s+(?:matlad|మాట్లాడ|fine|okay|ok)/iu.test(normalized)
  ) {
    return "TE";
  }

  if (followsLanguageQuestion || explicitLaterSwitch) {
    const mentioned = [
      /\benglish\b/iu.test(normalized) ? "EN" as const : undefined,
      /\b(?:hindi)\b|हिंदी|हिन्दी/iu.test(normalized) ? "HI" as const : undefined,
      /\b(?:telugu|telegu)\b|తెలుగు/iu.test(normalized) ? "TE" as const : undefined,
    ].filter((item): item is "EN" | "HI" | "TE" => item !== undefined);
    if (mentioned.length === 1) return mentioned[0];
  }
  return undefined;
}
