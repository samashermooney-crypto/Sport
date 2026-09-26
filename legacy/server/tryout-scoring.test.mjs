import test from "node:test";
import assert from "node:assert/strict";
import { parseTryoutScore, tryoutAttributeAverage, tryoutAttributeCanAffectRating } from "./tryout-scoring.mjs";

test("tryout scores preserve missing values, boolean answers and numeric measurements", () => {
  assert.equal(parseTryoutScore("yes-no", false), false);
  assert.equal(parseTryoutScore("measurement", 0), 0);
  assert.equal(parseTryoutScore("measurement", 6.72), 6.72);
  for (const [scale, value] of [["1-3", 4], ["1-5", 0], ["1-5", 2.5], ["yes-no", 1], ["measurement", "6.72"], ["measurement", Infinity], ["measurement", NaN]])
    assert.throws(() => parseTryoutScore(scale, value));
  assert.throws(() => parseTryoutScore("unknown", null));
});

test("attribute averages exclude unscored evaluators without dropping zero or No", () => {
  assert.equal(tryoutAttributeAverage("1-5", [5, null, 3]), 4);
  assert.equal(tryoutAttributeAverage("measurement", [0, 10, null]), 5);
  assert.equal(tryoutAttributeAverage("yes-no", [false, true, null]), 0.5);
  assert.equal(tryoutAttributeAverage("1-3", [null, null]), null);
  assert.equal(tryoutAttributeAverage("1-3", []), null);
  assert.equal(tryoutAttributeCanAffectRating("measurement"), false);
  assert.equal(tryoutAttributeCanAffectRating("yes-no"), true);
});
