"use strict";

/** Classic LCS-based line diff. Returns an array of { type: "same"|"add"|"remove", text }
 *  describing how to turn `oldText` into `newText`, line by line. Fine for manuscript-scale
 *  text (a scene, a manifest, a bible file) — not meant for huge documents. */
export function diffLines(oldText, newText) {
  const a = (oldText || "").split("\n");
  const b = (newText || "").split("\n");
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
