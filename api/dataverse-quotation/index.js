// api/dataverse-quotation/index.js
// GET /api/dataverse/quotation/{id}
// Returns a full quotation: header, hotel, flights, and the day-by-day
// itinerary with activities. Uses the same service-principal token pattern
// as dataverse-reservation.

let cachedToken = null;
let tokenExpiresAt = 0;

async function getAccessToken(context) {
  const now = Date.now();
  if (cachedToken && now < tokenExpiresAt - 300_000) return cachedToken;

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
    { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: body.toString() }
  );
  if (!resp.ok) {
    const detail = await resp.text();
    context.log.error("Token fetch failed", resp.status, detail);
    throw new Error(`Token fetch failed: ${resp.status}`);
  }
  const data = await resp.json();
  cachedToken = data.access_token;
  tokenExpiresAt = now + data.expires_in * 1000;
  return cachedToken;
}

module.exports = async function (context, req) {
  const id = req.params.id;
  if (!id) {
    context.res = { status: 400, body: { error: "Quotation id required" } };
    return;
  }

  const required = ["DATAVERSE_URL", "ENTRA_TENANT_ID", "ENTRA_CLIENT_ID", "ENTRA_CLIENT_SECRET"];
  const missing = required.filter(k => !process.env[k]);
  if (missing.length) {
    context.res = { status: 500, body: { error: "Server configuration incomplete", missing } };
    return;
  }

  try {
    const token = await getAccessToken(context);
    const dvUrl = process.env.DATAVERSE_URL.replace(/\/$/, "");
    const headers = {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      "OData-MaxVersion": "4.0",
      "OData-Version": "4.0",
      Prefer: 'odata.include-annotations="OData.Community.Display.V1.FormattedValue"'
    };

    // 1) The quotation header, with related guest/city/hotel/room expanded
    const expand = encodeURIComponent(
      "tra_Guest($select=tra_fullname,tra_email,tra_phone)," +
      "tra_DestinationCity($select=tra_name,tra_country)," +
      "tra_Hotel($select=tra_name,tra_address,tra_stars)," +
      "tra_Room($select=tra_name,tra_type,tra_pricepernight)"
    );
    const qResp = await fetch(
      `${dvUrl}/api/data/v9.2/tra_quotations(${id})?$expand=${expand}`,
      { headers }
    );
    if (!qResp.ok) {
      const detail = await qResp.text();
      context.res = { status: qResp.status, body: { error: "Quotation fetch failed", detail } };
      return;
    }
    const q = await qResp.json();

    // 2) The days for this quotation, sorted
    const daysResp = await fetch(
      `${dvUrl}/api/data/v9.2/tra_quotationdays` +
      `?$filter=_tra_quotation_value eq ${id}` +
      `&$orderby=tra_daynumber asc`,
      { headers }
    );
    const daysData = daysResp.ok ? await daysResp.json() : { value: [] };
    const days = daysData.value || [];

    // 3) Activities per day (one call each — few days, negligible)
    const dayObjects = [];
    for (const d of days) {
      const dayId = d.tra_quotationdayid;
      const actResp = await fetch(
        `${dvUrl}/api/data/v9.2/tra_quotationactivities` +
        `?$filter=_tra_quotationday_value eq ${dayId}` +
        `&$orderby=tra_starttime asc`,
        { headers }
      );
      const actData = actResp.ok ? await actResp.json() : { value: [] };
      const activities = (actData.value || []).map(a => ({
        name: a.tra_name,
        timeSlot: a["tra_timeslot@OData.Community.Display.V1.FormattedValue"] || "",
        startTime: a.tra_starttime || "",
        durationMinutes: a.tra_durationminutes || 0,
        cost: a.tra_estimatedcost || 0,
        category: a.tra_category || ""
      }));

      dayObjects.push({
        dayNumber: d.tra_daynumber,
        date: d.tra_date,
        weather: d.tra_weather || "",
        morning: d.tra_morningsummary || "",
        afternoon: d.tra_afternoonsummary || "",
        evening: d.tra_eveningsummary || "",
        dayTotal: d.tra_daytotal || 0,
        activities
      });
    }

    const hotel = q.tra_Hotel || {};
    const room = q.tra_Room || {};
    const guest = q.tra_Guest || {};
    const city = q.tra_DestinationCity || {};

    const shaped = {
      quotationId: q.tra_quotationid,
      quoteNumber: q.tra_quotenumber,
      status: q["tra_status@OData.Community.Display.V1.FormattedValue"] || q.tra_status,
      currency: q.tra_currency || "EUR",
      validUntil: q.tra_validuntil,
      documentUrl: q.tra_documenturl || "",
      checkIn: q.tra_checkindate,
      checkOut: q.tra_checkoutdate,
      nights: q.tra_nights,
      adults: q.tra_adults,
      children: q.tra_children,
      origin: q.tra_origincity,
      destination: city.tra_name,
      country: city.tra_country,
      guest: { name: guest.tra_fullname, email: guest.tra_email, phone: guest.tra_phone },
      hotel: {
        name: hotel.tra_name, address: hotel.tra_address, stars: hotel.tra_stars,
        room: room.tra_name, roomType: room["tra_type@OData.Community.Display.V1.FormattedValue"] || room.tra_type
      },
      flights: {
        outbound: q.tra_outboundcarrier ? `${q.tra_outboundcarrier} ${q.tra_outboundflight}` : "",
        outboundDate: q.tra_outbounddate,
        return: q.tra_returncarrier ? `${q.tra_returncarrier} ${q.tra_returnflight}` : "",
        returnDate: q.tra_returndate
      },
      subtotals: {
        hotel: q.tra_hotelsubtotal || 0,
        activities: q.tra_activitiessubtotal || 0,
        flights: q.tra_flightssubtotal || 0
      },
      total: q.tra_totalprice || 0,
      days: dayObjects
    };

    context.res = {
      status: 200,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
      body: shaped
    };
  } catch (err) {
    context.log.error(err);
    context.res = { status: 500, body: { error: err.message } };
  }
};