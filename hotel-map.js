/* ============================================================
   hotel-map.js
   Renders hotels on a Leaflet map in a side panel that slides in.
   Subscribes to agent:hotels DOM events. Handles the Leaflet
   tile-sizing quirk that breaks when the container animates in.

   Integrates with the PanelSwitcher so multiple side panels can
   share the right-side slot — opening the map automatically hides
   any other visible panel.
   ============================================================ */

class HotelMap {
  constructor(containerId, panelId, switcher) {
    this.containerId = containerId;
    this.panelId = panelId || "mapPanel";
    this.layout = document.getElementById("layout");
    this.panel = document.getElementById(this.panelId);
    this.closeButton = document.getElementById("mapClose");
    this.switcher = switcher;

    this.container = null;
    this.map = null;
    this.markers = [];

    if (this.closeButton) {
      this.closeButton.addEventListener("click", () => this.close());
    }

    window.addEventListener("agent:hotels", e => this.onHotels(e.detail));

    // Delegated handler for the "Book this hotel" button inside popups.
    // Popups are created/destroyed dynamically by Leaflet, so we listen
    // once on the document and read the templated message off the button.
    document.addEventListener("click", e => {
      const btn = e.target.closest && e.target.closest(".map-popup-book");
      if (btn) this.onBookClick(btn);
    });
  }

  /**
   * Send the "book this hotel" request to the bot. We don't have direct
   * access to the DirectLine client from here (it lives in app.js), so we
   * dispatch an app:send event that app.js routes through sendToBot —
   * mirroring how the rest of the UI talks to the agent via DOM events.
   */
  onBookClick(btn) {
    const message = btn.getAttribute("data-book-message");
    if (!message) return;
    btn.disabled = true;
    btn.textContent = "Adding to quotation…";
    window.dispatchEvent(new CustomEvent("app:send", { detail: { text: message } }));
  }

  ensureContainer() {
    if (this.container) return this.container;
    this.container = document.getElementById(this.containerId);
    return this.container;
  }

  ensureMap(centerLat, centerLon) {
    if (this.map) return this.map;
    const el = this.ensureContainer();
    if (!el) return null;

    this.map = L.map(el, {
      zoomControl: true,
      scrollWheelZoom: false
    }).setView([centerLat, centerLon], 13);

    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: '&copy; OpenStreetMap',
      maxZoom: 19
    }).addTo(this.map);

    return this.map;
  }

  open() {
    if (this.switcher) {
      this.switcher.show("map");
    } else {
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

  /**
   * Reopen the map panel without re-receiving the hotel data. Useful
   * after the user has closed it or after they've switched to another
   * panel and want to come back. Falls back to no-op if the map was
   * never populated.
   */
  reopen() {
    if (this.markers.length === 0) return;
    this.open();
    setTimeout(() => {
      if (!this.map) return;
      this.map.invalidateSize();
      if (this.markers.length > 1) {
        const bounds = this.markers.map(m => m.getLatLng());
        this.map.fitBounds(bounds, { padding: [50, 50], maxZoom: 16 });
      }
    }, 360);
  }

  clearMarkers() {
    for (const m of this.markers) m.remove();
    this.markers = [];
  }

  onHotels(detail) {
    const { city, hotels } = detail || {};
    if (!Array.isArray(hotels) || hotels.length === 0) return;

    const placed = hotels.filter(h => typeof h.lat === "number" && typeof h.lon === "number");
    if (placed.length === 0) {
      console.warn("[HotelMap] No hotels had coordinates");
      return;
    }

    // Open the panel first so the container starts gaining width
    this.open();

    const centerLat = placed.reduce((s, h) => s + h.lat, 0) / placed.length;
    const centerLon = placed.reduce((s, h) => s + h.lon, 0) / placed.length;

    // First call: initialize the map if needed
    const map = this.ensureMap(centerLat, centerLon);
    if (!map) return;

    this.clearMarkers();

    const bounds = [];
    for (const hotel of placed) {
      const marker = L.marker([hotel.lat, hotel.lon])
        .addTo(map)
        .bindPopup(this.popupHtml(hotel));
      this.markers.push(marker);
      bounds.push([hotel.lat, hotel.lon]);
    }

    // CRITICAL: invalidate size AFTER the slide-in animation completes.
    // Without this, the tile layer is laid out against the initial
    // (collapsed) container width and tiles render as a tiny strip.
    // We also do the fitBounds AFTER invalidateSize so the viewport
    // calculation uses the real container size.
    setTimeout(() => {
      map.invalidateSize();
      if (bounds.length > 1) {
        map.fitBounds(bounds, { padding: [50, 50], maxZoom: 16 });
      } else {
        map.setView([placed[0].lat, placed[0].lon], 15);
      }
    }, 360);

    if (city) {
      console.log(`[HotelMap] Plotted ${placed.length} hotels in ${city}`);
    }
  }

  popupHtml(hotel) {
    const currency = this.currencySymbol(hotel.currency);
    const starCount = Number(hotel.stars) || 0;
    const stars = starCount
      ? `★`.repeat(starCount) + `☆`.repeat(Math.max(0, 5 - starCount))
      : "";

    // Detail rows — only render the ones we actually have data for.
    const rows = [];
    if (starCount) {
      rows.push(this.detailRow("Rating", `<span class="map-popup-stars">${stars}</span> ${starCount}/5`));
    }
    if (hotel.roomName) {
      rows.push(this.detailRow("Room", this.escape(hotel.roomName)));
    }
    if (typeof hotel.lat === "number" && typeof hotel.lon === "number") {
      rows.push(this.detailRow("Coordinates", `${hotel.lat.toFixed(4)}, ${hotel.lon.toFixed(4)}`));
    }
    if (hotel.id) {
      rows.push(this.detailRow("Hotel ID", `<span class="map-popup-id">${this.escape(hotel.id)}</span>`));
    }

    const price = hotel.price != null && hotel.price !== ""
      ? `${currency}${Math.round(hotel.price).toLocaleString()}`
      : "";

    const bookMessage = `Add hotel ${hotel.name || ""} with room ${hotel.roomName || ""} to the quotation`;

    return `
      <div class="map-popup">
        <div class="map-popup-name">${this.escape(hotel.name)}</div>
        ${rows.length ? `<div class="map-popup-details">${rows.join("")}</div>` : ""}
        ${price ? `<div class="map-popup-price"><span class="map-popup-price-value">${price}</span><span class="map-popup-price-unit"> / night</span></div>` : ""}
        <button type="button" class="map-popup-book" data-book-message="${this.escapeAttr(bookMessage)}">
          Book this hotel
        </button>
      </div>
    `;
  }

  detailRow(label, valueHtml) {
    return `
      <div class="map-popup-row">
        <span class="map-popup-label">${this.escape(label)}</span>
        <span class="map-popup-value">${valueHtml}</span>
      </div>
    `;
  }

  currencySymbol(currency) {
    const map = { EUR: "€", USD: "$", GBP: "£", JPY: "¥" };
    if (!currency) return "€";
    return map[String(currency).toUpperCase()] || `${currency} `;
  }

  escape(s) {
    return String(s || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  escapeAttr(s) {
    return this.escape(s).replace(/"/g, "&quot;");
  }
}

window.HotelMap = HotelMap;