/* ============================================================
   launcher.js
   Floating bottom-right button that opens/closes the assistant
   window. Toggles `assistant-open` on <body>, which drives the
   show/hide animation of the chat window and panel dock (CSS).
   ============================================================ */

(() => {
  const launcher = document.getElementById("launcher");
  const input = document.getElementById("composeInput");
  if (!launcher) return;

  function setOpen(open) {
    document.body.classList.toggle("assistant-open", open);
    launcher.classList.toggle("open", open);
    launcher.setAttribute("aria-expanded", String(open));
    launcher.setAttribute(
      "aria-label",
      open ? "Close Untethered365 Travel Agent" : "Open Untethered365 Travel Agent"
    );
    if (open && input) {
      // Wait for the open animation before focusing so the caret lands cleanly.
      setTimeout(() => input.focus(), 360);
    }
  }

  launcher.addEventListener("click", () => {
    setOpen(!document.body.classList.contains("assistant-open"));
  });

  // Let other modules (e.g. the panel switcher) open the window when the agent
  // surfaces a map, booking, or quotation panel.
  window.openAssistant = () => {
    if (!document.body.classList.contains("assistant-open")) setOpen(true);
  };

  // Esc closes the window.
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && document.body.classList.contains("assistant-open")) {
      setOpen(false);
    }
  });
})();
