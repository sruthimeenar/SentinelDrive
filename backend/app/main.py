import asyncio
import json
from contextlib import asynccontextmanager

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware

from . import detections as detections_api
from . import dispatch as dispatch_api
from .pipeline import TelemetryPipeline
from .simulator import SentinelSimulator

sim = SentinelSimulator()
pipeline = TelemetryPipeline()
clients = set()
# Inbound client messages (e.g. browser PERCLOS telemetry, spoken answers) are
# serialized through this queue so all processing happens from a single task.
inbox: "asyncio.Queue[dict]" = asyncio.Queue()


def _publish(event):
    # Keep real pothole events in the in-memory list so GET /api/potholes (the
    # REST rehydration path) returns them even when Postgres is unavailable.
    # The simulator never fabricates potholes, so this list is real-uploads only.
    if event.get("type") == "pothole":
        sim.potholes.insert(0, event)
        del sim.potholes[60:]
    return pipeline.publish(event)


async def _send_to_all(ws_list, msg):
    for ws in list(ws_list):
        try:
            await ws.send_json(msg)
        except Exception:
            ws_list.discard(ws)


async def _tick_loop():
    # Producer: step the simulator and publish every generated event onto the
    # stream. The simulator only ever emits fatigue/talkback events and real
    # ambulance lifecycle updates; potholes/crashes come from real ingestion.
    while True:
        while not inbox.empty():
            await pipeline.publish(inbox.get_nowait())
        for msg in sim.tick():
            await pipeline.publish(msg)
            if msg.get("type") == "pothole":
                dispatch_api.create_dispatch(msg)
        await asyncio.sleep(0.9)


async def _consume_loop():
    # Consumer: reads events off the stream, fans them out to every connected
    # WebSocket client, and persists pothole/crash events to PostGIS.
    await pipeline.consume_loop(clients, _send_to_all)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    await pipeline.connect()
    detections_api.set_publisher(_publish)
    tasks = [
        asyncio.create_task(_tick_loop()),
        asyncio.create_task(_consume_loop()),
    ]
    yield
    for t in tasks:
        t.cancel()
    await pipeline.close()


app = FastAPI(title="SentinelDrive Telematics API", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(detections_api.router)
app.include_router(dispatch_api.router, prefix="/api")


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    clients.add(websocket)
    try:
        while True:
            raw = await websocket.receive_text()
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                continue
            if not isinstance(msg, dict):
                continue
            event = sim.ingest(msg)
            if event is not None:
                await inbox.put(event)
    except WebSocketDisconnect:
        pass
    finally:
        clients.discard(websocket)


@app.get("/api/potholes")
async def get_potholes():
    # Persisted rows come from PostGIS; falls back to the simulator's live
    # in-memory list when the database is unreachable.
    rows = await pipeline.list_potholes(limit=50)
    if rows is not None:
        return rows
    return sim.potholes


@app.get("/api/crashes")
async def get_crashes():
    rows = await pipeline.list_crashes(limit=50)
    if rows is not None:
        return rows
    return list(sim.crash_events)


@app.get("/api/talkbacks")
async def get_talkbacks():
    # Voice-guidance sessions for review/debugging (transcripts, outcomes).
    rows = await pipeline.list_talkbacks(limit=50)
    if rows is not None:
        return rows
    return []


@app.get("/api/status")
async def get_status():
    return {
        "fatigue": sim.fatigue,
        "tier": sim.tier,
        "fatigue_source": sim.fatigue_source,
        "talkback": sim.talkback,
        "pipeline": {"redis": pipeline.redis_ok, "postgres": pipeline.pg_ok},
    }
