/* ============================================================
   app.js
   Wires DirectLine, Azure Speech, and the chat UI.
   Voice mode: tap mic to start a hands-free conversation loop.
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
   * Convert bot reply text (which may include URLs, markdown, asterisks)
   * into something Azure Speech will pronounce naturally.
   */
  function textForSpeech(raw) {
    if (!raw) return "";
    return raw
      .replace(/\!\[[^\]]*\]\([^\)]+\)/g, "")        // image markdown
      .replace(/\[([^\]]+)\]\([^\)]+\)/g, "$1")      // link markdown
      .replace(/https?:\/\/\S+/g, "")                 // bare URLs
      .replace(/[*_`#>]+/g, "")                       // markdown noise
      .replace(/\s+/g, " ")
      .trim();
  }

  // ---------- DirectLine ----------

  const dl = new DirectLineClient({ tokenUrl: cfg.directLineTokenUrl });

  // Pending resolver for whichever turn we're waiting on (text OR voice).
  let pendingReply = null;
  let pendingTyping = null;

  dl.addEventListener("connected", () => setPill(connStatus, "Connected", "pill-ok"));

  dl.addEventListener("activity", (e) => {
    const act = e.detail;
    if (act.type !== "message") return;

    // Try to render structured hotel results, otherwise plain text.
    const rendered = renderHotelCards(act);
    if (!rendered && act.text) addBubble("bot", act.text);

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
      // Safety: never hang forever.
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
  let livePartial = null; // shows what the user is saying as they say it

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

  /**
   * Single voice turn:
   *  1. recognize one utterance
   *  2. post to bot, await reply
   *  3. speak the reply
   * Returns void; loops in voice mode until disabled.
   */
  async function voiceTurn() {
    let userText;
    try {
      userText = await speech.recognizeOnce();
    } catch (err) {
      if (livePartial) { livePartial.remove(); livePartial = null; }
      // Common case: no speech / silence timeout. Stop voice mode gracefully.
      addMeta(`Voice paused (${err.message}). Tap the mic to resume.`);
      voiceMode = false;
      setPill(voiceStatus, "Voice off");
      return;
    }

    // Promote the live-partial bubble to a final user bubble.
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

    // Continue the conversation loop until user taps mic again.
    if (voiceMode) {
      // Tiny gap so the recognizer doesn't pick up the tail of the TTS.
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
