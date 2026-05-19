/* ============================================================
   hotel-map.js
   Renders hotels on a Leaflet map in a side panel that slides in.
   Subscribes to agent:hotels DOM events. Handles the Leaflet
   tile-sizing quirk that breaks when the container animates in.
   ============================================================ */

class HotelMap {
    constructor(containerId, panelId) {
        this.containerId = containerId;
        this.panelId = panelId || "mapPanel";
        this.layout = document.getElementById("layout");
        this.panel = document.getElementById(this.panelId);
        this.closeButton = document.getElementById("mapClose");

        this.container = null;
        this.map = null;
        this.markers = [];

        if (this.closeButton) {
            this.closeButton.addEventListener("click", () => this.close());
        }

        window.addEventListener("agent:hotels", e => this.onHotels(e.detail));
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
        if (this.panel) this.panel.classList.add("visible");
        if (this.layout) this.layout.classList.add("map-open");
    }

    close() {
        if (this.panel) this.panel.classList.remove("visible");
        if (this.layout) this.layout.classList.remove("map-open");
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

        // The map needs to be initialized AFTER the container has real dimensions
        // and refreshed AFTER the CSS transition finishes. The 360ms here matches
        // the 320ms CSS transition + a small buffer.
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