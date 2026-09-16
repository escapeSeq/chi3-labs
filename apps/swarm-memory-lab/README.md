# Swarm Memory Lab

<img src="../../docs/screenshots/swarm.png" width="100%" alt="Swarm lab: pack hunting on a shared prey-scent map" />

Educational simulation of **shared memory in a drone swarm**, using the same
2-D Dubins gun fight as the dogfight lab. Hunters have a limited sense
radius. What they see they can write onto a decaying tactical map; the rest
of the pack reads that map. Hive mode trains one pack net on every hunter's
trajectory.

## Run with Docker Compose

From the monorepo root:

```bash
docker compose up --build
```

Then open [http://localhost:8080/swarm/](http://localhost:8080/swarm/).

Or from this directory:

```bash
docker compose up --build
```

Open [http://localhost:8083](http://localhost:8083).

```bash
python -m pip install -r requirements.txt
uvicorn app.main:app --host 0.0.0.0 --port 8083
```

## What it teaches

- A drone only sees inside its sense radius. Without a radio, far hunters are
  blind to the prey.
- The shared map is that radio: prey scent, danger, kill cells, and traffic.
  Scent decays, so stale reports fade.
- **Isolated** — private nets, map off. The control experiment.
- **Blackboard** — private nets, shared map. Coordination can start before
  weights agree.
- **Hive** — one pack net plus the map. A kill by drone 4 updates the brain
  drone 2 is flying.
- Swarm overlay assigns point / flank / cutter roles and mixes Reynolds
  separation into yaw. Coupling sliders turn that overlay up or down.

The field physics match dogfight: constant speed, yaw capped by
speed ÷ turn radius, gun welded to the nose. Default fight is one against
the pack.

Weights live on **`/data`**. On Railway, attach a volume at `/data` and set
`PORT=8083` as a service variable. The proxy reaches this lab at `/swarm/`.

## Tests

```bash
python -m pip install -r requirements-dev.txt
python -m pytest
```
