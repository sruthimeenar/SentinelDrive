import asyncio
import json
import logging
import os

import asyncpg
import redis.asyncio as aioredis
from redis.exceptions import ResponseError

logger = logging.getLogger("sentinel.pipeline")

# Redis Streams is used here as a light-weight, locally-runnable stand-in for
# Kafka, keeping the same pub/sub-with-history semantics without needing a full
# Kafka + Zookeeper/KRaft deployment. The mapping to a real Kafka deployment:
#
#   stream key  "sentinel:events"        <->  Kafka topic
#   XADD (per publish)                    <->  producer.append() to a topic
#   XREADGROUP GROUP <g> CONSUMER <c>    <->  consumer group w/ committed offsets
#   XACK (after processing)               <->  committing an offset post-process
#   MAXLEN ~ retention                    <->  topic retention/cleanup policy
#   multiple consumers on the group       <->  partition-based scale-out
#
# To move to real Kafka, replace this module with aiokafka's
# AIOKafkaProducer / AIOKafkaConsumer (topic = STREAM_KEY, a JSON serializer,
# enable.auto.commit=False + commit after Postgres write). main.py's call
# sites (pipeline.publish / pipeline.consume_loop) stay unchanged.
STREAM_KEY = os.getenv("SENTINEL_STREAM", "sentinel:events")
GROUP_NAME = os.getenv("SENTINEL_GROUP", "sentinel-broadcaster")


class TelemetryPipeline:
    """Producer/consumer for the telemetry stream plus PostGIS persistence.

    Every telemetry event produced by the simulator is XADD'ed to the Redis
    stream. A single consumer group then reads it back and, per event:
      (a) broadcasts it to every connected WebSocket client, and
      (b) upserts pothole/crash events into Postgres/PostGIS.

    If Redis or Postgres is unreachable at startup we degrade gracefully:
    events buffer in an in-process asyncio.Queue (order preserved) and the
    REST endpoints fall back to the simulator's in-memory lists, so the demo
    still runs without Docker. Once infra is up, persistence and SQL
    queryability are live.
    """

    def __init__(self):
        self.redis_url = os.getenv("REDIS_URL", "redis://localhost:6379/0")
        self.database_url = os.getenv(
            "DATABASE_URL", "postgresql://sentinel:sentinel@localhost:5432/sentinel"
        )
        self.redis = None
        self.pg = None
        self.redis_ok = False
        self.pg_ok = False
        self._fallback_queue = asyncio.Queue()

    async def connect(self):
        try:
            self.redis = aioredis.from_url(self.redis_url, decode_responses=True)
            await self.redis.ping()
            self.redis_ok = True
            try:
                # "$" => this group only receives messages published after it
                # is created; older entries stay in the stream for replay by
                # fresh consumer groups (Kafka offset semantics).
                await self.redis.xgroup_create(STREAM_KEY, GROUP_NAME, id="$", mkstream=True)
            except ResponseError as exc:
                if "BUSYGROUP" not in str(exc):
                    raise
            logger.info("Redis Streams connected: %s (group=%s)", self.redis_url, GROUP_NAME)
        except Exception as exc:
            self.redis_ok = False
            self.redis = None
            logger.warning("Redis unavailable (%s); falling back to in-process queue", exc)

        try:
            self.pg = await asyncpg.connect(self.database_url)
            self.pg_ok = True
            await self._init_schema()
            logger.info("PostGIS connected: %s", self.database_url)
        except Exception as exc:
            self.pg_ok = False
            self.pg = None
            logger.warning("Postgres unavailable (%s); persistence disabled", exc)
        return self

    async def close(self):
        if self.redis:
            await self.redis.aclose()
        if self.pg:
            await self.pg.close()

    async def publish(self, event):
        """Produce one event onto the stream (or the fallback queue)."""
        if self.redis_ok and self.redis:
            await self.redis.xadd(
                STREAM_KEY, {"ev": json.dumps(event)}, maxlen=2000, approximate=True
            )
        else:
            await self._fallback_queue.put(event)

    async def consume_loop(self, clients, broadcast_fn):
        """Consume events and fan them out: WebSocket broadcast + persistence."""
        while True:
            if self.redis_ok and self.redis:
                try:
                    results = await self.redis.xreadgroup(
                        groupname=GROUP_NAME,
                        consumername="local-1",
                        streams={STREAM_KEY: ">"},
                        count=50,
                        block=300,
                    )
                    if not results:
                        continue
                    for _, messages in results:
                        for msg_id, fields in messages:
                            event = json.loads(fields["ev"])
                            await broadcast_fn(clients, event)
                            await self.store(event)
                            await self.redis.xack(STREAM_KEY, GROUP_NAME, msg_id)
                    continue
                except Exception as exc:
                    logger.warning("stream read failed: %s", exc)
                    await asyncio.sleep(0.5)
                    continue

            # Fallback: drain the in-process queue.
            try:
                event = await asyncio.wait_for(self._fallback_queue.get(), timeout=0.3)
            except asyncio.TimeoutError:
                continue
            await broadcast_fn(clients, event)
            await self.store(event)

    async def store(self, event):
        """Persist pothole/crash events to PostGIS (idempotent by primary key)."""
        if not self.pg_ok or not self.pg:
            return
        mtype = event.get("type")
        if mtype == "pothole":
            await self.pg.execute(
                """
                INSERT INTO potholes
                    (id, geometry, lat, lng, area, depth, volume, material, cost,
                     breakdown, status, ts, detection_source, volume_estimated,
                     gps_source, bbox, accuracy)
                VALUES
                    ($1, ST_SetSRID(ST_MakePoint($2::double precision, $3::double precision), 4326), $3,
                     $2, $4::double precision, $5::double precision, $6::double precision,
                     $7, $8::double precision, $9::jsonb, $10, $11,
                     $12, $13, $14, $15::jsonb, $16::jsonb)
                ON CONFLICT (id) DO NOTHING
                """,
                event["id"],
                event["lng"],
                event["lat"],
                event["area"],
                event["depth"],
                event["volume"],
                event["material"],
                event["cost"],
                json.dumps(event.get("breakdown") or {}),
                event["status"],
                event["ts"],
                event.get("detection_source", "simulated"),
                bool(event.get("volume_estimated", True)),
                event.get("gps_source", "unknown"),
                json.dumps(event.get("bbox")) if event.get("bbox") else None,
                json.dumps(event.get("accuracy")) if event.get("accuracy") else None,
            )
        elif mtype == "crash":
            await self.pg.execute(
                """
                INSERT INTO crashes (id, verified, g_force, db, frame_crunch, guidance, ts,
                                     detection_source, verification)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
                ON CONFLICT (id) DO NOTHING
                """,
                event["id"],
                event["verified"],
                event["gForce"],
                event.get("db"),
                event["frameCrunch"],
                event.get("guidance"),
                event["ts"],
                event.get("detection_source", "simulated"),
                json.dumps(event.get("verification")) if event.get("verification") else None,
            )
        elif mtype == "talkback_done":
            # Voice-guidance sessions (question, spoken transcript, optional
            # audio capture) for later review/debugging.
            await self.pg.execute(
                """
                INSERT INTO talkbacks (id, question, expected_answer, parsed_answer,
                                       transcript, audio, transcription, correct, outcome, ts)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
                ON CONFLICT (id) DO NOTHING
                """,
                event["id"],
                event.get("question"),
                event.get("expectedAnswer"),
                event.get("parsedAnswer"),
                event.get("transcript"),
                event.get("audio"),
                event.get("transcription", "speech"),
                bool(event.get("correct", False)),
                event.get("outcome"),
                event["ts"],
            )

    async def list_potholes(self, limit=50):
        """Query persisted potholes with geometry read back as lat/lng."""
        if not self.pg_ok or not self.pg:
            return None
        rows = await self.pg.fetch(
            """
            SELECT id, ST_Y(geometry) AS lat, ST_X(geometry) AS lng,
                   area, depth, volume, material, cost, breakdown, status, ts,
                   detection_source, volume_estimated, gps_source, bbox, accuracy
            FROM potholes
            ORDER BY ts DESC, id DESC
            LIMIT $1
            """,
            limit,
        )
        out = []
        for r in rows:
            d = dict(r)
            d["type"] = "pothole"
            d["breakdown"] = json.loads(d["breakdown"]) if d["breakdown"] else {}
            d["bbox"] = json.loads(d["bbox"]) if d["bbox"] else None
            d["accuracy"] = json.loads(d["accuracy"]) if d["accuracy"] else None
            out.append(d)
        return out

    async def list_crashes(self, limit=50):
        if not self.pg_ok or not self.pg:
            return None
        rows = await self.pg.fetch(
            """
            SELECT id, verified, g_force, db, frame_crunch, guidance, ts,
                   detection_source, verification
            FROM crashes
            ORDER BY ts DESC, id DESC
            LIMIT $1
            """,
            limit,
        )
        out = []
        for r in rows:
            d = dict(r)
            d["type"] = "crash"
            d["gForce"] = d.pop("g_force")
            d["frameCrunch"] = d.pop("frame_crunch")
            d["verification"] = json.loads(d["verification"]) if d["verification"] else None
            out.append(d)
        return out

    async def list_talkbacks(self, limit=20):
        if not self.pg_ok or not self.pg:
            return None
        rows = await self.pg.fetch(
            """
            SELECT id, question, expected_answer, parsed_answer, transcript,
                   transcription, correct, outcome, ts
            FROM talkbacks
            ORDER BY ts DESC, id DESC
            LIMIT $1
            """,
            limit,
        )
        out = []
        for r in rows:
            d = dict(r)
            d["type"] = "talkback_done"
            d["expectedAnswer"] = d.pop("expected_answer")
            d["parsedAnswer"] = d.pop("parsed_answer")
            out.append(d)
        return out

    async def _init_schema(self):
        await self.pg.execute("CREATE EXTENSION IF NOT EXISTS postgis")
        await self.pg.execute(
            """
            CREATE TABLE IF NOT EXISTS potholes (
                id text PRIMARY KEY,
                geometry geometry(Point, 4326),
                lat double precision,
                lng double precision,
                area double precision,
                depth double precision,
                volume double precision,
                material text,
                cost double precision,
                breakdown jsonb,
                status text,
                ts bigint,
                detection_source text,
                volume_estimated boolean,
                gps_source text,
                bbox jsonb,
                accuracy jsonb
            )
            """
        )
        # Migration for databases created before the detection fields existed.
        for column, decl in [
            ("detection_source", "text"),
            ("volume_estimated", "boolean"),
            ("gps_source", "text"),
            ("bbox", "jsonb"),
            ("accuracy", "jsonb"),
        ]:
            await self.pg.execute(
                f"ALTER TABLE potholes ADD COLUMN IF NOT EXISTS {column} {decl}"
            )
        await self.pg.execute(
            """
            CREATE TABLE IF NOT EXISTS crashes (
                id text PRIMARY KEY,
                verified boolean,
                g_force double precision,
                db integer,
                frame_crunch boolean,
                guidance text,
                ts bigint,
                detection_source text,
                verification jsonb
            )
            """
        )
        for column, decl in [
            ("detection_source", "text"),
            ("verification", "jsonb"),
        ]:
            await self.pg.execute(
                f"ALTER TABLE crashes ADD COLUMN IF NOT EXISTS {column} {decl}"
            )
        await self.pg.execute(
            """
            CREATE TABLE IF NOT EXISTS talkbacks (
                id text PRIMARY KEY,
                question text,
                expected_answer integer,
                parsed_answer integer,
                transcript text,
                audio text,
                transcription text,
                correct boolean,
                outcome text,
                ts bigint
            )
            """
        )
        await self.pg.execute("CREATE INDEX IF NOT EXISTS idx_talkbacks_ts ON talkbacks (ts)")
        await self.pg.execute(
            "CREATE INDEX IF NOT EXISTS idx_potholes_geom ON potholes USING GIST (geometry)"
        )
        await self.pg.execute("CREATE INDEX IF NOT EXISTS idx_potholes_ts ON potholes (ts)")
        await self.pg.execute("CREATE INDEX IF NOT EXISTS idx_crashes_ts ON crashes (ts)")
