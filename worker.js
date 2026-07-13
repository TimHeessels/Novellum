"use strict";

/* Serves the static app for every normal request, and handles one extra route: the GitHub App
 * user-authorization code->token exchange, which needs GITHUB_CLIENT_SECRET (a Cloudflare-
 * encrypted secret that must never reach the browser, so the static app can't do this itself). */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/auth/callback") {
      return handleOAuthCallback(url, env);
    }
    return env.ASSETS.fetch(request);
  },
};

async function handleOAuthCallback(url, env) {
  const code = url.searchParams.get("code");
  // installation_id identifies which repos GitHub's own install picker just granted — the
  // client uses it to look those up (see listInstallationRepos) rather than us needing to.
  const installationId = url.searchParams.get("installation_id") || "";
  // Echoed straight back to github-oauth.js unchecked — this worker has no session of its own to
  // validate it against. The client is the one that generated it and is the one that verifies it
  // matches before trusting the token (see consumePendingOAuthResult), so round-tripping it here
  // is just plumbing, not the security boundary itself.
  const state = url.searchParams.get("state") || "";

  const redirectWith = (params) => {
    const frag = new URLSearchParams(params);
    if (state) frag.set("state", state);
    if (installationId) frag.set("installation_id", installationId);
    return Response.redirect(`${url.origin}/#${frag.toString()}`, 302);
  };

  if (!code) return redirectWith({ auth_error: "missing_code" });

  const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      client_id: env.GITHUB_CLIENT_ID,
      client_secret: env.GITHUB_CLIENT_SECRET,
      code,
    }),
  });

  let data;
  try {
    data = await tokenRes.json();
  } catch {
    return redirectWith({ auth_error: "github_unreachable" });
  }

  if (!tokenRes.ok || data.error || !data.access_token) {
    return redirectWith({ auth_error: data.error_description || data.error || "unknown_error" });
  }

  return redirectWith({ gh_token: data.access_token });
}
