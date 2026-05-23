# The Scraper Agent — Slide Narrative

## What you tell the audience

> "Populating a vector index used to mean writing scrapers, dealing with
> JavaScript-rendered pages, building structured-extraction pipelines, and
> shipping it all on a schedule. With Foundry Agent Service and the
> built-in Browser Automation tool, we replace that whole pipeline with a
> single agent that takes a city name as input and figures the rest out."

## The architecture (one slide)

```
                  ┌─────────────────────────────┐
                  │   Foundry Agent             │
                  │   (gpt-4.1-mini)            │
                  └─────────────┬───────────────┘
                                │
              ┌─────────────────┼──────────────────────┐
              │                 │                      │
        ┌─────▼──────┐   ┌──────▼──────┐       ┌───────▼──────┐
        │  Browser   │   │   Custom    │       │ Code Interp. │
        │ Automation │   │  MCP tool:  │       │  (embeddings │
        │  (managed  │   │  AI Search  │       │   generation)│
        │  Playwright│   │   upsert    │       │              │
        │ Workspaces)│   └──────┬──────┘       └──────┬───────┘
        └─────┬──────┘          │                     │
              │                 │                     │
              │                 ▼                     │
              │       ┌──────────────────┐            │
              │       │ Azure AI Search  │◀───────────┘
              │       │ travel-activities│
              │       │ vector index     │
              │       └──────────────────┘
              ▼
       (web pages)
```

## Agent configuration

**Name:** `DestinationIndexerAgent`
**Model:** `gpt-4.1-mini` (cheap enough, smart enough)
**Region:** Sweden Central (collocated with Foundry + AI Search)

**Tools (in this order):**

1. **Browser Automation** (Foundry built-in tool)
   - Provisioned via Microsoft Playwright Workspaces
   - Lets the agent navigate, click, wait, and extract content from any
     public page, including JS-rendered ones

2. **Custom MCP tool: AISearchTool**
   - Self-hosted MCP server on Azure Container Apps, ~80 lines of Python
   - Exposes 3 tools:
     - `search_by_slug(city_slug)` — returns existing docs so we can dedupe
     - `upsert_documents(documents)` — writes enriched activities
     - `delete_by_slug(city_slug)` — for re-indexing

3. **Code Interpreter** (Foundry built-in)
   - The agent uses this to call the embeddings deployment when it needs
     a vector for an activity. Avoids hard-coding embedding logic in
     the system prompt.

## System prompt (verbatim)

```
You are a travel content curator. Your job is to populate the
travel-activities vector index with high-quality activity entries
for a given destination.

When invoked with { "destination": "<name>", "city_slug": "<slug>",
"country": "<country>" }, perform these steps:

1. Use search_by_slug to retrieve existing activities for this slug.
2. Open Wikivoyage at https://en.wikivoyage.org/wiki/{destination}
   using the browser tool. If the page redirects, follow.
3. Scroll through and extract listings from the "See", "Do", "Eat",
   and "Drink" sections. Each listing has a name, an address, GPS
   coordinates, and a description.
4. For each listing, skip if it appears in the existing-activities list.
5. For each new listing, produce:
   - pitch: a vivid one-sentence description, max 25 words
   - tags: 3-6 short lowercase tags
   - duration_minutes: typical visit duration
   - estimated_cost_eur: typical cost (0 for free attractions)
   - indoor: true/false
   - best_time_of_day: morning, afternoon, evening, night, or any
6. Use Code Interpreter to call the embeddings endpoint at
   /openai/deployments/text-embedding-3-small/embeddings with the
   concatenated name + pitch + description as input.
7. Build a document with the fields above plus the embedding,
   and call upsert_documents in batches of 50.

Cap at 25 activities per destination. Report progress after each
batch. If a step fails, log it and continue.
```

## What we actually show on stage

A 30-second walkthrough in the Foundry portal:

1. Open the agent in the Foundry playground
2. Send: `{"destination": "Rome", "city_slug": "rome", "country": "Italy"}`
3. Switch to the **trace view** — the audience sees:
   - Browser tool call: navigate to Wikivoyage
   - Browser tool call: extract section content
   - Multiple `upsert_documents` calls
   - The agent's internal reasoning between each
4. Switch to the AI Search portal — show the index document count growing

This takes 90 seconds at most. The point is the architecture, not the runtime.

## Honest disclosure

If anyone asks, the actual demo index was populated by a Python script
that uses the same Wikivoyage source and the same enrichment model — the
data is identical to what the agent would produce. The agent approach is
production-grade; the script approach is rehearsal-grade.

This isn't a sleight of hand — both pipelines are real and you can show
both. The agent demo just isn't on the critical path of the live story,
which is the right engineering call for a 25-minute slot.

## The 80 lines of MCP server for AISearchTool

The custom MCP server lives on Azure Container Apps. The actual
implementation is straightforward — see `mcp-server/` in the repo. The
slide should show:

- Two-screen split: MCP server code (left) and the agent calling it (right)
- "MCP is the universal cable: any model, any tool, any host"
- Tie back to your earlier MCP server workshop ("we built this same
  pattern a few months ago")
