/* ============================================================
   hotel-map.js
   Renders hotels on a Leaflet map. Subscribes to agent:hotels
   events from the UI event bridge. No knowledge of DirectLine
   or the agent — pure DOM event consumer.
   ============================================================ */

class HotelMap {
  constructor(containerId) {
    this.containerId = containerId;
    this.container = null;
    this.map = null;
    this.markers = [];
    this.cityMarkers = {};  // for repeated searches in same city

    window.addEventListener("agent:hotels", e => this.onHotels(e.detail));
  }

  ensureContainer() {
    if (this.container) return this.container;

    let el = document.getElementById(this.containerId);
    if (!el) {
      // Container doesn't exist yet — defer
      return null;
    }
    this.container = el;
    return el;
  }

  ensureMap(centerLat, centerLon) {
    if (this.map) return this.map;
    const el = this.ensureContainer();
    if (!el) return null;

    // Show the container if it was hidden
    el.classList.add("visible");

    this.map = L.map(el, {
      zoomControl: true,
      scrollWheelZoom: false  // less aggressive in a chat context
    }).setView([centerLat, centerLon], 13);

    // Use OpenStreetMap tiles — free, no key
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: '&copy; OpenStreetMap',
      maxZoom: 19
    }).addTo(this.map);

    return this.map;
  }

  clearMarkers() {
    for (const m of this.markers) m.remove();
    this.markers = [];
  }

  onHotels(detail) {
    const { city, hotels } = detail || {};
    if (!Array.isArray(hotels) || hotels.length === 0) return;

    // Filter out hotels without coordinates
    const placed = hotels.filter(h => typeof h.lat === "number" && typeof h.lon === "number");
    if (placed.length === 0) {
      console.warn("[HotelMap] No hotels had coordinates");
      return;
    }

    // Center on the average of all hotel coordinates
    const centerLat = placed.reduce((s, h) => s + h.lat, 0) / placed.length;
    const centerLon = placed.reduce((s, h) => s + h.lon, 0) / placed.length;

    const map = this.ensureMap(centerLat, centerLon);
    if (!map) {
      console.warn("[HotelMap] Map container not ready, deferring render");
      return;
    }

    this.clearMarkers();

    const bounds = [];
    for (const hotel of placed) {
      const marker = L.marker([hotel.lat, hotel.lon])
        .addTo(map)
        .bindPopup(this.popupHtml(hotel));
      this.markers.push(marker);
      bounds.push([hotel.lat, hotel.lon]);
    }

    // Fit the map to show all markers nicely
    if (bounds.length > 1) {
      map.fitBounds(bounds, { padding: [40, 40] });
    } else {
      map.setView([placed[0].lat, placed[0].lon], 15);
    }

    // Header in the city marker (optional — useful for context)
    if (city) {
      console.log(`[HotelMap] Plotted ${placed.length} hotels in ${city}`);
    }
  }

  popupHtml(hotel) {
    const stars = "★".repeat(hotel.stars || 0);
    const price = hotel.price
      ? `${hotel.currency || "€"}${Math.round(hotel.price).toLocaleString()}`
      : "";
    const subtitle = [stars, price].filter(Boolean).join(" · ");
    return `
      <div class="map-popup">
        <div class="map-popup-name">${this.escape(hotel.name)}</div>
        ${subtitle ? `<div class="map-popup-meta">${subtitle}</div>` : ""}
      </div>
    `;
  }

  escape(s) {
    return String(s || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }
}

window.HotelMap = HotelMap;