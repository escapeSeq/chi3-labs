# Chi3-sim

Monorepo for educational simulations of analog computing and how small
neural nets **train** versus **use** what they learned.

## Projects

| Path | What it is | How to run |
| --- | --- | --- |
| [`apps/analog-chi3-lab`](apps/analog-chi3-lab) | Analog Ising / CIM relaxation vs sequential digital search, plus a Kerr field slab | `docker compose up --build` → http://localhost:8080 |
| [`apps/handwriting-ai-lab`](apps/handwriting-ai-lab) | Handwriting classroom: mouse-drawn digits, training loop, then frozen inference | `docker compose up --build` → http://localhost:8081 |
| [`apps/dogfight-ai-lab`](apps/dogfight-ai-lab) | Two empty policies learn a 2-D turn-radius gun fight by trial and error | `docker compose up --build` → http://localhost:8082 |

## Quick start

```bash
docker compose up --build
```

Root compose starts both labs. Each subproject also has its own
`docker-compose.yml` so it can be started from its own folder.
