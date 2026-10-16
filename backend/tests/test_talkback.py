import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.simulator import SentinelSimulator


def force_arm(sim, score=9.0):
    """Arm a talk-back challenge the realistic way.

    A real camera telemetry report must be flowing for the challenge to arm
    (the simulator never fabricates a cognitive challenge in simulated mode).
    We ingest a critical camera reading, tick until the challenge arms, then
    drop the camera (client went silent) so the tests can exercise the
    labeled simulated fallback + reset path.
    """
    sim.ingest({"type": "fatigue", "score": score, "perclos": 0.8, "tier": "critical"})
    for _ in range(200):
        sim.tick()
        if sim.talkback:
            sim._client_fatigue_at = 0.0  # camera goes silent after the challenge arms
            return sim.talkback
    raise RuntimeError("challenge never armed")


# --- A: correct answer resolves, simulated fatigue resets ---
sim = SentinelSimulator()
tb = force_arm(sim)
start_score = sim.fatigue["score"]
assert start_score >= 8
ev = sim.ingest({"type": "talkback_answer", "id": tb["id"], "answer": tb["answer"]})
assert ev is not None and ev["type"] == "talkback_done", ev
assert ev["outcome"] == "response_ok" and ev["correct"] is True, ev
assert sim.talkback is None
assert sim.fatigue["score"] <= 3.5
print("A OK: correct answer -> talkback_done(response_ok, correct) + reset (camera-off path)")

# --- B: wrong answer -> re-prompt, no resolve, no reset ---
sim = SentinelSimulator()
tb = force_arm(sim)
before = sim.fatigue["score"]
wrong = str(int(tb["answer"]) + 1)
ev = sim.ingest({"type": "talkback_answer", "id": tb["id"], "answer": wrong})
assert ev is not None and ev["type"] == "talkback_retry", ev
assert sim.talkback is not None and sim.talkback["phase"] == "asked" and sim.talkback["elapsed"] == 0
assert sim.fatigue["score"] == before
print("B OK: wrong answer -> talkback_retry, no resolve, score frozen")

# --- C: no answer -> beeping fallback -> no_answer resolution when score < 5 ---
sim = SentinelSimulator()
tb = force_arm(sim)
all_events = []
saw_beeping = False
saw_timer_resolve = False
for _ in range(120):
    evs = sim.tick()
    if not evs:
        continue
    all_events.extend(evs)
    if sim.talkback and sim.talkback["phase"] == "beeping":
        saw_beeping = True
    if sim.talkback is None:
        break
assert saw_beeping, "no-answer challenge must enter beeping phase"
assert sim.talkback is None, "challenge must resolve once fatigue < 5"
dones = [e for e in all_events if e["type"] == "talkback_done"]
assert len(dones) == 1, f"expected exactly one talkback_done, got {dones}"
assert dones[0]["outcome"] == "no_answer" and dones[0]["correct"] is False, dones[0]
assert not any(e["type"] == "talkback_done" and e["outcome"] == "response_ok" for e in all_events), (
    "a timer must NEVER resolve as response_ok"
)
print("C OK: no answer -> beeping, then talkback_done(no_answer); no spurious response_ok")

# --- D: during 'asked' phase, simulated score is frozen (challenge stays active) ---
sim = SentinelSimulator()
tb = force_arm(sim)
scores = []
for _ in range(4):
    sim.tick()
    if sim.talkback:
        scores.append(sim.fatigue["score"])
assert len(set(scores)) == 1, f"fatigue must stay frozen while challenge is asked, scores={scores}"
print("D OK: fatigue frozen during 'asked' phase")

# --- E: a challenge NEVER arms in simulated (camera-off) mode ---
sim = SentinelSimulator()
for _ in range(200):
    sim.tick()
    assert sim.talkback is None, "challenge must not arm without a live camera"
print("E OK: no fabricated cognitive challenge while camera is inactive")

print("\nALL PASS")