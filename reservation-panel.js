/* ============================================================
   reservation-panel.js
   Side panel that shows full booking details after a reservation.
   Subscribes to agent:reservation, fetches data via DataverseClient,
   renders the result. Shares the side-panel slot with HotelMap.
   ============================================================ */

class ReservationPanel {
  constructor(containerId, panelId, dataverseClient, switcher) {
    this.containerId = containerId;
    this.panelId = panelId || "reservationPanel";
    this.layout = document.getElementById("layout");
    this.panel = document.getElementById(this.panelId);
    this.container = document.getElementById(this.containerId);
    this.closeButton = document.getElementById("reservationClose");
    this.dataverseClient = dataverseClient;
    this.switcher = switcher;

    this.lastConfirmationCode = null;
    this.lastData = null;

    if (this.closeButton) {
      this.closeButton.addEventListener("click", () => this.close());
    }

    window.addEventListener("agent:reservation", e => this.onReservation(e.detail));
  }

  async onReservation(detail) {
    const code = detail?.confirmationCode;
    if (!code) {
      console.warn("[ReservationPanel] No confirmation code in event");
      return;
    }

    this.lastConfirmationCode = code;
    this.open();
    this.renderLoading(code);

    try {
      const data = await this.dataverseClient.getReservation(code);
      this.lastData = data;
      this.render(data);
      if (this.switcher) this.switcher.notifyAvailable("reservation");
    } catch (err) {
      console.error("[ReservationPanel] Fetch failed", err);
      this.renderError(err.message);
    }
  }

  open() {
    if (this.switcher) {
      this.switcher.show("reservation");
    } else {
      // Fallback if no switcher present
      if (this.panel) this.panel.classList.add("visible");
      if (this.layout) this.layout.classList.add("panel-open");
    }
  }

  close() {
    if (this.switcher) {
      this.switcher.hide();
    } else {
      if (this.panel) this.panel.classList.remove("visible");
      if (this.layout) this.layout.classList.remove("panel-open");
    }
  }

  reopen() {
    if (!this.lastData) return;
    this.open();
    this.render(this.lastData);
  }

  renderLoading(code) {
    this.container.innerHTML = `
      <div class="rp-loading">
        <div class="rp-spinner"></div>
        <div class="rp-loading-text">Loading reservation ${this.escape(code)}…</div>
      </div>
    `;
  }

  renderError(message) {
    this.container.innerHTML = `
      <div class="rp-error">
        <div class="rp-error-title">Could not load reservation</div>
        <div class="rp-error-message">${this.escape(message)}</div>
      </div>
    `;
  }

  render(data) {
    const nights = this.nightsBetween(data.checkInDate, data.checkOutDate);
    const totalPrice = nights * (data.room.pricePerNight || 0);

    const initials = (data.guest.fullName || "?")
      .split(/\s+/).filter(Boolean).slice(0, 2)
      .map(s => s[0]).join("").toUpperCase();

    const stars = "★".repeat(data.hotel.stars || 0);
    const checkIn = this.formatDate(data.checkInDate);
    const checkOut = this.formatDate(data.checkOutDate);

    this.container.innerHTML = `
      <div class="rp">
        <header class="rp-header">
          <div class="rp-status-badge">${this.escape(data.status || "Confirmed")}</div>
          <div class="rp-code">${this.escape(data.confirmationCode)}</div>
          <div class="rp-total">€${Math.round(totalPrice).toLocaleString()}</div>
          <div class="rp-total-label">${nights} ${nights === 1 ? "night" : "nights"} · total</div>
        </header>

        <section class="rp-section">
          <h3 class="rp-section-title">Guest</h3>
          <div class="rp-guest">
            <div class="rp-avatar">${this.escape(initials)}</div>
            <div class="rp-guest-info">
              <div class="rp-guest-name">${this.escape(data.guest.fullName || "—")}</div>
              <div class="rp-guest-meta">${this.escape(data.guest.email || "")}</div>
              ${data.guest.phone ? `<div class="rp-guest-meta">${this.escape(data.guest.phone)}</div>` : ""}
              ${data.guest.loyaltyNumber ? `<div class="rp-guest-meta rp-loyalty">Loyalty: ${this.escape(data.guest.loyaltyNumber)}</div>` : ""}
            </div>
          </div>
        </section>

        <section class="rp-section">
          <h3 class="rp-section-title">Hotel</h3>
          <div class="rp-hotel-name">${this.escape(data.hotel.name || "—")} <span class="rp-stars">${stars}</span></div>
          <div class="rp-hotel-meta">${this.escape(data.hotel.address || "")}</div>
          <div class="rp-hotel-meta">${this.escape(data.hotel.city || "")}${data.hotel.country ? `, ${this.escape(data.hotel.country)}` : ""}</div>
          ${data.hotel.description ? `<div class="rp-hotel-desc">${this.escape(data.hotel.description)}</div>` : ""}
          ${data.hotel.amenities ? `<div class="rp-amenities">${this.renderAmenities(data.hotel.amenities)}</div>` : ""}
        </section>

        <section class="rp-section">
          <h3 class="rp-section-title">Room</h3>
          <div class="rp-row">
            <span class="rp-label">Type</span>
            <span class="rp-value">${this.escape(data.room.name || "—")} (${this.escape(data.room.type || "")})</span>
          </div>
          <div class="rp-row">
            <span class="rp-label">Capacity</span>
            <span class="rp-value">${data.room.capacity || "—"} guests</span>
          </div>
          <div class="rp-row">
            <span class="rp-label">Per night</span>
            <span class="rp-value">€${Math.round(data.room.pricePerNight || 0).toLocaleString()}</span>
          </div>
        </section>

        <section class="rp-section">
          <h3 class="rp-section-title">Stay</h3>
          <div class="rp-row">
            <span class="rp-label">Check-in</span>
            <span class="rp-value">${checkIn}</span>
          </div>
          <div class="rp-row">
            <span class="rp-label">Check-out</span>
            <span class="rp-value">${checkOut}</span>
          </div>
          <div class="rp-row">
            <span class="rp-label">Nights</span>
            <span class="rp-value">${nights}</span>
          </div>
          ${data.specialRequests ? `
            <div class="rp-row rp-row-block">
              <span class="rp-label">Special requests</span>
              <span class="rp-value rp-requests">${this.escape(data.specialRequests)}</span>
            </div>
          ` : ""}
        </section>
      </div>
    `;
  }

  renderAmenities(amenitiesString) {
    return amenitiesString
      .split(/[,;]/)
      .map(a => a.trim())
      .filter(Boolean)
      .map(a => `<span class="rp-amenity">${this.escape(a)}</span>`)
      .join("");
  }

  nightsBetween(checkIn, checkOut) {
    if (!checkIn || !checkOut) return 0;
    const start = new Date(checkIn).getTime();
    const end = new Date(checkOut).getTime();
    return Math.max(0, Math.round((end - start) / (1000 * 60 * 60 * 24)));
  }

  formatDate(d) {
    if (!d) return "—";
    try {
      return new Date(d).toLocaleDateString(undefined, {
        weekday: "short", year: "numeric", month: "short", day: "numeric"
      });
    } catch {
      return d;
    }
  }

  escape(s) {
    return String(s || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }
}

window.ReservationPanel = ReservationPanel;