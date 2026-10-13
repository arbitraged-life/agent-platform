import { mkdir, open, readFile, readdir, rename, rm, lstat, link } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { validateObservabilityRecord } from "./evidence.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const settled = (row) =>
  row.receipt &&
  Object.values(row.receipt.destinations).every((r) => ["accepted", "disabled"].includes(r.delivery_status));
/** Durable, bounded local queue. A lost response or abandoned claim never causes replay. */
export function createDurableExporter({
  directory,
  exporter,
  maxEntries = 512,
  maxAttempts = 3,
  retryDelayMs = 60000,
  maxAgeMs = 604800000,
  now = Date.now,
}) {
  if (
    !path.isAbsolute(directory) ||
    !Number.isInteger(maxEntries) ||
    maxEntries < 1 ||
    !Number.isInteger(maxAttempts) ||
    maxAttempts < 1
  )
    throw new Error("Invalid outbox configuration");
  let queue = Promise.resolve(),
    deliveryQueue = Promise.resolve();
  const schedule = (fn) => {
    const result = deliveryQueue.then(fn);
    deliveryQueue = result.catch(() => undefined);
    return result;
  };
  const serial = (fn) => {
    const result = queue.then(fn);
    queue = result.catch(() => undefined);
    return result;
  };
  async function prepare() {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const info = await lstat(directory);
    if (!info.isDirectory() || info.mode & 0o077 || (process.getuid && info.uid !== process.getuid()))
      throw new Error("Unsafe outbox directory");
  }
  async function read(name) {
    const handle = await open(path.join(directory, name), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await handle.stat();
      if (
        !info.isFile() ||
        info.size > 32768 ||
        info.mode & 0o077 ||
        (process.getuid && info.uid !== process.getuid())
      )
        throw new Error("Unsafe outbox entry");
      const row = JSON.parse(await handle.readFile("utf8"));
      validateObservabilityRecord(row.event);
      return row;
    } finally {
      await handle.close();
    }
  }
  async function save(row) {
    const file = path.join(directory, `${row.event.event_id}.json`),
      temporary = file + `.${process.pid}.tmp`;
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(JSON.stringify(row));
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, file);
  }
  async function deliver(row) {
    const id = row.event.event_id,
      claim = path.join(directory, `${id}.claim`);
    let lock;
    try {
      lock = await open(claim, "wx", 0o600);
      await lock.writeFile(String(process.pid));
      await lock.sync();
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      // An existing claim is either active or an abandoned ambiguous delivery.
      // Do not remove it automatically or repeat its external writes.
      return { ...row.receipt, event_id: id, outbox_status: "claimed", delivery_status: "uncertain" };
    }
    try {
      row = await read(`${id}.json`);
      if (row.state === "in_flight")
        return { ...row.receipt, event_id: id, outbox_status: "interrupted", delivery_status: "uncertain" };
      if (
        row.receipt &&
        (!Object.values(row.receipt.destinations).some((r) => r.retryable) ||
          row.attempts >= maxAttempts ||
          now() < row.next_attempt_at)
      )
        return { ...row.receipt, outbox_status: "retained" };
      row.state = "in_flight";
      row.attempts++;
      await save(row);
      const receipt = await exporter(row.event, { receipts: row.receipt?.destinations });
      row.receipt = receipt;
      row.state = "recorded";
      row.next_attempt_at = now() + retryDelayMs * Math.pow(2, row.attempts - 1);
      row.updated_at = new Date(now()).toISOString();
      await save(row);
      return {
        ...receipt,
        outbox_status: "recorded",
        delivery_attempts: row.attempts,
        evicted_delivered_count: row.evicted_delivered_count ?? 0,
      };
    } finally {
      await lock.close();
      await rm(claim, { force: true });
    }
  }
  async function submit(event) {
    const snapshot = structuredClone(event);
    validateObservabilityRecord(snapshot);
    await prepare();
    let row;
    try {
      row = await read(`${snapshot.event_id}.json`);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (row) {
      if (JSON.stringify(row.event) !== JSON.stringify(snapshot))
        throw new Error("Outbox event identity collision");
      return row;
    }
    const names = (await readdir(directory)).filter(
      (name) => UUID.test(name.slice(0, -5)) && name.endsWith(".json"),
    );
    let evicted = 0;
    const rows = await Promise.all(names.map(read));
    const removable = rows.filter(settled).sort((a, b) => a.updated_at.localeCompare(b.updated_at));
    for (const old of removable) {
      if (names.length - evicted < maxEntries && now() - Date.parse(old.updated_at) < maxAgeMs) continue;
      await rm(path.join(directory, `${old.event.event_id}.json`));
      evicted++;
    }
    if (names.length - evicted >= maxEntries)
      throw new Error("Outbox capacity exhausted; unresolved evidence retained");
    row = {
      schema_version: 1,
      event: snapshot,
      state: "pending",
      attempts: 0,
      next_attempt_at: 0,
      receipt: null,
      evicted_delivered_count: evicted,
      updated_at: new Date(now()).toISOString(),
    };
    // Exclusive creation prevents concurrent submitters from replacing a receipt.
    let handle;
    const temporary = path.join(directory, `${snapshot.event_id}.${process.pid}.new`);
    try {
      handle = await open(temporary, "wx", 0o600);
      await handle.writeFile(JSON.stringify(row));
      await handle.sync();
      await link(temporary, path.join(directory, `${snapshot.event_id}.json`));
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      row = await read(`${snapshot.event_id}.json`);
    } finally {
      if (handle) await handle.close();
      await rm(temporary, { force: true });
    }
    return row;
  }
  const send = (event) => serial(() => submit(event)).then((row) => schedule(() => deliver(row)));
  send.drain = ({ limit = 20 } = {}) =>
    schedule(async () => {
      await prepare();
      const outcomes = [];
      for (const name of (await readdir(directory))
        .filter((name) => name.endsWith(".json") && UUID.test(name.slice(0, -5)))
        .sort()) {
        const row = await read(name);
        if (
          row.state === "pending" ||
          row.state === "in_flight" ||
          (row.receipt &&
            Object.values(row.receipt.destinations).some((r) => r.retryable) &&
            row.attempts < maxAttempts &&
            now() >= row.next_attempt_at)
        )
          outcomes.push(await deliver(row));
        if (outcomes.length >= limit) break;
      }
      return outcomes;
    });
  send.flushPersistence = () => queue;
  return send;
}
