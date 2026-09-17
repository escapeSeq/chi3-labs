import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Policy } from "../app/static/agents.js";
import { MODE_HUNT, World } from "../app/static/physics.js";
import { mulberry32 } from "../app/static/rng.js";
import { Academy } from "../app/static/trainer.js";

describe("dogfight client academy", () => {
  it("fresh policy is near uniform", () => {
    const p = new Policy(mulberry32(0), "red");
    const obs = new Float64Array(p.forward(new Float64Array(p.W1.length / 24)).x.length);
    const probs = p.forward(obs).probs;
    const sum = [...probs].reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(sum - 1) < 1e-6);
    assert.ok(Math.max(...probs) < 0.55);
  });

  it("a learned sortie updates weights", () => {
    const academy = new Academy(3);
    academy.setMaxSteps(80, false);
    const before = Float64Array.from(academy.red.W2);
    academy.play({ learn: true, persist: false, trace: false });
    assert.ok(academy.score.episodes === 1);
    assert.ok([...before].some((v, i) => v !== academy.red.W2[i]) || academy.blue.updates > 0 || academy.red.updates > 0);
    assert.equal(academy.empty, false);
  });

  it("timeout with two planes is a draw", () => {
    const rng = mulberry32(1);
    const world = new World(rng, { maxSteps: 8, nPlanes: 2 });
    while (!world.done()) world.step({ p1: 1, p2: 1 });
    assert.ok(world.events.includes("draw") || world.living().length <= 1);
  });

  it("hunt names P1 as prey", () => {
    const world = new World(mulberry32(2), { maxSteps: 20, nPlanes: 4, mode: MODE_HUNT });
    assert.equal(world.prey().name, "p1");
    assert.equal(world.prey().role, "prey");
    assert.ok(world.pack().every((p) => p.role === "pack"));
  });

  it("snapshot round-trips brains", () => {
    const first = new Academy(4);
    first.setMaxSteps(40, false);
    first.play({ learn: true, persist: false, trace: false });
    const snap = first.dumpSnapshot();
    const second = new Academy(99);
    assert.equal(second.restore(snap), true);
    assert.equal(second.score.episodes, first.score.episodes);
    assert.equal(second.red.updates, first.red.updates);
    assert.deepEqual(Array.from(second.red.W2), Array.from(first.red.W2));
  });
});
