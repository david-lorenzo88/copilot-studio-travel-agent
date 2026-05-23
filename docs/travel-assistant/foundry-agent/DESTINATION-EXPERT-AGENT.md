# Destination Expert — Foundry Agent Spec

This sub-agent moves from Copilot Studio to **Microsoft Foundry Agent
Service** to showcase pro-code capabilities (Code Interpreter, fine-grained
AI Search filtering, native multi-tool reasoning) that Copilot Studio's
Knowledge Source can't easily provide.

## Why this agent (and not the others)

The other three sub-agents have strong reasons to stay in Copilot Studio:

- **Hotel Reservation** → Dataverse + Power Automate is the natural home
- **Local Discovery** → dynamic chaining is *the* Copilot Studio story
- **Logistics** → custom connectors are *the* Power Platform story

Destination Expert was the weakest CPS story — just a KS-backed retriever.
Moving it to Foundry unlocks:

- Dynamic filtering on AI Search (`indoor`, `duration`, `best_time_of_day`)
- Code Interpreter for itinerary math
- Multi-tool reasoning (search → weather → recommend)
- Visible Foundry trace for the audience

## Agent configuration

| Property | Value |
|---|---|
| Name | `DestinationExpertAgent` |
| Project | Travel Assistant (Sweden Central) |
| Model deployment | `gpt-4.1-mini` |
| Temperature | 0.3 |
| Top P | 0.9 |
| Response format | Text |

## Tools

### 1. Azure AI Search (built-in knowledge tool)

Add via Foundry portal → Agent → Knowledge → Add Azure AI Search.

| Setting | Value |
|---|---|
| Connection | New connection to your AI Search resource |
| Index name | `travel-activities` |
| Query type | **Hybrid (vector + semantic)** |
| Semantic configuration | `travel-semantic` |
| Vector field | `content_vector` |
| Embedding model | `text-embedding-3-small` (your existing deployment) |
| Top K | 8 |
| Strictness | 3 (medium — too strict drops valid results) |
| Filterable fields exposed to agent | `city_slug`, `category`, `indoor`, `duration_minutes`, `estimated_cost_eur`, `best_time_of_day`, `tags` |

The "filterable fields exposed to agent" setting is what lets the agent
build dynamic OData filters. Without it, the agent can only do free-text
search and you lose the main reason for moving to Foundry.

### 2. Code Interpreter (built-in)

Enable it. No configuration needed. The agent will reach for it when:

- User asks for an itinerary
- User asks to rank, compare, or compute totals
- User asks "what fits in X hours" or "under €Y"

### 3. OpenAPI tool: GetWeatherForecast (optional)

Add via Foundry portal → Agent → Actions → Add OpenAPI tool.

Paste the same `03-weather.yaml` from the `connectors/` folder. The Foundry
OpenAPI tool ingestion is more forgiving than Copilot Studio's — paste the
YAML/JSON directly, no connector registration needed.

This lets the agent factor weather into recommendations natively, without
calling out to Copilot Studio's Logistics agent.

## System prompt (verbatim)

```
You are the Destination Expert for a travel assistant. You help travelers
plan activities and discover what to do in their destination city.

Your knowledge comes from the travel-activities Azure AI Search index,
which contains curated activities for each city tagged with category,
duration, cost, indoor/outdoor status, and best time of day. You ALWAYS
retrieve from this index before answering — never invent activities.

When the user asks about a destination:

1. Identify the city. If unclear, ask once.
2. Search the travel-activities index, filtering by city_slug. If the user
   constraints (rainy day, budget, time of day, family-friendly) are clear,
   add filters: indoor, estimated_cost_eur, best_time_of_day, duration_minutes.
3. If the user asks for an itinerary, a plan, or a comparison, use the
   code interpreter to organize the retrieved activities into a structured
   response. Compute totals, group by category or neighborhood, and rank
   sensibly.
4. If weather might be relevant ("what should I do tomorrow", "what about
   when it rains"), call GetWeatherForecast first with the city's coordinates
   and reason about indoor versus outdoor accordingly.
5. Present 3 to 7 activities by default. Each activity gets one short
   paragraph: name, why it's worth doing, practical details (duration,
   cost, when to go). Avoid lists of 20 things — curate.
6. Cite the index by including the source_url of the underlying entry only
   if the user asks where the information came from.

Style: warm, knowledgeable, concise. You're a friend who has been there,
not a brochure.

Languages: respond in the language the user is using.

City coordinates (lat, lon) for the weather tool:
  rome 41.90,12.50 · barcelona 41.39,2.17 · lisbon 38.72,-9.14 ·
  paris 48.86,2.35 · amsterdam 52.37,4.90 · prague 50.08,14.44

What you DO NOT do:
- Book anything (the Hotel Reservation agent handles that)
- Find restaurants nearby specific coordinates (Local Discovery handles that)
- Look up flights or currency conversion (Logistics handles that)

If asked about these, briefly say so and suggest the user ask the main
travel assistant who can route them to the right specialist.
```

## Connecting it to the Copilot Studio orchestrator

1. In Foundry portal → your project → Overview → copy the **Project
   endpoint URL**. Format:
   ```
   https://<project-resource>.services.ai.azure.com/api/projects/<project-name>
   ```
2. Note the **Agent ID** shown next to the agent name (`asst_xxxxx`).
3. Open `TravelAssistantOrchestrator` in Copilot Studio.
4. Settings → Agents → **Add → Connect to an external agent → Microsoft Foundry**.
5. Paste the Project endpoint URL. Sign in to Azure when prompted.
6. Select `DestinationExpertAgent` from the list.
7. **Description** (this is what the orchestrator uses to route):

   > Recommends activities and things to do in a destination. Use for
   > sightseeing, attractions, what-to-do questions, itinerary building,
   > and rainy-day or budget-constrained planning.

8. Save.

## What about the original CPS Destination Expert?

**Keep it published as a fallback.** Don't delete it. Just remove it from
the orchestrator's connected-agents list. If Foundry hiccups on demo day,
you can re-add the CPS version in 60 seconds and continue the talk.

## Auth troubleshooting

If the orchestrator errors with "Unauthorized" or "Cannot reach external
agent":

1. Azure portal → your Foundry project → **Access Control (IAM)**
2. Add role assignment: **Azure AI User**
3. Assign to: the identity Copilot Studio uses (shown in the connector's
   auth panel, usually `Microsoft Copilot Studio` service principal in
   your tenant)
4. Save and retry in ~30 seconds

For a dev tenant demo with you signed in as a global admin, this usually
just works because Copilot Studio inherits your delegated permissions.

## Test scripts (run in the Foundry playground first)

Before wiring to Copilot Studio, validate the agent stands alone:

| User says | Expected behavior |
|---|---|
| "What can I do in Rome?" | Calls AI Search with `city_slug='rome'`, returns 3-7 curated activities |
| "Things to do in Barcelona on a rainy Tuesday with €50" | Calls AI Search filtered by `city_slug='barcelona' and indoor=true and estimated_cost_eur le 50`, then optionally weather, then curates |
| "Build me a 2-day itinerary for Prague" | Searches Prague broadly, then **uses Code Interpreter** to assemble a day-by-day plan with timing and totals |
| "What's the weather like there?" | Should say "I focus on activities — the Logistics agent handles weather queries" |

The third one is the demo's wow moment. Make sure Code Interpreter triggers
reliably — if it doesn't, strengthen step 3 of the system prompt.

## The 30-second stage moment

After your voice turn that triggers the Foundry agent, do this:

1. Pause the conversation.
2. Switch to a pre-opened browser tab showing the agent's **trace view**
   in the Foundry portal.
3. Walk the audience through what just happened:
   - "Here's the orchestration trace. Copilot Studio delegated to this
     Foundry agent. The agent called AI Search with a dynamic filter,
     then ran Python via Code Interpreter to organize the itinerary,
     then checked the weather. None of this was scripted."
4. Switch back, continue the demo.

This 30 seconds is what justifies all the engineering. Without it, the
audience sees the same answer they'd see from a KS-backed CPS agent and
wonders what the point was.
