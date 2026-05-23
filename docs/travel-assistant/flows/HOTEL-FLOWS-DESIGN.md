# Power Automate flows — Hotel Reservation sub-agent actions

All four flows are **Instant cloud flows** triggered by Copilot Studio
(`When Power Virtual Agents calls a flow`). Each flow's inputs are exposed
to the AI Orchestrator as action parameters; descriptions matter as much
as names because they tell the orchestrator when to invoke.

Solution: TravelAssistant. Owner: service principal. All flows run as the
service account, not as the calling user.

---

## Flow 1: SearchHotels

**Trigger description (this is what the orchestrator reads):**
> Searches for hotels that have rooms available for the given city and
> dates. Returns a list of hotels with the cheapest available room and
> the total nights price. Use this when the user wants to find a place
> to stay.

**Inputs:**
- `cityName` (text, required) — City to search in. Example "Rome"
- `checkInDate` (date, required) — Check-in date
- `checkOutDate` (date, required) — Check-out date
- `guests` (number, required) — Number of guests, default 2

**Steps:**

1. **Initialize variable** `vNights` (integer)
   - Expression: `div(sub(ticks(triggerBody()?['checkOutDate']), ticks(triggerBody()?['checkInDate'])), 864000000000)`

2. **Get city** (Dataverse — List rows on `tra_cities`)
   - Filter rows: `tra_name eq '@{triggerBody()?['cityName']}'`
   - Top count: 1

3. **Condition** — was a city found?
   - If `length(outputs('Get_city')?['body/value'])` is equal to 0 → return empty array.

4. **Get hotels** (Dataverse — List rows on `tra_hotels`)
   - Filter rows: `_tra_city_value eq @{first(outputs('Get_city')?['body/value'])?['tra_cityid']}`
   - Expand: `tra_room_hotel($filter=tra_capacity ge @{triggerBody()?['guests']} and tra_quantityavailable gt 0;$orderby=tra_pricepernight asc;$top=1)`

5. **Select** — shape the output (no loop, expression-based for speed)
   - From: `outputs('Get_hotels')?['body/value']`
   - Map (advanced mode):
   ```json
   {
     "hotelId": "@item()?['tra_hotelid']",
     "hotelName": "@item()?['tra_name']",
     "stars": "@item()?['tra_stars']",
     "address": "@item()?['tra_address']",
     "description": "@item()?['tra_description']",
     "amenities": "@item()?['tra_amenities']",
     "cheapestRoomName": "@first(item()?['tra_room_hotel'])?['tra_name']",
     "cheapestRoomType": "@first(item()?['tra_room_hotel'])?['tra_type@OData.Community.Display.V1.FormattedValue']",
     "pricePerNight": "@first(item()?['tra_room_hotel'])?['tra_pricepernight']",
     "totalPrice": "@mul(first(item()?['tra_room_hotel'])?['tra_pricepernight'], variables('vNights'))",
     "nights": "@variables('vNights')"
   }
   ```

6. **Filter array** — drop hotels with no matching room
   - From: output of step 5
   - Condition: `item()?['pricePerNight']` is not equal to `null`

7. **Respond to Copilot** with:
   - `hotels` (array of objects): output of step 6
   - `nights` (number): `variables('vNights')`
   - `searchedCity` (text): `first(outputs('Get_city')?['body/value'])?['tra_name']`

**Why expression-based and not Apply to each:** keeps total runtime under
1.5 seconds even with 18 hotels and 70 rooms. On stage every second
matters; loops in Power Automate add fixed overhead per iteration.

---

## Flow 2: MakeReservation

**Trigger description:**
> Creates a hotel reservation. Use this when the user has chosen a
> hotel and a room type and confirmed they want to book it. Returns
> the confirmation code.

**Inputs:**
- `hotelId` (text, required) — GUID of the hotel
- `roomId` (text, required) — GUID of the room
- `guestFullName` (text, required)
- `guestEmail` (text, required)
- `guestPhone` (text, optional)
- `checkInDate` (date, required)
- `checkOutDate` (date, required)
- `specialRequests` (text, optional)

**Steps:**

1. **List rows** `tra_guests` — filter `tra_email eq @{triggerBody()?['guestEmail']}`, top 1
2. **Condition** — was guest found?
   - If 0 results: **Add new row** to `tra_guests` with the input fields, capture the new guest ID.
   - If 1 result: capture existing guest ID.
   - After the condition, set `vGuestId` to the resulting GUID.
3. **Add new row** to `tra_reservations`:
   - `tra_guest@odata.bind` → `/tra_guests(@{variables('vGuestId')})`
   - `tra_hotel@odata.bind` → `/tra_hotels(@{triggerBody()?['hotelId']})`
   - `tra_room@odata.bind`  → `/tra_rooms(@{triggerBody()?['roomId']})`
   - `tra_checkindate`, `tra_checkoutdate`, `tra_specialrequests`
   - `tra_status` = 1 (Confirmed)
4. **Update row** `tra_rooms` — decrement `tra_quantityavailable` by 1.
5. **Respond to Copilot**:
   - `confirmationCode` (text): `outputs('Add_reservation')?['body/tra_confirmationcode']`
   - `reservationId` (text): GUID
   - `status` (text): "Confirmed"

---

## Flow 3: LookupReservation

**Trigger description:**
> Retrieves details for an existing hotel reservation. Use this when
> the user mentions a confirmation code or asks about a booking by
> their email.

**Inputs:**
- `confirmationCode` (text, optional) — example RES-000042
- `guestEmail` (text, optional)

(At least one of the two must be provided. The flow handles both cases.)

**Steps:**

1. **Compose** `vFilter`:
   - Expression:
     ```
     if(
       and(empty(triggerBody()?['confirmationCode']), empty(triggerBody()?['guestEmail'])),
       null,
       if(
         not(empty(triggerBody()?['confirmationCode'])),
         concat('tra_confirmationcode eq ''', triggerBody()?['confirmationCode'], ''''),
         concat('tra_guest/tra_email eq ''', triggerBody()?['guestEmail'], '''')
       )
     )
     ```
2. **List rows** on `tra_reservations` with the filter, expand
   `tra_guest($select=tra_fullname,tra_email)`,
   `tra_hotel($select=tra_name,tra_address)`,
   `tra_room($select=tra_name,tra_type,tra_pricepernight)`
3. **Select** to shape (same pattern as flow 1)
4. **Respond to Copilot** with `reservations` array.

---

## Flow 4: CancelReservation

**Trigger description:**
> Cancels an existing hotel reservation by its confirmation code.
> Use this only when the user explicitly asks to cancel a booking.

**Inputs:**
- `confirmationCode` (text, required)

**Steps:**

1. **List rows** on `tra_reservations` — filter
   `tra_confirmationcode eq '@{triggerBody()?['confirmationCode']}'`, top 1
2. **Condition** — found and not already cancelled?
   - If yes:
     - **Update row** on `tra_reservations`: set `tra_status` to 3 (Cancelled).
     - **Update row** on `tra_rooms` (the linked room): increment `tra_quantityavailable` by 1.
     - Set `vSuccess` = true.
   - If no:
     - Set `vSuccess` = false.
3. **Respond to Copilot**:
   - `success` (boolean)
   - `message` (text): "Reservation cancelled" or "Reservation not found"

---

## Connection reference

All four flows use a **single Dataverse connection reference** named
`shared_commondataservice_travelassistant`. Set this up once in the
solution; flows will bind to it on import.

## Authentication

In Copilot Studio, when adding these flows as actions, choose **Run as
the service principal** (not "Run as user") so the demo doesn't need
each audience member to authenticate.
