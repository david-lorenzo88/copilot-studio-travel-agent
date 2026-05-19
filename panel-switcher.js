/* ============================================================
   panel-switcher.js
   Manages which side panel is visible. Hides the others when
   one opens. Toggles the layout class so chat narrows.

   Each panel has:
   - panelId   (the .map-panel or .reservation-panel element id)
   - toggleId  (the button in the topbar that re-opens it)
   ============================================================ */

class PanelSwitcher {
  constructor(panels) {
    // panels: [{ key, panelId, toggleId, onReopen }]
    this.panels = panels;
    this.layout = document.getElementById("layout");
    this.active = null;
    this.available = new Set(); // panels that have data ready to show

    for (const p of panels) {
      const toggle = document.getElementById(p.toggleId);
      if (toggle) {
        toggle.addEventListener("click", () => {
          if (this.active === p.key) {
            this.hide();
          } else {
            this.show(p.key);
            if (typeof p.onReopen === "function") p.onReopen();
          }
        });
      }
    }
  }

  show(key) {
    const panel = this.panels.find(p => p.key === key);
    if (!panel) return;

    // Hide all panels
    for (const p of this.panels) {
      const el = document.getElementById(p.panelId);
      if (el) el.classList.remove("visible");
      const toggle = document.getElementById(p.toggleId);
      if (toggle) toggle.classList.remove("active");
    }

    // Show the requested panel
    const el = document.getElementById(panel.panelId);
    if (el) el.classList.add("visible");
    const toggle = document.getElementById(panel.toggleId);
    if (toggle) toggle.classList.add("active");

    if (this.layout) this.layout.classList.add("panel-open");
    this.active = key;
  }

  hide() {
    for (const p of this.panels) {
      const el = document.getElementById(p.panelId);
      if (el) el.classList.remove("visible");
      const toggle = document.getElementById(p.toggleId);
      if (toggle) toggle.classList.remove("active");
    }
    if (this.layout) this.layout.classList.remove("panel-open");
    this.active = null;
  }

  notifyAvailable(key) {
    this.available.add(key);
    const panel = this.panels.find(p => p.key === key);
    if (!panel) return;
    const toggle = document.getElementById(panel.toggleId);
    if (toggle) toggle.classList.remove("hidden");
  }
}

window.PanelSwitcher = PanelSwitcher;