"use strict";

import { escapeHtml, sanitizeFormattingHtml, chapterNumber } from "./model.js";

const INLINE_TAG = {
  B: "b", STRONG: "b", I: "i", EM: "i", U: "u", S: "s", STRIKE: "s", DEL: "s",
};

/** Converts a scene's sanitized formatting HTML into an array of paragraph inner-HTML
 *  strings, preserving bold/italic/underline/strikethrough. Paragraph breaks in scene text
 *  can show up as <p> (the normal case), literal newlines, <br>, or <div> (contenteditable's
 *  legacy line-break tag) — any run of one or more of those collapses to a single boundary. */
function sceneHtmlToParagraphs(html) {
  const container = document.createElement("div");
  container.innerHTML = sanitizeFormattingHtml(html || "");

  function walk(node) {
    let out = "";
    for (const child of node.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) {
        out += escapeHtml(child.textContent);
      } else if (child.nodeType === Node.ELEMENT_NODE) {
        if (child.tagName === "BR") {
          out += "\n";
        } else if (child.tagName === "P") {
          out += walk(child) + "\n\n";
        } else if (child.tagName === "DIV") {
          out += walk(child) + "\n";
        } else if (INLINE_TAG[child.tagName]) {
          const tag = INLINE_TAG[child.tagName];
          out += `<${tag}>${walk(child)}</${tag}>`;
        } else {
          out += walk(child);
        }
      }
    }
    return out;
  }

  return walk(container)
    .split(/\n+/)
    .map((p) => p.trim())
    .filter(Boolean);
}

function chapterToHtml(ch) {
  const scenesHtml = ch.scenes
    .map((sc) => {
      const paragraphs = sceneHtmlToParagraphs(sc.text)
        .map((p) => `<p>${p}</p>`)
        .join("\n");
      return `<div class="ms-scene">${paragraphs}</div>`;
    })
    .join("\n");

  return `
    <section class="ms-chapter">
      <header class="ms-chapter-heading">
        <div class="ms-chapter-num">Chapter ${chapterNumber(ch)}</div>
        <div class="ms-chapter-title">${escapeHtml(ch.title)}</div>
      </header>
      ${scenesHtml}
    </section>`;
}

export function buildManuscriptDocument(data) {
  const title = data.title || "Untitled Book";
  const chaptersHtml = data.chapters.map(chapterToHtml).join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Lora:wght@400;500;600&display=swap" rel="stylesheet">
<style>
  :root{color-scheme:light}
  *{box-sizing:border-box}
  body{
    margin:0; padding:64px 24px 96px; background:#fff; color:#1a1a1a;
    font:400 16px/1.7 'Lora',Georgia,serif;
  }
  .ms-title{max-width:640px;margin:0 auto 72px;text-align:center}
  .ms-title h1{font-size:28px;font-weight:600;margin:0;letter-spacing:.01em}
  .ms-chapter{max-width:640px;margin:0 auto}
  .ms-chapter + .ms-chapter{margin-top:96px}
  .ms-chapter-heading{text-align:center;margin-bottom:48px}
  .ms-chapter-num{font-size:13px;font-weight:600;letter-spacing:.12em;text-transform:uppercase;color:#666}
  .ms-chapter-title{font-size:21px;font-weight:600;margin-top:6px}
  .ms-scene p{margin:0 0 1em;text-align:justify;text-justify:inter-word}
  .ms-scene + .ms-scene{margin-top:2.75em}
  @media print{
    body{padding:0}
    .ms-chapter{page-break-before:always}
    .ms-chapter:first-of-type{page-break-before:avoid}
  }
</style>
</head>
<body>
  <div class="ms-title"><h1>${escapeHtml(title)}</h1></div>
  ${chaptersHtml}
</body>
</html>`;
}

/** Opens the formatted manuscript in a new tab as a self-contained HTML document, ready to
 *  read or print/save-as-PDF from the browser's own print dialog. */
export function exportManuscript(data) {
  const html = buildManuscriptDocument(data);
  const blob = new Blob([html], { type: "text/html" });
  const url = URL.createObjectURL(blob);
  window.open(url, "_blank");
}
