# Trek or Treat Travel — Copilot Studio travel agent

A demo travel-agent web experience built around a **Microsoft Copilot Studio**
bot, surfaced through a custom web UI over the **Direct Line** channel. It adds
voice (Azure Speech), a Dataverse-backed reservation/quotation experience,
a hotel map, and PDF quotation generation.

The frontend is a static site (plain HTML/CSS/JS, no build step). The backend
is a set of **Azure Static Web Apps** managed functions under [`api/`](api/)
that keep every secret off the browser.

## Architecture at a glance

| Piece | Where | Talks to |
| --- | --- | --- |
| Web UI | root (`index.html`, `app.js`, …) | the `/api/*` functions only |
| DirectLine token minter | [`api/directline-token`](api/directline-token) | Copilot Studio bot (Direct Line) |
| Speech token minter | [`api/speech-token`](api/speech-token) | Azure Speech |
| Dataverse proxies | [`api/dataverse-*`](api) | Dataverse (Entra service principal) |
| Voice summarizer | [`api/foundry-summarize`](api/foundry-summarize) | Azure AI Foundry |
| PDF service | [`api/pdf-service`](api/pdf-service) | Playwright/Chromium |

The browser **never** sees a long-lived secret. Each function reads its
credentials from app settings (`process.env`) and hands the browser only
short-lived tokens or already-shaped data.

## Configuration & secrets

Nothing sensitive is committed. There are two config seams:

### 1. Frontend config (non-secret)

Edit `window.AppConfig` in [`index.html`](index.html#L338). These are just
endpoint paths and voice preferences — no secrets:

- `directLineTokenUrl` — defaults to the relative `/api/directline/token`
- `speechTokenUrl` — defaults to `/api/speech/token`
- `speechRecognitionLanguage`, `speechSynthesisVoice`

### 2. Backend secrets (never committed)

Copy the example and fill in your values:

```bash
cp api/local.settings.json.example api/local.settings.json
```

`api/local.settings.json` is git-ignored. It documents every required app
setting: `DIRECTLINE_SECRET`, `SPEECH_KEY`/`SPEECH_REGION`, `DATAVERSE_URL`,
`ENTRA_TENANT_ID`/`ENTRA_CLIENT_ID`/`ENTRA_CLIENT_SECRET`, and
`FOUNDRY_ENDPOINT`. In production, set these as **Static Web App application
settings**, not in the file.

The scraper has its own secrets:

```bash
cp docs/travel-assistant/scraper/.env.example docs/travel-assistant/scraper/.env
```

The provisioning/flow scripts under [`docs/travel-assistant`](docs/travel-assistant)
take the Dataverse org URL from `--env <orgUrl>` or the `DATAVERSE_URL`
environment variable — no org is hardcoded.

## Local development

```bash
# from repo root, with the Azure Static Web Apps CLI + Functions Core Tools
swa start . --api-location api
```

See [`docs/travel-assistant/docs/BUILD-AND-DEPLOY.md`](docs/travel-assistant/docs/BUILD-AND-DEPLOY.md)
for full provisioning and deployment steps.
