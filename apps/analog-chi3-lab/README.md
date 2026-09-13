# χ³ Analog Lab

Educational simulation of **analog nonlinear (χ³) computing**: a coherent Ising
machine that relaxes a Max-Cut instance in analog time, shown next to a digital
walker that flips one spin per tick, plus a Kerr-slab field processor that
applies |E|²E to every pixel at once.

## Run with Docker Compose

From the monorepo root:

```bash
docker compose up --build
```

Or from this directory:

```bash
docker compose up --build
```

Open [http://localhost:8080](http://localhost:8080).

## Run without Docker

```bash
python -m pip install -r requirements.txt
uvicorn app.main:app --host 0.0.0.0 --port 8080
```

## What it teaches

Digital search inspects configurations sequentially. A χ³ analog fabric
instantiates every pairwise product as a physical coupling and saturates each
oscillator with a cubic (Kerr) term:

```
ẋᵢ = (p − 1) xᵢ − xᵢ³ + ξ Σⱼ Jᵢⱼ xⱼ
```

The computational **volume** is the N² interactions that occur in each analog
instant. The lab does not claim a complexity-class breakthrough; it shows why
analog nonlinear media can deliver that volume in physical time.

## Tests

```bash
python -m pip install -r requirements-dev.txt
python -m pytest
```
