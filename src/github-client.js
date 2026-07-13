"use strict";

/* ---------------------------------------------------------------- */
/* Minimal GitHub REST client. No knowledge of app data shapes —     */
/* just file/repo/auth plumbing with normalized errors.              */
/* ---------------------------------------------------------------- */

const API_ROOT = "https://api.github.com";

function toBase64Utf8(str) {
  return btoa(unescape(encodeURIComponent(str)));
}

function fromBase64Utf8(b64) {
  return decodeURIComponent(escape(atob(b64.replace(/\n/g, ""))));
}

class GitHubError extends Error {
  constructor(type, message, status) {
    super(message);
    this.type = type; // 'auth' | 'conflict' | 'network' | 'notfound' | 'ratelimit' | 'unknown'
    this.status = status;
  }
}

function classifyStatus(status, body) {
  if (status === 401 || status === 403) {
    if (body && /rate limit/i.test(body.message || "")) return "ratelimit";
    return "auth";
  }
  if (status === 404) return "notfound";
  if (status === 409) return "conflict";
  if (status === 422) return "conflict";
  return "unknown";
}

async function request(token, method, path, body) {
  let res;
  try {
    res = await fetch(`${API_ROOT}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    throw new GitHubError("network", err.message, null);
  }

  if (res.status === 404) {
    return { status: 404, data: null };
  }

  let data = null;
  try {
    data = await res.json();
  } catch {
    // empty body, fine for some successful responses
  }

  if (!res.ok) {
    const type = classifyStatus(res.status, data);
    throw new GitHubError(type, data?.message || `GitHub API error (${res.status})`, res.status);
  }

  return { status: res.status, data };
}

export async function testToken(token) {
  const { data } = await request(token, "GET", "/user");
  return data.login;
}

export async function testRepoAccess(token, owner, repo) {
  const { status, data } = await request(token, "GET", `/repos/${owner}/${repo}`);
  if (status === 404 || !data) {
    throw new GitHubError("notfound", `Repository ${owner}/${repo} not found`, 404);
  }
  return { defaultBranch: data.default_branch };
}

/** The repos the user granted this GitHub App installation access to — set by GitHub's own
 *  install picker ("Only select repositories"), not anything we ask for. Usually exactly one,
 *  since users are guided to select just their vault repo, but a user can grant more. */
export async function listInstallationRepos(token, installationId) {
  const { data } = await request(token, "GET", `/user/installations/${installationId}/repositories?per_page=100`);
  const repositories = data?.repositories || [];
  return repositories.map((r) => ({ owner: r.owner.login, repo: r.name, private: r.private }));
}

/** Returns { content, sha } or null if the file doesn't exist yet. */
export async function getFile(token, owner, repo, path) {
  const { status, data } = await request(token, "GET", `/repos/${owner}/${repo}/contents/${path}`);
  if (status === 404 || !data) return null;
  return { content: fromBase64Utf8(data.content), sha: data.sha };
}

/** Creates or updates a file. `sha` must be the last known blob sha (omit for a brand-new file). */
export async function putFile(token, owner, repo, path, content, message, sha) {
  const { data } = await request(token, "PUT", `/repos/${owner}/${repo}/contents/${path}`, {
    message,
    content: toBase64Utf8(content),
    ...(sha ? { sha } : {}),
  });
  return { sha: data.content.sha };
}

/** Deletes a file. `sha` must be its last known blob sha. */
export async function deleteFile(token, owner, repo, path, message, sha) {
  await request(token, "DELETE", `/repos/${owner}/${repo}/contents/${path}`, { message, sha });
}

export async function listDir(token, owner, repo, path) {
  const { status, data } = await request(token, "GET", `/repos/${owner}/${repo}/contents/${path}`);
  if (status === 404 || !data) return [];
  return data;
}

/** Full recursive file tree for a branch/ref — one request instead of GETing every file individually. */
export async function getTree(token, owner, repo, ref) {
  const { status, data } = await request(token, "GET", `/repos/${owner}/${repo}/git/trees/${ref}?recursive=1`);
  if (status === 404 || !data) return { tree: [], truncated: false };
  return { tree: data.tree, truncated: !!data.truncated };
}

/** Fetches a blob directly by sha — cheaper than getFile() when the sha is already known (e.g. from a tree). */
export async function getBlob(token, owner, repo, sha) {
  const { data } = await request(token, "GET", `/repos/${owner}/${repo}/git/blobs/${sha}`);
  return { content: fromBase64Utf8(data.content), sha: data.sha };
}

/** Commits that touched `path` (a file or folder), most recent first — the data source for the
 *  "restore to a point in time" history browser. `ref` pins which branch's history to walk. */
export async function listCommits(token, owner, repo, path, ref, { perPage = 25, page = 1 } = {}) {
  const { data } = await request(
    token, "GET",
    `/repos/${owner}/${repo}/commits?path=${encodeURIComponent(path)}&sha=${encodeURIComponent(ref)}&per_page=${perPage}&page=${page}`
  );
  return (data || []).map((c) => ({
    sha: c.sha,
    message: c.commit.message,
    date: c.commit.author?.date || c.commit.committer?.date,
  }));
}

export { GitHubError };
