"use strict";

/* ---------------------------------------------------------------- */
/* Utilities                                                         */
/* ---------------------------------------------------------------- */

/* crypto.randomUUID() only exists in secure contexts (HTTPS/localhost) — opening the app over
 * plain http://<lan-ip> (e.g. from a phone/tablet hitting a dev server) leaves it undefined.
 * crypto.getRandomValues() has no such restriction, so build the v4 UUID from that instead. */
function randomUuid() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function uid(prefix) {
  return `${prefix}-${randomUuid()}`;
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

export function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

export function formatRelativeTime(isoString) {
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(isoString).getTime()) / 1000));
  if (seconds < 10) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function wordCount(text) {
  return ((text || "").trim().match(/\S+/g) || []).length;
}

/** Strips a scene body's rich-text HTML down to plain text before counting words in it —
 *  sc.text is sanitized inline HTML (see sanitizeFormattingHtml below), not plain text. */
function htmlToPlainText(html) {
  const div = document.createElement("div");
  div.innerHTML = html || "";
  return div.textContent || "";
}

export function sceneWordCount(sc) {
  return wordCount(htmlToPlainText(sc.text));
}

export function chapterWordCount(ch) {
  return ch.scenes.reduce((sum, sc) => sum + sceneWordCount(sc), 0);
}

export function bookWordCount() {
  return data.chapters.reduce((sum, ch) => sum + chapterWordCount(ch), 0);
}

/* ---------------------------------------------------------------- */
/* Rich text formatting                                              */
/* Scene body text (scene.text) is stored as a small, constrained    */
/* subset of HTML — just inline bold/italic/underline/strikethrough  */
/* markup plus <br>/<div> line breaks, produced by execCommand() in  */
/* the editor. sanitizeFormattingHtml() is the single choke point    */
/* that content passes through before being written into a live     */
/* contenteditable element, so nothing outside that whitelist (incl. */
/* content pulled in from GitHub sync) can smuggle in markup/scripts.*/
/* ---------------------------------------------------------------- */

const FORMATTING_TAGS = new Set(["B", "STRONG", "I", "EM", "U", "S", "STRIKE", "DEL", "BR", "DIV", "P"]);
const MARKDOWN_WRAP = {
  B: ["**", "**"], STRONG: ["**", "**"],
  I: ["*", "*"], EM: ["*", "*"],
  U: ["<u>", "</u>"],
  S: ["~~", "~~"], STRIKE: ["~~", "~~"], DEL: ["~~", "~~"],
};

/** Browsers leave the first line typed into an empty contenteditable (or text inserted via
 *  execCommand("insertText")) as bare top-level text/inline nodes, not wrapped in a <p>/<div> —
 *  unlike every other line, which gets wrapped when Enter splits an existing block. Bare nodes
 *  render flush against .manuscript-text's own edge, without the text-indent that every other
 *  paragraph gets, so wrap any such stray runs in a <p> to keep indentation consistent. */
function wrapLooseTopLevelContent(container) {
  const BLOCK_TAGS = new Set(["P", "DIV"]);
  let node = container.firstChild;
  while (node) {
    if (node.nodeType === Node.ELEMENT_NODE && BLOCK_TAGS.has(node.tagName)) {
      node = node.nextSibling;
      continue;
    }
    const p = document.createElement("p");
    let hasContent = false;
    let cur = node;
    while (cur && !(cur.nodeType === Node.ELEMENT_NODE && BLOCK_TAGS.has(cur.tagName))) {
      const next = cur.nextSibling;
      if (cur.nodeType === Node.ELEMENT_NODE || cur.textContent !== "") hasContent = true;
      p.appendChild(cur);
      cur = next;
    }
    if (hasContent) {
      container.insertBefore(p, cur);
      node = p.nextSibling;
    } else {
      node = cur;
    }
  }
}

export function sanitizeFormattingHtml(html) {
  const container = document.createElement("div");
  container.innerHTML = html || "";
  (function clean(node) {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType !== Node.ELEMENT_NODE) continue;
      if (!FORMATTING_TAGS.has(child.tagName)) {
        while (child.firstChild) node.insertBefore(child.firstChild, child);
        node.removeChild(child);
        continue;
      }
      for (const attr of Array.from(child.attributes)) child.removeAttribute(attr.name);
      clean(child);
    }
  })(container);
  wrapLooseTopLevelContent(container);
  return container.innerHTML;
}

export function formattingHtmlToMarkdown(html) {
  const container = document.createElement("div");
  container.innerHTML = html || "";
  function walk(node) {
    let out = "";
    for (const child of node.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) {
        out += child.textContent;
      } else if (child.nodeType === Node.ELEMENT_NODE) {
        if (child.tagName === "BR") {
          out += "\n";
        } else if (child.tagName === "P") {
          // A paragraph is a full blank-line break — not just a single line break like DIV/BR —
          // so the round trip back through markdownToFormattingHtml() re-forms it as its own <p>.
          out += walk(child) + "\n\n";
        } else if (child.tagName === "DIV") {
          out += walk(child) + "\n";
        } else if (MARKDOWN_WRAP[child.tagName]) {
          const inner = walk(child);
          const [open, close] = MARKDOWN_WRAP[child.tagName];
          out += inner.trim() ? open + inner + close : inner;
        } else {
          out += walk(child);
        }
      }
    }
    return out;
  }
  return walk(container).replace(/\n+$/, "");
}

function inlineMarkdownToHtml(text) {
  let out = escapeHtml(text);
  out = out.replace(/&lt;u&gt;([\s\S]*?)&lt;\/u&gt;/g, "<u>$1</u>");
  out = out.replace(/\*\*([\s\S]+?)\*\*/g, "<b>$1</b>");
  out = out.replace(/~~([\s\S]+?)~~/g, "<strike>$1</strike>");
  out = out.replace(/\*([\s\S]+?)\*/g, "<i>$1</i>");
  return out.replace(/\n/g, "<br>");
}

/** A blank line is a real paragraph break (rendered as a separate indented <p>, per
 *  .manuscript-text's styling); any other single newline is just a soft break within one. */
export function markdownToFormattingHtml(markdown) {
  return (markdown || "")
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p>${inlineMarkdownToHtml(p)}</p>`)
    .join("");
}

/* ---------------------------------------------------------------- */
/* Fresh-book seed                                                   */
/* ---------------------------------------------------------------- */

export function scene(title, text, summary, todos) {
  return {
    id: uid("scene"),
    title,
    text,
    summary,
    todos: todos.map((t) => ({ id: uid("todo"), text: t.text, done: !!t.done })),
  };
}

export function chapter(title, scenes) {
  return { id: uid("chapter"), title, scenes };
}

// Used both as the very first book on a fresh install (main.js boot()) and as the shape of
// any new book a user creates (ui.js handleCreateBook) — one empty chapter/scene, no content.
export const data = {
  title: "Untitled Book",
  author: "",
  chapters: [chapter("Chapter 1", [scene("Untitled Scene", "", "", [])])],
  characters: [],
  locations: [],
  concepts: [],
};

/* ---------------------------------------------------------------- */
/* Data helpers                                                      */
/* ---------------------------------------------------------------- */

export function getSceneAndChapter(sceneId) {
  for (const ch of data.chapters) {
    const sc = ch.scenes.find((s) => s.id === sceneId);
    if (sc) return { chapter: ch, scene: sc };
  }
  return { chapter: null, scene: null };
}

export function getChapter(chapterId) {
  return data.chapters.find((c) => c.id === chapterId) || null;
}

export function sceneNumber(ch, sc) {
  return ch.scenes.indexOf(sc) + 1;
}

export function sceneLabel(ch, sc) {
  return `Scene ${sceneNumber(ch, sc)} - ${sc.title}`;
}

export function chapterNumber(ch) {
  return data.chapters.indexOf(ch) + 1;
}

export function chapterLabel(ch) {
  return `Chapter ${chapterNumber(ch)} — ${ch.title}`;
}

export function bibleArrayFor(kind) {
  if (kind === "character") return data.characters;
  if (kind === "location") return data.locations;
  return data.concepts;
}

export function bibleLabel(kind) {
  if (kind === "character") return "Character";
  if (kind === "location") return "Location";
  return "Concept";
}

// Bible items used to store a single `desc` string. Reads from IndexedDB rows or a pulled
// bible.json may still be in that old shape, so fold it into one untitled entry on the way in.
export function entriesFromLegacy(row) {
  if (Array.isArray(row.entries)) return row.entries;
  if (row.desc) return [{ id: uid("entry"), title: "", text: row.desc }];
  return [];
}

/* ---------------------------------------------------------------- */
/* Scene <-> Markdown+frontmatter (de)serialization                 */
/* Every frontmatter value is written via JSON.stringify — a JSON   */
/* literal is always valid YAML too, so these files are genuinely   */
/* openable/readable in Obsidian without hand-rolling a YAML parser.*/
/* ---------------------------------------------------------------- */

export function sceneToMarkdown(sceneRow) {
  const front = [
    `id: ${JSON.stringify(sceneRow.id)}`,
    `title: ${JSON.stringify(sceneRow.title)}`,
    `summary: ${JSON.stringify(sceneRow.summary || "")}`,
    `todos: ${JSON.stringify(sceneRow.todos || [])}`,
    `updatedAt: ${JSON.stringify(sceneRow.updatedAt)}`,
  ].join("\n");
  return `---\n${front}\n---\n\n${formattingHtmlToMarkdown(sceneRow.text || "")}`;
}

export function markdownToScene(markdown) {
  const match = markdown.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) throw new Error("Invalid scene markdown: missing frontmatter");
  const [, frontBlock, body] = match;
  const fields = {};
  for (const line of frontBlock.split("\n")) {
    const m = line.match(/^([a-zA-Z]+):\s*(.*)$/);
    if (!m) continue;
    fields[m[1]] = JSON.parse(m[2]);
  }
  return {
    id: fields.id,
    title: fields.title,
    summary: fields.summary || "",
    todos: fields.todos || [],
    updatedAt: fields.updatedAt,
    text: markdownToFormattingHtml(body.replace(/^\n/, "")),
  };
}
