import { randomUUID } from "node:crypto";

export async function addNote(bridge, deviceId, { title, body, id = randomUUID() }) {
  const note = { id, title, body, updated_at: new Date().toISOString() };
  const created = await bridge.data.put({
    deviceId,
    key: noteKey(id),
    value: note,
    requestKey: `bridge-notes-put-${id}-${Date.now()}`,
  });
  const final = await waitForSucceeded(bridge, created.job.id);
  return { note, result: final.result };
}

export async function listNotes(bridge, deviceId) {
  const created = await bridge.data.query({
    deviceId,
    prefix: "note/",
    limit: 100,
    requestKey: `bridge-notes-list-${Date.now()}`,
  });
  const final = await waitForSucceeded(bridge, created.job.id);
  return (final.result.items || []).map((item) => item.value);
}

export async function getNote(bridge, deviceId, id) {
  const created = await bridge.data.get({
    deviceId,
    key: noteKey(id),
    requestKey: `bridge-notes-get-${id}-${Date.now()}`,
  });
  const final = await waitForSucceeded(bridge, created.job.id);
  return final.result.found ? final.result.value : null;
}

export async function rmNote(bridge, deviceId, id) {
  const created = await bridge.data.delete({
    deviceId,
    key: noteKey(id),
    requestKey: `bridge-notes-rm-${id}-${Date.now()}`,
  });
  const final = await waitForSucceeded(bridge, created.job.id);
  return final.result.deleted === true;
}

export function noteKey(idOrKey) {
  return String(idOrKey || "").startsWith("note/") ? String(idOrKey) : `note/${idOrKey}`;
}

async function waitForSucceeded(bridge, jobId) {
  const job = await bridge.jobs.wait(jobId, { timeoutMs: 180000, intervalMs: 500 });
  if (job.status !== "succeeded") {
    const reason = job.result?.reason || job.result?.error || job.status;
    throw new Error(`Bridge job failed: ${reason}`);
  }
  return job;
}
