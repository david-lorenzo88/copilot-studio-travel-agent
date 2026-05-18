/* ============================================================
   app.js
   Wires DirectLine, Azure Speech, and the chat UI.
   Voice mode: tap mic to start a hands-free conversation loop.
   Auth: renders OAuth cards and handles the sign-in popup flow.
   ============================================================ */

(() => {
  const cfg = window.AppConfig;
  const chat = document.getElementById("chat");
  const form = document.getElementById("composeForm");
  const input = document.getElementById("composeInput");
  const micButton = document.getElementById("micButton");
  const connStatus = document.getElementById("connectionStatus");
  const voiceStatus = document.getElementById("voiceStatus");

  function setPill(el, text, cls) {
    el.textContent = text;
    el.className = "pill " + (cls || "pill-muted");
  }

  // ---------- chat UI helpers ----------

  function addBubble(role, text) {
    const b = document.createElement("div");
    b.className = `bubble ${role}`;
    b.textContent = text;
    chat.appendChild(b);
    chat.scrollTop = chat.scrollHeight;
    return b;
  }

  function addMeta(text) {
    const b = document.createElement("div");
    b.className = "bubble meta";
    b.textContent = text;
    chat.appendChild(b);
    chat.scrollTop = chat.scrollHeight;
    return b;
  }

  function addTyping() {
    const b = document.createElement("div");
    b.className = "bubble bot";
    b.innerHTML = '<span class="typing"><span></span><span></span><span></span></span>';
    chat.appendChild(b);
    chat.scrollTop = chat.scrollHeight;
    return b;
  }

  function renderHotelCards(activity) {
    const value = activity.value || activity.attachments?.[0]?.content?.body;
    if (!value || !Array.isArray(value.hotels)) return null;

    const wrap = document.createElement("div");
    wrap.className = "bubble bot";
    const intro = document.createElement("div");
    intro.textContent = `Found ${value.hotels.length} options in ${value.searchedCity || "the area"}:`;
    wrap.appendChild(intro);

    const list = document.createElement("div");
    list.className = "card-list";
    for (const h of value.hotels.slice(0, 5)) {
      const card = document.createElement("div");
      card.className = "card";
      card.innerHTML = `
        <div>
          <div class="name">${h.hotelName} · ${"★".repeat(h.stars)}</div>
          <div class="meta">${h.cheapestRoomType} · ${h.nights} nights</div>
        </div>
        <div class="price">€${Math.round(h.totalPrice).toLocaleString()}</div>
      `;
      list.appendChild(card);
    }
    wrap.appendChild(list);
    chat.appendChild(wrap);
    chat.scrollTop = chat.scrollHeight;
    return wrap;
  }

  /**
   * Detect and render an OAuth sign-in card. Returns the rendered element if
   * the activity carried one; null otherwise.
   */
  function renderOAuthCard(activity) {
    const attachment = activity.attachments?.[0];
    if (!attachment || attachment.contentType !== "application/vnd.microsoft.card.oauth") {
      return null;
    }

    const card = attachment.content || {};
    const text = card.text || "Please sign in to continue.";
    const button = card.buttons?.[0] || {};
    const buttonText = button.title || "Sign in";
    const signInUrl = button.value;

    const wrap = document.createElement("div");
    wrap.className = "bubble bot";
    const msg = document.createElement("div");
    msg.textContent = text;
    wrap.appendChild(msg);

    const btn = document.createElement("button");
    btn.className = "auth-button";
    btn.textContent = buttonText;
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      btn.textContent = "Signing in…";
      try {
        await handleSignIn(card, signInUrl);
        btn.textContent = "Signed in ✓";
      } catch (err) {
        console.error("Sign-in failed", err);
        btn.disabled = false;
        btn.textContent = buttonText;
        addMeta(`Sign-in failed: ${err.message}`);
      }
    });
    wrap.appendChild(btn);

    chat.appendChild(wrap);
    chat.scrollTop = chat.scrollHeight;
    return wrap;
  }

  /**
   * Open the OAuth sign-in flow in a popup. After completion, DirectLine
   * forwards a token to the bot automatically; we just wait for the popup
   * to close and let the bot continue the conversation.
   */
  async function handleSignIn(card, prebuiltUrl) {
    let signInUrl = prebuiltUrl;

    if (!signInUrl || !signInUrl.startsWith("http")) {
      const connectionName = card.connectionName;
      if (!connectionName) throw new Error("OAuth card has no connectionName");
      try {
        const resp = await dl.getSignInUrl(connectionName);
        signInUrl = resp.signInUrl || resp.link || resp.url;
      } catch (e) {
        throw new Error("Could not retrieve sign-in URL: " + e.message);
      }
    }

    if (!signInUrl) throw new Error("No sign-in URL available");

    const popup = window.open(
      signInUrl,
      "agentSignIn",
      "width=500,height=700,menubar=no,toolbar=no,location=no,status=no"
    );

    if (!popup) {
      throw new Error("Sign-in popup was blocked. Please allow popups for this site.");
    }

    await new Promise((resolve) => {
      const interval = setInterval(() => {
        if (popup.closed) {
          clearInterval(interval);
          resolve();
        }
      }, 500);
      setTimeout(() => {
        clearInterval(interval);
        try { popup.close(); } catch {}
        resolve();
      }, 180000);
    });
  }

  /**
   * Convert bot reply text (which may include URLs, markdown, asterisks)
   * into something Azure Speech will pronounce naturally.
   */
  function textForSpeech(raw) {
    if (!raw) return "";
    return raw
      .replace(/\!\[[^\]]*\]\([^\)]+\)/g, "")
      .replace(/\[([^\]]+)\]\([^\)]+\)/g, "$1")
      .replace(/https?:\/\/\S+/g, "")
      .replace(/[*_`#>]+/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  // ---------- DirectLine ----------

  const dl = new DirectLineClient({ tokenUrl: cfg.directLineTokenUrl });

  let pendingReply = null;
  let pendingTyping = null;

  dl.addEventListener("connected", () => setPill(connStatus, "Connected", "pill-ok"));

  dl.addEventListener("activity", (e) => {
    const act = e.detail;
    if (act.type !== "message") return;

    // OAuth card first — these have no plain-text fallback worth showing
    const oauthRendered = renderOAuthCard(act);

    // Otherwise try structured hotel results, then plain text
    const hotelRendered = oauthRendered ? null : renderHotelCards(act);
    if (!oauthRendered && !hotelRendered && act.text) {
      addBubble("bot", act.text);
    }

    if (pendingTyping) { pendingTyping.remove(); pendingTyping = null; }
    if (pendingReply) {
      const r = pendingReply;
      pendingReply = null;
      r(act.text || "");
    }
  });

  function sendToBot(text) {
    pendingTyping = addTyping();
    return new Promise(async (resolve) => {
      pendingReply = resolve;
      try {
        await dl.sendText(text);
      } catch (err) {
        if (pendingTyping) { pendingTyping.remove(); pendingTyping = null; }
        pendingReply = null;
        resolve(`I couldn't reach the travel system: ${err.message}`);
      }
      setTimeout(() => {
        if (pendingReply === resolve) {
          pendingReply = null;
          if (pendingTyping) { pendingTyping.remove(); pendingTyping = null; }
          resolve("Still working on that. Want to try a different question?");
        }
      }, 20000);
    });
  }

  // ---------- Voice ----------

  const speech = new SpeechClient({
    tokenUrl: cfg.speechTokenUrl,
    recognitionLanguage: cfg.speechRecognitionLanguage,
    synthesisVoice: cfg.speechSynthesisVoice
  });

  let voiceMode = false;
  let livePartial = null;

  speech.addEventListener("statechange", (e) => {
    const s = e.detail;
    micButton.classList.remove("listening", "speaking");
    if (s === "listening") {
      micButton.classList.add("listening");
      setPill(voiceStatus, "Listening", "pill-warn");
    } else if (s === "speaking") {
      micButton.classList.add("speaking");
      setPill(voiceStatus, "Speaking", "pill-ok");
    } else if (s === "idle") {
      setPill(voiceStatus, voiceMode ? "Voice on" : "Voice off",
              voiceMode ? "pill-ok" : "pill-muted");
    }
  });

  speech.addEventListener("partial", (e) => {
    const text = e.detail;
    if (!livePartial) {
      livePartial = addBubble("user", text);
      livePartial.style.opacity = "0.6";
    } else {
      livePartial.textContent = text;
    }
  });

  async function voiceTurn() {
    let userText;
    try {
      userText = await speech.recognizeOnce();
    } catch (err) {
      if (livePartial) { livePartial.remove(); livePartial = null; }
      addMeta(`Voice paused (${err.message}). Tap the mic to resume.`);
      voiceMode = false;
      setPill(voiceStatus, "Voice off");
      return;
    }

    if (livePartial) {
      livePartial.textContent = userText;
      livePartial.style.opacity = "";
      livePartial = null;
    } else {
      addBubble("user", userText);
    }

    const reply = await sendToBot(userText);
    const spoken = textForSpeech(reply);
    if (spoken) {
      try {
        await speech.speak(spoken);
      } catch (err) {
        addMeta(`Voice playback failed: ${err.message}`);
      }
    }

    if (voiceMode) {
      setTimeout(() => { if (voiceMode) voiceTurn(); }, 300);
    }
  }

  micButton.addEventListener("click", async () => {
    if (voiceMode) {
      voiceMode = false;
      speech.stopRecognition();
      speech.stopSpeaking();
      setPill(voiceStatus, "Voice off");
      return;
    }
    voiceMode = true;
    setPill(voiceStatus, "Voice on", "pill-ok");
    voiceTurn();
  });

  // ---------- Text composer ----------

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    input.value = "";
    addBubble("user", text);
    await sendToBot(text);
  });

  // ---------- Boot ----------

  (async () => {
    try {
      await dl.connect();
    } catch (e) {
      setPill(connStatus, "Disconnected", "pill-err");
      addMeta(`Couldn't connect to bot: ${e.message}`);
    }
  })();
})();