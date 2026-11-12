import "dotenv/config";

const env = (k, d = "") => process.env[k] ?? d;

export const cfg = {
  token: env("BOT_TOKEN"),
  mode: env("BOT_MODE", "polling").toLowerCase(),
  port: Number(env("PORT", "10000")),
  dbUrl: env("DATABASE_URL"),
  dbSsl: env("DATABASE_SSL", "true") === "true",
  groqKey: env("GROQ_API_KEY"),
  groqModel: env("GROQ_MODEL", "openai/gpt-oss-20b"),
  // على Render متغير RENDER_EXTERNAL_URL بيتحط لوحده
  webhookDomain: (env("WEBHOOK_DOMAIN") || env("RENDER_EXTERNAL_URL")).replace(/\/+$/, ""),
  webhookPath: env("WEBHOOK_PATH", "malek-telegram-webhook").replace(/^\/+/, ""),
  webhookSecret: env("WEBHOOK_SECRET", ""),
  tz: env("TIMEZONE", "Africa/Cairo"),
  city: env("PRAYER_CITY", "Cairo"),
  country: env("PRAYER_COUNTRY", "Egypt"),
  method: env("PRAYER_METHOD", "5"),
  owner: Number(env("OWNER_ID", "0")),
};

for (const k of ["token", "dbUrl"]) {
  if (!cfg[k]) {
    console.error(`❌ Missing env var for: ${k}`);
    process.exit(1);
  }
}