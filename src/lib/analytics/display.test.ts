// SHOPEE-8 display helpers (pure) — node --test src/lib/analytics/display.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";

import { formatMoney, formatPct, formatSignedMoney, profitWord, roundDecimalString } from "./display.ts";

test("SHOPEE-8 47: textual rounding to the đồng (no float)", () => {
  assert.equal(roundDecimalString("1116212.235967348313"), "1116212");
  assert.equal(roundDecimalString("1535744.65"), "1535745");
  assert.equal(roundDecimalString("999999.5"), "1000000");
  assert.equal(roundDecimalString("-0.4"), "0");
  assert.equal(roundDecimalString("-10000.50"), "-10001");
  assert.equal(roundDecimalString("12345678901234567.5"), "12345678901234568", "beyond float precision stays exact");
  assert.equal(roundDecimalString(null), null);
  assert.equal(formatMoney("1116212.24"), "1.116.212 ₫");
  assert.equal(formatMoney(null), "—", "missing is never 0");
});

test("SHOPEE-8 99: sign + number + word, percentages", () => {
  assert.equal(formatSignedMoney("-10000.00"), "−10.000 ₫");
  assert.equal(formatSignedMoney("817277.27"), "+817.277 ₫");
  assert.equal(profitWord("-1"), "lỗ");
  assert.equal(profitWord("0.00"), "hoà vốn");
  assert.equal(profitWord(null), "chưa đủ dữ liệu");
  assert.equal(formatPct("14.0"), "14,0%");
  assert.equal(formatPct("43.4"), "43,4%");
  assert.equal(formatPct("-5"), "−5,0%");
  assert.equal(formatPct(null), "—");
});
