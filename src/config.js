import "dotenv/config";

const env = (key, fallback = "") => process.env[key] ?? fallback;
const asBool = (value, fallback = false) =>
  String(value ?? fallback).toLowerCase() === "true";
const cleanBaseUrl = (value) => String(value || "").replace(/\/+$/, "");

export const cfg = {
  token: env("BOT_TOKEN"),
  mode: env("BOT_MODE", "webhook").toLowerCase(),
  port: Number(env("PORT", "10000")),
  dbUrl: env("DATABASE_URL"),
  dbSsl: asBool(env("DATABASE_SSL", "true")),
  groqKey: env("GROQ_API_KEY"),
  groqModel: env("GROQ_MODEL", "openai/gpt-oss-20b"),
  webhookDomain: cleanBaseUrl(
    env("WEBHOOK_DOMAIN") || env("RENDER_EXTERNAL_URL")
  ),
  webhookPath: env("WEBHOOK_PATH", "malek-telegram-webhook").replace(/^\/+/, ""),
  webhookSecret: env("WEBHOOK_SECRET"),
  tz: env("TIMEZONE", "Africa/Cairo"),
  city: env("PRAYER_CITY", "Cairo"),
  country: env("PRAYER_COUNTRY", "Egypt"),

  // Cairo coordinates are the safe default; set these to your intended city.
  latitude: Number(env("PRAYER_LATITUDE", "30.0444")),
  longitude: Number(env("PRAYER_LONGITUDE", "31.2357")),

  method: Number(env("PRAYER_METHOD", "5")),
  azanAudioFileId: env("AZAN_AUDIO_FILE_ID"),
  azanAudioUrl: env("AZAN_AUDIO_URL"),
  owner: Number(env("OWNER_ID", "0")),
};

if (!cfg.token) {
  throw new Error("Missing required environment variable: BOT_TOKEN");
}

if (!cfg.dbUrl) {
  throw new Error("Missing required environment variable: DATABASE_URL");
}

if (!Number.isInteger(cfg.port) || cfg.port < 1 || cfg.port > 65535) {
  throw new Error("Invalid PORT");
}

if (!Number.isFinite(cfg.latitude) || !Number.isFinite(cfg.longitude)) {
  throw new Error("Invalid prayer coordinates");
}

if (cfg.mode === "webhook" && !cfg.webhookDomain) {
  console.warn(
    "WEBHOOK mode requested but no WEBHOOK_DOMAIN/RENDER_EXTERNAL_URL; falling back to polling"
  );
}
