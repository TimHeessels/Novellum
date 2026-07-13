"use strict";

/* Kicks off and consumes the "Connect GitHub" flow via the Novellum GitHub App's install picker —
 * GitHub's own UI for choosing exactly which repo(s) to grant, rather than an OAuth scope that
 * would cover the whole account. The code->token exchange itself happens in worker.js (it needs a
 * secret this static app can never hold) — this module only builds the redirect out and reads the
 * result back out of the URL fragment worker.js redirects to. */

// Public identifiers for the Novellum GitHub App — not secrets. CLIENT_ID must match the
// client_id worker.js uses for the exchange (see wrangler.jsonc GITHUB_CLIENT_ID). APP_SLUG is
// the App's URL slug (from its settings page), used to link into its own install picker.
const CLIENT_ID = "Iv23ct1Ixs50tGitKrap";
const APP_SLUG = "novellum-writing-tool";
const CALLBACK_PATH = "/api/auth/callback";

// Where the per-attempt CSRF nonce lives between the redirect out and the redirect back —
// sessionStorage survives the full-page navigation to github.com and back, but not a new tab, so
// a nonce an attacker captured (e.g. by luring a victim to a callback URL they crafted themselves)
// can never match what's sitting in the victim's own tab.
const STATE_STORAGE_KEY = "novellum:oauthState";

function randomState() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Sends the user to GitHub's install picker for the Novellum GitHub App — where they choose
 *  "Only select repositories" and pick just their vault repo. Because "Request user
 *  authorization (OAuth) during installation" is enabled on the App, this same flow also
 *  produces the `code` worker.js exchanges for a user access token, so install and sign-in
 *  happen in one trip. */
export function startGithubLogin() {
  const oauthState = randomState();
  sessionStorage.setItem(STATE_STORAGE_KEY, oauthState);

  const url = new URL(`https://github.com/apps/${APP_SLUG}/installations/new`);
  url.searchParams.set("state", oauthState);
  location.href = url.toString();
}

/** Reads (and strips from the URL) an OAuth result left in the fragment by worker.js's callback
 *  redirect. Returns { token, installationId }, or throws if GitHub sign-in failed or the
 *  returned `state` doesn't match what startGithubLogin() stored (a mismatch means this redirect
 *  didn't originate from a login this tab actually started — see STATE_STORAGE_KEY). Returns
 *  null on any page load that isn't a return from that redirect. */
export function consumePendingOAuthResult() {
  const hash = new URLSearchParams(location.hash.slice(1));
  const token = hash.get("gh_token");
  const error = hash.get("auth_error");
  const installationId = hash.get("installation_id");
  const returnedState = hash.get("state");
  if (!token && !error) return null;

  history.replaceState(null, "", location.pathname + location.search);
  const expectedState = sessionStorage.getItem(STATE_STORAGE_KEY);
  sessionStorage.removeItem(STATE_STORAGE_KEY);

  if (error) throw new Error(`GitHub sign-in failed (${error}).`);
  if (!expectedState || returnedState !== expectedState) {
    throw new Error("GitHub sign-in couldn't be verified — please try signing in again.");
  }
  if (!installationId) {
    throw new Error("GitHub didn't report which repository was granted — please try again.");
  }
  return { token, installationId };
}
