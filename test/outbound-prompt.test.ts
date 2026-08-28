import assert from "node:assert/strict";
import test from "node:test";

import {
  ELEVATEBOX_OUTBOUND_PROMPT,
  ELEVATEBOX_OUTBOUND_START,
  ELEVATEBOX_CALLBACK_START,
} from "../src/prompts/elevatebox-outbound.ts";

test("defines an outbound ElevateBox opening and adaptive discovery flow", () => {
  assert.match(ELEVATEBOX_OUTBOUND_PROMPT, /Ayanabh from ElevateBox/);
  assert.match(ELEVATEBOX_OUTBOUND_PROMPT, /team of developers/i);
  assert.match(ELEVATEBOX_OUTBOUND_PROMPT, /outbound sales call/i);
  assert.match(ELEVATEBOX_OUTBOUND_PROMPT, /You called the lead; the lead did not call you/i);
  assert.match(ELEVATEBOX_OUTBOUND_PROMPT, /Immediately after the lead chooses a language/i);
  assert.match(ELEVATEBOX_OUTBOUND_PROMPT, /Never say or imply "How can I help\?"/i);
  assert.match(ELEVATEBOX_OUTBOUND_PROMPT, /Hindi, Telugu, ya English/i);
  assert.match(ELEVATEBOX_OUTBOUND_PROMPT, /5–15 words/i);
  assert.match(ELEVATEBOX_OUTBOUND_PROMPT, /Never ask more than one question in a turn/i);
  assert.match(ELEVATEBOX_OUTBOUND_PROMPT, /no more than one question mark/i);
  assert.match(ELEVATEBOX_OUTBOUND_PROMPT, /upward intonation/i);
  assert.match(ELEVATEBOX_OUTBOUND_PROMPT, /One light filled pause/i);
  assert.match(ELEVATEBOX_OUTBOUND_PROMPT, /yehi number theek hai na/i);
  assert.match(ELEVATEBOX_OUTBOUND_PROMPT, /do not ask for separate permission/i);
  assert.match(ELEVATEBOX_OUTBOUND_PROMPT, /MANDATORY HANDOFF/);
  assert.match(ELEVATEBOX_OUTBOUND_PROMPT, /Never wait for the lead to bring up WhatsApp first/i);
  assert.match(ELEVATEBOX_OUTBOUND_PROMPT, /first complete the mandatory WhatsApp-consent step/i);
  assert.match(ELEVATEBOX_OUTBOUND_PROMPT, /have no business/i);
  assert.match(ELEVATEBOX_OUTBOUND_PROMPT, /budget range in INR/i);
  assert.match(ELEVATEBOX_OUTBOUND_PROMPT, /timeline/i);
  assert.match(ELEVATEBOX_OUTBOUND_PROMPT, /budget, timing, or decision-maker barrier/i);
  assert.match(ELEVATEBOX_OUTBOUND_PROMPT, /only looking and have no clear need or budget/i);
  assert.match(ELEVATEBOX_OUTBOUND_PROMPT, /do not offer or send anything/i);
  assert.match(ELEVATEBOX_OUTBOUND_PROMPT, /Never mention HOT, WARM, COLD/i);
  assert.match(ELEVATEBOX_OUTBOUND_START, /Begin the outbound call now/i);
  assert.doesNotMatch(ELEVATEBOX_OUTBOUND_START, /AI-assisted/i);
  assert.doesNotMatch(ELEVATEBOX_OUTBOUND_START, /kis language mein comfortable/);
  assert.match(ELEVATEBOX_CALLBACK_START.EN, /You asked me to call back/i);
  assert.match(ELEVATEBOX_CALLBACK_START.HI, /callback ke liye kaha tha/i);
  assert.match(ELEVATEBOX_CALLBACK_START.TE, /తిరిగి కాల్ చేయమని/u);
});
