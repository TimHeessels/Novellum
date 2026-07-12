"use strict";

import { scene, chapter, markdownToFormattingHtml } from "./model.js";

/** Parses the book-level markdown export format:
 *    # Title
 *    by Author
 *
 *    ## Novel
 *
 *    ### Chapter 1: Some Title
 *    ...chapter body...
 *
 *    ### Chapter 2: Another Title
 *    ...
 *  Only the "## Novel" section (or the whole document, if that heading is missing) is scanned
 *  for "### " chapter headings — anything before/after it (author line, other "## " sections)
 *  is ignored rather than misread as manuscript content. */
export function parseManuscriptMarkdown(markdown) {
  const text = (markdown || "").replace(/\r\n/g, "\n");

  const titleMatch = text.match(/^#\s+(.+?)\s*$/m);
  const title = titleMatch ? titleMatch[1].trim() : null;

  let scoped = text;
  const novelMatch = text.match(/^##\s+Novel\s*$/im);
  if (novelMatch) {
    const rest = text.slice(novelMatch.index + novelMatch[0].length);
    const nextSection = rest.match(/^##\s+\S.*$/m);
    scoped = nextSection ? rest.slice(0, nextSection.index) : rest;
  }

  const headingRegex = /^###\s+(.+?)\s*$/gm;
  const headings = [];
  let m;
  while ((m = headingRegex.exec(scoped))) {
    headings.push({ start: m.index, end: m.index + m[0].length, text: m[1].trim() });
  }

  const chapters = headings.map((h, i) => {
    const body = scoped.slice(h.end, headings[i + 1] ? headings[i + 1].start : scoped.length).trim();
    const title = h.text.replace(/^Chapter\s+\d+\s*:\s*/i, "").trim() || h.text;
    return { title, body };
  });

  return { title, chapters };
}

const SCENE_BREAK_RE = /^[ \t]*(?:\*[ \t]*){3,}$/m;

/** Splits a chapter body into scene bodies on "* * *" (or "***", "*  *  *", ...) lines. */
function splitSceneBodies(chapterBody) {
  return chapterBody
    .split(SCENE_BREAK_RE)
    .map(reflowManuscriptText)
    .filter(Boolean);
}

/** Plain-text exports of a manuscript are usually hard-wrapped — every source line ends in a
 *  newline whether or not it's an actual paragraph break, and stray blank/whitespace-only lines
 *  creep in from copy-paste. Re-flows that into real paragraphs: a run of one or more blank
 *  lines is a paragraph break, and every other line break is just a wrap artifact to be undone
 *  (joined back into one line) so the app's own word-wrap can re-flow it. */
function reflowManuscriptText(raw) {
  return raw
    .split(/\n{2,}/)
    .map((para) =>
      para
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .join(" ")
        .replace(/[ \t]{2,}/g, " ")
    )
    .filter(Boolean)
    .join("\n\n");
}

/** Builds ready-to-install `data.chapters` rows from manuscript markdown. Each chapter's body is
 *  split into scenes on "* * *" lines — if it has none, the whole chapter becomes one scene. */
export function buildChaptersFromMarkdown(markdown) {
  const { title, chapters } = parseManuscriptMarkdown(markdown);
  const builtChapters = chapters.map(({ title: chTitle, body }) => {
    const sceneBodies = splitSceneBodies(body);
    const scenes = (sceneBodies.length ? sceneBodies : [""]).map((sceneBody) =>
      scene("Untitled Scene", markdownToFormattingHtml(sceneBody), "", [])
    );
    return chapter(chTitle || "Untitled Chapter", scenes);
  });
  return { title, chapters: builtChapters };
}
