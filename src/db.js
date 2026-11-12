import pg from "pg";
import { cfg } from "./config.js";

// BIGINT Telegram IDs and balances are kept as JS numbers.
// Keep values within Number.MAX_SAFE_INTEGER.
pg.types.setTypeParser(20, (v) => Number(v));

export const pool = new pg.Pool({
  connectionString: cfg.dbUrl,
  ssl: cfg.dbSsl ? { rejectUnauthorized: false } : undefined,
  max: Number(process.env.DB_POOL_MAX || 8),
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
});

pool.on("error", (err) => console.error("PostgreSQL pool error:", err));

export const q = (text, params) => pool.query(text, params);

export async function initDb() {
  await q(`
    CREATE TABLE IF NOT EXISTS users(
      id BIGINT PRIMARY KEY,
      name TEXT,
      username TEXT,
      coins BIGINT NOT NULL DEFAULT 1000 CHECK (coins >= 0),
      bank BIGINT NOT NULL DEFAULT 0 CHECK (bank >= 0),
      xp INT NOT NULL DEFAULT 0 CHECK (xp >= 0),
      streak INT NOT NULL DEFAULT 0,
      last_daily TIMESTAMPTZ,
      shield_until TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS chats(
      id BIGINT PRIMARY KEY,
      title TEXT,
      type TEXT,
      prayer_on BOOLEAN NOT NULL DEFAULT FALSE,
      welcome_on BOOLEAN NOT NULL DEFAULT TRUE,
      antilink BOOLEAN NOT NULL DEFAULT FALSE
    );

    CREATE TABLE IF NOT EXISTS warns(
      chat_id BIGINT,
      user_id BIGINT,
      n INT NOT NULL DEFAULT 0,
      PRIMARY KEY(chat_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS cooldowns(
      user_id BIGINT,
      key TEXT,
      until TIMESTAMPTZ,
      PRIMARY KEY(user_id, key)
    );

    CREATE TABLE IF NOT EXISTS prayer_deliveries(
      chat_id BIGINT NOT NULL,
      prayer_date DATE NOT NULL,
      prayer_key TEXT NOT NULL,
      sent_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY(chat_id, prayer_date, prayer_key)
    );

    CREATE INDEX IF NOT EXISTS users_total_idx
      ON users ((coins + bank) DESC);

    CREATE INDEX IF NOT EXISTS chats_prayer_on_idx
      ON chats (id) WHERE prayer_on = TRUE;
  `);
}

export async function transaction(work) {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const result = await work(client);

    await client.query("COMMIT");

    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function upsertUser(u) {
  const name =
    [u.first_name, u.last_name]
      .filter(Boolean)
      .join(" ")
      .slice(0, 64) || "مجهول";

  const r = await q(
    `INSERT INTO users(id,name,username)
     VALUES($1,$2,$3)
     ON CONFLICT(id)
     DO UPDATE SET
       name=EXCLUDED.name,
       username=EXCLUDED.username
     RETURNING *`,
    [u.id, name, u.username || null]
  );

  return r.rows[0];
}

export async function getUser(id) {
  return (
    await q("SELECT * FROM users WHERE id=$1", [id])
  ).rows[0] || null;
}

// Atomic balance update.
// Returns the new balance, or null if it would go negative.
export async function addCoins(id, delta) {
  const amount = Math.trunc(Number(delta));

  if (!Number.isSafeInteger(amount)) {
    throw new TypeError("Invalid coin amount");
  }

  const r = await q(
    `UPDATE users
     SET coins=coins+$2
     WHERE id=$1 AND coins+$2>=0
     RETURNING coins`,
    [id, amount]
  );

  return r.rows[0] ? r.rows[0].coins : null;
}

// Transfer is all-or-nothing.
export async function transferCoins(fromId, toId, amount) {
  amount = Math.trunc(Number(amount));

  if (
    !Number.isSafeInteger(amount) ||
    amount <= 0 ||
    fromId === toId
  ) {
    return false;
  }

  return transaction(async (client) => {
    const debit = await client.query(
      `UPDATE users
       SET coins=coins-$2
       WHERE id=$1 AND coins >= $2
       RETURNING id`,
      [fromId, amount]
    );

    if (!debit.rowCount) return false;

    const credit = await client.query(
      `UPDATE users
       SET coins=coins+$2
       WHERE id=$1
       RETURNING id`,
      [toId, amount]
    );

    if (!credit.rowCount) {
      throw new Error("Recipient user does not exist");
    }

    return true;
  });
}

export async function addXp(id, delta) {
  const d = Math.trunc(Number(delta));

  const r = await q(
    "UPDATE users SET xp=xp+$2 WHERE id=$1 RETURNING xp",
    [id, d]
  );

  return r.rows[0]
    ? { old: r.rows[0].xp - d, xp: r.rows[0].xp }
    : null;
}

export async function rank(id) {
  const r = await q(
    `SELECT COUNT(*)+1 AS r
     FROM users
     WHERE coins+bank > (
       SELECT coins+bank FROM users WHERE id=$1
     )`,
    [id]
  );

  return Number(r.rows[0]?.r || 0);
}

export async function top(n = 10) {
  return (
    await q(
      `SELECT name, coins+bank AS total
       FROM users
       ORDER BY total DESC
       LIMIT $1`,
      [n]
    )
  ).rows;
}

// Returns 0 when cooldown starts, otherwise seconds remaining.
export async function cooldown(uid, key, seconds) {
  const r = await q(
    `INSERT INTO cooldowns(user_id,key,until)
     VALUES(
       $1,
       $2,
       now()+make_interval(secs => $3::int)
     )
     ON CONFLICT(user_id,key)
     DO UPDATE SET until=EXCLUDED.until
     WHERE cooldowns.until <= now()
     RETURNING 1`,
    [uid, key, Math.max(1, Math.trunc(seconds))]
  );

  if (r.rowCount) return 0;

  const s = await q(
    `SELECT GREATEST(
       1,
       CEIL(EXTRACT(EPOCH FROM (until-now())))::int
     ) AS s
     FROM cooldowns
     WHERE user_id=$1 AND key=$2`,
    [uid, key]
  );

  return s.rows[0]?.s ?? 1;
}

const chatCache = new Map();

const FIELDS = [
  "prayer_on",
  "welcome_on",
  "antilink"
];

export async function touchChat(c) {
  await q(
    `INSERT INTO chats(id,title,type)
     VALUES($1,$2,$3)
     ON CONFLICT(id)
     DO UPDATE SET
       title=EXCLUDED.title,
       type=EXCLUDED.type`,
    [
      c.id,
      c.title || c.first_name || "private",
      c.type
    ]
  );

  chatCache.delete(c.id);
}

export async function getChat(id) {
  const c = chatCache.get(id);

  if (c && Date.now() - c.t < 30_000) {
    return c.v;
  }

  const r = await q(
    "SELECT * FROM chats WHERE id=$1",
    [id]
  );

  const v = r.rows[0] || {
    prayer_on: false,
    welcome_on: true,
    antilink: false
  };

  chatCache.set(id, {
    t: Date.now(),
    v
  });

  return v;
}

export async function setChat(id, field, value) {
  if (!FIELDS.includes(field)) {
    throw new Error("bad field");
  }

  await q(
    `UPDATE chats SET ${field}=$2 WHERE id=$1`,
    [id, value]
  );

  chatCache.delete(id);
}

export async function toggleChat(id, field) {
  if (!FIELDS.includes(field)) {
    throw new Error("bad field");
  }

  const r = await q(
    `UPDATE chats
     SET ${field}=NOT ${field}
     WHERE id=$1
     RETURNING ${field} AS v`,
    [id]
  );

  chatCache.delete(id);

  return r.rows[0]?.v ?? false;
}

export async function claimPrayerDelivery(
  chatId,
  date,
  prayerKey
) {
  const r = await q(
    `INSERT INTO prayer_deliveries(
       chat_id,
       prayer_date,
       prayer_key
     )
     VALUES($1,$2,$3)
     ON CONFLICT DO NOTHING
     RETURNING chat_id`,
    [chatId, date, prayerKey]
  );

  return r.rowCount > 0;
}
