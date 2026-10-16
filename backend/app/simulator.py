import random
import time
import uuid
from collections import deque


def _ts():
    return int(time.time() * 1000)


# How long a browser camera's fatigue telemetry stays authoritative before the
# simulator falls back to its random walk. Camera clients report every ~1s.
_CLIENT_FATIGUE_TTL_S = 3.0

# Crash verification thresholds (see _verify_crash). Mirrors Phase 3's honesty
# pattern: the browser's real accelerometer spike is the primary signal, and
# every corroborating layer is labeled with its source (device vs simulated) so
# the UI shows exactly what agreed.
CRASH_G_THRESHOLD = 4.0    # g-force at which an impact is a real candidate
CRASH_G_DECISIVE = 8.0     # above this the impact is overwhelming on its own
CRASH_GPS_DELTA_KMH = 20.0  # GPS speed drop that corroborates hard deceleration
CRASH_DISTRACTED_SCORE = 5.0  # camera fatigue score that corroborates inattention


class SentinelSimulator:
    CRASH_GUIDANCE = [
        "Oncoming traffic on left - do NOT exit driver door.",
        "Vehicle stopped mid-lane. Hazard lights ON. Await live instructions.",
        "Right shoulder is clear - exit on the passenger side.",
        "Rear vehicle approaching at speed - remain seated until impact is clear.",
    ]
    AMBULANCE_GUIDANCE = [
        "Ambulance behind you - signal left and pull over in 20 m.",
        "Clear the right lane now. Emergency vehicle is 30 m behind.",
        "Stop short of the crosswalk - do not block the intersection.",
        "Merge left slowly - lights-and-siren vehicle is passing on your right.",
    ]

    def __init__(self):
        self.fatigue = {"score": 3.0, "perclos": 0.07}
        self.tier = "safe"
        # "camera" when the browser is streaming real PERCLOS/head-pose,
        # "simulated" when the camera is genuinely off or permission was
        # denied and we fall back to the (clearly labeled) random walk.
        # Exposed in every fatigue event.
        self.fatigue_source = "simulated"
        self._client_fatigue_at = 0.0
        self.talkback = None
        self.potholes = []
        self.crash_events = deque(maxlen=25)
        # Real emergency-vehicle state, populated only by audio siren
        # detections relayed from the browser mic (ambulance_candidate).
        self.ambulance = None
        self._amb_ticks = 0
        self._amb_last_at = 0.0

    @staticmethod
    def _tier_for_score(score):
        return "critical" if score >= 8 else ("moderate" if score >= 5 else "safe")

    def _has_live_fatigue(self):
        return time.time() - self._client_fatigue_at < _CLIENT_FATIGUE_TTL_S

    def _verify_crash(self, candidate):
        """Multimodal verification for a device-reported impact.

        Returns (verified, verification_block). The g-force spike is real
        device data; GPS speed-drop and camera distraction evidence corroborate
        it when the browser provided them, and are labeled with their actual
        source otherwise.
        """
        g_force = max(0.0, float(candidate.get("gForce") or 0.0))
        gps = candidate.get("gps") or {}
        fatigue = candidate.get("fatigue") or {}

        gps_delta = 0.0
        if gps.get("speed_prior_kmh") is not None and gps.get("speed_kmh") is not None:
            gps_delta = float(gps["speed_prior_kmh"]) - float(gps["speed_kmh"])

        cam_source = fatigue.get("source")
        cam_score = fatigue.get("score")
        try:
            cam_score = None if cam_score is None else float(cam_score)
        except (TypeError, ValueError):
            cam_score = None

        gps_agree = gps_delta >= CRASH_GPS_DELTA_KMH
        cam_agree = cam_source == "camera" and cam_score is not None and cam_score >= CRASH_DISTRACTED_SCORE
        decisive = g_force >= CRASH_G_DECISIVE
        verified = decisive or (g_force >= CRASH_G_THRESHOLD and (gps_agree or cam_agree))

        verification = {
            "mode": "device-multimodal",
            "sensors": {
                "gForce": {
                    "value": round(g_force, 1),
                    "source": "device",
                    "agree": g_force >= CRASH_G_THRESHOLD,
                },
                "gps": {
                    "speed_delta_kmh": round(gps_delta, 1),
                    "source": "device" if gps else "not-captured",
                    "agree": gps_agree,
                },
                "camera": {
                    "fatigue_score": None if cam_score is None else round(cam_score, 1),
                    "source": cam_source or "not-captured",
                    "agree": cam_agree,
                },
            },
            "rule": "gForce >= 4g AND (GPS speed-drop >= 20 km/h OR camera distraction); gForce >= 8g is decisive",
            "upgrade_path": "dedicated-IMU-and-audio",
        }
        return verified, verification

    def _ingest_crash_candidate(self, msg):
        verified, verification = self._verify_crash(msg)
        g_force = max(0.0, float(msg.get("gForce") or 0.0))
        cam_active = (msg.get("fatigue") or {}).get("source") == "camera"
        event = {
            "type": "crash",
            "id": uuid.uuid4().hex[:8],
            "detection_source": "device",
            "verified": verified,
            "gForce": round(g_force, 1),
            "db": None,
            "frameCrunch": cam_active,
            "guidance": random.choice(self.CRASH_GUIDANCE) if verified else None,
            "verification": verification,
            "ts": int(msg.get("ts") or _ts()),
        }
        self.crash_events.appendleft(event)
        return event

    def ingest(self, msg):
        """Handle an inbound message from a browser client.

        Camera fatigue telemetry ({type: "fatigue", score, perclos, tier})
        replaces the simulated random walk while it keeps arriving. A captured
        spoken answer ({type: "talkback_answer", id, answer}) is VERIFIED here
        against the expected value: a correct answer resolves the challenge
        (the only path that resets a simulated fatigue score); a wrong answer
        triggers a re-prompt. Returns an event to relay to all clients, or
        None if nothing should be broadcast.
        """
        mtype = msg.get("type")

        if mtype == "talkback_answer":
            if not self.talkback or self.talkback.get("id") != msg.get("id"):
                return None
            try:
                answer = int(msg["answer"])
            except (KeyError, TypeError, ValueError):
                return None
            expected = int(self.talkback["answer"])
            transcript = msg.get("transcript")
            audio = msg.get("audio")
            transcription = msg.get("transcription", "speech")
            if answer == expected:
                event = {
                    "type": "talkback_done",
                    "id": self.talkback["id"],
                    "question": self.talkback["question"],
                    "expectedAnswer": expected,
                    "outcome": "response_ok",
                    "correct": True,
                    "parsedAnswer": answer,
                    "transcript": transcript,
                    "audio": audio,
                    "transcription": transcription,
                    "ts": _ts(),
                }
                self.talkback = None
                if not self._has_live_fatigue():
                    self.fatigue["score"] = random.uniform(2.0, 3.5)
                    self.fatigue["perclos"] = 0.05
                return event
            # Wrong answer: never resolve as a success. Re-prompt with a fresh
            # response window; carry the transcript so the UI can show what
            # was heard.
            self.talkback["elapsed"] = 0
            self.talkback["phase"] = "asked"
            return {
                "type": "talkback_retry",
                "id": self.talkback["id"],
                "question": self.talkback["question"],
                "transcript": transcript,
                "ts": _ts(),
            }

        if mtype == "crash_candidate":
            return self._ingest_crash_candidate(msg)

        if mtype == "ambulance_candidate":
            return self._ingest_siren(msg)

        if mtype == "ambulance_clear":
            return self._ingest_siren_clear(msg)

        if mtype != "fatigue":
            return None
        try:
            score = float(msg["score"])
            perclos = float(msg.get("perclos", 0.0))
        except (KeyError, TypeError, ValueError):
            return None
        self.fatigue["score"] = max(0.0, min(10.0, score))
        self.fatigue["perclos"] = max(0.0, min(1.0, perclos))
        # Real camera telemetry: eye closure (PERCLOS) + head droop (pitch /
        # sustained tilt). Relayed verbatim so the UI shows what the browser
        # actually measured, never a fabricated blend.
        nod = msg.get("nod")
        if isinstance(nod, dict):
            self.fatigue["nod"] = nod
        if "face" in msg:
            self.fatigue["face"] = bool(msg["face"])
        self.tier = msg.get("tier") or self._tier_for_score(self.fatigue["score"])
        self.fatigue_source = "camera"
        self._client_fatigue_at = time.time()
        return {
            "type": "fatigue",
            "score": self.fatigue["score"],
            "perclos": self.fatigue["perclos"],
            "tier": self.tier,
            "source": self.fatigue_source,
            "face": self.fatigue.get("face", True),
            "nod": self.fatigue.get("nod"),
            "ts": int(msg.get("ts") or _ts()),
        }

    def _ingest_siren(self, msg):
        """Handle a real audio siren detection relayed from the browser mic.

        The browser performs spectral siren detection (frequency/pattern
        matching on live microphone input) and reports
        {type: "ambulance_candidate", freq_hz, score}. This creates or advances
        a REAL emergency-vehicle event tagged detection_source: "audio-siren".
        """
        now = _ts()
        freq = msg.get("freq_hz")
        score = msg.get("score")
        if self.ambulance is None:
            self.ambulance = {
                "id": uuid.uuid4().hex[:8],
                "stage": "APPROACHING",
                "detection_source": "audio-siren",
                "guidance": random.choice(self.AMBULANCE_GUIDANCE),
                "corridor": True,
                "distance": None,
                "siren_freq_hz": freq,
                "siren_score": score,
            }
            self._amb_ticks = 0
        else:
            self.ambulance["stage"] = "GUIDING"
            self.ambulance["siren_freq_hz"] = freq
            self.ambulance["siren_score"] = score
        self._amb_last_at = time.time()
        return {"type": "ambulance", **self.ambulance, "ts": now}

    def _ingest_siren_clear(self, msg):
        """Siren no longer audible -> mark the real event CLEARED."""
        if self.ambulance is None:
            return None
        amb = self.ambulance
        self.ambulance = None
        self._amb_ticks = 0
        return {"type": "ambulance", **amb, "stage": "CLEARED", "ts": _ts()}

    def _update_fatigue(self):
        f = self.fatigue
        drift = random.uniform(-0.05, 0.30)
        if random.random() < 0.02:
            drift += random.uniform(2.2, 4.2)
        f["score"] = min(10.0, max(0.0, f["score"] + drift))
        target_perclos = 0.02 + (f["score"] / 10.0) * 0.75
        f["perclos"] = max(0.0, min(1.0, f["perclos"] + (target_perclos - f["perclos"]) * 0.2))
        self.tier = "critical" if f["score"] >= 8 else ("moderate" if f["score"] >= 5 else "safe")

    def tick(self):
        msgs = []
        live_fatigue = self._has_live_fatigue()

        if not live_fatigue and self.fatigue_source == "camera":
            # The browser stopped reporting camera telemetry (camera genuinely
            # off or permission was denied); revert to the labeled random walk
            # and say so in the UI ("SIMULATED — camera inactive") rather than
            # silently freezing on stale values or blending real+fake data.
            self.fatigue_source = "simulated"

        if self.talkback:
            self.talkback["elapsed"] += 1

            if self.talkback["phase"] == "asked" and self.talkback["elapsed"] >= self.talkback["max_ticks"]:
                # No answer arrived within the response window. Escalate to the
                # beeping fallback. This is NOT a success: the challenge is not
                # resolved here and the fatigue score is not reset.
                self.talkback["phase"] = "beeping"

            if self.talkback["phase"] == "beeping":
                # Keep alarming until the driver is alert again (score < 5).
                if self.fatigue["score"] < 5:
                    msgs.append({"type": "talkback_done", "id": self.talkback["id"], "outcome": "no_answer", "correct": False, "ts": _ts()})
                    self.talkback = None
                else:
                    msgs.append({"type": "talkback", **self.talkback, "ts": _ts()})
            else:
                msgs.append({"type": "talkback", **self.talkback, "ts": _ts()})

        # NO real potholes, crashes, or ambulances are ever generated here.
        # Potholes come only from camera uploads (detections.py), crashes only
        # from device crash_candidate ingestion, and ambulances only from
        # browser siren detection. When the camera is inactive the fatigue
        # random walk below runs ONLY as an explicitly-labeled fallback.

        if not live_fatigue:
            if self.talkback is None:
                self._update_fatigue()
            elif self.talkback["phase"] == "beeping":
                # Simulated stand-in for the driver fighting to stay awake under
                # the alarm: recover steadily until alert again.
                self.fatigue["score"] = max(0.0, self.fatigue["score"] - 0.6)
                self.tier = "critical" if self.fatigue["score"] >= 8 else ("moderate" if self.fatigue["score"] >= 5 else "safe")

        # Talk-back challenges arm ONLY from real camera fatigue (score >= 8).
        # In simulated (camera-off) mode we never fabricate a cognitive
        # challenge — the driver isn't actually being watched.
        if not self.talkback and self.fatigue_source == "camera" and self.tier == "critical" and random.random() < 0.6:
            a = random.randint(6, 19)
            b = random.randint(3, 9)
            self.talkback = {
                "id": uuid.uuid4().hex[:8],
                "question": f"Quick! What is {a} minus {b}?",
                "answer": str(a - b),
                "elapsed": 0,
                "max_ticks": 6,
                "phase": "asked",
            }

        # A real siren that stops reporting for > 6 s auto-clears (the browser
        # also sends ambulance_clear explicitly; this is a safety net so a
        # disconnected client can't leave a stale CLEAR GUIDANCE active).
        if self.ambulance and time.time() - self._amb_last_at > 6.0:
            amb = self.ambulance
            self.ambulance = None
            self._amb_ticks = 0
            msgs.append({"type": "ambulance", **amb, "stage": "CLEARED", "ts": _ts()})

        if not live_fatigue:
            msgs.append({
                "type": "fatigue",
                "score": round(self.fatigue["score"], 1),
                "perclos": round(self.fatigue["perclos"], 3),
                "tier": self.tier,
                "source": self.fatigue_source,
                "face": self.fatigue.get("face", False),
                "nod": self.fatigue.get("nod"),
                "ts": _ts(),
            })
        return msgs
