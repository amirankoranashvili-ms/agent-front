# Drive-Through Frontend — Build Journal

## What We Built

A vanilla JS frontend for the "Fast X Food" drive-through voice agent running on Google CX Agent Studio. The frontend simulates a kiosk screen: full-page dark layout with real-time voice interaction, live order display, and a menu panel — all without frameworks.

### Architecture

```
Browser (vanilla JS)
  ├── Mic → ScriptProcessorNode → PCM INT16 → base64 → WebSocket
  ├── WebSocket → base64 audio → AudioContext → Speaker
  ├── WebSocket → parse `payload` field → Update Order/Loyalty UI
  └── WebSocket → parse `sessionOutput.text` → Show transcript
         │
    ws://localhost:8080/ws/voice
         │
Local Proxy Server (Python FastAPI)
  ├── Serves static files (index.html, app.js, styles.css)
  ├── Authenticates with Google (service account)
  ├── Proxies /api/menu to backend (with fallback to sample_menu.json)
  └── Proxies WebSocket to CES BidiRunSession
         │
    wss://ces.googleapis.com/ws/...BidiRunSession/locations/us
```

### Files

| File | Purpose |
|---|---|
| `index.html` | Three-panel kiosk layout (order, menu, voice controls) |
| `app.js` | WebSocket connection, audio capture/playback, payload handlers, menu loading |
| `styles.css` | Dark drive-through theme with animations and color-coded tags |
| `proxy.py` | FastAPI WebSocket proxy + static server + menu proxy |
| `requirements.txt` | Python dependencies |
| `.env` | Environment variables (deployment IDs, credentials path) |
| `.env.example` | Template for .env |

---

## Key Decision: Web Widget vs. BidiRunSession API

We evaluated two deployment approaches:

### Web Widget (rejected)

- Handles all voice/audio complexity automatically
- BUT: only 4 JS events exposed (`chat-messenger-loaded`, `chat-messenger-close`, `chat-messenger-error`, `df-update-cart-count`)
- **No event for receiving custom payloads or session variable changes**
- No way to extract `order_items` variable to a side panel
- Widget runs in shadow DOM — can't intercept its internal communications
- Would require modifying agent tools to POST order state to backend + polling
- Results in a chat-widget component, not a kiosk experience

### BidiRunSession API (chosen)

- Full control over the kiosk UI layout
- The agent's `after_tool_callback` already emits `Part.from_json()` payloads with order state
- These arrive as a `payload` field in WebSocket `sessionOutput` messages
- Real-time order updates with zero polling
- Audio handled via Web Audio API (~50 lines)
- Requires a WebSocket proxy for auth (browser `WebSocket` API doesn't support custom headers on upgrade)

**Bottom line:** The agent was literally designed to emit screen payloads for a companion display. BidiRunSession is how those payloads reach the screen. The web widget swallows them.

---

## How Order State Reaches the Frontend

This was the core technical challenge. CX Agent Studio session variables (`order_items`, `order_subtotal`, etc.) are internal to the agent — no direct API to query them.

### Solution: Callback Pipeline

```
Tool executes (add_to_order, etc.)
    │
    ▼
after_tool_callback
    │  Reads order_items variable
    │  Stores JSON payload in _pending_ui_payload variable
    │
    ▼
Model generates text response ("Got it, one burger!")
    │
    ▼
after_model_callback
    │  Checks _pending_ui_payload
    │  Appends Part.from_json(payload) to response
    │  Clears _pending_ui_payload
    │
    ▼
Client receives sessionOutput with:
    - text (streamed as audio chunks)
    - payload: {type: "order_update", items: [...], subtotal_display: "$7.99", ...}
```

The `Part.from_json()` payload is invisible to the LLM — it's a sideband data channel from callbacks to the client, delivered as a `payload` field in the BidiRunSession WebSocket message.

---

## Problems & Solutions

### 1. `navigator.mediaDevices` is undefined

**Symptom:** `Cannot read properties of undefined (reading 'getUserMedia')`

**Cause:** `mediaDevices` requires a secure context. The proxy was binding to `0.0.0.0`, so accessing via the IP address (not `localhost`) failed.

**Fix:** Bind proxy to `127.0.0.1` and access via `http://localhost:8080`. Added a guard in `app.js` to show a clear message instead of crashing.

### 2. Infinite payload loop crashes CES (code 1007)

**Symptom:** After adding an item to the order, the same payload is emitted 9+ times in rapid succession, then CES closes with `failed_precondition`.

**Cause:** We initially emitted `Part.from_json()` from `before_model_callback` with `response.partial = True`. Partial responses cause the model to continue processing, which re-triggers `before_model_callback`. The same function response is still in `llm_request.contents`, so the callback matches again — infinite loop.

**Fix:** Never emit payloads from `before_model_callback` with `partial = True`. Use the two-step pattern instead:

1. `after_tool_callback` — store payload in a session variable (`_pending_ui_payload`)
2. `after_model_callback` — check for pending payload, append to response, clear variable

This fires exactly once per model turn. No loop possible.

### 3. Agent speaks twice

**Symptom:** The agent's response plays through speakers, then plays again immediately.

**Cause:** BidiRunSession streams text/audio in chunks as the model generates. Then `after_model_callback` returns the modified response (with payload appended), which CES re-sends as a complete message — including the full text and audio again.

**Fix (agent side):** On non-first turns, `after_model_callback` returns ONLY the `Part.from_json(payload)` part, not the full text. CES sends just the payload without re-streaming text/audio.

**Fix (client side):** When a `sessionOutput` has a `payload` field, skip text display and audio playback from that message (they're duplicates of already-streamed content).

### 4. Menu fails to load (ConnectTimeout)

**Symptom:** `/api/menu` returns 500 with `httpx.ConnectTimeout`.

**Cause:** The Cloud Run backend has autoscaling with 0 minimum instances. Cold starts take 10+ seconds.

**Fix:** Added a fallback in `proxy.py` — if the backend times out, load the menu from the local `sample_menu.json` file. Also increased httpx timeout to 10 seconds.

### 5. `after_tool_callback` can't emit `LlmResponse`

**Discovery:** The original agent code in `after_tool_callback` creates `LlmResponse.from_parts([Part.from_json(...)])` but returns `tool_response` (a dict). The `LlmResponse` is never delivered — `after_tool_callback` can only return `Optional[dict]`, not `LlmResponse`. This was dead code.

**Lesson:** Only `before_model_callback` and `after_model_callback` can return `LlmResponse`. Tool callbacks return `dict` (to replace tool output) or `None`.

### 6. WebSocket disconnects silently

**Symptom:** Connection drops after tool calls with no error in logs.

**Cause:** The original proxy used `asyncio.gather()` for the two forwarding tasks. When one side closed, the other would try to send to a dead connection, raising an unhandled exception.

**Fix:** Switched to `asyncio.wait(return_when=FIRST_COMPLETED)` — when one pipe closes, the other is cancelled cleanly. Added logging for CES close codes/reasons, agent text, user transcripts, and payloads.

---

## Prerequisites

### Google Cloud Setup

```bash
# 1. Create service account
gcloud iam service-accounts create drive-through-frontend \
  --display-name="Drive-Through Frontend"

# 2. Grant CES Client role
gcloud projects add-iam-policy-binding YOUR_PROJECT_ID \
  --member="serviceAccount:drive-through-frontend@YOUR_PROJECT_ID.iam.gserviceaccount.com" \
  --role="roles/ces.client"

# 3. Download key
gcloud iam service-accounts keys create service-account.json \
  --iam-account=drive-through-frontend@YOUR_PROJECT_ID.iam.gserviceaccount.com
```

### Agent Deployment

1. Import the agent into CX Agent Studio
2. Deploy → Create Channel → API Access
3. Note the deployment resource name

### Environment

```bash
cp .env.example .env
# Fill in your values
```

### Run

```bash
cd frontend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python proxy.py
# → Open http://localhost:8080
```

---

## CX Agent Studio API Reference (for this use case)

### BidiRunSession WebSocket

**Endpoint:** `wss://ces.googleapis.com/ws/google.cloud.ces.v1.SessionService/BidiRunSession/locations/{REGION}`

**Config message (sent first):**
```json
{
  "config": {
    "session": "projects/.../apps/.../sessions/{SESSION_ID}",
    "deployment": "projects/.../apps/.../deployments/{DEPLOY_ID}",
    "inputAudioConfig": {"audioEncoding": "LINEAR16", "sampleRateHertz": 16000},
    "outputAudioConfig": {"audioEncoding": "LINEAR16", "sampleRateHertz": 16000}
  }
}
```

**Client → Server:** `{"realtimeInput": {"audio": "<base64>"}}`  or  `{"realtimeInput": {"text": "..."}}`

**Server → Client:**
```json
{"sessionOutput": {"text": "...", "audio": "<base64>", "payload": {...}}}
{"recognitionResult": {"transcript": "..."}}
{"interruptionSignal": {}}
{"endSession": {}}
```

### Callback Return Types

| Callback | Returns | Can emit `LlmResponse`? |
|---|---|---|
| `before_model_callback` | `Optional[LlmResponse]` | Yes (but beware `partial = True` loops) |
| `after_model_callback` | `Optional[LlmResponse]` | Yes (safe — fires once per turn) |
| `before_tool_callback` | `Optional[dict]` | No |
| `after_tool_callback` | `Optional[dict]` | No |

### `Part.from_json()` Delivery

- Created in Python callbacks: `Part.from_json(data=json.dumps(payload))`
- Invisible to the LLM — purely a sideband channel to the client
- Delivered as a `payload` field in `sessionOutput` for both `runSession` and `BidiRunSession`
- The payload is a Struct (JSON object), not a string
