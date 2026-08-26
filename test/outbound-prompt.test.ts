import assert from "node:assert/strict";
import test from "node:test";

import {
  ELEVATEBOX_OUTBOUND_PROMPT,
  ELEVATEBOX_OUTBOUND_START,
} from "../src/prompts/elevatebox-outbound.ts";

test("defines an outbound ElevateBox opening and adaptive discovery flow", () => {
  assert.match(ELEVATEBOX_OUTBOUND_PROMPT, /Ayanabh from ElevateBox/);
  assert.match(ELEVATEBOX_OUTBOUND_PROMPT, /team of developers/i);
  assert.match(ELEVATEBOX_OUTBOUND_PROMPT, /outbound sales call/i);
  assert.match(ELEVATEBOX_OUTBOUND_PROMPT, /Hindi, Telugu, ya English/i);
  assert.match(ELEVATEBOX_OUTBOUND_PROMPT, /10–25 spoken words/i);
  assert.match(ELEVATEBOX_OUTBOUND_PROMPT, /upward intonation/i);
  assert.match(ELEVATEBOX_OUTBOUND_PROMPT, /one light filled pause/i);
  assert.match(ELEVATEBOX_OUTBOUND_PROMPT, /yehi number theek hai na/i);
  assert.match(ELEVATEBOX_OUTBOUND_PROMPT, /do not ask for separate permission/i);
  assert.match(ELEVATEBOX_OUTBOUND_PROMPT, /do not have a business/i);
  assert.match(ELEVATEBOX_OUTBOUND_PROMPT, /budget range in INR/i);
  assert.match(ELEVATEBOX_OUTBOUND_PROMPT, /timeline/i);
  assert.match(ELEVATEBOX_OUTBOUND_PROMPT, /budget, timing, or decision-maker barrier/i);
  assert.match(ELEVATEBOX_OUTBOUND_PROMPT, /only looking and has no clear need or budget/i);
  assert.match(ELEVATEBOX_OUTBOUND_PROMPT, /do not offer or send anything/i);
  assert.match(ELEVATEBOX_OUTBOUND_PROMPT, /Never say HOT, WARM, COLD/i);
  assert.match(ELEVATEBOX_OUTBOUND_START, /Begin the outbound call now/i);
  assert.doesNotMatch(ELEVATEBOX_OUTBOUND_START, /AI-assisted/i);
  assert.doesNotMatch(ELEVATEBOX_OUTBOUND_START, /kis language mein comfortable/);
});
