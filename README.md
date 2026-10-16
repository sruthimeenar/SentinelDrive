# SentinelDrive

Next-Gen AI & Telematics Ecosystem for Proactive Road Safety, Active Collision Mitigation & Municipal Dispatch.

Interactive demo dashboard for the SentinelDrive MVP: live fatigue (PERCLOS +
head-pose) telemetry with Cognitive Talk-Back, multimodal crash verification,
audio-siren emergency clearance, and a municipal PWD pothole dispatch portal.
All events are real (webcam, accelerometer, microphone, camera uploads); the
only simulation left is an explicitly-labeled fatigue fallback for when the
camera is genuinely off.

## Architecture

```
frontend (React + Vite + Recharts)
        │  /ws   WebSocket telemetry (live stream)
        │  /api  REST (potholes, crashes, status)
        ▼
backend (FastAPI)
        │  SentinelSimulator → Edge CV (PERCLOS + volumetric pothole depth)
        │                     → Kafka-style telemetry events
        │                     → B2G PWD dispatch payloads
```

| Pitch component | Demo mapping |
| --- | --- |
| Working Edge CV | FatiguePanel (PERCLOS/fatigue tiers), pothole volume/cost engine |
| Kafka Telemetry Pipeline | WebSocket live feed (`TelemetryFeed` raw stream) |
| Municipal PWD Portal | `PotholePortal` with GPS, volumetric data, PMB spec, itemized cost |
| Cognitive Talk-Back | `TalkBackCard` — interactive vocal challenge at fatigue >= 8 |
| Multimodal Crash Engine | `CrashFeed` — acoustic + CV verification (G-force, dB, frame crunch) |
| Active Clear Guidance | `AmbulanceCard` — voice co-pilot + green-wave corridor |

## Quickstart

Backend (port 8000):

```
cd backend
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000
```

Frontend (port 5173):

```
cd frontend
npm install
npm run dev
```

Open http://localhost:5173 — Vite proxies `/api` and `/ws` to the backend.

## Real implementation status (phased)

### Phase 1 — Real Edge CV: Driver Fatigue (PERCLOS) ✅

The fake fatigue random walk is replaced by real webcam-based PERCLOS.

- **Detection:** MediaPipe Face Landmarker (`@mediapipe/tasks-vision@0.10.35`) runs
  fully in the browser (WASM bundled under `frontend/public/wasm/`, model at
  `frontend/public/models/face_landmarker.task` — no frames ever leave the device).
- **Metric:** Eye-Aspect-Ratio (EAR) computed per frame from the standard 6-point
  eye keypoints; EAR < 0.18 counts as "closed"; PERCLOS = closed frames over the
  last 60s (standard P80-style definition).
- **Head-pose corroboration:** the Face Landmarker also emits the face-geometry
  rotation matrix (`outputFaceGeometryMatrixes`); a sustained head droop is
  detected two independent ways — the nose-chin/eye-landmark droop ratio and the
  matrix pitch angle (positive = tilted down) — and adds a "Head droop" metric +
  a nod contribution to the score. Sustained closure (>1.5s) and sustained droop
  (>1.5s) stack onto the PERCLOS baseline (score = PERCLOS×25 + closure bonus,
  or the nod score, whichever is higher; clamped at 10).
- **Score curve:** `score = min(10, PERCLOS × 25)` → 0.00→0 (alert), 0.08→2,
  0.20→5 (moderate tier), 0.32→8 (critical tier, arms talk-back), 0.40+→10.
- **Flow:** the browser streams `{type:"fatigue", score, perclos, tier, source,
  face, nod, ts}` over the existing WebSocket (nod carries the live
  pitch/droop evidence); the backend relays it to all clients (single source of
  truth, so talk-back arming and future logging use the real signal) and stops
  its own random walk while camera data keeps arriving (~1 msg/s). The backend
  keeps using real camera data even when no face is in frame (the stream stays
  alive, `face:false`), and only reverts to the random walk when the camera is
  genuinely off/denied and stops reporting for 3s — every fallback event is
  tagged `source:"simulated"` and labeled **"SIMULATED — CAMERA INACTIVE"** in
  the UI. Talk-back challenges arm ONLY from real camera fatigue (never from
  the simulated walk).

Known caveats: the 0.18 EAR threshold and score curve are generic and may need
recalibration for your face, glasses, and lighting; the 60s window means the
score lags sustained eye closure by design (hold eyes closed ~15–20s to reach
"critical"). Tested with Chrome/Edge — other browsers may differ.

### Phase 2 — Real Telemetry Pipeline (Redis Streams + PostGIS) ✅

The in-process asyncio broadcast loop is replaced by a real message pipeline with
durable, geospatially-queryable storage.

- **Transport:** Redis Streams (`app/pipeline.py`) as a light-weight Kafka
  stand-in — same pub/sub-with-history semantics, runs locally in Docker. The
  module documents the exact mapping (stream ↔ topic, consumer group ↔ consumer
  group offsets, `XACK` ↔ commit, `MAXLEN` ↔ retention) so swapping in aiokafka
  later only touches that one file.
- **Flow:** every simulator event is `XADD`ed to the `sentinel:events` stream;
  a consumer task reads it back and (a) broadcasts to connected WebSocket
  clients and (b) persists `pothole`/`crash` events to Postgres/PostGIS.
- **Storage:** Postgres + PostGIS. `potholes` stores a real `geometry(Point,4326)`
  column (via `ST_SetSRID(ST_MakePoint(lng, lat), 4326)`) plus the volumetric
  survey, PMB material spec, and itemized cost as `jsonb`; `crashes` store the
  multimodal verification sensors. A GiST index backs spatial queries.
- **Queryability:** `GET /api/potholes` and `GET /api/crashes` now read from
  Postgres (they fall back to the simulator's in-memory lists only if the DB is
  unreachable). Data survives a backend restart — `docker compose up`, let a few
  events stream, restart the backend, and the dispatched potholes/crashes
  reappear (frontend rehydrates them on reconnect).
- **Graceful degradation:** if Redis/Postgres are down at startup, the backend
  logs a warning and runs in-process (queue-backed broadcast, in-memory REST),
  so the demo still works without Docker. `/api/status` reports
  `pipeline: {redis, postgres}` health.

Run the full pipeline:

```
docker compose up -d          # Redis + Postgres/PostGIS (root of the repo)
cd backend && uvicorn app.main:app --reload --port 8000
cd frontend && npm run dev    # as before
```

Connectivity is configured via `REDIS_URL` and `DATABASE_URL` (see
`backend/.env.example`; defaults match docker-compose).

### Phase 3 — Real Pothole Detection (upload → dispatch) ✅

The random pothole generator is no longer the only source: uploading a dashcam
image or clip now produces a real bounding box, an **estimated** volume, and a
dispatched cost entry in the PWD Portal.

- **Upload:** `POST /api/detections/upload` (multipart `file` + optional
  `lat`/`lng`/`gps_source`). Images are processed whole; videos are sampled at
  ~1.5 s intervals (max 8 frames) and the best-confidence detection per frame is
  dispatched. The annotated best frame is returned as a base64 JPEG preview.
- **Detector tiers** (`app/vision/detector.py`):
  - `yolo` — Ultralytics YOLO (YOLO11) when weights exist at
    `backend/models/pothole_yolo.pt` (override with `POTHOLES_YOLO_WEIGHTS`).
    See "Fine-tuning" below.
  - `cv-fallback` — pure OpenCV: multi-scale BlackHat (dark-structure) response
    ANDed with an HSV dark/desaturated mask, horizon dead-zone, morphology, and
    shape/fill filters. This runs with zero ML dependencies.
- **Depth honesty:** true volumetric depth requires stereo vision or LiDAR. We
  use a **monocular estimate** and say so: the volume is labeled `EST` in the
  UI, the API carries `volume_estimated: true`, and every detection includes an
  `accuracy` block:
  ```json
  "accuracy": {
    "mode": "monocular-estimated",
    "reference": "painted-lane-line",        // or "assumed-camera-model"
    "depth_signal": "brightness-contrast",   // or "depth-map" when MiDaS runs
    "upgrade_path": "stereo-vision-or-LiDAR"
  }
  ```
  - **Depth tiers:** `midas` (MiDaS DPT-Large via `torch.hub`, for the `ml`
    extra) → monocular depth-map contrast; otherwise a pinhole camera model
    (horizon 35%, FOV 55°, mount height 1.30 m) with brightness contrast.
  - **Known-size reference:** a painted lane line (0.125 m) crossing the
    pothole row calibrates meters-per-pixel; without one, the assumed camera
    model is used (and reported).
- **Cost:** unchanged formula — `Cost = Volume × Price_PMB + Labor + Sealing`
  (`PMB-25`, $185/m³, $42 labor, $18 sealing) in `app/vision/geometry.py`.
- **GPS:** browser Geolocation API (button in the portal) → else image EXIF
  (`image-exif`) → else `unknown`. Each pothole carries `gps_source`.
- **Pipeline:** every detection is published as a `pothole` event, so it fans
  out over WebSocket and persists to PostGIS with `detection_source`,
  `volume_estimated`, `gps_source`, `bbox`, and `accuracy` columns.
- **No synthetic backfill:** the simulator NEVER fabricates potholes. Every
  pothole in the portal comes from a real camera upload (`detection_source:
  "cv-fallback"` or `"yolo"`). `GET /api/potholes` returns persisted PostGIS
  rows, or the in-memory list of real uploads when the DB is down.

#### YOLO fine-tuning (optional, better accuracy)

```
pip install ".[ml]"                          # torch, torchvision, ultralytics
# 1. Export a pothole dataset (e.g. a Roboflow pothole set) as YOLOv11 format.
# 2. Train, then copy the best weights:
python -m ultralytics.train data=dataset.yaml model=yolo11n.pt epochs=50 imgsz=640
# weights run from backend/models/pothole_yolo.pt (POTHOLES_YOLO_WEIGHTS)
```

### Phase 4 — Real Crash Detection (DeviceMotion → multimodal verification) ✅

The simulated crash generator is no longer the only source: the browser's
accelerometer reports real impacts and the backend verifies them across
multiple modalities before dispatch.

- **Client** (`useCrashDetector.js`): listens to `devicemotion`, computes the
  instantaneous g-force from `accelerationIncludingGravity`, keeps a ~600 ms
  rolling peak, and reports a `crash_candidate` when the peak crosses ~2.5 g
  (debounced 8 s). It attaches the last known GPS position + speed (geolocation
  `watchPosition`, `coords.speed`) and the current camera fatigue score/tier as
  distraction evidence. iOS needs `DeviceMotionEvent.requestPermission()`.
- **Verification** (`simulator.py` `_verify_crash`): honest multimodal gating —
  the g-force spike is real device data; the corroborating layers are labeled
  with their actual source:
  - `gForce ≥ 4 g` is a candidate; `gForce ≥ 8 g` is **decisive** on its own.
  - `GPS` corroborates when the speed dropped ≥ 20 km/h between samples
    (`device` when the browser provided GPS, else `not-captured`).
  - `Camera` corroborates when the camera pipeline was live and the fatigue
    score ≥ 5 at impact (`camera`, else `simulated`/`not-captured`).
  - `verified = decisive OR (gForce ≥ 4 AND (GPS OR camera agree))`.
- **Honesty:** every device crash carries a `verification` block —
  ```json
  {
    "mode": "device-multimodal",
    "sensors": {
      "gForce": {"value": 9.2, "source": "device", "agree": true},
      "gps": {"speed_delta_kmh": 46.0, "source": "device", "agree": true},
      "camera": {"fatigue_score": 7.2, "source": "camera", "agree": true}
    },
    "rule": "gForce >= 4g AND (GPS speed-drop >= 20 km/h OR camera distraction); gForce >= 8g is decisive",
    "upgrade_path": "dedicated-IMU-and-audio"
  }
  ```
  No acoustic sensor is captured yet, so `db` is `null` for device events (the
  UI renders `—`) and real microphone/IMU access is flagged as the upgrade path.
- **Flow:** `crash_candidate` → WS → `sim.ingest` → verified `crash` event
  (`detection_source: "device"`) → published → broadcast to the portal + stored
  in PostGIS (`crashes` gains `detection_source` and `verification jsonb`).
- **No synthetic crashes:** the simulator NEVER fabricates crash events. Only a
  real device `crash_candidate` can produce a crash row, so the feed is
  real-impacts only (see `test_crash_detection.py` E: 4000 ticks, zero crashes).

### Phase 5 — Real Voice Guidance (spoken two-way talk-back + spoken guidance) ✅

The challenge is now fully spoken, not just displayed, and the driver's spoken
answer is transcribed, shown on screen, and stored for review.

- **Question spoken aloud:** when a challenge arms (fatigue ≥ 8) the browser's
  `SpeechSynthesis` actually says the question ("Quick! What is 12 minus 5?");
  the card shows a "SPEAKING QUESTION ALOUD…" state. Answer capture is armed
  only after the TTS finishes (or 3 s), so the echoed question can never be
  mistaken for an answer.
- **Transcribe + record:** `SpeechRecognition` (Chrome/Edge) transcribes the
  driver's reply live; the transcript is shown on screen ("Heard: …"). The mic
  is also captured with `MediaRecorder` (best-effort, ≤ 300 KB, capped at 8 s)
  and sent as base64 so the spoken audio can be replayed/reviewed.
- **Verify:** the parsed number (handles spoken variations — "seven" vs "7",
  "forty two" → 42, "minus three" → −3 — via `parseSpokenNumber`) is sent as
  `talkback_answer {answer, transcript, audio, transcription}`; the backend
  compares it against the expected value and resolves.
- **Confirm out loud:** a correct answer makes the system say "Congratulations!"
  before the challenge clears (existing behavior, now with transcript/audio
  attached to the resolved event).
- **Fallbacks preserved:** wrong answer → pulse + re-prompt (with the heard
  transcript echoed on `talkback_retry`); nothing heard → the 2000–4000 Hz
  beeping alarm until alert. Browsers without `SpeechRecognition` get a typed
  manual input labeled `transcription: "manual"`; a server-side Whisper endpoint
  can be dropped in later (audio is already captured).
- **Spoken ambulance guidance:** `useSpokenGuidance` speaks each new
  emergency-vehicle "move aside" instruction aloud ("Attention. …") via the same
  SpeechSynthesis path.
- **Persistence:** resolved sessions are stored in a new `talkbacks` table
  (`question`, `expected_answer`, `parsed_answer`, `transcript`, `audio`,
  `transcription`, `correct`, `outcome`, `ts`) and exposed at
  `GET /api/talkbacks` for review/debugging.

### Phase 6 — On-Device Privacy Redaction (blur before upload) ✅

Faces and license plates are redacted **in the browser** before any frame
leaves the device, so the backend only ever receives already-blurred pixels.

- **On-device detectors** (`frontend/src/lib/redact.js`): faces via MediaPipe
  `FaceDetector` (wasm, `blaze_face_short_range`, GPU → CPU fallback) using the
  same `/wasm` + `/models` assets already shipped; license plates via a
  heuristic matcher (character-sized, low-saturation, high-contrast
  components grouped into a horizontal text line). Plate matcher + pixelation
  are pure functions unit-tested in Node (`frontend/tests/test_redaction.mjs`).
- **Pixelation is fail-closed and two-pass:** regions are replaced with
  mean-color blocks at two grid offsets so no character-scale cell survives
  regardless of block alignment. If the face detector cannot load, uploads are
  **blocked** rather than sending an unredacted frame.
- **Inline in the capture pipeline:** `PotholeUpload` runs the redaction before
  appending to `FormData`; only the redacted JPEG (or re-encoded WebM clip,
  frames sampled client-side) is sent. The report (`faces`, `plates`,
  `pixels`) is attached as a `redaction` form field and echoed by the backend
  on the response and on each published event, shown as a
  `PRIVACY REDACTED · nF nP` pill.
- **Verified end-to-end in a real browser** (headless Edge via puppeteer-core,
  see `e2e_privacy.mjs` in the Phase 6 report): a real photo's face is detected
  and its pixels changed; a synthetic plate's characters are destroyed; and a
  pothole frame with a visible plate **arrives at the backend already blurred**
  (the backend's annotated preview shows the plate region flat) while the
  pothole is still detected and dispatched.

### Phase 7 — Municipal PWD Portal / B2G API (dispatch + PDF invoices) ✅

Every detected pothole is auto-assigned to a municipality, dispatched to the
city's Public Works department, and gets a downloadable PDF invoice — turning
the detection feed into a business-to-government repair pipeline.

- **B2G dispatch API** (`backend/app/dispatch.py`): `POST /api/dispatch`
  (X-API-Key protected — env `SENTINEL_API_KEY`, default `sentinel-demo-key`,
  accepted as `Authorization: Bearer <key>` or a raw header), `GET
  /api/dispatches` (list all), and `GET /api/dispatch/{pothole_id}/invoice`
  (download the PDF). Dispatches are idempotent (same pothole id re-returns the
  existing record) and an invoice is generated and cached in-memory on first
  request.
- **Auto-dispatch on every detection:** every camera upload flows into
  `create_dispatch()`, so a pothole never sits unassigned. A municipality is
  derived deterministically from GPS via `assign_municipality()` (8 Pittsburgh
  districts, MD5-hash of the coordinates — reproducible, no external geocoder
  needed); without GPS it defaults to a Pittsburgh district rather than failing.
- **PDF invoice** (`reportlab`): each invoice includes the invoice header
  (number, date, municipality), GPS coordinates, a volumetric survey (area,
  depth, volume), the PMB material spec, and an itemized cost breakdown
  (material V×PMB + labor + sealing) with the total. Generated server-side and
  streamed with `application/pdf`.
- **Frontend dispatch portal** (`PotholePortal`): a per-municipality summary
  table (pothole count, total volume, total cost, DISPATCHED status) plus a
  `DOWNLOAD INVOICE PDF` button on every pothole row (also shown per detection
  in the upload result). Downloads the invoice directly from the running API.
- **Tested:** `backend/tests/test_dispatch.py` covers 401 (no auth), 403 (wrong
  key), valid dispatch, idempotency, PDF bytes + `%PDF-` header, 404 for
  missing invoices, auto-municipality assignment, and the auto-dispatch on
  upload path. Frontend verified in a real browser via
  `frontend/tests/e2e_dispatch.mjs` (real image upload → municipality table +
  invoice button render, detail panel shows municipality + real CV detection).

### Phase 8 — Real-Data Only (fake data removed) ✅

All fabricated event generators are gone. Every feed now shows genuinely
detected events, each labeled with its real source; the only remaining
simulation is an explicitly-labeled fatigue fallback for when the camera is
genuinely off.

- **Potholes — real uploads only.** The simulator no longer emits potholes.
  The PWD portal populates only from `POST /api/detections/upload`
  (`detection_source: "cv-fallback"`/`"yolo"`). Empty portal at startup;
  rehydrated from PostGIS (or the in-memory real-upload list) on reconnect.
- **Crashes — device impacts only.** The simulated crash generator is removed.
  A crash row exists only when the browser accelerometer sends a
  `crash_candidate` (`detection_source: "device"`). The crash feed's empty
  state says so.
- **Ambulance — real siren detection.** `frontend/src/lib/siren.js` +
  `useSirenDetector.js` analyze the live microphone with Web Audio: a
  narrowband dominant tone (peak towers ≥18 dB over the band average in the
  400–1800 Hz band) whose dominant frequency swings ≥250 Hz repeatedly
  (two-tone/wail pattern) for ≥1.4 s within a 2.2 s window arms an emergency
  vehicle. The browser sends `ambulance_candidate {freq_hz, score}` (and
  `ambulance_clear`); the backend creates an `APPROACHING → GUIDING → CLEARED`
  event tagged `detection_source: "audio-siren"` with the dominant tone Hz and
  match score shown on the card, and auto-clears after 6 s of silence. A steady
  tone (horn) or broadband traffic noise does NOT arm it.
- **Fatigue — real camera + head pose, honest fallback.** Fatigue is PERCLOS
  (EAR < 0.18 over 60 s) + head droop (nose-chin landmark ratio and face-matrix
  pitch), streamed from the live camera. The backend keeps the camera
  authoritative while reports flow and labels every fallback event
  `source: "simulated"` / **"SIMULATED — CAMERA INACTIVE"** with
  `face: false`, `nod: null` when the camera is off. Talk-back only arms from
  real camera fatigue.
- **Labels everywhere.** Fatigue panel: REAL PERCLOS + HEAD POSE vs SIMULATED;
  ambulance card: SOURCE: AUDIO SIREN + dominant tone; crash feed: DEVICE badge
  only; telemetry feed shows each event's source; portal empty state notes no
  synthetic backfill.
- **Tests:** `backend/tests/test_real_pipelines.py` (no fake potholes/crashes/
  ambulances across ticks, siren → ambulance lifecycle + clear/auto-clear,
  camera-authoritative fatigue, labeled fallback, nod/face relay);
  `frontend/tests/test_fatigue.mjs` (21 checks: EAR/PERCLOS/head-droop/pitch/
  scoring); `frontend/tests/test_siren.mjs` (14 checks: narrowband peak, tonal
  alternation vs steady horn vs broadband noise, sustained-window gating);
  `e2e_dispatch.mjs` now drives a REAL image upload end-to-end.

## API

- `GET /api/potholes` — dispatched pothole payloads (GPS, volume, PMB, itemized cost, detection source/accuracy, municipality), from PostGIS
- `GET /api/crashes` — recent verified/suppressed crash events (device/simulated, verification block), from PostGIS
- `POST /api/detections/upload` — upload a dashcam image/clip → real bounding box + estimated volume + dispatched cost (see Phase 3); optional `redaction` field carries the client's on-device privacy report
- `GET /api/talkbacks` — resolved voice-guidance sessions (transcript, audio, outcome) for review
- `POST /api/dispatch` — create a dispatch (X-API-Key: `SENTINEL_API_KEY`); auto-assigns municipality from GPS, generates the invoice
- `GET /api/dispatches` — list all dispatches (id, pothole, municipality, status, total cost)
- `GET /api/dispatch/{pothole_id}/invoice` — download the PDF repair invoice for a dispatched pothole
- `GET /api/status` — current fatigue state + active talk-back challenge + pipeline health
- `WS /ws` — live telemetry stream. Message types: `fatigue` (with `source`/`face`/`nod`), `talkback`, `talkback_done`, `crash`, `ambulance` (with `detection_source: "audio-siren"`), `pothole`. Inbound: `fatigue`, `talkback_answer`, `crash_candidate`, `ambulance_candidate`, `ambulance_clear`
>>>>>>> 87bec44 (Initial Commit)
