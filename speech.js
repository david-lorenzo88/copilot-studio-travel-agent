/* ============================================================
   speech.js
   Azure AI Speech wrapper.
   - STT via continuous recognition with end-of-utterance detection
   - TTS via SpeechSynthesizer with SSML prosody control
   - Short-lived authorization tokens from /api/speech/token
   ============================================================ */

class SpeechClient extends EventTarget {
  constructor({ tokenUrl, recognitionLanguage, synthesisVoice }) {
    super();
    this.tokenUrl = tokenUrl;
    this.recognitionLanguage = recognitionLanguage || "en-US";
    this.synthesisVoice = synthesisVoice || "en-US-AvaMultilingualNeural";

    this.token = null;
    this.region = null;
    this.tokenExpiresAt = 0;

    this.recognizer = null;
    this.synthesizer = null;
    this.audioCtx = null;       // user-gesture activated, kept warm
    this.isListening = false;
    this.isSpeaking = false;
  }

  setVoiceState(state) {
    this.dispatchEvent(new CustomEvent("statechange", { detail: state }));
  }

  // -------------------- token management --------------------

  async _ensureToken() {
    const now = Date.now();
    // Refresh if missing or within 60s of expiry. Tokens last 10 minutes.
    if (this.token && now < this.tokenExpiresAt - 60_000) return;

    const r = await fetch(this.tokenUrl, { method: "POST" });
    if (!r.ok) throw new Error(`Speech token failed: ${r.status}`);
    const data = await r.json();
    this.token = data.token;
    this.region = data.region;
    // Server returns expires_in (seconds). 9 minutes is the safe default.
    const ttlMs = (data.expires_in || 540) * 1000;
    this.tokenExpiresAt = now + ttlMs;
  }

  // -------------------- STT --------------------

  /**
   * Start one round of continuous recognition.
   * Resolves with the final transcript when the user stops speaking.
   * Rejects on cancel/error.
   */
  async recognizeOnce() {
    await this._ensureToken();

    const SDK = window.SpeechSDK;
    if (!SDK) throw new Error("Azure Speech SDK not loaded");

    const speechConfig = SDK.SpeechConfig.fromAuthorizationToken(this.token, this.region);
    speechConfig.speechRecognitionLanguage = this.recognitionLanguage;

    // End-of-utterance / initial silence timeouts — feels natural for a
    // push-to-talk demo while still tolerating a thoughtful pause.
    speechConfig.setProperty(
      SDK.PropertyId.Speech_SegmentationSilenceTimeoutMs, "800"
    );
    speechConfig.setProperty(
      SDK.PropertyId.SpeechServiceConnection_InitialSilenceTimeoutMs, "5000"
    );

    const audioConfig = SDK.AudioConfig.fromDefaultMicrophoneInput();
    const recognizer = new SDK.SpeechRecognizer(speechConfig, audioConfig);
    this.recognizer = recognizer;
    this.isListening = true;
    this.setVoiceState("listening");

    return new Promise((resolve, reject) => {
      let finalText = "";
      let settled = false;
      const finish = (fn, arg) => {
        if (settled) return;
        settled = true;
        this.isListening = false;
        try {
          recognizer.stopContinuousRecognitionAsync(
            () => recognizer.close(),
            () => recognizer.close()
          );
        } catch { /* swallow */ }
        this.recognizer = null;
        fn(arg);
      };

      // Live partial — useful for UI feedback ("you said: ...")
      recognizer.recognizing = (_s, e) => {
        if (e.result.text) {
          this.dispatchEvent(new CustomEvent("partial", { detail: e.result.text }));
        }
      };

      // Final segment recognized.
      recognizer.recognized = (_s, e) => {
        if (e.result.reason === SDK.ResultReason.RecognizedSpeech && e.result.text) {
          finalText += (finalText ? " " : "") + e.result.text;
          // One segment is enough for a single user turn — stop now.
          finish(resolve, finalText.trim());
        } else if (e.result.reason === SDK.ResultReason.NoMatch) {
          finish(reject, new Error("No speech recognized"));
        }
      };

      recognizer.canceled = (_s, e) => {
        if (e.reason === SDK.CancellationReason.Error) {
          finish(reject, new Error(`Recognition error: ${e.errorDetails}`));
        } else {
          finish(reject, new Error("Recognition cancelled"));
        }
      };

      recognizer.sessionStopped = () => finish(reject, new Error("Session stopped"));

      recognizer.startContinuousRecognitionAsync(
        () => { /* started */ },
        (err) => finish(reject, new Error(err))
      );
    });
  }

  stopRecognition() {
    if (this.recognizer) {
      try { this.recognizer.stopContinuousRecognitionAsync(); } catch { /* swallow */ }
    }
    this.isListening = false;
  }

  // -------------------- TTS --------------------

  /**
   * Synthesize text and play it back. Awaits playback completion.
   */
  async speak(text) {
    if (!text || !text.trim()) return;
    await this._ensureToken();

    const SDK = window.SpeechSDK;
    const speechConfig = SDK.SpeechConfig.fromAuthorizationToken(this.token, this.region);
    speechConfig.speechSynthesisVoiceName = this.synthesisVoice;
    speechConfig.speechSynthesisOutputFormat =
      SDK.SpeechSynthesisOutputFormat.Audio24Khz96KBitRateMonoMp3;

    // AudioConfig.fromDefaultSpeakerOutput() routes to the system default
    // playback device through the SDK's internal audio element.
    const audioConfig = SDK.AudioConfig.fromDefaultSpeakerOutput();
    const synthesizer = new SDK.SpeechSynthesizer(speechConfig, audioConfig);
    this.synthesizer = synthesizer;
    this.isSpeaking = true;
    this.setVoiceState("speaking");

    const ssml = this._toSsml(text);

    return new Promise((resolve, reject) => {
      synthesizer.speakSsmlAsync(
        ssml,
        (result) => {
          synthesizer.close();
          this.synthesizer = null;
          this.isSpeaking = false;
          this.setVoiceState("idle");
          if (result.reason === SDK.ResultReason.SynthesizingAudioCompleted) {
            resolve();
          } else {
            reject(new Error(`Synthesis failed: ${result.errorDetails || result.reason}`));
          }
        },
        (err) => {
          synthesizer.close();
          this.synthesizer = null;
          this.isSpeaking = false;
          this.setVoiceState("idle");
          reject(new Error(err));
        }
      );
    });
  }

  stopSpeaking() {
    if (this.synthesizer) {
      try { this.synthesizer.close(); } catch { /* swallow */ }
      this.synthesizer = null;
    }
    this.isSpeaking = false;
    this.setVoiceState("idle");
  }

  /**
   * Wrap plain text in SSML with a natural rate and minor prosody.
   * Also escapes XML special characters from bot replies.
   */
  _toSsml(text) {
    const escaped = text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&apos;");

    const lang = this.synthesisVoice.split("-").slice(0, 2).join("-");
    return [
      `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis"`,
      ` xmlns:mstts="https://www.w3.org/2001/mstts" xml:lang="${lang}">`,
      `<voice name="${this.synthesisVoice}">`,
      `<prosody rate="+5%">${escaped}</prosody>`,
      `</voice></speak>`
    ].join("");
  }
}

window.SpeechClient = SpeechClient;
