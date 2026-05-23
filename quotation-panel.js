/* ============================================================
   quotation-panel.js
   Side panel showing a full travel quotation: header with total,
   hotel, flights, day-by-day itinerary, pricing breakdown, and a
   download button for the generated PDF. Subscribes to
   agent:quotation, fetches from Dataverse, renders. Shares the
   side-panel slot via PanelSwitcher.
   ============================================================ */

class QuotationPanel {
  constructor(containerId, panelId, dataverseClient, switcher) {
    this.containerId = containerId;
    this.panelId = panelId || "quotationPanel";
    this.layout = document.getElementById("layout");
    this.panel = document.getElementById(this.panelId);
    this.container = document.getElementById(this.containerId);
    this.closeButton = document.getElementById("quotationClose");
    this.dataverseClient = dataverseClient;
    this.switcher = switcher;

    this.lastId = null;
    this.lastData = null;

    if (this.closeButton) this.closeButton.addEventListener("click", () => this.close());
    window.addEventListener("agent:quotation", e => this.onQuotation(e.detail));
  }

  async onQuotation(detail) {
    const id = detail?.quotationId;
    if (!id) { console.warn("[QuotationPanel] No quotationId in event"); return; }
    this.lastId = id;
    this.open();
    this.renderLoading();
    try {
      const data = await this.dataverseClient.getQuotation(id);
      this.lastData = data;
      this.render(data);
      if (this.switcher) this.switcher.notifyAvailable("quotation");
    } catch (err) {
      console.error("[QuotationPanel] Fetch failed", err);
      this.renderError(err.message);
    }
  }

  open() {
    if (this.switcher) this.switcher.show("quotation");
    else { this.panel?.classList.add("visible"); this.layout?.classList.add("panel-open"); }
  }
  close() {
    if (this.switcher) this.switcher.hide();
    else { this.panel?.classList.remove("visible"); this.layout?.classList.remove("panel-open"); }
  }
  reopen() { if (this.lastData) { this.open(); this.render(this.lastData); } }

  renderLoading() {
    this.container.innerHTML = `
      <div class="qp-loading">
        <div class="qp-spinner"></div>
        <div class="qp-loading-text">Assembling your quotation…</div>
      </div>`;
  }
  renderError(message) {
    this.container.innerHTML = `
      <div class="qp-error">
        <div class="qp-error-title">Could not load quotation</div>
        <div class="qp-error-message">${this.escape(message)}</div>
      </div>`;
  }

  money(n, cur = "EUR") {
    const sym = cur === "EUR" ? "€" : cur + " ";
    return `${sym}${Math.round(n || 0).toLocaleString()}`;
  }

  render(data) {
    const cur = data.currency || "EUR";
    const stars = "★".repeat(data.hotel?.stars || 0);

    const daysHtml = (data.days || []).map(d => {
      const acts = (d.activities || []).map(a => `
        <tr>
          <td>${this.escape(a.name)}</td>
          <td>${this.escape(a.startTime)}</td>
          <td>${a.durationMinutes ? a.durationMinutes + " min" : ""}</td>
          <td class="qp-act-cost">${this.money(a.cost, cur)}</td>
        </tr>`).join("");

      return `
        <div class="qp-day">
          <div class="qp-day-head">
            <span class="qp-day-title">Day ${d.dayNumber}${d.date ? " · " + this.escape(d.date) : ""}</span>
            <span class="qp-day-total">${this.money(d.dayTotal, cur)}</span>
          </div>
          ${d.weather ? `<div class="qp-day-weather">${this.escape(d.weather)}</div>` : ""}
          ${d.morning ? `<div class="qp-slot"><span class="qp-slot-label">Morning</span> ${this.escape(d.morning)}</div>` : ""}
          ${d.afternoon ? `<div class="qp-slot"><span class="qp-slot-label">Afternoon</span> ${this.escape(d.afternoon)}</div>` : ""}
          ${d.evening ? `<div class="qp-slot"><span class="qp-slot-label">Evening</span> ${this.escape(d.evening)}</div>` : ""}
          ${acts ? `<table class="qp-act-table"><tbody>${acts}</tbody></table>` : ""}
        </div>`;
    }).join("");

    this.container.innerHTML = `
      <div class="qp">
        <header class="qp-header">
          <div class="qp-status">${this.escape(data.status || "Draft")}</div>
          <div class="qp-number">${this.escape(data.quoteNumber || "")}</div>
          <div class="qp-total">${this.money(data.total, cur)}</div>
          <div class="qp-total-label">total</div>
        </header>

        <section class="qp-section">
          <h3 class="qp-section-title">Trip</h3>
          <div class="qp-row"><span class="qp-label">Destination</span><span class="qp-value">${this.escape(data.destination || "")}${data.country ? ", " + this.escape(data.country) : ""}</span></div>
          <div class="qp-row"><span class="qp-label">From</span><span class="qp-value">${this.escape(data.origin || "")}</span></div>
          <div class="qp-row"><span class="qp-label">Dates</span><span class="qp-value">${this.escape(data.checkIn || "")} → ${this.escape(data.checkOut || "")}</span></div>
          <div class="qp-row"><span class="qp-label">Nights</span><span class="qp-value">${data.nights || ""}</span></div>
          <div class="qp-row"><span class="qp-label">Travelers</span><span class="qp-value">${data.adults || 0} adults${data.children ? ", " + data.children + " children" : ""}</span></div>
        </section>

        ${data.hotel?.name ? `
        <section class="qp-section">
          <h3 class="qp-section-title">Hotel</h3>
          <div class="qp-hotel-name">${this.escape(data.hotel.name)} <span class="qp-stars">${stars}</span></div>
          ${data.hotel.address ? `<div class="qp-muted">${this.escape(data.hotel.address)}</div>` : ""}
          ${data.hotel.room ? `<div class="qp-muted">${this.escape(data.hotel.room)} (${this.escape(data.hotel.roomType || "")})</div>` : ""}
        </section>` : ""}

        ${data.flights?.outbound ? `
        <section class="qp-section">
          <h3 class="qp-section-title">Flights</h3>
          <div class="qp-row"><span class="qp-label">Outbound</span><span class="qp-value">${this.escape(data.flights.outbound)} · ${this.escape(data.flights.outboundDate || "")}</span></div>
          <div class="qp-row"><span class="qp-label">Return</span><span class="qp-value">${this.escape(data.flights.return)} · ${this.escape(data.flights.returnDate || "")}</span></div>
        </section>` : ""}

        ${daysHtml ? `
        <section class="qp-section">
          <h3 class="qp-section-title">Itinerary</h3>
          ${daysHtml}
        </section>` : ""}

        <section class="qp-section">
          <h3 class="qp-section-title">Pricing</h3>
          <div class="qp-row"><span class="qp-label">Hotel</span><span class="qp-value">${this.money(data.subtotals?.hotel, cur)}</span></div>
          <div class="qp-row"><span class="qp-label">Activities</span><span class="qp-value">${this.money(data.subtotals?.activities, cur)}</span></div>
          <div class="qp-row"><span class="qp-label">Flights</span><span class="qp-value">${this.money(data.subtotals?.flights, cur)}</span></div>
          <div class="qp-row qp-grand"><span class="qp-label">Grand total</span><span class="qp-value">${this.money(data.total, cur)}</span></div>
        </section>

        ${data.documentUrl ? `
          <a class="qp-download" href="${this.escapeAttr(data.documentUrl)}" target="_blank" rel="noopener noreferrer">
            Download quote PDF
          </a>` : `
          <div class="qp-muted qp-pending">Document will appear once the quote is finalized.</div>`}
      </div>`;
  }

  escape(s) {
    return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
  escapeAttr(s) {
    return this.escape(s).replace(/"/g, "&quot;");
  }
}

window.QuotationPanel = QuotationPanel;