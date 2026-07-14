"use strict";

import { data, escapeHtml, chapterLabel, sceneLabel } from "./model.js";

export function renderOverviewView(container, { onOpenChapter, onOpenScene, highlightTodos, onToggleHighlightTodos }) {
  container.innerHTML = `
    <div class="overview-view">
      <div class="overview-header">
        <div class="overview-title">Overview</div>
        <div class="overview-todo-toggle" id="overviewHighlightTodosBtn" role="switch" aria-checked="${highlightTodos}">
          <span class="overview-todo-toggle-label">Highlight scenes with To-Dos</span>
          <span class="toggle-switch ${highlightTodos ? "on" : ""}"><span class="toggle-knob"></span></span>
        </div>
      </div>
      <div class="overview-chapters ${highlightTodos ? "highlight-todos" : ""}">
        ${data.chapters.length ? data.chapters.map(chapterSectionHtml).join("") : `<div class="no-scene">No chapters yet.</div>`}
      </div>
    </div>
  `;

  document.getElementById("overviewHighlightTodosBtn").onclick = onToggleHighlightTodos;
  container.querySelectorAll(".overview-chapter-title").forEach((el) => {
    el.onclick = () => onOpenChapter(el.dataset.chapterId);
  });
  container.querySelectorAll(".overview-scene-card").forEach((el) => {
    el.onclick = () => onOpenScene(el.dataset.chapterId, el.dataset.sceneId);
  });
}

function chapterSectionHtml(ch) {
  const scenesHtml = ch.scenes.length
    ? ch.scenes.map((sc) => sceneCardHtml(ch, sc)).join("")
    : `<div class="no-scene">No scenes in this chapter yet.</div>`;
  const chapterHasTodos = ch.scenes.some((sc) => sc.todos.some((t) => !t.done));
  return `
    <section class="overview-chapter">
      <div class="overview-chapter-title ${chapterHasTodos ? "has-todos" : ""}" data-chapter-id="${ch.id}">${escapeHtml(chapterLabel(ch))}</div>
      <div class="overview-scene-list">${scenesHtml}</div>
    </section>
  `;
}

function sceneCardHtml(ch, sc) {
  const summaryHtml = sc.summary && sc.summary.trim()
    ? `<div class="overview-scene-summary">${escapeHtml(sc.summary)}</div>`
    : "";
  const todosHtml = sc.todos.length ? todoListHtml(sc.todos) : "";
  const hasTodos = sc.todos.some((t) => !t.done);
  return `
    <div class="overview-scene-card ${hasTodos ? "has-todos" : ""}" data-chapter-id="${ch.id}" data-scene-id="${sc.id}">
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
