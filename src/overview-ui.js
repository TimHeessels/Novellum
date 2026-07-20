"use strict";

import { data, escapeHtml, chapterLabel, chapterNumber, sceneLabel, sceneNumber, bookWordCount, chapterWordCount, sceneWordCount } from "./model.js";

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
            <span class="overview-todo-toggle-label">Show word count</span>
            <span class="toggle-switch ${showWordCounts ? "on" : ""}"><span class="toggle-knob"></span></span>
          </div>
          <div class="overview-todo-toggle" id="overviewChaptersOnlyBtn" role="switch" aria-checked="${chaptersOnly}">
            <span class="overview-todo-toggle-label">Chapters only</span>
            <span class="toggle-switch ${chaptersOnly ? "on" : ""}"><span class="toggle-knob"></span></span>
          </div>
        </div>
      </div>
      ${showWordCounts ? chartPanelHtml(highlightTodos, chaptersOnly) : ""}
      <div class="overview-chapters ${highlightTodos ? "highlight-todos" : ""} ${chaptersOnly ? "chapters-only" : ""}">
        ${data.chapters.length
          ? data.chapters.map((ch) => (chaptersOnly ? chapterCardHtml(ch, showWordCounts, highlightTodos) : chapterSectionHtml(ch, showWordCounts))).join("")
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

/** Builds the "12,345 words · 3 to-dos" style line shared by the book total and each chapter —
 *  each half only appears when its toggle is on; empty string when both are off. */
function combinedStatusLine(showWordCounts, highlightTodos, words, todos) {
  const parts = [];
  if (showWordCounts) parts.push(`${formatWordCount(words)} words`);
  if (highlightTodos) parts.push(`${todos} to-do${todos === 1 ? "" : "s"}`);
  return parts.join(" &middot; ");
}

function chartPanelHtml(highlightTodos, chaptersOnly) {
  return chaptersOnly ? chapterChartPanelHtml(highlightTodos) : sceneChartPanelHtml(highlightTodos);
}

function chapterChartPanelHtml(highlightTodos) {
  const maxWords = Math.max(1, ...data.chapters.map((ch) => chapterWordCount(ch)));
  const bars = data.chapters
    .map((ch) => {
      const words = chapterWordCount(ch);
      const hasTodos = chapterActiveTodoCount(ch) > 0;
      const height = Math.max(6, (words / maxWords) * 100);
      const title = `${escapeHtml(chapterLabel(ch))}: ${formatWordCount(words)} words`;
      return `<div class="overview-chart-bar ${highlightTodos && hasTodos ? "has-todos" : ""}" style="height:${height}%" title="${title}"></div>`;
    })
    .join("");
  const labels = data.chapters
    .map((ch) => `<span title="${escapeHtml(chapterLabel(ch))}">${chapterNumber(ch)}</span>`)
    .join("");
  return `
    <div class="overview-chart-panel">
      <div class="overview-chart-eyebrow">Words per chapter</div>
      <div class="overview-chart-body">
        <div class="overview-chart-axis">
          <span>${formatWordCount(maxWords)}</span>
          <span>0</span>
        </div>
        <div class="overview-chart-track">
          <div class="overview-chart-bars">${bars}</div>
          <div class="overview-chart-labels">${labels}</div>
        </div>
      </div>
    </div>
  `;
}

function sceneChartPanelHtml(highlightTodos) {
  const maxWords = Math.max(1, ...data.chapters.flatMap((ch) => ch.scenes.map((sc) => sceneWordCount(sc))));
  const groups = data.chapters
    .map((ch) => {
      const sceneCount = Math.max(1, ch.scenes.length);
      const bars = ch.scenes
        .map((sc) => {
          const words = sceneWordCount(sc);
          const hasTodos = highlightTodos && sc.todos.some((t) => !t.done);
          const height = Math.max(6, (words / maxWords) * 100);
          const title = `${escapeHtml(sceneLabel(ch, sc))}: ${formatWordCount(words)} words`;
          return `<div class="overview-chart-bar ${hasTodos ? "has-todos" : ""}" style="height:${height}%" title="${title}"></div>`;
        })
        .join("");
      return `<div class="overview-chart-group" style="flex-grow:${sceneCount}" title="${escapeHtml(chapterLabel(ch))}">${bars}</div>`;
    })
    .join("");
  const labelGroups = data.chapters
    .map((ch) => {
      const sceneCount = Math.max(1, ch.scenes.length);
      const labels = ch.scenes
        .map((sc) => `<span title="${escapeHtml(sceneLabel(ch, sc))}">${chapterNumber(ch)}-${sceneNumber(ch, sc)}</span>`)
        .join("");
      return `<div class="overview-chart-group" style="flex-grow:${sceneCount}">${labels}</div>`;
    })
    .join("");
  return `
    <div class="overview-chart-panel">
      <div class="overview-chart-eyebrow">Words per scene</div>
      <div class="overview-chart-body">
        <div class="overview-chart-axis">
          <span>${formatWordCount(maxWords)}</span>
          <span>0</span>
        </div>
        <div class="overview-chart-track">
          <div class="overview-chart-groups">${groups}</div>
          <div class="overview-chart-groups overview-chart-label-groups">${labelGroups}</div>
        </div>
      </div>
    </div>
  `;
}

function chapterWordCountHtml(ch, showWordCounts, chapterHasTodos) {
  if (!showWordCounts) return "";
  return `<div class="overview-chapter-status ${chapterHasTodos ? "has-todos" : ""}">${formatWordCount(chapterWordCount(ch))} words</div>`;
}

function chapterSectionHtml(ch, showWordCounts) {
  const scenesHtml = ch.scenes.length
    ? ch.scenes.map((sc) => sceneCardHtml(ch, sc, showWordCounts)).join("")
    : `<div class="no-scene">No scenes in this chapter yet.</div>`;
  const chapterHasTodos = ch.scenes.some((sc) => sc.todos.some((t) => !t.done));
  const statusLineHtml = chapterWordCountHtml(ch, showWordCounts, chapterHasTodos);
  return `
    <section class="overview-chapter overview-chapter-section-card">
      <div class="overview-chapter-title ${chapterHasTodos ? "has-todos" : ""}" data-chapter-id="${ch.id}">${escapeHtml(chapterLabel(ch))}</div>
      ${statusLineHtml}
      <div class="overview-scene-list">${scenesHtml}</div>
    </section>
  `;
}

function chapterCardHtml(ch, showWordCounts, highlightTodos) {
  const chapterHasTodos = ch.scenes.some((sc) => sc.todos.some((t) => !t.done));
  const activeTodos = chapterActiveTodoCount(ch);
  const wordsLineHtml = chapterWordCountHtml(ch, showWordCounts, chapterHasTodos);
  const todoChipHtml = highlightTodos && activeTodos > 0
    ? `<span class="overview-todo-count-chip">${activeTodos} to-do${activeTodos === 1 ? "" : "s"}</span>`
    : "";
  return `
    <div class="overview-chapter-card ${chapterHasTodos ? "has-todos" : ""}" data-chapter-id="${ch.id}">
      ${todoChipHtml}
      <div class="overview-chapter-card-title">${escapeHtml(chapterLabel(ch))}</div>
      ${wordsLineHtml}
    </div>
  `;
}

function sceneCardHtml(ch, sc, showWordCounts) {
  const wordsHtml = showWordCounts
    ? `<div class="overview-scene-wordcount">${formatWordCount(sceneWordCount(sc))} words</div>`
    : "";
  const summaryHtml = sc.summary && sc.summary.trim()
    ? `<div class="overview-scene-summary">${escapeHtml(sc.summary)}</div>`
    : "";
  const todosHtml = sc.todos.length ? todoListHtml(sc.todos) : "";
  const hasTodos = sc.todos.some((t) => !t.done);
  const todoChipHtml = sc.todos.length
    ? `<span class="overview-todo-count-chip">${sc.todos.length} to-do${sc.todos.length === 1 ? "" : "s"}</span>`
    : "";
  return `
    <div class="overview-scene-card ${hasTodos ? "has-todos" : ""}" data-chapter-id="${ch.id}" data-scene-id="${sc.id}">
      ${todoChipHtml}
      <div class="overview-scene-title">${escapeHtml(sceneLabel(ch, sc))}</div>
      ${wordsHtml}
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
