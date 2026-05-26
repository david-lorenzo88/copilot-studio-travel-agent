// api/foundry-summarize/index.js
// POST /api/foundry/summarize   body: { text }   -> { summary }
//
// Shortens a long on-screen assistant reply into ONE spoken sentence for
// text-to-speech, so live audio stays brief. Keeps the Foundry token off the
// browser by minting it here with a service principal (same Entra app creds
// as the Dataverse functions), then calling the Foundry v1 chat completions
// endpoint with gpt-5.4.
//
// App settings required:
//   FOUNDRY_ENDPOINT   e.g. https://foundry-travelagent.services.ai.azure.com
//   ENTRA_TENANT_ID, ENTRA_CLIENT_ID, ENTRA_CLIENT_SECRET
//   (FOUNDRY_DEPLOYMENT optional, defaults to "gpt-5.4")

let cachedToken = null;
let tokenExpiresAt = 0;

// Cognitive Services / Foundry data-plane scope for AAD auth.
const FOUNDRY_SCOPE = "https://cognitiveservices.azure.com/.default";

async function getAccessToken(context) {
  const now = Date.now();
  if (cachedToken && now < tokenExpiresAt - 300_000) return cachedToken;

  const { ENTRA_TENANT_ID, ENTRA_CLIENT_ID, ENTRA_CLIENT_SECRET } = process.env;
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: ENTRA_CLIENT_ID,
    client_secret: ENTRA_CLIENT_SECRET,
    scope: FOUNDRY_SCOPE
  });

  const resp = await fetch(
    `https://login.microsoftonline.com/${ENTRA_TENANT_ID}/oauth2/v2.0/token`,
    { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: body.toString() }
  );
  if (!resp.ok) {
    const detail = await resp.text();
    context.log.error("Foundry token fetch failed", resp.status, detail);
    throw new Error(`Token fetch failed: ${resp.status}`);
  }
  const data = await resp.json();
  cachedToken = data.access_token;
  tokenExpiresAt = now + data.expires_in * 1000;
  return cachedToken;
}

const SYSTEM_PROMPT =
  "You turn a travel assistant's on-screen reply into ONE short spoken sentence " +
  "(max 25 words) for text-to-speech. Summarize the gist; never read lists, " +
  "flight numbers, times, or prices aloud. If there are options, say how many " +
  "and invite the user to pick from the screen. Plain spoken language, no markdown.";

module.exports = async function (context, req) {
  const text = req.body && req.body.text;
  if (!text || typeof text !== "string") {
    context.res = { status: 400, body: { error: "text required" } };
    return;
  }

  // Very short text shouldn't even reach here (the client guards), but if it
  // does, just echo it back rather than spending a model call.
  if (text.length < 280) {
    context.res = { status: 200, body: { summary: text } };
    return;
  }

  const required = ["FOUNDRY_ENDPOINT", "ENTRA_TENANT_ID", "ENTRA_CLIENT_ID", "ENTRA_CLIENT_SECRET"];
  const missing = required.filter(k => !process.env[k]);
  if (missing.length) {
    context.res = { status: 500, body: { error: "Server configuration incomplete", missing } };
    return;
  }

  try {
    const token = await getAccessToken(context);
    const endpoint = process.env.FOUNDRY_ENDPOINT.replace(/\/$/, "");
    const model = process.env.FOUNDRY_DEPLOYMENT || "gpt-5.4";

    const resp = await fetch(`${endpoint}/openai/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify({
        model,
        reasoning_effort: "low",
        max_completion_tokens: 120,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: text }
        ]
      })
    });

    if (!resp.ok) {
      const detail = await resp.text();
      context.log.error("Foundry summarize failed", resp.status, detail);
      // Soft-fail: let the client speak its own fallback line.
      context.res = { status: 200, body: { summary: "", error: detail } };
      return;
    }

    const data = await resp.json();
    const summary = (data.choices?.[0]?.message?.content || "").trim();

    context.res = {
      status: 200,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
      body: { summary }
    };
  } catch (err) {
    context.log.error(err);
    // Soft-fail so the voice loop falls back gracefully rather than erroring.
    context.res = { status: 200, body: { summary: "", error: err.message } };
  }
};