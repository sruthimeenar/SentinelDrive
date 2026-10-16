import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from websockets.sync.client import connect

import subprocess

proc = subprocess.Popen(
    [sys.executable, "-m", "uvicorn", "app.main:app", "--port", "8010"],
    cwd=str(Path(__file__).resolve().parents[1]),
    stdout=subprocess.DEVNULL,
    stderr=subprocess.DEVNULL,
)

try:
    deadline = time.time() + 15
    ws = None
    while time.time() < deadline:
        try:
            ws = connect("ws://localhost:8010/ws")
            break
        except Exception:
            time.sleep(0.4)
    assert ws is not None, "could not connect to WS in time"

    types_seen = {}
    cutoff = time.time() + 5
    while time.time() < cutoff:
        msg = json.loads(ws.recv(timeout=5))
        types_seen[msg["type"]] = types_seen.get(msg["type"], 0) + 1

    # Browser PERCLOS telemetry must be relayed (camera path preserved).
    ws.send(json.dumps({
        "type": "fatigue", "score": 7.2, "perclos": 0.29,
        "tier": "moderate", "ts": int(time.time() * 1000),
    }))
    relayed = False
    for _ in range(30):
        msg = json.loads(ws.recv(timeout=2))
        if msg.get("type") == "fatigue" and msg.get("source") == "camera" and msg.get("score") == 7.2:
            relayed = True
            break
    ws.close()
    assert relayed, "camera fatigue telemetry was not relayed through the pipeline"
    print("OK: WS connected, events flowed through pipeline, camera telemetry relayed")
    print("OK: saw event types:", sorted(types_seen.keys()))
finally:
    proc.terminate()
    try:
        proc.wait(timeout=5)
    except Exception:
        proc.kill()

print("WS PIPELINE TEST PASS")
