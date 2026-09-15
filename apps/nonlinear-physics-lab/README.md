# χ Nonlinear Physics Lab

Educational simulation of the **absolute fundamentals of nonlinear analog
physics**: a weakly nonlinear medium

```
P = χ⁽¹⁾ E + χ⁽²⁾ E² + χ⁽³⁾ E³
```

driven by one or two tones, then the same cubic as a Kerr index and as a
saturating well.

## Run with Docker Compose

From the monorepo root:

```bash
docker compose up --build
```

Or from this directory:

```bash
docker compose up --build
```

Open [http://localhost:8080](http://localhost:8080) from this folder, or
[http://localhost:8080/physics/](http://localhost:8080/physics/) from the
monorepo root (through the proxy).

## Run without Docker

```bash
python -m pip install -r requirements.txt
uvicorn app.main:app --host 0.0.0.0 --port 8080
```

## What it teaches

A linear analog medium copies a field. Superposition holds, and the spectrum
of the response is the spectrum of the drive. Each extra power of E is an
analog multiply that happens everywhere at once:

| Term | What it does to a sine | What it does to two sines |
| --- | --- | --- |
| χ¹ E | scaled copy at ω | two copies, nothing new |
| χ² E² | DC + 2ω | sum and difference |
| χ³ E³ | Kerr at ω + 3ω | four-wave mixing |

The Kerr pane is the spatial face of χ³: intensity writes phase. The
saturate pane is the same cubic as a restoring force — the well that analog
Ising machines lock onto a spin. This lab does not compute Max-Cut; it shows
why a cubic medium *can*.

## Tests

```bash
python -m pip install -r requirements-dev.txt
python -m pytest
```
