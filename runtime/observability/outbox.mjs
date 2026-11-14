import { mkdir, open, readdir, rename, rm, lstat, link } from "node:fs/promises";
import { constants, readFileSync, readlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { hostname } from "node:os";
import path from "node:path";
import { validateObservabilityRecord } from "./evidence.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
let cachedOwnerIdentity;
function ownerIdentity() {
  if (cachedOwnerIdentity !== undefined) return cachedOwnerIdentity;
  try {
    const boot = process.platform === "linux"
      ? readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim()
      : process.platform === "darwin"
        ? execFileSync("/usr/sbin/sysctl", ["-n", "kern.bootsessionuuid"], {
          encoding: "utf8", timeout: 1000, maxBuffer: 1024, stdio: ["ignore", "pipe", "ignore"],
        }).trim()
        : "";
    const namespace = process.platform === "linux" ? readlinkSync("/proc/self/ns/pid") : "";
    cachedOwnerIdentity = /^[0-9a-f-]{36}$/i.test(boot) ? `${hostname()}:${boot}:${namespace}` : null;
  } catch {
    cachedOwnerIdentity = null;
  }
  return cachedOwnerIdentity;
}
const settled = (row) =>
  row.state === "recorded" && row.receipt &&
  Object.values(row.receipt.destinations).every((r) => ["accepted", "disabled"].includes(r.delivery_status));
async function releaseAfterDelivery(lock, claim, deliver) {
  const errors = [];
  let result;
  try {
    result = await deliver();
  } catch (error) {
    errors.push(error);
  }
  try {
    const owner = await lock.stat();
    const current = await lstat(claim);
    if (owner.dev !== current.dev || owner.ino !== current.ino)
      throw new Error("Outbox claim ownership changed");
    await rm(claim);
  } catch (error) {
    errors.push(error);
  }
  try {
    await lock.close();
  } catch (error) {
    errors.push(error);
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, "Outbox delivery and claim release failed");
  return result;
}
/** Durable, bounded local queue. A lost response or abandoned claim never causes replay. */
export function createDurableExporter({
  directory,
  exporter,
  maxEntries = 512,
  maxAttempts = 3,
  retryDelayMs = 60000,
  maxAgeMs = 604800000,
  now = Date.now,
  onInterrupted = async () => {},
  beforeAttempt = async () => null,
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
    const handle = await open(path.join(directory, name), constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
    try {
      const info = await handle.stat();
      if (
        !info.isFile() ||
        info.size > 1048576 ||
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
  async function abandonedClaim(claim) {
    let handle;
    try {
      handle = await open(claim, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
      const info = await handle.stat();
      if (!info.isFile() || info.size > 1024 || info.mode & 0o077 ||
          (process.getuid && info.uid !== process.getuid())) return false;
      const owner = JSON.parse(await handle.readFile("utf8"));
      if (!ownerIdentity() || owner.owner !== ownerIdentity() ||
          !Number.isSafeInteger(owner.pid) || owner.pid < 1) return false;
      try {
        process.kill(owner.pid, 0);
        return false;
      } catch (error) {
        // EPERM, unreadable metadata, and PID reuse are unknown ownership, not abandonment.
        return error.code === "ESRCH";
      }
    } catch {
      return false;
    } finally {
      if (handle) await handle.close();
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
  async function interrupt(row) {
    await onInterrupted(row.event, { receipts: row.receipt?.destinations, attempts: row.attempts });
    row.state = "interrupted";
    row.updated_at = new Date(now()).toISOString();
    await save(row);
    return { ...row.receipt, event_id: row.event.event_id, outbox_status: "interrupted", delivery_status: "uncertain" };
  }
  async function deliver(row) {
    const id = row.event.event_id,
      claim = path.join(directory, `${id}.claim`);
    if (row.state === "interrupted")
      return { ...row.receipt, event_id: id, outbox_status: "interrupted", delivery_status: "uncertain" };
    let lock;
    try {
      lock = await open(claim, "wx", 0o600);
      await lock.writeFile(JSON.stringify({ pid: process.pid, owner: ownerIdentity() }));
      await lock.sync();
    } catch (error) {
      if (error.code !== "EEXIST") {
        if (lock) await lock.close();
        throw error;
      }
      // PID-only/foreign/active claims are ambiguous. Never steal or replay them.
      if (await abandonedClaim(claim)) {
        row = await read(`${id}.json`);
        if (row.state === "in_flight") return interrupt(row);
        if (row.state === "interrupted")
          return { ...row.receipt, event_id: id, outbox_status: "interrupted", delivery_status: "uncertain" };
      }
      return { ...row.receipt, event_id: id, outbox_status: "claimed", delivery_status: "uncertain" };
    }
    return releaseAfterDelivery(lock, claim, async () => {
      row = await read(`${id}.json`);
      if (row.state === "in_flight") return interrupt(row);
      if (row.state === "interrupted")
        return { ...row.receipt, event_id: id, outbox_status: "interrupted", delivery_status: "uncertain" };
      if (
        row.receipt &&
        (!Object.values(row.receipt.destinations).some((r) => r.retryable) ||
          row.attempts >= maxAttempts ||
          now() < row.next_attempt_at)
      )
        return { ...row.receipt, outbox_status: "retained" };
      const blocked = await beforeAttempt(row.event, { receipts: row.receipt?.destinations });
      if (blocked) return { ...row.receipt, ...blocked, event_id: id, outbox_status: "capacity_blocked" };
      row.state = "in_flight";
      row.attempts++;
      await save(row);
      const receipt = await exporter(row.event, { receipts: row.receipt?.destinations, attempt: row.attempts });
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
    });
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
      let claimed;
      for (const name of (await readdir(directory))
        .filter((name) => name.endsWith(".json") && UUID.test(name.slice(0, -5)))
        .sort()) {
        const row = await read(name);
        if (
          row.state === "pending" ||
          row.state === "in_flight" ||
          (row.state !== "interrupted" && row.receipt &&
            Object.values(row.receipt.destinations).some((r) => r.retryable) &&
            row.attempts < maxAttempts &&
            now() >= row.next_attempt_at)
        ) {
          const outcome = await deliver(row);
          if (outcome.outbox_status === "claimed") claimed ??= outcome;
          else outcomes.push(outcome);
        }
        if (outcomes.length >= limit) break;
      }
      return outcomes.length ? outcomes : claimed ? [claimed] : [];
    });
  send.retry = async (eventId) => {
    if (typeof eventId !== "string" || !UUID.test(eventId)) throw new Error("Invalid outbox event ID");
    return schedule(async () => {
      await prepare();
      let row;
      try { row = await read(`${eventId}.json`); }
      catch (error) {
        if (error.code === "ENOENT") return null;
        throw error;
      }
      return deliver(row);
    });
  };
  send.flushPersistence = () => queue;
  return send;
}
