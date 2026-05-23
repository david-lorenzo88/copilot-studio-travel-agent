# Quotation Flows — Design Spec (v2 Phase 2)

Five Power Automate flows, each a Copilot Studio-callable action. They build
a quotation incrementally: create the draft, attach each component as the
QuotationAgent gathers it, then finalize (compute totals + generate document).

All flows live in the TravelAssistant solution. Trigger: "When an agent calls
the flow" (Copilot Studio / Power Virtual Agents trigger). Each returns to the
agent via "Respond to Copilot".

Naming convention matches v1: PascalCase flow names, camelCase inputs.

---

## Flow 1 — CreateDraftQuotation

Creates the parent tra_quotation row in Draft status. Resolves the guest by
email (creating one if needed) and the destination city by slug. Returns the
quotation GUID and quote number so subsequent flows can target it.

### Trigger inputs

| Input | Type | Notes |
|---|---|---|
| guestFullName | Text | Lead traveler name |
| guestEmail | Text | Used to find or create the guest |
| guestPhone | Text | Optional |
| destinationCitySlug | Text | rome, barcelona, lisbon, paris, amsterdam, prague |
| originCity | Text | Free text, e.g. "Madrid" |
| originIata | Text | e.g. MAD (the agent resolves this via Duffel/places) |
| destinationIata | Text | e.g. FCO |
| checkInDate | Text | ISO date yyyy-MM-dd |
| checkOutDate | Text | ISO date yyyy-MM-dd |
| adults | Number | Default 2 |
| children | Number | Default 0 |

### Steps

1. **Initialize variable** `nights` (Integer):
   `div(sub(ticks(triggerBody()?['checkOutDate']), ticks(triggerBody()?['checkInDate'])), 864000000000)`
   (ticks per day = 864000000000)

2. **List rows** tra_guests, filter `tra_email eq '@{triggerBody()?['guestEmail']}'`, top 1.

3. **Condition**: guest found?
   - **If no** → Add a new row to tra_guests:
     - tra_fullname = guestFullName
     - tra_email = guestEmail
     - tra_phone = guestPhone
     Store the new guest id.
   - **If yes** → use the first match's tra_guestid.

4. **List rows** tra_cities, filter `tra_slug eq '@{triggerBody()?['destinationCitySlug']}'`, top 1.
   Store tra_cityid. (If your city table uses a different slug column, adjust.)

5. **Add a new row** to tra_quotations:
   - tra_status = 100000000 (Draft)
   - tra_origincity = originCity
   - tra_originiata = originIata
   - tra_destinationiata = destinationIata
   - tra_checkindate = checkInDate
   - tra_checkoutdate = checkOutDate
   - tra_nights = variables('nights')
   - tra_adults = adults
   - tra_children = children
   - tra_currency = "EUR"
   - tra_validuntil = `addDays(utcNow(), 14, 'yyyy-MM-dd')`
   - tra_Guest@odata.bind = `/tra_guests(@{guestId})`
   - tra_DestinationCity@odata.bind = `/tra_cities(@{cityId})`

6. **Respond to Copilot**:
   - success (Boolean) = true
   - quotationId (Text) = the new row's tra_quotationid
   - quoteNumber (Text) = the new row's tra_quotenumber
   - message (Text) = "Draft quotation @{quoteNumber} created for @{guestFullName}."

### Action description (for the agent)

> Creates a new draft travel quotation. Call this first, once you have the
> destination, dates, traveler name and email, and party size. Returns the
> quotationId (a GUID) and quoteNumber. You must pass the quotationId to all
> subsequent quotation actions.

---

## Flow 2 — AttachHotelToQuotation

Sets the hotel and room on an existing quotation and computes the hotel
subtotal from nights x nightly rate.

### Trigger inputs

| Input | Type | Notes |
|---|---|---|
| quotationId | Text | GUID from CreateDraftQuotation |
| hotelGuid | Text | From SearchHotels (use GUID, not name) |
| roomGuid | Text | From SearchHotels |
| pricePerNight | Number | The nightly rate the user selected |

### Steps

1. **Get a row by ID** tra_quotations, id = quotationId, select tra_nights.
   Store nights.

2. **Update a row** tra_quotations (id = quotationId):
   - tra_Hotel@odata.bind = `/tra_hotels(@{hotelGuid})`
   - tra_Room@odata.bind = `/tra_rooms(@{roomGuid})`
   - tra_hotelsubtotal = `mul(triggerBody()?['pricePerNight'], outputs from step 1 nights)`

3. **Respond to Copilot**:
   - success = true
   - hotelSubtotal (Number)
   - message = "Hotel attached. Subtotal @{hotelSubtotal} EUR for @{nights} nights."

### Action description

> Attaches a selected hotel and room to a draft quotation and computes the
> hotel subtotal. Requires the quotationId, hotelGuid and roomGuid (GUIDs from
> SearchHotels, never names), and the price per night. Call after the user
> picks a hotel.

---

## Flow 3 — AttachItineraryToQuotation

Takes the structured itinerary JSON from the Foundry Destination Expert and
creates the day and activity rows, computing the activities subtotal.

### Trigger inputs

| Input | Type | Notes |
|---|---|---|
| quotationId | Text | GUID |
| itineraryJson | Text | The full itinerary JSON string from the Foundry agent |

### Itinerary JSON shape (parsed inside the flow)

```json
{
  "days": [
    {
      "day_number": 1,
      "date": "2026-06-24",
      "weather": "Partly cloudy, 24C",
      "morning":   { "summary": "...", "activities": [ { "name":"", "start_time":"10:00", "duration_minutes":90, "estimated_cost_eur":35, "category":"Landmark", "source_id":"abc" } ] },
      "afternoon": { "summary": "...", "activities": [ ... ] },
      "evening":   { "summary": "...", "activities": [ ... ] },
      "day_total_eur": 95
    }
  ]
}
```

### Steps

1. **Parse JSON** of itineraryJson using a schema matching the shape above.

2. **Initialize variable** `activitiesSubtotal` (Float) = 0.

3. **Apply to each** day in `body('Parse_JSON')?['days']`:

   a. **Add a new row** to tra_quotationdays:
      - tra_name = `concat('Day ', item()?['day_number'])`
      - tra_daynumber = item()?['day_number']
      - tra_date = item()?['date']
      - tra_morningsummary = item()?['morning']?['summary']
      - tra_afternoonsummary = item()?['afternoon']?['summary']
      - tra_eveningsummary = item()?['evening']?['summary']
      - tra_weather = item()?['weather']
      - tra_daytotal = item()?['day_total_eur']
      - tra_Quotation@odata.bind = `/tra_quotations(@{triggerBody()?['quotationId']})`
      Store dayId.

   b. **Increment variable** activitiesSubtotal by item()?['day_total_eur'].

   c. For each time slot (morning, afternoon, evening), **Apply to each**
      activity in that slot's activities array:
      **Add a new row** to tra_quotationactivities:
        - tra_name = activity name
        - tra_timeslot = (Morning=100000000, Afternoon=100000001, Evening=100000002)
        - tra_starttime = activity start_time
        - tra_durationminutes = activity duration_minutes
        - tra_estimatedcost = activity estimated_cost_eur
        - tra_category = activity category
        - tra_activitysourceid = activity source_id
        - tra_QuotationDay@odata.bind = `/tra_quotationdays(@{dayId})`

   > Note: nested Apply-to-each over the three slots is easiest to build as
   > three separate Apply-to-each blocks (one per slot) inside the day loop,
   > or compose all activities into a single array first with a Select +
   > union. The three-block approach is more readable in the designer.

4. **Update a row** tra_quotations (id = quotationId):
   - tra_activitiessubtotal = variables('activitiesSubtotal')

5. **Respond to Copilot**:
   - success = true
   - daysCreated (Number) = length of days array
   - activitiesSubtotal (Number)
   - message = "Itinerary attached: @{daysCreated} days, activities subtotal @{activitiesSubtotal} EUR."

### Action description

> Attaches a day-by-day itinerary to a quotation. Requires the quotationId and
> the itinerary JSON produced by the Destination Expert in itinerary mode. Call
> after the destination expert returns a structured plan.

---

## Flow 4 — AttachFlightsToQuotation

Stores outbound and return flight details (from Duffel via the Logistics
agent) and computes the flights subtotal.

### Trigger inputs

| Input | Type | Notes |
|---|---|---|
| quotationId | Text | GUID |
| outboundCarrier | Text | e.g. "Iberia" |
| outboundFlight | Text | e.g. "IB3170" |
| outboundDate | Text | ISO date |
| outboundDepTime | Text | "08:25" |
| outboundArrTime | Text | "10:55" |
| returnCarrier | Text | |
| returnFlight | Text | |
| returnDate | Text | ISO date |
| returnDepTime | Text | |
| returnArrTime | Text | |
| totalFlightPrice | Number | Round-trip total for the party |

### Steps

1. **Update a row** tra_quotations (id = quotationId):
   - tra_outboundcarrier, tra_outboundflight, tra_outbounddate,
     tra_outbounddeptime, tra_outboundarrtime
   - tra_returncarrier, tra_returnflight, tra_returndate,
     tra_returndeptime, tra_returnarrtime
   - tra_flightssubtotal = totalFlightPrice

2. **Respond to Copilot**:
   - success = true
   - flightsSubtotal (Number) = totalFlightPrice
   - message = "Flights attached. Subtotal @{totalFlightPrice} EUR."

### Action description

> Attaches round-trip flight details and price to a quotation. Requires the
> quotationId and both flight legs (carrier, flight number, date, times) plus
> the total round-trip price. Call after the Logistics agent returns flight
> offers and the user picks one.

---

## Flow 5 — FinalizeQuotation

Computes the grand total, sets status to Confirmed, optionally enriches with
destination/weather summaries, triggers Word document generation, and returns
the document URL. (Document generation detail is built in Phase 6; for now this
flow computes totals and flips status, returning a placeholder doc URL.)

### Trigger inputs

| Input | Type | Notes |
|---|---|---|
| quotationId | Text | GUID |
| destinationSummary | Text | Optional, from Destination Expert / Logistics |
| weatherSummary | Text | Optional |
| notes | Text | Optional free notes |

### Steps

1. **Get a row by ID** tra_quotations, id = quotationId. Select the three
   subtotals: tra_hotelsubtotal, tra_activitiessubtotal, tra_flightssubtotal.

2. **Initialize variable** `total` (Float):
   `add(add(coalesce(hotelsubtotal,0), coalesce(activitiessubtotal,0)), coalesce(flightssubtotal,0))`

3. **Update a row** tra_quotations (id = quotationId):
   - tra_totalprice = variables('total')
   - tra_status = 100000001 (Confirmed)
   - tra_destinationsummary = destinationSummary (if provided)
   - tra_weathersummary = weatherSummary (if provided)
   - tra_notes = notes (if provided)

4. **[Phase 6]** Generate the Word document (Word Online connector → Populate
   template → save to SharePoint/OneDrive → get share link). Store documentUrl.
   For Phase 2, set documentUrl to empty string.

5. **Update a row** (if documentUrl set): tra_documenturl = documentUrl.

6. **Respond to Copilot**:
   - success = true
   - quoteNumber (Text)
   - total (Number)
   - documentUrl (Text) — empty until Phase 6
   - message = "Quotation @{quoteNumber} finalized. Total @{total} EUR."

### Action description

> Finalizes a quotation: computes the grand total from all subtotals, sets the
> status to Confirmed, stores destination and weather summaries, and generates
> the quotation document. Call last, after hotel, itinerary, and flights are all
> attached. Returns the final total and the document URL.

---

## Build order and testing

Build and test each flow standalone in Power Automate before wiring to the
QuotationAgent. Test data:

1. **CreateDraftQuotation**: guestFullName="David Lorenzo", guestEmail="david@test.com",
   destinationCitySlug="rome", originCity="Madrid", originIata="MAD",
   destinationIata="FCO", checkInDate="2026-06-24", checkOutDate="2026-06-28",
   adults=2, children=0. Confirm a Draft row appears with a Q-number and 4 nights.

2. **AttachHotelToQuotation**: use the quotationId from step 1, a real hotelGuid
   and roomGuid from your seed data, pricePerNight=420. Confirm hotelSubtotal=1680.

3. **AttachItineraryToQuotation**: paste a small 2-day itinerary JSON. Confirm
   2 day rows and the activity rows appear, activitiesSubtotal computed.

4. **AttachFlightsToQuotation**: dummy flight data, totalFlightPrice=380. Confirm
   the columns populate and flightsSubtotal=380.

5. **FinalizeQuotation**: use the same quotationId. Confirm total = 1680 + activities
   + 380, status flips to Confirmed.

After all five pass standalone, Phase 3 wires them into the QuotationAgent.

## A note on the agent passing GUIDs

Same lesson as v1's hotel booking: name the GUID inputs hotelGuid / roomGuid /
quotationId explicitly, and in the action descriptions say "this is a GUID from
a previous step, never a name." The agent will be chaining five flows with
quotationId threaded through all of them, so reliability here matters more than
anywhere else in the build.
