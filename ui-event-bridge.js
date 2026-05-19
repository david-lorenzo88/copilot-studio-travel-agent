/* ============================================================
   ui-event-bridge.js
   Translates DirectLine event activities into DOM CustomEvents.

   Listeners subscribe via:
     window.addEventListener("agent:hotels", e => { ... e.detail ... });
   ============================================================ */

class UIEventBridge {
  constructor() {
    this.seenEventNames = new Set();
  }

  /**
   * Inspect a DirectLine activity. If it's an event activity (type === "event"),
   * dispatch it as a DOM CustomEvent. Returns true if the activity was an event
   * (so the chat renderer can skip it).
   */
  processActivity(activity) {
    if (activity?.type !== "event") return false;
    if (!activity.name) return true;  // unnamed event — silently ignore

    this.seenEventNames.add(activity.name);
    const customEvent = new CustomEvent(activity.name, {
      detail: activity.value || {},
      bubbles: false,
      cancelable: false
    });
    window.dispatchEvent(customEvent);
    console.debug(`[UIEventBridge] Dispatched ${activity.name}`, activity.value);
    return true;
  }
}

window.UIEventBridge = UIEventBridge;