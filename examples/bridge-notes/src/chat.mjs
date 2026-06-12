export async function streamChat(bridge, deviceId, message, output = process.stdout) {
  const created = await bridge.codex.chat({
    deviceId,
    prompt: message,
    requestKey: `bridge-notes-chat-${Date.now()}`,
  });
  let reply = "";
  for await (const event of bridge.jobs.stream(created.job.id, {
    deviceId,
    realtime: false,
    timeoutMs: 180000,
    intervalMs: 500,
  })) {
    const payload = event.payload || {};
    if (event.type === "text_delta" && typeof payload.delta === "string") {
      reply += payload.delta;
      output.write(payload.delta);
    }
    if (event.type === "failed") {
      throw new Error(payload.reason || payload.error || "codex.chat failed");
    }
    if (event.type === "completed" && typeof payload.reply === "string") {
      reply = payload.reply;
    }
  }
  const final = await bridge.jobs.wait(created.job.id, { timeoutMs: 1000, intervalMs: 100 });
  if (final.status !== "succeeded") throw new Error(final.result?.error || "codex.chat failed");
  if (!reply && final.result?.reply) reply = final.result.reply;
  if (!reply.endsWith("\n")) output.write("\n");
  return reply;
}
