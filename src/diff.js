"use strict";

/** Classic LCS-based diff over two token arrays. Returns an array of
 *  { type: "same"|"add"|"remove", text } describing how to turn `a` into `b`, one token at a
 *  time. Shared by `diffLines` (tokens = lines) and `diffWords` (tokens = words) below. Fine for
 *  manuscript-scale text (a scene, a manifest, a bible file) — not meant for huge documents. */
function diffTokens(a, b) {
  const n = a.length;
  const m = b.length;

  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const result = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      result.push({ type: "same", text: a[i] });
      i++; j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      result.push({ type: "remove", text: a[i] });
      i++;
    } else {
      result.push({ type: "add", text: b[j] });
      j++;
    }
  }
  while (i < n) { result.push({ type: "remove", text: a[i] }); i++; }
  while (j < m) { result.push({ type: "add", text: b[j] }); j++; }
  return result;
}

/** Line-by-line diff of two whole files — the raw, everything-included view (frontmatter and
 *  all). Used for the "raw file diff" fallback, not the field-level conflict summary. */
export function diffLines(oldText, newText) {
  return diffTokens((oldText || "").split("\n"), (newText || "").split("\n"));
}

/** Word-by-word diff of two strings, splitting on (and preserving) whitespace so the result can
 *  be rejoined into readable prose with additions/removals highlighted inline — the "track
 *  changes" style view used for a single changed field (title, summary, scene text). */
export function diffWords(oldText, newText) {
  const split = (s) => (s || "").split(/(\s+)/).filter((t) => t !== "");
  return diffTokens(split(oldText), split(newText));
}
