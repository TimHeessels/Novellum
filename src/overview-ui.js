"use strict";

import { data, escapeHtml, chapterLabel, sceneLabel, bookWordCount, chapterWordCount, sceneWordCount } from "./model.js";

export function renderOverviewView(container, {
  onOpenChapter,
  onOpenScene,
  highlightTodos,
  onToggleHighlightTodos,
  showWordCounts,
  onToggleShowWordCounts,
  chaptersOnly,
  onToggleChaptersOnly,
}) {
  const totalLine = combinedStatusLine(showWordCounts, highlightTodos, bookWordCount(), bookActiveTodoCount());
  const totalStatusHtml = totalLine ? `<div class="overview-total-wordcount">${totalLine}</div>` : "";
  container.innerHTML = `
    <div class="overview-view">
      <div class="overview-header">
        <div class="overview-header-title">
          <div class="overview-title">Overview</div>
          ${totalStatusHtml}
        </div>
        <div class="overview-toggles">
          <div class="overview-todo-toggle" id="overviewHighlightTodosBtn" role="switch" aria-checked="${highlightTodos}">
            <span class="overview-todo-toggle-label">Highlight to-dos</span>
            <span class="toggle-switch ${highlightTodos ? "on" : ""}"><span class="toggle-knob"></span></span>
          </div>
          <div class="overview-todo-toggle" id="overviewShowWordCountsBtn" role="switch" aria-checked="${showWordCounts}">
            <span class="overview-todo-toggle-label">Show word counts</span>
            <span class="toggle-switch ${showWordCounts ? "on" : ""}"><span class="toggle-knob"></span></span>
          </div>
          <div class="overview-todo-toggle" id="overviewChaptersOnlyBtn" role="switch" aria-checked="${chaptersOnly}">
            <span class="overview-todo-toggle-label">Chapters only</span>
            <span class="toggle-switch ${chaptersOnly ? "on" : ""}"><span class="toggle-knob"></span></span>
          </div>
        </div>
      </div>
      <div class="overview-chapters ${highlightTodos ? "highlight-todos" : ""} ${chaptersOnly ? "chapters-only" : ""}">
        ${data.chapters.length
          ? data.chapters.map((ch) => (chaptersOnly ? chapterCardHtml(ch, showWordCounts, highlightTodos) : chapterSectionHtml(ch, showWordCounts, highlightTodos))).join("")
          : `<div class="no-scene">No chapters yet.</div>`}
      </div>
    </div>
  `;

  document.getElementById("overviewHighlightTodosBtn").onclick = onToggleHighlightTodos;
  document.getElementById("overviewShowWordCountsBtn").onclick = onToggleShowWordCounts;
  document.getElementById("overviewChaptersOnlyBtn").onclick = onToggleChaptersOnly;
  container.querySelectorAll(".overview-chapter-title, .overview-chapter-card").forEach((el) => {
    el.onclick = () => onOpenChapter(el.dataset.chapterId);
  });
  container.querySelectorAll(".overview-scene-card").forEach((el) => {
    el.onclick = () => onOpenScene(el.dataset.chapterId, el.dataset.sceneId);
  });
}

function formatWordCount(n) {
  return n.toLocaleString();
}

function chapterActiveTodoCount(ch) {
  return ch.scenes.reduce((sum, sc) => sum + sc.todos.filter((t) => !t.done).length, 0);
}

function bookActiveTodoCount() {
  return data.chapters.reduce((sum, ch) => sum + chapterActiveTodoCount(ch), 0);
}

/** Builds the "12,345 words - 3 to-dos" style line shared by the book total and each chapter —
 *  each half only appears when its toggle is on; empty string when both are off. */
function combinedStatusLine(showWordCounts, highlightTodos, words, todos) {
  const parts = [];
  if (showWordCounts) parts.push(`${formatWordCount(words)} words`);
  if (highlightTodos) parts.push(`${todos} to-do${todos === 1 ? "" : "s"}`);
  return parts.join(" - ");
}

function chapterStatusLineHtml(ch, showWordCounts, highlightTodos, chapterHasTodos) {
  const line = combinedStatusLine(showWordCounts, highlightTodos, chapterWordCount(ch), chapterActiveTodoCount(ch));
  if (!line) return "";
  return `<div class="overview-chapter-status ${chapterHasTodos ? "has-todos" : ""}">${line}</div>`;
}

function chapterSectionHtml(ch, showWordCounts, highlightTodos) {
  const scenesHtml = ch.scenes.length
    ? ch.scenes.map((sc) => sceneCardHtml(ch, sc, showWordCounts)).join("")
    : `<div class="no-scene">No scenes in this chapter yet.</div>`;
  const chapterHasTodos = ch.scenes.some((sc) => sc.todos.some((t) => !t.done));
  const statusLineHtml = chapterStatusLineHtml(ch, showWordCounts, highlightTodos, chapterHasTodos);
  return `
    <section class="overview-chapter">
      <div class="overview-chapter-title ${chapterHasTodos ? "has-todos" : ""}" data-chapter-id="${ch.id}">${escapeHtml(chapterLabel(ch))}</div>
      ${statusLineHtml}
      <div class="overview-scene-list">${scenesHtml}</div>
    </section>
  `;
}

function chapterCardHtml(ch, showWordCounts, highlightTodos) {
  const chapterHasTodos = ch.scenes.some((sc) => sc.todos.some((t) => !t.done));
  const statusLineHtml = chapterStatusLineHtml(ch, showWordCounts, highlightTodos, chapterHasTodos);
  return `
    <div class="overview-chapter-card ${chapterHasTodos ? "has-todos" : ""}" data-chapter-id="${ch.id}">
      <div class="overview-chapter-card-title">${escapeHtml(chapterLabel(ch))}</div>
      ${statusLineHtml}
    </div>
  `;
}

function sceneCardHtml(ch, sc, showWordCounts) {
  const summaryHtml = sc.summary && sc.summary.trim()
    ? `<div class="overview-scene-summary">${escapeHtml(sc.summary)}</div>`
    : "";
  const todosHtml = sc.todos.length ? todoListHtml(sc.todos) : "";
  const hasTodos = sc.todos.some((t) => !t.done);
  const sceneWordsHtml = showWordCounts
    ? `<div class="overview-scene-wordcount">${formatWordCount(sceneWordCount(sc))}</div>`
    : "";
  return `
    <div class="overview-scene-card ${hasTodos ? "has-todos" : ""}" data-chapter-id="${ch.id}" data-scene-id="${sc.id}">
      ${sceneWordsHtml}
      <div class="overview-scene-title">${escapeHtml(sceneLabel(ch, sc))}</div>
      ${summaryHtml}
      ${todosHtml}
    </div>
  `;
}

function todoListHtml(todos) {
  const rows = todos
    .map(
      (t) => `
      <div class="todo-row overview-todo-row ${t.done ? "done" : ""}">
        <span class="chk ${t.done ? "checked" : ""}">${t.done ? "&#10003;" : ""}</span>
        <span class="todo-text">${t.text && t.text.trim() ? escapeHtml(t.text) : `<span class="overview-todo-empty">Untitled to-do</span>`}</span>
      </div>`
    )
    .join("");
  return `<div class="overview-todo-list">${rows}</div>`;
}
