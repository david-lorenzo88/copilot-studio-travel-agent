/* ============================================================
   dataverse-client.js
   Browser-side client for Dataverse data, talking to the
   /api/dataverse/* proxy functions. Pure data fetching — no
   UI concerns. Designed to be extended with new methods as
   the demo grows.
   ============================================================ */

class DataverseClient {
  constructor({ baseUrl = "/api/dataverse" } = {}) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  /**
   * Fetch a single reservation by confirmation code with all related
   * data expanded (guest, hotel, room, city).
   */
  async getReservation(confirmationCode) {
    if (!confirmationCode) throw new Error("Confirmation code required");
    return await this._call(`/reservation/${encodeURIComponent(confirmationCode)}`);
  }

  /**
   * Generic GET helper. Future endpoints just add methods that call _call.
   * Keeps error handling, headers, and timeout logic in one place.
   */
  async _call(path, options = {}) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000);

    try {
      const resp = await fetch(`${this.baseUrl}${path}`, {
        method: options.method || "GET",
        headers: { Accept: "application/json", ...(options.headers || {}) },
        body: options.body,
        signal: controller.signal
      });

      if (!resp.ok) {
        const body = await resp.text().catch(() => "");
        let parsed = null;
        try { parsed = JSON.parse(body); } catch {}
        const message = parsed?.error || `HTTP ${resp.status}`;
        throw new DataverseError(message, resp.status, parsed);
      }

      return await resp.json();
    } catch (err) {
      if (err.name === "AbortError") {
        throw new DataverseError("Request timed out", 0);
      }
      throw err;
    } finally {
      clearTimeout(timeoutId);
    }
  }
}

class DataverseError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = "DataverseError";
    this.status = status;
    this.body = body;
  }
}

window.DataverseClient = DataverseClient;
window.DataverseError = DataverseError;