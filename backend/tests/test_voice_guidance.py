"""Phase 5 tests: spoken-answer transcripts/audio flow through talk-back.

The browser sends the transcript (and optional recorded audio) with each
talkback_answer; the backend echoes them onto the resolved talkback_done event
(and onto retries) so they can be persisted for review/debugging.
"""

import os
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(_HERE))

from app.simulator import SentinelSimulator  # noqa: E402

HERE_DIR = os.path.dirname(_HERE)
spec_path = os.path.join(HERE_DIR, "frontend", "src", "hooks", "useVoiceTalkBack.js")


def _arm_challenge(s):
    s.ingest({"type": "fatigue", "score": 9.0, "perclos": 0.8, "tier": "critical"})
    for _ in range(200):
        msgs = s.tick()
        for m in msgs:
            if m["type"] == "talkback":
                s._client_fatigue_at = 0.0  # camera goes silent -> labeled fallback path
                return m
    raise RuntimeError("no talkback armed")


def test_correct_spoken_answer_with_transcript_and_audio():
    s = SentinelSimulator()
    tb = _arm_challenge(s)
    ev = s.ingest({
        "type": "talkback_answer",
        "id": tb["id"],
        "answer": int(tb["answer"]),
        "transcript": "seven",
        "audio": "data:audio/webm;base64,AAABBB",
        "transcription": "speech",
    })
    assert ev["type"] == "talkback_done"
    assert ev["correct"] is True
    assert ev["outcome"] == "response_ok"
    assert ev["transcript"] == "seven"
    assert ev["audio"] == "data:audio/webm;base64,AAABBB"
    assert ev["parsedAnswer"] == int(tb["answer"])
    assert ev["expectedAnswer"] == int(tb["answer"])
    assert ev["transcription"] == "speech"
    assert s.talkback is None  # challenge resolved
    print("A OK: spoken answer -> talkback_done carries transcript + audio + parsed/expected answer")


def test_wrong_answer_carries_transcript():
    s = SentinelSimulator()
    tb = _arm_challenge(s)
    expected = int(tb["answer"])
    wrong = expected + 1
    ev = s.ingest({
        "type": "talkback_answer",
        "id": tb["id"],
        "answer": wrong,
        "transcript": "nineteen",
    })
    assert ev["type"] == "talkback_retry"
    assert ev["transcript"] == "nineteen"
    assert s.talkback is not None  # still challenged
    print("B OK: wrong spoken answer -> talkback_retry carries the transcript for the UI")


def test_no_answer_beeping_path_unchanged():
    s = SentinelSimulator()
    tb = _arm_challenge(s)
    tb["elapsed"] = tb["max_ticks"]  # force phase escalation on next tick
    done = None
    for _ in range(60):
        msgs = s.tick()
        for m in msgs:
            if m["type"] == "talkback_done" and m["id"] == tb["id"]:
                done = m
                break
        if done:
            break
    assert done is not None and done["correct"] is False and done["outcome"] == "no_answer"
    print("C OK: silence still resolves to no_answer (fallback alarm path intact)")


def test_manual_transcription_type_passthrough():
    s = SentinelSimulator()
    tb = _arm_challenge(s)
    ev = s.ingest({
        "type": "talkback_answer",
        "id": tb["id"],
        "answer": int(tb["answer"]),
        "transcript": "forty two",
        "audio": None,
        "transcription": "manual",
    })
    assert ev["transcription"] == "manual"
    assert ev["transcript"] == "forty two"
    print("D OK: manual (typed) fallback labeled transcription=manual")


if __name__ == "__main__":
    test_correct_spoken_answer_with_transcript_and_audio()
    test_wrong_answer_carries_transcript()
    test_no_answer_beeping_path_unchanged()
    test_manual_transcription_type_passthrough()
    print("\nALL VOICE GUIDANCE TESTS PASS")
