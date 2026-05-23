"""
populate-index.py — pre-populate the travel-activities AI Search index.

Pulls activity data from Wikivoyage for the seed cities, traversing both the
main city page and every district subpage. Enriches each activity with a pitch
and tags via Foundry chat model, generates an embedding, and upserts to
Azure AI Search.

Usage:
  pip install -r requirements.txt
  cp .env.example .env  # fill in keys
  python populate-index.py
"""

import os
import re
import sys
import json
import time
import uuid
import requests
from datetime import datetime, timezone
from dotenv import load_dotenv
from openai import AzureOpenAI
from azure.core.credentials import AzureKeyCredential
from azure.search.documents import SearchClient
from azure.search.documents.indexes import SearchIndexClient

load_dotenv()

# --- Config ---
SEARCH_ENDPOINT     = os.environ["AZURE_SEARCH_ENDPOINT"]
SEARCH_KEY          = os.environ["AZURE_SEARCH_KEY"]
INDEX_NAME          = os.environ.get("AZURE_SEARCH_INDEX", "travel-activities")

FOUNDRY_ENDPOINT    = os.environ["FOUNDRY_ENDPOINT"]
FOUNDRY_KEY         = os.environ["FOUNDRY_KEY"]
FOUNDRY_API_VERSION = os.environ.get("FOUNDRY_API_VERSION", "2024-10-21")
CHAT_DEPLOYMENT     = os.environ.get("CHAT_DEPLOYMENT", "gpt-4.1-mini")
EMBED_DEPLOYMENT    = os.environ.get("EMBED_DEPLOYMENT", "text-embedding-3-small")

CITIES = [
    {"slug": "rome",       "name": "Rome",       "country": "Italy",          "wikivoyage": "Rome"},
    {"slug": "barcelona",  "name": "Barcelona",  "country": "Spain",          "wikivoyage": "Barcelona"},
    {"slug": "lisbon",     "name": "Lisbon",     "country": "Portugal",       "wikivoyage": "Lisbon"},
    {"slug": "paris",      "name": "Paris",      "country": "France",         "wikivoyage": "Paris"},
    {"slug": "amsterdam",  "name": "Amsterdam",  "country": "Netherlands",    "wikivoyage": "Amsterdam"},
    {"slug": "prague",     "name": "Prague",     "country": "Czech Republic", "wikivoyage": "Prague"},
]

# Cap on activities indexed per city. 25 is plenty for a demo.
MAX_ACTIVITIES_PER_CITY = 25

# Wikimedia requires identifiable User-Agent. Change the email if you like.
WIKIVOYAGE_HEADERS = {
    "User-Agent": "TravelAssistantDemo/1.0 (DynamicsMinds 2026; contact@example.com)"
}

# Map listing types to our category taxonomy.
TYPE_FIELD_TO_CATEGORY = {
    "see":   "Landmark",
    "do":    "Activity",
    "eat":   "Restaurant",
    "drink": "Bar",
    "buy":   "Shopping",
    "sleep": "Hotel",
    "view":  "Landmark",
    "go":    "Activity",
}

# --- Foundry client ---
foundry = AzureOpenAI(
    api_key=FOUNDRY_KEY,
    api_version=FOUNDRY_API_VERSION,
    azure_endpoint=FOUNDRY_ENDPOINT,
)


# ---------------------------------------------------------------------------
# WIKIVOYAGE — page traversal + parsing
# ---------------------------------------------------------------------------

def get_subpages(city_name: str) -> list[str]:
    """
    Returns Wikivoyage subpage titles (districts) for the given city, e.g.
    'Rome/Centro storico', 'Rome/Trastevere'. Excludes the main page.
    """
    url = "https://en.wikivoyage.org/w/api.php"
    params = {
        "action":   "query",
        "list":     "allpages",
        "apprefix": f"{city_name}/",
        "aplimit":  50,
        "format":   "json",
    }
    try:
        r = requests.get(url, params=params, headers=WIKIVOYAGE_HEADERS, timeout=30)
        r.raise_for_status()
        return [p["title"] for p in r.json().get("query", {}).get("allpages", [])]
    except Exception as e:
        print(f"    ! Could not list subpages for {city_name}: {e}", flush=True)
        return []


def fetch_page_wikitext(page_title: str) -> str:
    """Fetch the raw wikitext of a single Wikivoyage page."""
    url = "https://en.wikivoyage.org/w/api.php"
    params = {
        "action":    "parse",
        "page":      page_title,
        "prop":      "wikitext",
        "format":    "json",
        "redirects": 1,
    }
    r = requests.get(url, params=params, headers=WIKIVOYAGE_HEADERS, timeout=30)
    r.raise_for_status()
    payload = r.json()
    if "parse" not in payload:
        # Page doesn't exist or other API error — return empty so caller continues
        return ""
    return payload["parse"]["wikitext"]["*"]


# Matches Wikivoyage listing templates in any of the formats used across the
# project: the new {{listing|type=see|...}} and the legacy named variants
# {{see|...}}, {{do|...}}, {{eat|...}}, {{drink|...}}, {{buy|...}}, {{sleep|...}}.
LISTING_RE = re.compile(
    r"\{\{(listing|see|do|eat|drink|buy|sleep)\s*\|(.*?)\}\}",
    re.IGNORECASE | re.DOTALL,
)


def parse_listings_from_wikitext(wikitext: str) -> list[dict]:
    """
    Extract listing-like entries from a Wikivoyage page's wikitext.
    Returns a list of {name, category, content, address, lat, lon} dicts.
    """
    out = []
    if not wikitext:
        return out

    for match in LISTING_RE.finditer(wikitext):
        template_name = match.group(1).lower()
        body          = match.group(2)

        # Parse |key=value pairs. The negative lookahead avoids splitting inside
        # nested templates like {{coord|41.9|12.5}}.
        fields = {}
        for part in re.split(r"\|(?![^{]*\})", body):
            if "=" in part:
                k, _, v = part.partition("=")
                fields[k.strip().lower()] = v.strip()

        # Resolve category from either the unified template's type= field,
        # or the legacy named template itself.
        if template_name == "listing":
            type_field = fields.get("type", "").lower()
            if not type_field:
                continue
            category = TYPE_FIELD_TO_CATEGORY.get(type_field, "Activity")
        else:
            category = TYPE_FIELD_TO_CATEGORY.get(template_name, "Activity")

        # Skip Sleep listings — we have hotels in Dataverse already
        if category == "Hotel":
            continue

        name = fields.get("name", "").strip()
        if not name or len(name) < 3:
            continue

        # Strip wiki link syntax and HTML from description
        content = fields.get("content", "")
        content = re.sub(r"\[\[(?:[^|\]]+\|)?([^\]]+)\]\]", r"\1", content)
        content = re.sub(r"<[^>]+>", "", content)
        content = re.sub(r"\s+", " ", content).strip()

        try:
            lat = float(fields["lat"])  if fields.get("lat")  else None
            lon = float(fields["long"]) if fields.get("long") else None
        except ValueError:
            lat, lon = None, None

        out.append({
            "name":     name,
            "category": category,
            "content":  content,
            "address":  fields.get("address", ""),
            "lat":      lat,
            "lon":      lon,
        })

    return out


def fetch_wikivoyage_activities(city: dict) -> list[dict]:
    """
    Fetch and parse activities from the main city page and every district
    subpage. De-dupes by name across all pages.
    """
    print(f"  ↘ Fetching Wikivoyage for {city['wikivoyage']}…", flush=True)

    pages = [city["wikivoyage"]] + get_subpages(city["wikivoyage"])
    print(f"    + {len(pages)} page(s) to scan (main + districts)", flush=True)

    all_activities = []
    for page in pages:
        try:
            wt = fetch_page_wikitext(page)
        except Exception as e:
            print(f"    ! Skipping {page}: {e}", flush=True)
            continue
        listings = parse_listings_from_wikitext(wt)
        if listings:
            print(f"      · {page}: {len(listings)} listings", flush=True)
        all_activities.extend(listings)
        time.sleep(0.3)   # be polite to Wikimedia

    # De-dupe by name (some entries cross-reference in multiple districts)
    seen = set()
    unique = []
    for a in all_activities:
        key = a["name"].lower()
        if key in seen:
            continue
        seen.add(key)
        unique.append(a)

    print(f"    ✓ {len(unique)} unique activities parsed", flush=True)
    return unique


# ---------------------------------------------------------------------------
# ENRICHMENT + EMBEDDING
# ---------------------------------------------------------------------------

def enrich_activity(activity: dict, city: dict) -> dict:
    """
    Use the chat model to produce pitch, tags, duration, cost estimate,
    indoor/outdoor, and best time of day for an activity.
    """
    system = (
        "You are a travel content curator. Given a brief activity description, "
        "you produce a concise, vivid pitch (max 25 words) and rich metadata. "
        "Always respond with valid JSON only, no preamble."
    )
    user = json.dumps({
        "city":     city["name"],
        "name":     activity["name"],
        "category": activity["category"],
        "raw":      activity["content"][:800],
    })

    try:
        resp = foundry.chat.completions.create(
            model=CHAT_DEPLOYMENT,
            temperature=0.4,
            max_tokens=300,
            response_format={"type": "json_object"},
            messages=[
                {"role": "system", "content": system},
                {"role": "user",   "content": (
                    f"For this activity, return JSON with keys: "
                    f"pitch (string, <=25 words), "
                    f"tags (array of 3-6 short lowercase strings), "
                    f"duration_minutes (int, typical visit time), "
                    f"estimated_cost_eur (number, 0 for free), "
                    f"indoor (boolean), "
                    f"best_time_of_day (one of: morning, afternoon, evening, night, any).\n\n"
                    f"Input:\n{user}"
                )}
            ],
        )
        return json.loads(resp.choices[0].message.content)
    except Exception:
        # Fallback in case the model misbehaves
        return {
            "pitch": activity["content"][:140] or activity["name"],
            "tags": [activity["category"].lower()],
            "duration_minutes": 60,
            "estimated_cost_eur": 0.0,
            "indoor": False,
            "best_time_of_day": "any",
        }


def embed_text(text: str) -> list[float]:
    resp = foundry.embeddings.create(model=EMBED_DEPLOYMENT, input=text)
    return resp.data[0].embedding


def build_document(activity: dict, enriched: dict, city: dict) -> dict:
    embed_input = " ".join([
        activity["name"],
        enriched.get("pitch", ""),
        activity["content"][:500],
        " ".join(enriched.get("tags", [])),
        city["name"],
    ])
    return {
        "id":                 str(uuid.uuid5(uuid.NAMESPACE_URL, f"{city['slug']}:{activity['name']}")),
        "city_slug":          city["slug"],
        "city_name":          city["name"],
        "country":            city["country"],
        "activity_name":      activity["name"],
        "category":           activity["category"],
        "description":        activity["content"][:1500],
        "pitch":              enriched.get("pitch", "")[:200],
        "tags":               [t.lower() for t in enriched.get("tags", [])][:6],
        "duration_minutes":   int(enriched.get("duration_minutes", 60)),
        "estimated_cost_eur": float(enriched.get("estimated_cost_eur", 0.0)),
        "indoor":             bool(enriched.get("indoor", False)),
        "best_time_of_day":   enriched.get("best_time_of_day", "any"),
        "latitude":           activity.get("lat"),
        "longitude":          activity.get("lon"),
        "source_url":         f"https://en.wikivoyage.org/wiki/{city['wikivoyage'].replace(' ', '_')}",
        "last_indexed":       datetime.now(timezone.utc).isoformat(),
        "content_vector":     embed_text(embed_input),
    }


def upsert_documents(search_client: SearchClient, docs: list[dict]):
    for i in range(0, len(docs), 50):
        batch = docs[i:i + 50]
        result = search_client.merge_or_upload_documents(documents=batch)
        success = sum(1 for r in result if r.succeeded)
        print(f"    ↑ {success}/{len(batch)} uploaded", flush=True)


# ---------------------------------------------------------------------------
# MAIN
# ---------------------------------------------------------------------------

def main():
    index_client = SearchIndexClient(SEARCH_ENDPOINT, AzureKeyCredential(SEARCH_KEY))
    try:
        index_client.get_index(INDEX_NAME)
        print(f"✓ Index '{INDEX_NAME}' exists", flush=True)
    except Exception:
        print(f"✗ Index '{INDEX_NAME}' missing. Create it via REST first.", file=sys.stderr)
        sys.exit(1)

    search_client = SearchClient(SEARCH_ENDPOINT, INDEX_NAME, AzureKeyCredential(SEARCH_KEY))

    total = 0
    for city in CITIES:
        print(f"\n=== {city['name']} ===", flush=True)

        raw_activities = fetch_wikivoyage_activities(city)

        # Cap per city. Prefer Landmarks and Activities over Restaurants for the demo.
        ranked = sorted(
            raw_activities,
            key=lambda a: {"Landmark": 0, "Activity": 1, "Restaurant": 2, "Bar": 3, "Shopping": 4}.get(a["category"], 5)
        )
        raw_activities = ranked[:MAX_ACTIVITIES_PER_CITY]

        docs = []
        for i, activity in enumerate(raw_activities, 1):
            try:
                print(f"  [{i}/{len(raw_activities)}] {activity['name'][:60]}…", flush=True)
                enriched = enrich_activity(activity, city)
                doc = build_document(activity, enriched, city)
                docs.append(doc)
                time.sleep(0.2)
            except Exception as e:
                print(f"     ! skipping ({e})", flush=True)

        if docs:
            upsert_documents(search_client, docs)
            total += len(docs)

    print(f"\nDone. Indexed {total} activities across {len(CITIES)} cities.", flush=True)


if __name__ == "__main__":
    main()
