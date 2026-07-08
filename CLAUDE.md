# CLAUDE.md — Frontend

## What this is

Voice-powered drive-through kiosk frontend for Google CX Agent Studio. Vanilla HTML/CSS/JS served by a Python FastAPI proxy that bridges WebSocket auth to Google's BidiRunSession API.

## Quick start

```bash
cd frontend
source .venv/bin/activate
python proxy.py
# http://localhost:8080
```

## Project structure

- `proxy.py` — FastAPI app: serves static files, proxies `/ws/voice` to CES, proxies `/api/menu` to backend
- `app.js` — All client logic: WebSocket, mic capture (PCM INT16 16kHz), audio playback, payload handling, menu rendering
- `index.html` — Three-panel kiosk layout
- `styles.css` — Dark theme, animations, responsive
- `.env` — Config (not committed): `CES_APP_RESOURCE`, `CES_DEPLOYMENT`, `BACKEND_URL`
- `service-account.json` — Google Cloud credentials (do not commit)
- `../sample_menu.json` — Fallback menu data when backend is unavailable

## Tech stack

- **No build step.** No bundler, no transpiler, no package.json. Vanilla JS (ES5-compatible IIFE pattern).
- **Python proxy:** FastAPI + uvicorn + websockets + google-auth + httpx
- **Audio:** Web Audio API (`ScriptProcessorNode` for capture, `AudioBufferSourceNode` for playback)
- **Backend:** Separate Cloud Run service (not in this directory), 12 REST endpoints

## Key architecture decisions

1. **BidiRunSession over web widget** — the widget can't receive custom JSON payloads (`Part.from_json()`) that carry order state
2. **Proxy for auth** — browser WebSocket API doesn't support custom headers; proxy adds Bearer token
3. **Two-step callback pipeline** — agent uses `after_tool_callback` to store UI payload in session var, `after_model_callback` appends it as `Part.from_json()` — avoids infinite loop from `before_model_callback`
4. **Menu fallback** — `/api/menu` tries backend first, falls back to `../sample_menu.json` on timeout (Cloud Run cold starts)

## Code conventions

- No frameworks, no TypeScript, no build tools
- DOM manipulation via `getElementById` + `innerHTML`
- All WebSocket message parsing in `app.js` handles: `sessionOutput.audio`, `sessionOutput.text`, `sessionOutput.payload`, `recognitionResult`
- Proxy logs session ID, agent text, user transcripts, and payloads for debugging

## Common tasks

**Change audio settings:** `proxy.py` lines 54-60 (config msg), `app.js` `SAMPLE_RATE` constant

**Add new payload types:** Handle in `app.js` `handlePayload()` function, add corresponding UI in `index.html`

**Change proxy port:** `proxy.py` line 176 (`uvicorn.run` call)

**Debug WebSocket messages:** Proxy logs all messages with session ID prefix — check terminal output

## Testing

No automated tests. Manual test cases in `../TEST_CASES.md` (18 categories, 58+ scenarios). Run against the CX Agent Studio Simulator or the live kiosk.

## Related files outside this directory

- `../ARCHITECTURE.md` — Full agent design (tools, callbacks, guardrails, variables)
- `../BACKEND.md` — Backend REST API specification (12 endpoints)
- `../sample_menu.json` — Restaurant menu data (7 categories, 30+ items)
- `../TEST_CASES.md` — Manual test cases
- `../templates/` — Sample CX Agent Studio agent templates
