import pg from "pg";
import { cfg } from "./config.js";

pg.types.setTypeParser(20, (v) => Number(v)); // BIGINT -> Number

export const pool = new pg.Pool({
  connectionString: cfg.dbUrl,
  ssl: cfg.dbSsl ? { rejectUnauthorized: false } : undefined,
  max: 8,
});
export const q = (text, params) => pool.query(text, params);

export async function initDb() {
  await q(`
    CREATE TABLE IF NOT EXISTS users(
      id BIGINT PRIMARY KEY,
      name TEXT, username TEXT,
      coins BIGINT NOT NULL DEFAULT 1000,
      bank BIGINT NOT NULL DEFAULT 0,
      xp INT NOT NULL DEFAULT 0,
      streak INT NOT NULL DEFAULT 0,
      last_daily TIMESTAMPTZ,
      shield_until TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS chats(
      id BIGINT PRIMARY KEY,
      title TEXT, type TEXT,
      prayer_on BOOLEAN NOT NULL DEFAULT FALSE,
      welcome_on BOOLEAN NOT NULL DEFAULT TRUE,
      antilink BOOLEAN NOT NULL DEFAULT FALSE
    );
    CREATE TABLE IF NOT EXISTS warns(
      chat_id BIGINT, user_id BIGINT, n INT NOT NULL DEFAULT 0,
      PRIMARY KEY(chat_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS cooldowns(
      user_id BIGINT, key TEXT, until TIMESTAMPTZ,
      PRIMARY KEY(user_id, key)
    );
  `);
}

export async function upsertUser(u) {
  const name = [u.first_name, u.last_name].filter(Boolean).join(" ").slice(0, 64) || "مجهول";
  const r = await q(
    `INSERT INTO users(id,name,username) VALUES($1,$2,$3)
     ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name, username=EXCLUDED.username
     RETURNING *`,
    [u.id, name, u.username || null]
  );
  return r.rows[0];
}

export async function getUser(id) {
  return (await q("SELECT * FROM users WHERE id=$1", [id])).rows[0];
}

// يرجع الرصيد الجديد أو null لو الرصيد مش مكفي
export async function addCoins(id, delta) {
  const r = await q(
    "UPDATE users SET coins=coins+$2 WHERE id=$1 AND coins+$2>=0 RETURNING coins",
    [id, Math.trunc(delta)]
  );
  return r.rows[0] ? r.rows[0].coins : null;
}

export async function addXp(id, d) {
  const r = await q("UPDATE users SET xp=xp+$2 WHERE id=$1 RETURNING xp", [id, d]);
  return r.rows[0] ? { old: r.rows[0].xp - d, xp: r.rows[0].xp } : null;
}

export async function rank(id) {
  const r = await q(
    `SELECT COUNT(*)+1 AS r FROM users
     WHERE coins+bank > (SELECT coins+bank FROM users WHERE id=$1)`, [id]);
  return r.rows[0].r;
}

export async function top(n = 10) {
  return (await q("SELECT name, coins+bank AS total FROM users ORDER BY total DESC LIMIT $1", [n])).rows;
}

// يرجع 0 لو مفيش كولداون (وبيبدأه)، أو الثواني المتبقية
export async function cooldown(uid, key, sec) {
  const r = await q(
    `INSERT INTO cooldowns(user_id,key,until) VALUES($1,$2, now()+make_interval(secs => $3::int))
     ON CONFLICT(user_id,key) DO UPDATE SET until=EXCLUDED.until
     WHERE cooldowns.until <= now() RETURNING 1`,
    [uid, key, sec]
  );
  if (r.rowCount) return 0;
  const s = await q(
    "SELECT CEIL(EXTRACT(EPOCH FROM (until-now())))::int AS s FROM cooldowns WHERE user_id=$1 AND key=$2",
    [uid, key]
  );
  return s.rows[0]?.s ?? 1;
}

// ---- الجروبات ----
const chatCache = new Map();
const FIELDS = ["prayer_on", "welcome_on", "antilink"];

export async function touchChat(c) {
  await q(
    `INSERT INTO chats(id,title,type) VALUES($1,$2,$3)
     ON CONFLICT(id) DO UPDATE SET title=EXCLUDED.title, type=EXCLUDED.type`,
    [c.id, c.title || c.first_name || "private", c.type]
  );
}

export async function getChat(id) {
  const c = chatCache.get(id);
  if (c && Date.now() - c.t < 30000) return c.v;
  const r = await q("SELECT * FROM chats WHERE id=$1", [id]);
  const v = r.rows[0] || { prayer_on: false, welcome_on: true, antilink: false };
  chatCache.set(id, { t: Date.now(), v });
  return v;
}

export async function setChat(id, field, val) {
  if (!FIELDS.includes(field)) throw new Error("bad field");
  await q(`UPDATE chats SET ${field}=$2 WHERE id=$1`, [id, val]);
  chatCache.delete(id);
}

export async function toggleChat(id, field) {
  if (!FIELDS.includes(field)) throw new Error("bad field");
  const r = await q(`UPDATE chats SET ${field}=NOT ${field} WHERE id=$1 RETURNING ${field} AS v`, [id]);
  chatCache.delete(id);
  return r.rows[0]?.v;
}