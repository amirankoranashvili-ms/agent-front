# Fast X Food Drive-Through Kiosk Frontend

Voice-powered drive-through ordering kiosk built on Google CX Agent Studio. Customers speak into a microphone to place orders through an AI agent (Gemini), while the kiosk screen displays the live order, menu, and loyalty info in real time.

## Architecture

```
Browser (vanilla JS + Web Audio API)
    ├── Mic → PCM INT16 16kHz → base64 → WebSocket
    ├── WebSocket ← base64 audio → AudioContext → Speaker
    └── WebSocket ← JSON payloads → Order/Loyalty UI
    │
  ws://localhost:8080/ws/voice
    │
Python Proxy (FastAPI)
    ├── Authenticates with Google Cloud (service account)
    ├── Proxies WebSocket ↔ CES BidiRunSession API
    └── Proxies GET /api/menu → Backend REST API
    │
  wss://ces.googleapis.com/.../BidiRunSession/locations/us
    │
Google CX Agent Studio (Gemini gemini-3.1-flash-live)
    │
  https://drive-through-api-*.us-central1.run.app
    │
Backend REST API (Cloud Run)
```

### Why a proxy instead of connecting directly?

The browser `WebSocket` API doesn't support custom headers on the upgrade request. The proxy handles Google Cloud authentication via service account credentials and bridges the connection.

### Why not the CX Agent Studio web widget?

The embeddable widget only exposes 4 JS events with no way to receive custom JSON payloads. The agent emits `Part.from_json()` payloads containing order state — the widget swallows these. BidiRunSession gives full control over the kiosk UI and real-time payload delivery.

## Files

| File | Purpose |
|---|---|
| `index.html` | Three-panel kiosk layout (order, menu, voice controls) |
| `app.js` | WebSocket connection, audio capture/playback, payload rendering |
| `styles.css` | Dark drive-through theme with animations and color-coded tags |
| `proxy.py` | FastAPI WebSocket proxy + static file server + menu proxy |
| `requirements.txt` | Python dependencies |
| `.env` | Environment variables (not committed) |
| `.env.example` | Template for `.env` |
| `service-account.json` | Google Cloud service account key (do not commit) |

## Prerequisites

- Python 3.10+
- A Google Cloud service account with `roles/ces.client`
- A deployed CX Agent Studio agent with an API Access channel
- (Optional) The backend REST API deployed on Cloud Run

## Setup

```bash
cd frontend

# Create virtual environment
python3 -m venv .venv
source .venv/bin/activate

# Install dependencies
pip install -r requirements.txt

# Configure environment
cp .env.example .env
# Edit .env with your CES_APP_RESOURCE, CES_DEPLOYMENT, and BACKEND_URL

# Place your service account key
cp /path/to/your-key.json service-account.json
```

## Run

```bash
python proxy.py
# Open http://localhost:8080
```

The server binds to `127.0.0.1:8080`. It must be localhost (not an IP) because `navigator.mediaDevices` requires a secure context.

## Environment Variables

| Variable | Description |
|---|---|
| `GOOGLE_APPLICATION_CREDENTIALS` | Path to service account JSON key (default: `./service-account.json`) |
| `CES_APP_RESOURCE` | CX Agent Studio app resource name (`projects/.../apps/...`) |
| `CES_DEPLOYMENT` | CX Agent Studio deployment ID (`projects/.../deployments/...`) |
| `BACKEND_URL` | Backend REST API URL; if empty, falls back to local `sample_menu.json` |

## Audio Format

- Encoding: LINEAR16 (PCM signed 16-bit)
- Sample rate: 16,000 Hz
- Channels: mono
- Transport: base64-encoded over WebSocket

## JSON Payloads

The agent sends structured payloads through the WebSocket for UI updates:

- **`order_update`** — current order items, subtotal, tax, total, calories
- **`loyalty_update`** — loyalty tier, points, rewards
- **`order_confirmed`** / **`order_submitted`** — terminal order states

The browser parses these from `sessionOutput.payload` in the CES response.
