import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export function loadVoiceEnvFile(path, target = process.env) {
  if (!path) return false;
  const resolved = resolve(path);
  if (!existsSync(resolved)) return false;
  for (const line of readFileSync(resolved, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const index = trimmed.indexOf("=");
    const key = trimmed.slice(0, index).trim();
    const raw = trimmed.slice(index + 1).trim();
    if (!key || target[key]) continue;
    target[key] = unquote(raw);
  }
  return true;
}

export function realtimeConfig(env = process.env) {
  const read = (name, fallback = "") => {
    const value = env[name];
    return value == null || value === "" ? fallback : value;
  };
  return {
    baseUrl: read("VOLC_REALTIME_BASE_URL", "wss://openspeech.bytedance.com/api/v3/realtime/dialogue"),
    resourceId: read("VOLC_REALTIME_RESOURCE_ID", "volc.speech.dialog"),
    appKey: read("VOLC_REALTIME_APP_KEY"),
    appId: read("VOLC_REALTIME_APP_ID", read("VOLC_DOUBAO_S2S_APP_ID")),
    accessKey: read("VOLC_REALTIME_ACCESS_KEY", read("VOLC_DOUBAO_S2S_ACCESS_TOKEN")),
    apiKey: read("VOLC_REALTIME_API_KEY"),
    model: read("VOLC_REALTIME_MODEL", "1.2.1.1"),
    speaker: read("VOLC_REALTIME_SPEAKER", "zh_female_vv_jupiter_bigtts"),
    ttsFormat: read("VOLC_REALTIME_TTS_FORMAT", "pcm_s16le"),
    ttsSampleRate: Number(read("VOLC_REALTIME_TTS_SAMPLE_RATE", "24000")),
    compression: read("VOLC_REALTIME_COMPRESSION", "none"),
    connectTimeoutMs: Number(read("VOLC_REALTIME_CONNECT_TIMEOUT_MS", "12000")),
  };
}

export function primitiveConfig(env = process.env) {
  const read = (name, fallback = "") => {
    const value = env[name];
    return value == null || value === "" ? fallback : value;
  };
  const apiKey = read("VOLC_PRIMITIVE_API_KEY", read("VOLC_ASR_TTS_API_KEY", read("VOLC_REALTIME_API_KEY")));
  return {
    ttsUrl: read("VOLC_PRIMITIVE_TTS_URL", "wss://openspeech.bytedance.com/api/v3/tts/bidirection"),
    ttsResourceId: read("VOLC_PRIMITIVE_TTS_RESOURCE_ID", "seed-tts-2.0"),
    asrUrl: read("VOLC_PRIMITIVE_ASR_URL", "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async"),
    asrResourceId: read("VOLC_PRIMITIVE_ASR_RESOURCE_ID", "volc.seedasr.sauc.duration"),
    apiKey,
    apiKeySource: apiKey ? apiKeySource(env) : "",
    speaker: read("VOLC_PRIMITIVE_TTS_SPEAKER", "zh_female_vv_uranus_bigtts"),
    ttsFormat: read("VOLC_PRIMITIVE_TTS_FORMAT", "pcm"),
    ttsSampleRate: Number(read("VOLC_PRIMITIVE_TTS_SAMPLE_RATE", "24000")),
    asrSampleRate: Number(read("VOLC_PRIMITIVE_ASR_SAMPLE_RATE", "16000")),
    connectTimeoutMs: Number(read("VOLC_PRIMITIVE_CONNECT_TIMEOUT_MS", "12000")),
  };
}

export function missingRealtimeConfig(config) {
  if (config.apiKey) return [];
  const missing = [];
  if (!config.appKey || config.appKey.includes("replace-with")) missing.push("VOLC_REALTIME_APP_KEY");
  if (!config.appId || config.appId.includes("replace-with")) missing.push("VOLC_REALTIME_APP_ID");
  if (!config.accessKey || config.accessKey.includes("replace-with")) missing.push("VOLC_REALTIME_ACCESS_KEY");
  return missing;
}

export function missingPrimitiveConfig(config) {
  const missing = [];
  if (!config.apiKey || config.apiKey.includes("replace-with")) missing.push("VOLC_PRIMITIVE_API_KEY");
  return missing;
}

export function providerHeaders(config, connectId) {
  if (config.apiKey) {
    return {
      "X-Api-Key": config.apiKey,
      "X-Api-Resource-Id": config.resourceId,
      "X-Api-App-Key": config.appKey,
      "X-Api-Connect-Id": connectId,
    };
  }
  return {
    "X-Api-App-ID": config.appId,
    "X-Api-Access-Key": config.accessKey,
    "X-Api-Resource-Id": config.resourceId,
    "X-Api-App-Key": config.appKey,
    "X-Api-Connect-Id": connectId,
  };
}

export function primitiveProviderHeaders(config, kind, connectId) {
  const resourceId = kind === "asr" ? config.asrResourceId : config.ttsResourceId;
  return {
    "X-Api-Key": config.apiKey,
    "X-Api-Resource-Id": resourceId,
    "X-Api-Connect-Id": connectId,
    ...(kind === "asr" ? { "X-Api-Request-Id": connectId } : { "X-Control-Require-Usage-Tokens-Return": "*" }),
  };
}

export function publicRealtimeConfig(config) {
  return {
    url: config.baseUrl,
    resource_id: config.resourceId,
    model: config.model,
    speaker: config.speaker,
    tts_format: config.ttsFormat,
    tts_sample_rate: config.ttsSampleRate,
    auth_mode: config.apiKey ? "x-api-key" : "app-id-access-key",
    missing_realtime_config: missingRealtimeConfig(config),
  };
}

export function publicPrimitiveConfig(config) {
  return {
    provider: "volcengine-primitive",
    tts_url: config.ttsUrl,
    tts_resource_id: config.ttsResourceId,
    asr_url: config.asrUrl,
    asr_resource_id: config.asrResourceId,
    tts_format: config.ttsFormat,
    tts_sample_rate: config.ttsSampleRate,
    asr_sample_rate: config.asrSampleRate,
    auth_mode: "x-api-key",
    api_key_present: Boolean(config.apiKey),
    api_key_source: config.apiKey ? config.apiKeySource || "alias" : "",
    missing_primitive_config: missingPrimitiveConfig(config),
  };
}

function apiKeySource(env) {
  if (env.VOLC_PRIMITIVE_API_KEY) return "VOLC_PRIMITIVE_API_KEY";
  if (env.VOLC_ASR_TTS_API_KEY) return "VOLC_ASR_TTS_API_KEY";
  if (env.VOLC_REALTIME_API_KEY) return "VOLC_REALTIME_API_KEY";
  return "";
}

function unquote(value) {
  if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) return value.slice(1, -1);
  return value;
}
