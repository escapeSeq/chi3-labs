import { Academy, stepsFromSeconds } from "./trainer.js";

const academy = new Academy(7);

academy.onPersist = (snapshot) => {
  postMessage({ type: "persist", snapshot });
};

let burstLoop = null;
const queue = [];
let busy = false;

onmessage = (event) => {
  queue.push(event.data);
  pump();
};

async function pump() {
  if (busy) return;
  busy = true;
  while (queue.length) {
    const msg = queue.shift();
    if (!msg || msg.type === "persist") continue;
    const { id, cmd, payload } = msg;
    try {
      const result = await handle(cmd, payload || {});
      postMessage({ id, ok: true, result });
    } catch (err) {
      postMessage({ id, ok: false, error: String(err.message || err) });
    }
  }
  busy = false;
}

async function handle(cmd, payload) {
  switch (cmd) {
    case "boot":
      if (payload.snapshot) academy.restore(payload.snapshot);
      return academy.status();
    case "state":
      return academy.status();
    case "play":
      return { ...academy.play({ learn: payload.learn !== false, lr: payload.lr, persist: payload.persist !== false, trace: payload.trace !== false, record: payload.record !== false }), ...academy.status() };
    case "watch":
      return { ...academy.play({ learn: false, record: false, persist: false, trace: true }), ...academy.status() };
    case "timeout":
      academy.setMaxSteps(stepsFromSeconds(payload.seconds));
      return academy.status();
    case "planes":
      academy.setNPlanes(payload.n);
      return academy.status();
    case "mode":
      academy.setMode(payload.mode);
      return academy.status();
    case "roster":
      academy.setRoster(payload.brains || [], payload.lineup);
      return academy.status();
    case "addBrain":
      academy.addBrain(payload.label || "New brain", payload.learn !== false);
      return academy.status();
    case "revise":
      academy.reviseBrain(payload.id, true, payload.seat ?? null);
      return academy.status();
    case "removeBrain":
      academy.removeBrain(payload.id);
      return academy.status();
    case "wipeBrain":
      academy.wipeBrain(payload.id);
      return academy.status();
    case "reset":
      academy.resetModels(true);
      return academy.status();
    case "resetStats":
      academy.resetStats(true);
      return academy.status();
    case "burst":
      return academy.burstStatus();
    case "startBurst": {
      if (payload.seconds != null) academy.setMaxSteps(stepsFromSeconds(payload.seconds), false);
      const burst = academy.startBurst(payload.lr ?? 0.018);
      if (!burstLoop) burstLoop = academy.runBurst().finally(() => {
        burstLoop = null;
      });
      return { ...burst, burst };
    }
    case "stopBurst": {
      const burst = academy.stopBurst();
      return { ...burst, burst };
    }
    case "persist":
      academy.persist();
      return academy.status();
    default:
      throw new Error(`unknown command ${cmd}`);
  }
}
