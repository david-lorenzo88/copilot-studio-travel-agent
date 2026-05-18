/* ============================================================
   directline.js
   Minimal DirectLine client. No SDK, just fetch + a polling
   conversation stream. Good enough for a 25-minute demo and
   keeps the moving parts visible.
   ============================================================ */

class DirectLineClient extends EventTarget {
  constructor({ tokenUrl }) {
    super();
    this.tokenUrl = tokenUrl;
    this.token = null;
    this.conversationId = null;
    this.watermark = null;
    this.polling = false;
  }

  async connect() {
    // Step 1: get a short-lived DirectLine token from your backend.
    const tokenResp = await fetch(this.tokenUrl, { method: "POST" });
    if (!tokenResp.ok) throw new Error(`Token fetch failed: ${tokenResp.status}`);
    const tokenData = await tokenResp.json();
    this.token = tokenData.token;

    // Step 2: start a conversation.
    const convResp = await fetch("https://directline.botframework.com/v3/directline/conversations", {
      method: "POST",
      headers: { Authorization: `Bearer ${this.token}` }
    });
    if (!convResp.ok) throw new Error(`Conversation start failed: ${convResp.status}`);
    const conv = await convResp.json();
    this.conversationId = conv.conversationId;

    this.dispatchEvent(new CustomEvent("connected", { detail: { conversationId: this.conversationId } }));

    // Step 3: kick off the polling loop (we could use WebSocket here, but polling
    // is reliable across venue WiFi and easier to debug live).
    this.polling = true;
    this._poll();
  }

  async sendText(text) {
    if (!this.conversationId) throw new Error("Not connected");
    const resp = await fetch(
      `https://directline.botframework.com/v3/directline/conversations/${this.conversationId}/activities`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.token}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          type: "message",
          from: { id: "user", name: "Guest" },
          text
        })
      }
    );
    if (!resp.ok) {
      const body = await resp.text();
      throw new Error(`Send failed: ${resp.status} ${body}`);
    }
    return await resp.json();
  }

  /**
 * Send a structured value payload (used by Adaptive Card Action.Submit).
 * Wraps it as a message activity with both `value` and `text` so the bot
 * sees the action.
 */
async sendValue(value) {
  if (!this.conversationId) throw new Error("Not connected");
  const resp = await fetch(
    `https://directline.botframework.com/v3/directline/conversations/${this.conversationId}/activities`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        type: "message",
        from: { id: "user", name: "Guest" },
        text: value?.action || "",   // fallback text the bot may log
        value: value
      })
    }
  );
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Send failed: ${resp.status} ${body}`);
  }
  return await resp.json();
}

  async _poll() {
    while (this.polling) {
      try {
        const url = new URL(
          `https://directline.botframework.com/v3/directline/conversations/${this.conversationId}/activities`
        );
        if (this.watermark) url.searchParams.set("watermark", this.watermark);
        const resp = await fetch(url.toString(), {
          headers: { Authorization: `Bearer ${this.token}` }
        });
        if (resp.ok) {
          const data = await resp.json();
          this.watermark = data.watermark;
          for (const activity of data.activities || []) {
            if (activity.from?.id === "user") continue; // echo, ignore
            this.dispatchEvent(new CustomEvent("activity", { detail: activity }));
          }
        }
      } catch (err) {
        console.warn("Poll error", err);
      }
      await new Promise(r => setTimeout(r, 1000));
    }
  }

  /**
   * For an OAuth card attachment, get the sign-in URL the user should visit.
   * DirectLine exchanges the connection name + state for a real OAuth URL
   * that completes the round-trip back to the bot.
   */
  async getSignInUrl(connectionName) {
    if (!this.conversationId) throw new Error("Not connected");

    // DirectLine generates the sign-in URL based on the conversation and
    // the connection name configured server-side in Copilot Studio.
    const url = `https://directline.botframework.com/v3/directline/conversations/${this.conversationId}/tokens?connectionName=${encodeURIComponent(connectionName)}`;

    const resp = await fetch(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${this.token}` }
    });

    if (!resp.ok) {
      const body = await resp.text();
      throw new Error(`Sign-in URL retrieval failed: ${resp.status} ${body}`);
    }

    const data = await resp.json();
    // Response shape: { conversationId, token, expires_in, eTag }
    // The actual sign-in URL is encoded in the response; for OAuth cards we
    // construct it from the card's content.buttons[0].value
    return data;
  }

  disconnect() {
    this.polling = false;
  }
}

window.DirectLineClient = DirectLineClient;
