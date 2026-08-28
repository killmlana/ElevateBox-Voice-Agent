import assert from "node:assert/strict";
import test from "node:test";

import { explicitLanguageChoice } from "../src/domain/language-choice.ts";

const question = "Aap Hindi, Telugu, ya English—kis language mein comfortable hain?";

test("locks natural language-choice answers using the preceding question", () => {
  assert.equal(
    explicitLanguageChoice("I am comfortable with English.", question),
    "EN",
  );
  assert.equal(
    explicitLanguageChoice("Hindi mein baat kar sakte hain.", question),
    "HI",
  );
  assert.equal(
    explicitLanguageChoice("Telugu would be okay.", question),
    "TE",
  );
});

test("does not lock an ambiguous multi-language answer", () => {
  assert.equal(
    explicitLanguageChoice("Hindi or English, both are okay.", question),
    undefined,
  );
});

test("does not infer a lock from ordinary later code-switching", () => {
  assert.equal(
    explicitLanguageChoice("Our English catalogue also needs Hindi pages.", "How many products do you sell?"),
    undefined,
  );
  assert.equal(
    explicitLanguageChoice("Please switch to English.", "What is your budget?"),
    "EN",
  );
});
