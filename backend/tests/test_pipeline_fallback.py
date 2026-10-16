import asyncio
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.pipeline import TelemetryPipeline


async def main():
    pipe = TelemetryPipeline()
    await pipe.connect()
    assert pipe.redis_ok is False, "expected Redis to be unreachable in this env"
    assert pipe.pg_ok is False, "expected Postgres to be unreachable in this env"
    print("OK: degraded startup (redis/pg unavailable -> flags False, fallback armed)")

    events = [
        {"type": "fatigue", "score": 6.0, "perclos": 0.2, "tier": "moderate", "source": "simulated", "ts": 1},
        {"type": "pothole", "id": "ph-1", "lat": 40.712, "lng": -74.006, "area": 0.2, "depth": 0.1,
         "volume": 0.02, "material": "PMB", "cost": 30.0, "breakdown": {"labor": 42.0}, "status": "dispatched", "ts": 2},
        {"type": "crash", "id": "cr-1", "verified": True, "gForce": 12.0, "db": 100,
         "frameCrunch": True, "guidance": "exit right", "ts": 3},
    ]
    broadcast = []
    async def record(_clients, event):
        broadcast.append(event)

    task = asyncio.create_task(pipe.consume_loop(set(), record))
    for e in events:
        await pipe.publish(e)
    for _ in range(100):
        if len(broadcast) >= len(events):
            break
        await asyncio.sleep(0.05)
    task.cancel()
    try:
        await task
    except asyncio.CancelledError:
        pass

    got_types = [e["type"] for e in broadcast]
    assert got_types == ["fatigue", "pothole", "crash"], f"order broken: {got_types}"
    print("OK: fallback queue delivered events in order")

    assert await pipe.list_potholes() is None
    assert await pipe.list_crashes() is None
    print("OK: list_* return None when Postgres is down (REST falls back to simulator lists)")

    await pipe.close()
    print("\nALL FALLBACK TESTS PASS")


asyncio.run(main())
