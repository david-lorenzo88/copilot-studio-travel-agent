/* ============================================================
   app.js
   Wires DirectLine, Azure Speech, side panels, and the chat UI.
   - Voice mode: tap mic to start a hands-free conversation loop
   - Adaptive cards: connection-manager and similar cards
   - UI events: side-channel event activities routed to the bridge,
     which dispatches DOM CustomEvents for components (HotelMap,
     ReservationPanel, future widgets)
   - Markdown rendering for agent replies that look like markdown
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
    if (role === "bot" && looksLikeMarkdown(text)) {
      b.classList.add("md");
      b.innerHTML = mdToHtml(text);
    } else {
      b.textContent = text;
    }
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

  // ---------- Adaptive card rendering ----------

  function renderAdaptiveCard(activity) {
    const attachment = activity.attachments?.[0];
    if (!attachment || attachment.contentType !== "application/vnd.microsoft.card.adaptive") {
      return null;
    }
    const card = attachment.content;
    if (!card || card.type !== "AdaptiveCard") return null;

    const wrap = document.createElement("div");
    wrap.className = "bubble bot adaptive";

    if (Array.isArray(card.body)) {
      for (const item of card.body) renderAdaptiveItem(item, wrap);
    }
    if (Array.isArray(card.actions) && card.actions.length > 0) {
      renderActionSet({ actions: card.actions }, wrap);
    }

    chat.appendChild(wrap);
    chat.scrollTop = chat.scrollHeight;
    return wrap;
  }

  function renderAdaptiveItem(item, parent) {
    if (!item || !item.type) return;

    switch (item.type) {
      case "TextBlock": {
        const p = document.createElement("p");
        p.className = "ac-text";
        if (item.wrap !== false) p.style.whiteSpace = "normal";
        p.innerHTML = markdownLite(item.text || "");
        parent.appendChild(p);
        break;
      }
      case "ColumnSet": {
        const row = document.createElement("div");
        row.className = "ac-row";
        if (Array.isArray(item.columns)) {
          for (const col of item.columns) renderAdaptiveItem(col, row);
        }
        parent.appendChild(row);
        break;
      }
      case "Column": {
        const col = document.createElement("div");
        col.className = "ac-col";
        if (item.width && typeof item.width === "string") {
          const n = parseFloat(item.width);
          if (!isNaN(n)) col.style.flex = String(n);
        }
        if (Array.isArray(item.items)) {
          for (const child of item.items) renderAdaptiveItem(child, col);
        }
        parent.appendChild(col);
        break;
      }
      case "ActionSet": {
        renderActionSet(item, parent);
        break;
      }
      case "Container": {
        const c = document.createElement("div");
        c.className = "ac-container";
        if (Array.isArray(item.items)) {
          for (const child of item.items) renderAdaptiveItem(child, c);
        }
        parent.appendChild(c);
        break;
      }
      default:
        console.debug("Unhandled adaptive item type:", item.type, item);
    }
  }

  function renderActionSet(item, parent) {
    if (!Array.isArray(item.actions) || item.actions.length === 0) return;
    const row = document.createElement("div");
    row.className = "ac-actions";
    for (const action of item.actions) {
      const btn = document.createElement("button");
      btn.className = "ac-button";
      if (action.style === "positive") btn.classList.add("ac-button-positive");
      if (action.style === "destructive") btn.classList.add("ac-button-destructive");
      btn.textContent = action.title || "Action";
      btn.addEventListener("click", () => handleAdaptiveAction(action, btn));
      row.appendChild(btn);
    }
    parent.appendChild(row);
  }

  function handleAdaptiveAction(action, btn) {
    if (action.type === "Action.OpenUrl" && action.url) {
      window.open(action.url, "_blank", "noopener,noreferrer");
      return;
    }
    const data = action.data || {};
    btn.disabled = true;
    btn.textContent = btn.textContent + "…";

    if (data.action) {
      addBubble("user", data.action);
    }

    dl.sendValue(data).catch(err => {
      addMeta(`Action failed: ${err.message}`);
      btn.disabled = false;
    });
  }

  function markdownLite(s) {
    const esc = s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const linked = esc.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, url) => {
      const safeUrl = url.replace(/"/g, "&quot;");
      return `<a href="${safeUrl}" target="_blank" rel="noopener noreferrer" class="ac-link">${label}</a>`;
    });
    return linked.replace(/\n/g, "<br>");
  }

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

  // ---------- UI event bridge + Dataverse + side panels ----------

  const uiBridge = new UIEventBridge();
  const dataverse = new DataverseClient();

  

  const panelSwitcher = new PanelSwitcher([
    { key: "map", panelId: "mapPanel", toggleId: "showMapButton" },
    { key: "reservation", panelId: "reservationPanel", toggleId: "showReservationButton" },
    { key: "quotation", panelId: "quotationPanel", toggleId: "showQuotationButton" }
  ]);

  const hotelMap = new HotelMap("hotelMap", "mapPanel", panelSwitcher);
  const reservationPanel = new ReservationPanel("reservationContent", "reservationPanel", dataverse, panelSwitcher);
  const quotationPanel = new QuotationPanel("quotationContent", "quotationPanel", dataverse, panelSwitcher);

  // Reveal the Map toggle in the topbar after hotels arrive for the first time
  window.addEventListener("agent:hotels", () => panelSwitcher.notifyAvailable("map"));
  // The reservation toggle is revealed from inside ReservationPanel after a successful fetch.

  // ---------- DirectLine ----------

  const dl = new DirectLineClient({ tokenUrl: cfg.directLineTokenUrl });

  let pendingReply = null;
  let pendingTyping = null;

  dl.addEventListener("connected", () => setPill(connStatus, "Connected", "pill-ok"));

  dl.addEventListener("activity", (e) => {
    const act = e.detail;

    // Side-channel event activities go to the UI bridge and don't render in chat
    if (uiBridge.processActivity(act)) return;

    // Everything else is treated as a regular conversational activity
    if (act.type !== "message") return;

    if (isInternalJsonPayload(act.text)) {
      // Internal data meant for flows/panels, not for the user to read.
      // Clean up the typing indicator and resolve any pending reply so the
      // conversation loop doesn't hang waiting on this turn.
      if (pendingTyping) { pendingTyping.remove(); pendingTyping = null; }
      if (pendingReply) {
        const r = pendingReply;
        pendingReply = null;
        r(""); // resolve with empty so voice mode doesn't try to speak JSON
      }
      return;
    }

    const adaptiveRendered = renderAdaptiveCard(act);
    const hotelRendered = adaptiveRendered ? null : renderHotelCards(act);

    if (!adaptiveRendered && !hotelRendered) {
      if (act.text) {
        addBubble("bot", act.text);
      } else if (act.speak) {
        addBubble("bot", act.speak);
      } else if (act.attachments?.length > 0) {
        console.warn("Unrendered attachment", act.attachments[0]);
        addMeta("(received a structured message I couldn't display)");
      }
    }

    if (pendingTyping) { pendingTyping.remove(); pendingTyping = null; }
    if (pendingReply) {
      const r = pendingReply;
      pendingReply = null;
      r(act.text || act.speak || "");
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
      }, 60000);
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