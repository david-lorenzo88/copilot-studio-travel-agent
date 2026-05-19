// api/dataverse-reservation/index.js
// GET /api/dataverse/reservation/{code}
// Fetches a reservation with expanded guest, hotel, and room from Dataverse
// using a service principal token.
//
// App settings required:
//   DATAVERSE_URL       e.g. https://yourorg.crm4.dynamics.com
//   ENTRA_TENANT_ID
//   ENTRA_CLIENT_ID
//   ENTRA_CLIENT_SECRET

// Cache the token in module scope. Tokens last 1 hour; we'll refresh when within
// 5 minutes of expiry. Persistent across warm invocations.
let cachedToken = null;
let tokenExpiresAt = 0;

async function getAccessToken(context) {
  const now = Date.now();
  if (cachedToken && now < tokenExpiresAt - 300_000) {
    return cachedToken;
  }

  const { ENTRA_TENANT_ID, ENTRA_CLIENT_ID, ENTRA_CLIENT_SECRET, DATAVERSE_URL } = process.env;
  const resource = DATAVERSE_URL.replace(/\/$/, "");

  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: ENTRA_CLIENT_ID,
    client_secret: ENTRA_CLIENT_SECRET,
    scope: `${resource}/.default`
  });

  const resp = await fetch(
    `https://login.microsoftonline.com/${ENTRA_TENANT_ID}/oauth2/v2.0/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString()
    }
  );

  if (!resp.ok) {
    const detail = await resp.text();
    context.log.error("Token fetch failed", resp.status, detail);
    throw new Error(`Token fetch failed: ${resp.status}`);
  }

  const data = await resp.json();
  cachedToken = data.access_token;
  tokenExpiresAt = now + (data.expires_in * 1000);
  return cachedToken;
}

module.exports = async function (context, req) {
  const code = req.params.code;
  if (!code) {
    context.res = { status: 400, body: { error: "Confirmation code required" } };
    return;
  }

  try {
    const token = await getAccessToken(context);
    const dataverseUrl = process.env.DATAVERSE_URL.replace(/\/$/, "");

    // Query the reservation by confirmation code, expanding all related rows.
    // The $expand clauses pull guest, hotel (with its city), and room in one round trip.
    const filter = encodeURIComponent(`tra_confirmationcode eq '${code}'`);
    const expand = encodeURIComponent(
      "tra_Guest($select=tra_fullname,tra_email,tra_phone,tra_loyaltynumber)," +
      "tra_Hotel($select=tra_name,tra_address,tra_stars,tra_latitude,tra_longitude,tra_description,tra_amenities;" +
        "$expand=tra_City($select=tra_name,tra_country))," +
      "tra_Room($select=tra_name,tra_type,tra_pricepernight,tra_capacity)"
    );

    const url = `${dataverseUrl}/api/data/v9.2/tra_reservations` +
                `?$filter=${filter}&$expand=${expand}`;

    const dvResp = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "OData-MaxVersion": "4.0",
        "OData-Version": "4.0",
        Prefer: 'odata.include-annotations="OData.Community.Display.V1.FormattedValue"'
      }
    });

    if (!dvResp.ok) {
      const detail = await dvResp.text();
      context.log.error("Dataverse fetch failed", dvResp.status, detail);
      context.res = { status: dvResp.status, body: { error: "Dataverse fetch failed", detail } };
      return;
    }

    const data = await dvResp.json();
    const reservations = data.value || [];

    if (reservations.length === 0) {
      context.res = { status: 404, body: { error: "Reservation not found", code } };
      return;
    }

    // Return the first match. Shape it into a friendly response for the UI.
    const r = reservations[0];
    const guest = r.tra_Guest || {};
    const hotel = r.tra_Hotel || {};
    const room = r.tra_Room || {};
    const city = hotel.tra_City || {};

    const shaped = {
      confirmationCode: r.tra_confirmationcode,
      status: r["tra_status@OData.Community.Display.V1.FormattedValue"] || r.tra_status,
      checkInDate: r.tra_checkindate,
      checkOutDate: r.tra_checkoutdate,
      specialRequests: r.tra_specialrequests,
      guest: {
        fullName: guest.tra_fullname,
        email: guest.tra_email,
        phone: guest.tra_phone,
        loyaltyNumber: guest.tra_loyaltynumber
      },
      hotel: {
        name: hotel.tra_name,
        address: hotel.tra_address,
        stars: hotel.tra_stars,
        description: hotel.tra_description,
        amenities: hotel["tra_amenities@OData.Community.Display.V1.FormattedValue"] || "",
        lat: hotel.tra_latitude,
        lon: hotel.tra_longitude,
        city: city.tra_name,
        country: city.tra_country
      },
      room: {
        name: room.tra_name,
        type: room["tra_type@OData.Community.Display.V1.FormattedValue"] || room.tra_type,
        capacity: room.tra_capacity,
        pricePerNight: room.tra_pricepernight
      }
    };

    context.res = {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store"
      },
      body: shaped
    };

  } catch (err) {
    context.log.error(err);
    context.res = { status: 500, body: { error: err.message } };
  }
};