# Dogfight AI Lab

Educational simulation of empty policies learning a 2-D **last-plane-standing**
gun fight by trial and error. Each plane has a hard **turn radius** and can
only **shoot straight forward**. Every other living plane is a target.

## Run with Docker Compose

From the monorepo root:

```bash
docker compose up --build
```

Then open [http://localhost:8082](http://localhost:8082).

Or from this directory:

```bash
docker compose up --build
```

## Run without Docker

```bash
python -m pip install -r requirements.txt
uvicorn app.main:app --host 0.0.0.0 --port 8082
```

## What it teaches

- A Dubins / constant-speed plane cannot change heading faster than
  speed ÷ turn radius. The dashed circles on the plot are the only legal
  paths.
- The gun is welded to the nose. Kills are geometry, not turrets.
- Each seat starts with its own softmax net. Share a brain only when you
  want identical tactics. If one copy should learn and another should stay
  put, **revise**: the child starts from the parent's weights and keeps
  training.
- A sortie ends when one aircraft remains, or the timeout scores a draw.

Flights run continuously in the browser. Use **Train this burst** to
fast-forward sorties (default 100, up to 1,000,000). Use **Sortie timeout**
for the draw clock (10–600 s). Use **Planes in the fight** for 2–9 aircraft;
new seats get a fresh brain. The **Hangar** assigns brains to planes. The
**Brain library** creates, revises, freezes, wipes, and deletes nets.

Policies, revisions, hangar seats, and the scoreboard are stored on
**`/data`** (`p1.npz`, `p2.npz`, …, `academy.json`). Reset statistics to
zero wins and the learning chart without touching weights. Wipe all brains
to scramble weights and keep names and seats.

On Railway:

- Set the service **Root Directory** to `apps/dogfight-ai-lab` (the folder
  with `Dockerfile` and `requirements.txt`, not the inner `app/` package).
- Leave the start command empty so the Dockerfile/`Procfile` can run
  uvicorn on `$PORT`.
- Do not put `VOLUME` in the Dockerfile. Attach a **Railway Volume** with
  mount path `/data` — never `/app` or `/lab`, or the volume will hide the
  installed code and you will see `ModuleNotFoundError: numpy`.
- The lab also honors `RAILWAY_VOLUME_MOUNT_PATH` if you mount elsewhere.

## Tests

```bash
python -m pip install -r requirements-dev.txt
python -m pytest
```
