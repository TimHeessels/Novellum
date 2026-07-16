"use strict";

import { escapeHtml, sanitizeFormattingHtml, chapterNumber } from "./model.js";
import { createZipBlob } from "./zip.js";

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
  /* Page number only, bottom-center — Chromium 131+/Safari 18.2+ render this from the page
   * box itself, so it appears regardless of the browser's own "headers and footers" print
   * option (which independently adds its own title/URL/date and can't be suppressed from the
   * page — the user has to uncheck that in the print dialog to avoid the two overlapping). */
  @page{
    margin:0.85in 0.75in 0.9in 0.75in;
    @bottom-center{
      content: counter(page);
      font: 400 10px 'Manrope', Arial, sans-serif;
      color:#888;
    }
  }
</style>
</head>
<body>
  <div class="ms-title"><h1>${escapeHtml(title)}</h1></div>
  ${chaptersHtml}
  <script>window.addEventListener("load", () => window.print());</script>
</body>
</html>`;
}

/** Opens the formatted manuscript in a new tab and triggers the browser's print dialog, so
 *  "Save as PDF" there produces a real paginated PDF (correct page breaks, selectable text) —
 *  far higher quality than a canvas-rasterized PDF library could give a text-heavy manuscript. */
export function exportManuscript(data) {
  const html = buildManuscriptDocument(data);
  const blob = new Blob([html], { type: "text/html" });
  const url = URL.createObjectURL(blob);
  window.open(url, "_blank");
}

/* ---------------------------------------------------------------- */
/* EPUB export                                                       */
/* ---------------------------------------------------------------- */

const CONTAINER_XML = `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`;

const EPUB_CSS = `body{font-family:Georgia,'Times New Roman',serif;line-height:1.6;margin:0;padding:0 6%}
.titlepage{text-align:center;margin-top:45%}
.titlepage h1{font-size:1.6em}
.chapter h1{text-align:center;margin:2.5em 0 2em}
.chapter-num{display:block;font-size:.75em;letter-spacing:.12em;text-transform:uppercase;color:#555}
.chapter-title{display:block;font-size:1.3em;margin-top:.3em}
p{margin:0 0 1em;text-align:justify}
p.scene-break{text-align:center;letter-spacing:.4em;margin:1.5em 0}`;

function chapterFileName(index) {
  return `chapter-${index + 1}.xhtml`;
}

function epubUuid() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function chapterToXhtml(ch) {
  const scenesHtml = ch.scenes
    .map((sc) =>
      sceneHtmlToParagraphs(sc.text)
        .map((p) => `<p>${p}</p>`)
        .join("\n")
    )
    .filter(Boolean)
    .join('\n<p class="scene-break">&#8226;&#8226;&#8226;</p>\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="en">
<head>
<meta charset="utf-8"/>
<title>${escapeHtml(ch.title)}</title>
<link rel="stylesheet" type="text/css" href="styles.css"/>
</head>
<body>
<section class="chapter">
<h1><span class="chapter-num">Chapter ${chapterNumber(ch)}</span><span class="chapter-title">${escapeHtml(ch.title)}</span></h1>
${scenesHtml}
</section>
</body>
</html>`;
}

function buildTitlepageXhtml(title) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="en">
<head>
<meta charset="utf-8"/>
<title>${escapeHtml(title)}</title>
<link rel="stylesheet" type="text/css" href="styles.css"/>
</head>
<body>
<section class="titlepage">
<h1>${escapeHtml(title)}</h1>
</section>
</body>
</html>`;
}

function buildNavXhtml(title, chapters) {
  const items = chapters
    .map((ch, i) => `<li><a href="${chapterFileName(i)}">Chapter ${i + 1} &#8212; ${escapeHtml(ch.title)}</a></li>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="en">
<head><meta charset="utf-8"/><title>${escapeHtml(title)}</title></head>
<body>
<nav epub:type="toc" id="toc">
<h1>Contents</h1>
<ol>
${items}
</ol>
</nav>
</body>
</html>`;
}

function buildNcx(title, uuid, chapters) {
  const navPoints = chapters
    .map(
      (ch, i) => `<navPoint id="navPoint-${i + 1}" playOrder="${i + 1}">
<navLabel><text>Chapter ${i + 1} &#8212; ${escapeHtml(ch.title)}</text></navLabel>
<content src="${chapterFileName(i)}"/>
</navPoint>`
    )
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
<head>
<meta name="dtb:uid" content="urn:uuid:${uuid}"/>
<meta name="dtb:depth" content="1"/>
<meta name="dtb:totalPageCount" content="0"/>
<meta name="dtb:maxPageNumber" content="0"/>
</head>
<docTitle><text>${escapeHtml(title)}</text></docTitle>
<navMap>
${navPoints}
</navMap>
</ncx>`;
}

function buildContentOpf(title, uuid, chapters) {
  const chapterItems = chapters
    .map((ch, i) => `<item id="chapter${i + 1}" href="${chapterFileName(i)}" media-type="application/xhtml+xml"/>`)
    .join("\n");
  const chapterSpine = chapters.map((ch, i) => `<itemref idref="chapter${i + 1}"/>`).join("\n");
  const modified = new Date().toISOString().replace(/\.\d+Z$/, "Z");

  return `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="book-id">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:identifier id="book-id">urn:uuid:${uuid}</dc:identifier>
<dc:title>${escapeHtml(title)}</dc:title>
<dc:language>en</dc:language>
<meta property="dcterms:modified">${modified}</meta>
</metadata>
<manifest>
<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
<item id="css" href="styles.css" media-type="text/css"/>
<item id="titlepage" href="titlepage.xhtml" media-type="application/xhtml+xml"/>
${chapterItems}
</manifest>
<spine toc="ncx">
<itemref idref="titlepage"/>
${chapterSpine}
</spine>
</package>`;
}

/** Builds a complete EPUB 3 archive (with an EPUB2-compatible NCX for older readers) as a
 *  Blob, ready to download or hand to an e-reader. */
export function buildEpubBlob(data) {
  const title = data.title || "Untitled Book";
  const uuid = epubUuid();

  const entries = [
    { name: "mimetype", data: "application/epub+zip" },
    { name: "META-INF/container.xml", data: CONTAINER_XML },
    { name: "OEBPS/content.opf", data: buildContentOpf(title, uuid, data.chapters) },
    { name: "OEBPS/nav.xhtml", data: buildNavXhtml(title, data.chapters) },
    { name: "OEBPS/toc.ncx", data: buildNcx(title, uuid, data.chapters) },
    { name: "OEBPS/styles.css", data: EPUB_CSS },
    { name: "OEBPS/titlepage.xhtml", data: buildTitlepageXhtml(title) },
    ...data.chapters.map((ch, i) => ({ name: `OEBPS/${chapterFileName(i)}`, data: chapterToXhtml(ch) })),
  ];

  return createZipBlob(entries);
}

/** Downloads the book as a .epub file, ready to open in Apple Books, Kindle (via
 *  conversion), or any other EPUB reader. */
export function exportEpub(data) {
  const blob = buildEpubBlob(data);
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  const slug = (data.title || "untitled-book")
    .trim()
    .toLowerCase()
    .replace(/[^\w]+/g, "-")
    .replace(/^-+|-+$/g, "");
  a.download = `${slug || "untitled-book"}.epub`;
  a.click();
  URL.revokeObjectURL(url);
}
