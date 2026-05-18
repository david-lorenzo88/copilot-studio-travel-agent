// api/speech-token/index.js
// POST /api/speech/token  →  { token, region, expires_in }
// Issues a short-lived (10-minute) Azure Speech authorization token.
// Keeps the long-lived subscription key off the browser.
//
// App settings:
//   SPEECH_KEY     — primary key of the Speech (or Foundry-multi-service) resource
//   SPEECH_REGION  — e.g. "swedencentral"

module.exports = async function (context, req) {
  const { SPEECH_KEY, SPEECH_REGION } = process.env;
  if (!SPEECH_KEY || !SPEECH_REGION) {
    context.res = { status: 500, body: { error: "SPEECH_KEY / SPEECH_REGION not set" } };
    return;
  }

  try {
    const resp = await fetch(
      `https://${SPEECH_REGION}.api.cognitive.microsoft.com/sts/v1.0/issueToken`,
      {
        method: "POST",
        headers: {
          "Ocp-Apim-Subscription-Key": SPEECH_KEY,
          "Content-Length": "0"
        }
      }
    );

    if (!resp.ok) {
      const detail = await resp.text();
      context.log.error("Speech token failed", resp.status, detail);
      context.res = { status: resp.status, body: { error: "Token issue failed", detail } };
      return;
    }

    const token = await resp.text();
    context.res = {
      status: 200,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
      body: {
        token,
        region: SPEECH_REGION,
        expires_in: 540  // 9 minutes, conservative; actual lifetime is 10
      }
    };
  } catch (err) {
    context.log.error(err);
    context.res = { status: 500, body: { error: err.message } };
  }
};
