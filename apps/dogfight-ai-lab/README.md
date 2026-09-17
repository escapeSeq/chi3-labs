# Dogfight AI Lab

<img src="../../docs/screenshots/dogfight.png" width="100%" alt="Dogfight lab: last-plane-standing arena and flight controls" />

Educational simulation of empty policies learning a 2-D **last-plane-standing**
gun fight by trial and error. Each plane has a hard **turn radius** and can
only **shoot straight forward**. Every other living plane is a target.

## Run with Docker Compose

From the monorepo root:

```bash
docker compose up --build
```

Then open [http://localhost:8080/dogfight/](http://localhost:8080/dogfight/).

Or from this directory:

```bash
docker compose up --build
```

Open [http://localhost:8082](http://localhost:8082).

```bash
python -m pip install -r requirements.txt
uvicorn app.main:app --host 0.0.0.0 --port 8082
```

## What it teaches

- A Dubins / constant-speed plane cannot change heading faster than
  speed ÷ turn radius. The dashed circles on the plot are the only legal
  paths. Net yaw of a full circle is a crash, same as the wall.
- The gun is welded to the nose. Kills are geometry, not turrets.
- Each seat starts with its own softmax net. Share a brain only when you
  want identical tactics. If one copy should learn and another should stay
  put, **revise**: the child starts from the parent's weights and keeps
  training.
- A sortie ends when one aircraft remains. A timeout with more than one
  plane still up is a draw, scored as a loss and a failure. A full circle
  is a crash.

Flights run continuously in the browser. Use **Train this burst** to
fast-forward sorties (default 100, up to 1,000,000). Use **Sortie timeout**
for the clock (10–600 s); a timeout with more than one plane still flying
is a loss. Use **Planes in the fight** for 2–9 aircraft;
new seats get a fresh brain. The **Hangar** lists those active nets with
sortable wins, kills, walls, and updates. The **Brain library** starts
entries stay until you delete them. Putting a library brain on a plane
copies it; the stored snapshot does not change. Swapping a working copy
discards that copy and does not write into the library.

Policies, revisions, hangar seats, and the scoreboard stay in **this
browser** (`localStorage`). Close the tab and they are still there; another
device starts empty. Training, including burst, runs in a Web Worker in
the page. Close the tab and burst stops.

On Railway (behind the monorepo proxy):

- Set this service **Root Directory** to `apps/dogfight-ai-lab` (the folder
  with `Dockerfile` and `requirements.txt`, not the inner `app/` package).
- Do **not** generate a public domain here. The `proxy` service is the
  public entry; this lab is reached at `/dogfight/` over private networking.
- Set `PORT=8082` as a **service variable** (not only Railway's runtime
  `PORT`) and leave the start command empty so the Dockerfile can run
  uvicorn on `$PORT`. The image binds dual-stack so the proxy can reach
  this lab over Railway private IPv6.

## Tests

```bash
python -m pip install -r requirements-dev.txt
python -m pytest
node --test tests/js-academy.test.mjs
```
