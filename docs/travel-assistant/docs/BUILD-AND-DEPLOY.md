# Travel Assistant demo — build & deploy

## What's in this bundle

```
travel-assistant/
├── connectors/         OpenAPI specs for 6 custom connectors
├── dataverse/          PowerShell provisioning + seed scripts + CSVs
├── flows/              Power Automate flow design specs
├── foundry-agent/      Destination Expert Foundry agent spec
├── scraper/            AI Search index schema + populate script + slide
├── website/            Static site + token-issuing managed functions
└── docs/               This file
```

## Architecture summary

```
Browser (Azure Speech STT/TTS, DirectLine)
   ↓
Copilot Studio orchestrator (TravelAssistantOrchestrator)
   ├── HotelReservationAgent      → Copilot Studio + Power Automate + Dataverse
   ├── LocalDiscoveryAgent        → Copilot Studio + 2 custom connectors (dynamic chaining)
   ├── LogisticsAgent             → Copilot Studio + 4 custom connectors
   └── DestinationExpertAgent     → Foundry Agent Service (AI Search + Code Interpreter + Weather)
```

Three sub-agents in Copilot Studio, one in Foundry. Each platform showcases
what it's best at. The audience leaves with a clear architectural pattern.

## Build order — 11 days

### Day 1 — Dataverse foundation
1. Run the provisioning script from PowerShell 7:
   ```powershell
   az login
   cd dataverse
   pwsh ./00-provision-solution.ps1 -EnvironmentUrl https://YOUR-ORG.crm4.dynamics.com
   ```
2. Run the seed script:
   ```powershell
   pwsh ./01-seed-data.ps1 -EnvironmentUrl https://YOUR-ORG.crm4.dynamics.com
   ```
3. Verify: 6 cities, 18 hotels, ~70 rooms, 5 guests in the maker portal.

### Day 2 — Hotel sub-agent
1. Build the 4 cloud flows per `flows/HOTEL-FLOWS-DESIGN.md`. Add to solution.
2. New Copilot Studio agent `HotelReservationAgent`, generative orchestration on.
3. Add each flow as an Action with the trigger description verbatim.
4. Test:
   - "Find hotels in Rome from June 1 to June 4 for 2 guests"
   - "Book the first one"
   - "What's reservation RES-000001?"
   - "Cancel my booking"

### Day 3 — Foundry + AI Search
1. Azure portal → create a **Microsoft Foundry** resource in **Sweden Central**.
   Make it multi-service so the same key works for Speech.
2. Inside the Foundry resource, create a **Foundry project** (you'll need it
   for Day 4's agent).
3. Deploy these models:
   - `gpt-4.1-mini` (chat for CPS agents, Destination Expert agent, enrichment)
   - `text-embedding-3-small` (index embeddings)
4. Create Azure AI Search (Basic tier).
5. PUT the index using `scraper/ai-search-index.json`.
6. Populate the index:
   ```
   cd scraper
   pip install -r requirements.txt
   cp .env.example .env  # fill values
   python populate-index.py
   ```
   ~10 minutes. Expect ~150 documents across 6 cities.

### Day 4 — Destination Expert in Foundry
**This day moved out of Copilot Studio.** Full spec in
`foundry-agent/DESTINATION-EXPERT-AGENT.md`.

1. Foundry portal → your project → Agents → **+ New agent**
2. Name: `DestinationExpertAgent`, model: `gpt-4.1-mini`
3. Paste the system prompt from the spec.
4. Add **Azure AI Search** knowledge tool pointing at `travel-activities`,
   semantic config `travel-semantic`, hybrid query.
5. Enable **Code Interpreter**.
6. Add OpenAPI tool from `connectors/03-weather.yaml`.
7. Test in the Foundry playground using the test scripts in the spec.

### Day 5 — Local Discovery sub-agent
1. Sign up: OpenCage (geocoding), Foursquare (places).
2. Import 2 connectors:
   - `connectors/01-geocoding.yaml`
   - `connectors/02-places.yaml`
3. New CPS agent `LocalDiscoveryAgent`, add both connector actions.
   **Do not edit the descriptions in the maker UI** — they enable dynamic chaining.
4. Test: "Find restaurants near the Trevi Fountain". Confirm the trace
   shows GeocodeLocation → FindNearbyPlaces.

### Day 6 — Logistics sub-agent
1. Sign up: AviationStack (free tier).
2. Import 4 connectors:
   - `connectors/03-weather.yaml`
   - `connectors/04-currency.yaml`
   - `connectors/05-flights.yaml`
   - `connectors/06-destination-info.yaml`
3. New CPS agent `LogisticsAgent`, add all 4 actions.
4. Test the four operations.

### Day 7 — Travel Assistant orchestrator
1. New CPS agent `TravelAssistantOrchestrator`.
2. Settings → Generative orchestration → **Connected Agents**.
3. Add the four sub-agents with these descriptions:
   - `HotelReservationAgent` (CPS): "Books, modifies, or looks up hotel reservations."
   - `LocalDiscoveryAgent` (CPS): "Finds nearby restaurants, cafes, bars, or other places of interest."
   - `LogisticsAgent` (CPS): "Gets flight status, weather forecasts, currency conversion, or destination facts."
   - `DestinationExpertAgent` (**Foundry**): connect via "Connect to an external agent → Microsoft Foundry", paste your project endpoint URL, select the agent. Description: "Recommends activities and things to do in a destination. Use for sightseeing, attractions, what-to-do questions, itinerary building, and rainy-day or budget-constrained planning."
4. Publish. Channels → Direct Line → copy a secret.
5. Test end-to-end in the orchestrator's test pane.

### Day 8 — Website (text-only)
1. Push `website/` to a new GitHub repo.
2. Create **Azure Static Web App** linked to the repo.
3. App settings:
   - `DIRECTLINE_SECRET`
   - `SPEECH_KEY`
   - `SPEECH_REGION` = `swedencentral`
4. Browse the SWA URL. Test text-only chat first.

### Day 9 — Voice
1. Visit the SWA on Chrome/Edge. Grant mic permission.
2. Tap the mic. Verify the listening → speaking → idle loop works.
3. Run through the four sub-agents via voice.

### Day 10 — Scraper story
See `scraper/SCRAPER-AGENT-SLIDE.md`. Build the Foundry Agent with Browser
Automation once to capture trace screenshots. Not run on stage.

### Day 11 — Dress rehearsal
- Full demo end-to-end three times.
- Pre-open the Foundry agent trace view in a browser tab (for the Day 4
  showcase moment).
- DirectLine token expires at 30 min — restart between rehearsals.
- Open the voice session once before the audience arrives.
- Pre-record a 90-second voice clip as final safety net.

## Stage fallbacks

**Voice fails:** text composer still works. Pre-script: "If voice fails I
still have my full multi-agent army; let me show you the trace by typing."

**Foundry Destination Expert fails:** in Copilot Studio, swap the Foundry
connected agent for the original CPS version (keep it published as a backup,
not connected). 60-second swap, you're back online.

**DirectLine fails:** demo agents directly inside Copilot Studio's test
pane. Less polished, story still flies.

## Cost rough order of magnitude

- Copilot Studio capacity: existing dev tenant
- Foundry multi-service (Sweden Central):
  - gpt-4.1-mini: ~$0.20 per demo run
  - text-embedding-3-small: one-time ~$0.05 for the whole index
  - Speech STT: ~$1 per audio hour
  - Speech TTS neural: ~$16 per 1M characters
  - Foundry agent runs: ~$0.05 per demo
- Azure AI Search Basic: ~$70/month
- AviationStack free: 100 req/month (sufficient)
- All other APIs: free

Total prep + event + standby month: under $100.

## The demo's three peak moments

When you rehearse, these are the moments that need to land:

1. **Hotel reservation** — booking flows into Dataverse end-to-end via voice
2. **Local Discovery dynamic chaining** — orchestrator deciding to call Geocode then Places
3. **Foundry Destination Expert trace** — pause the demo, show the trace view, explain the platform choice

If any of those three lands, the talk works. If all three land, it's a
standout.
