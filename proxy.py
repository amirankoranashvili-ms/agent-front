import os
import uuid
import asyncio
import json
import logging

from dotenv import load_dotenv
load_dotenv()

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
import websockets
from google.auth.transport.requests import Request
from google.oauth2 import service_account

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("proxy")

SCOPES = ["https://www.googleapis.com/auth/cloud-platform"]
CES_WS_URL = "wss://ces.googleapis.com/ws/google.cloud.ces.v1.SessionService/BidiRunSession/locations/us"

CES_APP_RESOURCE = os.environ.get("CES_APP_RESOURCE", "")
CES_DEPLOYMENT = os.environ.get("CES_DEPLOYMENT", "")
BACKEND_URL = os.environ.get("BACKEND_URL", "https://drive-through-api-764628510125.us-central1.run.app")

app = FastAPI()


def get_access_token():
    creds = service_account.Credentials.from_service_account_file(
        os.environ.get("GOOGLE_APPLICATION_CREDENTIALS", "service-account.json"),
        scopes=SCOPES,
    )
    creds.refresh(Request())
    return creds.token


@app.websocket("/ws/voice")
async def voice_proxy(client_ws: WebSocket):
    await client_ws.accept()

    token = get_access_token()
    session_id = f"dt-{uuid.uuid4().hex[:12]}"
    session_name = f"{CES_APP_RESOURCE}/sessions/{session_id}"

    headers = {"Authorization": f"Bearer {token}"}

    try:
        async with websockets.connect(CES_WS_URL, additional_headers=headers) as ces_ws:
            config_msg = {
                "config": {
                    "session": session_name,
                    "inputAudioConfig": {
                        "audioEncoding": "LINEAR16",
                        "sampleRateHertz": 24000,
                    },
                    "outputAudioConfig": {
                        "audioEncoding": "LINEAR16",
                        "sampleRateHertz": 24000,
                    },
                }
            }
            if CES_DEPLOYMENT:
                config_msg["config"]["deployment"] = CES_DEPLOYMENT

            await ces_ws.send(json.dumps(config_msg))
            await ces_ws.send(json.dumps({"realtimeInput": {"text": "<event>session start</event>"}}))
            log.info(f"[{session_id}] CES session started")

            async def client_to_ces():
                try:
                    while True:
                        data = await client_ws.receive_text()
                        await ces_ws.send(data)
                except (WebSocketDisconnect, websockets.exceptions.ConnectionClosed):
                    log.info(f"[{session_id}] client->CES pipe closed")

            async def ces_to_client():
                try:
                    async for msg in ces_ws:
                        text = msg if isinstance(msg, str) else msg.decode()
                        try:
                            parsed = json.loads(text)
                            if "endSession" in parsed:
                                log.info(f"[{session_id}] CES sent endSession")
                            if "sessionOutput" in parsed:
                                so = parsed["sessionOutput"]
                                if so.get("text"):
                                    log.info(f"[{session_id}] agent: {so['text'][:120]}")
                                if so.get("payload"):
                                    log.info(f"[{session_id}] payload: {json.dumps(so['payload'])[:800]}")
                            if "recognitionResult" in parsed:
                                t = parsed["recognitionResult"].get("transcript", "")
                                if t:
                                    log.info(f"[{session_id}] user: {t}")
                        except (json.JSONDecodeError, KeyError):
                            pass
                        await client_ws.send_text(text)
                except websockets.exceptions.ConnectionClosed as e:
                    log.info(f"[{session_id}] CES closed: code={e.code} reason={e.reason}")
                except Exception as e:
                    log.warning(f"[{session_id}] ces->client error: {e}")
                finally:
                    log.info(f"[{session_id}] ces->client pipe closed")

            t1 = asyncio.create_task(client_to_ces())
            t2 = asyncio.create_task(ces_to_client())

            done, pending = await asyncio.wait(
                [t1, t2], return_when=asyncio.FIRST_COMPLETED
            )
            for t in pending:
                t.cancel()
            for t in done:
                if t.exception():
                    log.warning(f"[{session_id}] task error: {t.exception()}")

    except websockets.exceptions.InvalidStatusCode as e:
        log.error(f"[{session_id}] CES rejected connection: {e.status_code}")
        try:
            await client_ws.send_text(json.dumps({"error": f"CES auth failed ({e.status_code})"}))
        except Exception:
            pass
    except Exception as e:
        log.error(f"[{session_id}] proxy error: {e}")
        try:
            await client_ws.send_text(json.dumps({"error": str(e)}))
        except Exception:
            pass
    finally:
        try:
            await client_ws.close()
        except Exception:
            pass
        log.info(f"[{session_id}] session ended")


@app.get("/api/menu")
async def proxy_menu():
    if BACKEND_URL:
        try:
            import httpx
            async with httpx.AsyncClient(timeout=10.0) as client:
                resp = await client.get(f"{BACKEND_URL}/v1/menu")
                return resp.json()
        except Exception:
            pass
    with open(os.path.join(os.path.dirname(__file__), "..", "sample_menu.json")) as f:
        menu = json.load(f)
    categories = []
    for cat in menu.get("categories", []):
        items = []
        for item in cat.get("items", []):
            items.append({
                "id": item["id"],
                "name": item["name"],
                "description": item.get("description", ""),
                "basePrice": item.get("basePrice", 0),
                "sizes": item.get("sizes", []),
                "tags": item.get("tags", []),
                "available": True,
            })
        categories.append({"id": cat["id"], "name": cat["name"], "items": items})
    return {"restaurant_name": menu.get("name", "Fast X Food"), "categories": categories}


@app.get("/")
async def index():
    return FileResponse("index.html")


app.mount("/", StaticFiles(directory="."), name="static")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=8080)
