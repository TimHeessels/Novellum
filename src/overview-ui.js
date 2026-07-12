"use strict";

import { data, escapeHtml, chapterLabel, sceneLabel } from "./model.js";

export function renderOverviewView(container, { onOpenChapter, onOpenScene }) {
  container.innerHTML = `
    <div class="overview-view">
      <div class="overview-title">Overview</div>
      <div class="overview-chapters">
        ${data.chapters.length ? data.chapters.map(chapterSectionHtml).join("") : `<div class="no-scene">No chapters yet.</div>`}
      </div>
    </div>
  `;

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
  return `
    <section class="overview-chapter">
      <div class="overview-chapter-title" data-chapter-id="${ch.id}">${escapeHtml(chapterLabel(ch))}</div>
      <div class="overview-scene-list">${scenesHtml}</div>
    </section>
  `;
}

function sceneCardHtml(ch, sc) {
  const summaryHtml = sc.summary && sc.summary.trim()
    ? `<div class="overview-scene-summary">${escapeHtml(sc.summary)}</div>`
    : "";
  const todosHtml = sc.todos.length ? todoListHtml(sc.todos) : "";
  return `
    <div class="overview-scene-card" data-chapter-id="${ch.id}" data-scene-id="${sc.id}">
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
