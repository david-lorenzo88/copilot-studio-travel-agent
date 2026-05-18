// api/directline-token/index.js
// POST /api/directline/token  →  { token, conversationId, expires_in }
// Mints a short-lived DirectLine token from the long-lived secret.
// Long-lived secret lives in app settings — NEVER ship to browser.

module.exports = async function (context, req) {
  const secret = process.env.DIRECTLINE_SECRET;
  if (!secret) {
    context.res = { status: 500, body: { error: "DIRECTLINE_SECRET not set" } };
    return;
  }

  try {
    const resp = await fetch("https://directline.botframework.com/v3/directline/tokens/generate", {
      method: "POST",
      headers: { Authorization: `Bearer ${secret}` }
    });
    if (!resp.ok) {
      context.res = { status: resp.status, body: await resp.text() };
      return;
    }
    const data = await resp.json();
    context.res = {
      status: 200,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
      body: data
    };
  } catch (err) {
    context.res = { status: 500, body: { error: err.message } };
  }
};
