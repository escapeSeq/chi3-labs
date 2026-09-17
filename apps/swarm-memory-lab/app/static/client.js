export const STORE_KEY = "chi3.swarm.brains";

export function createAcademyClient(workerUrl) {
  const worker = new Worker(workerUrl, { type: "module" });
  let seq = 1;
  const pending = new Map();

  worker.onmessage = (event) => {
    const msg = event.data;
    if (msg?.type === "persist" && msg.snapshot) {
      try {
        localStorage.setItem(STORE_KEY, JSON.stringify(msg.snapshot));
      } catch {
        /* quota */
      }
      return;
    }
    const wait = pending.get(msg.id);
    if (!wait) return;
    pending.delete(msg.id);
    if (msg.ok) wait.resolve(msg.result);
    else wait.reject(new Error(msg.error || "Academy error"));
  };

  worker.onerror = (event) => {
    const err = new Error(event.message || "Academy worker failed");
    for (const wait of pending.values()) wait.reject(err);
    pending.clear();
  };

  function call(cmd, payload = {}) {
    const id = seq++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      worker.postMessage({ id, cmd, payload });
    });
  }

  async function boot() {
    let snapshot = null;
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (raw) snapshot = JSON.parse(raw);
    } catch {
      snapshot = null;
    }
    return call("boot", { snapshot });
  }

  function saveNow(snapshot) {
    if (!snapshot) return;
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(snapshot));
    } catch {
      /* quota */
    }
  }

  addEventListener("pagehide", () => {
    call("persist").catch(() => {});
  });

  return { call, boot, saveNow, worker };
}
