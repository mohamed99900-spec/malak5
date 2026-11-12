import { cfg } from "./config.js";
import { q } from "./db.js";
import { duas } from "./data.js";

export const PRAYERS = [
  ["Fajr", "الفجر", "🌌"],
  ["Dhuhr", "الظهر", "☀️"],
  ["Asr", "العصر", "🌤"],
  ["Maghrib", "المغرب", "🌇"],
  ["Isha", "العشاء", "🌙"],
];

export function nowCairo() {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: cfg.tz, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    }).formatToParts(new Date()).map((x) => [x.type, x.value])
  );
  return { date: `${p.day}-${p.month}-${p.year}`, hm: `${p.hour}:${p.minute}` };
}

let cache = { date: "", t: null };
export async function getTimings() {
  const { date } = nowCairo();
  if (cache.date === date && cache.t) return cache.t;
  const url = `https://api.aladhan.com/v1/timingsByCity/${date}?city=${encodeURIComponent(cfg.city)}&country=${encodeURIComponent(cfg.country)}&method=${cfg.method}`;
  const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error("aladhan " + r.status);
  const t = (await r.json()).data.timings;
  const out = { Sunrise: String(t.Sunrise).slice(0, 5) };
  for (const [k] of PRAYERS) out[k] = String(t[k]).slice(0, 5);
  cache = { date, t: out };
  return out;
}

export function fmt12(hm) {
  let [h, m] = hm.split(":").map(Number);
  const s = h >= 12 ? "م" : "ص";
  h = h % 12 || 12;
  return `${h}:${String(m).padStart(2, "0")} ${s}`;
}

export async function timesText() {
  const t = await getTimings();
  const { hm } = nowCairo();
  const toMin = (x) => Number(x.slice(0, 2)) * 60 + Number(x.slice(3, 5));
  const now = toMin(hm);
  let next = PRAYERS.find(([k]) => toMin(t[k]) > now) || PRAYERS[0];
  let diff = toMin(t[next[0]]) - now;
  if (diff < 0) diff += 1440;
  const lines = PRAYERS.map(([k, n, e]) => `${e} ${n}: <b>${fmt12(t[k])}</b>`).join("\n");
  return (
    `🕌 <b>مواعيد الصلاة — ${cfg.city}</b>\n\n${lines}\n🌅 الشروق: <b>${fmt12(t.Sunrise)}</b>\n\n` +
    `⏳ الصلاة الجاية: <b>${next[1]}</b> بعد ${Math.floor(diff / 60)} س و ${diff % 60} د`
  );
}

const sent = new Set();
async function broadcast(bot, name, emoji) {
  const rows = (await q("SELECT id FROM chats WHERE prayer_on")).rows;
  const txt = `${emoji} <b>حان الآن موعد أذان ${name}</b> بتوقيت القاهرة\n\n${duas[Math.floor(Math.random() * duas.length)]}`;
  for (const { id } of rows) {
    try {
      await bot.api.sendMessage(id, txt, { parse_mode: "HTML" });
    } catch (e) {
      if ([400, 403].includes(e.error_code)) await q("UPDATE chats SET prayer_on=FALSE WHERE id=$1", [id]).catch(() => {});
    }
    await new Promise((r) => setTimeout(r, 60));
  }
}

export function startScheduler(bot) {
  setInterval(async () => {
    try {
      const { date, hm } = nowCairo();
      for (const k of [...sent]) if (!k.startsWith(date)) sent.delete(k);
      const t = await getTimings();
      for (const [k, name, emoji] of PRAYERS) {
        const key = date + k;
        if (t[k] === hm && !sent.has(key)) {
          sent.add(key);
          broadcast(bot, name, emoji).catch(console.error);
        }
      }
    } catch (e) {
      console.error("prayer scheduler:", e.message);
    }
  }, 20000);
}