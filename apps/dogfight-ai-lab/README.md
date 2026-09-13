# Dogfight AI Lab

Educational simulation of **two empty policies** learning a 2-D gun fight
by trial and error. Each plane has a hard **turn radius** and can only
**shoot straight forward**.

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
- Both softmax policies start as random weights. After each sortie,
  REINFORCE keeps action sequences that lived longer or scored.

Flights run continuously in the browser: when a sortie ends the next one
starts automatically, and each one still updates the two policies. Use
**Train this burst** to fast-forward a chosen number of sorties (default
100, up to 1,000,000) before the live loop continues. Use **Sortie timeout**
to change how long a fight may last before it is scored a draw (2–60
seconds; default 12 s / 240 steps).

Both policies and the scoreboard are stored on **`/data`**
(`red.npz`, `blue.npz`, `academy.json`) so a container restart keeps the
brains. Reset statistics to zero the scoreboard and learning chart without
touching those weights. Wipe both brains to scramble the weights and rewrite
those files.

On Railway, do not put `VOLUME` in the Dockerfile. Attach a **Railway
Volume** to the service with mount path `/data` (Settings → Volumes).
The lab also honors `RAILWAY_VOLUME_MOUNT_PATH` if you mount elsewhere.

The scoreboard tracks kills and wall exits. Training progress is the
learning chart (life and return). Each brain has a **Graph** tab (the
wired net) and a **Numbers** tab (weights, heatmaps, probe mix). Reset
statistics zeros the scoreboard and chart without touching those
weights.

## Tests

```bash
python -m pip install -r requirements-dev.txt
python -m pytest
```
