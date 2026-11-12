import http from "node:http";
import { Bot, InlineKeyboard, webhookCallback } from "grammy";
import { run } from "@grammyjs/runner";
import { cfg } from "./config.js";
import * as db from "./db.js";
import * as ai from "./ai.js";
import * as prayer from "./prayer.js";
import * as D from "./data.js";

const bot = new Bot(cfg.token);
bot.catch((err) => console.error("BOT ERROR:", err.error?.description || err.error || err));
const rand = (a, b) => Math.floor(Math.random() * (b - a + 1)) + a;
const pick = (a) => a[Math.floor(Math.random() * a.length)];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const fmt = (n) => Number(n || 0).toLocaleString("en-US");
const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const mention = (id, name) => `<a href="tg://user?id=${id}">${esc(name || "مجهول")}</a>`;
const levelOf = (xp) => Math.floor(Math.sqrt(Math.max(0, xp) / 40)) + 1;
const norm = (s) => String(s || "").toLowerCase().replace(/[\u064B-\u065F\u0670\u0640]/g, "").replace(/[أإآٱ]/g, "ا").replace(/ى/g, "ي").replace(/ة/g, "ه").replace(/[٠-٩]/g, (d) => "٠١٢٣٤٥٦٧٨٩".indexOf(d)).trim();
const fmtT = (s) => s < 60 ? `${s} ثانية` : s < 3600 ? `${Math.ceil(s / 60)} دقيقة` : `${Math.floor(s / 3600)} س و ${Math.ceil((s % 3600) / 60)} د`;

async function reply(ctx, text, extra = {}) {
  return ctx.reply(text, {
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
    reply_parameters: ctx.message ? {
      message_id: ctx.message.message_id,
      allow_sending_without_reply: true
    } : undefined,
    ...extra
  });
}

function parseAmount(raw, max = Number.MAX_SAFE_INTEGER) {
  if (!raw) return NaN;
  const s = norm(raw);
  if (["all", "كله", "الكل", "كل", "max"].includes(s)) return max;
  const m = s.match(/^(\d+(?:\.\d+)?)(k|ك|الف)?$/);
  if (!m) return NaN;
  const n = Number(m[1]) * (m[2] ? 1000 : 1);
  return Number.isSafeInteger(Math.floor(n)) ? Math.floor(n) : NaN;
}

function commandParts(text, username) {
  const m = String(text || "").trim().match(/^(\/)?([^\s@/]+)(?:@(\w+))?(?:\s+([\s\S]*))?$/);
  if (!m || (m[3] && m[3].toLowerCase() !== String(username || "").toLowerCase())) return null;
  const name = norm(m[2]);
  if (!m[1] && /^[a-z]/i.test(m[2])) return null;
  return { name, args: (m[4] || "").trim().split(/\s+/).filter(Boolean) };
}

const commands = new Map();
function cmd(names, fn, opts = {}) {
  for (const name of names) commands.set(norm(name), { fn, ...opts });
}

const throttle = new Map();
const adminCache = new Map();

async function isAdmin(ctx, id = ctx.from.id) {
  if (id === cfg.owner) return true;
  if (!ctx.chat || ctx.chat.type === "private") return false;

  const key = `${ctx.chat.id}:${id}`;
  const cached = adminCache.get(key);
  if (cached && Date.now() - cached.at < 45_000) return cached.value;

  try {
    const member = await ctx.api.getChatMember(ctx.chat.id, id);
    const value = ["creator", "administrator"].includes(member.status);
    adminCache.set(key, { at: Date.now(), value });
    return value;
  } catch {
    return false;
  }
}

async function getTarget(ctx, args) {
  const replied = ctx.message?.reply_to_message?.from;

  if (replied && !replied.is_bot) {
    await db.upsertUser(replied);
    return { id: replied.id, name: replied.first_name, rest: args };
  }

  const token = args[0];
  if (!token) return null;

  if (/^\d{5,}$/.test(token)) {
    const id = Number(token);
    const user = await db.getUser(id);
    return user ? { id, name: user.name || token, rest: args.slice(1) } : null;
  }

  if (token.startsWith("@")) {
    const row = (await db.q(
      "SELECT id,name FROM users WHERE lower(username)=lower($1)",
      [token.slice(1)]
    )).rows[0];

    return row ? {
      id: Number(row.id),
      name: row.name,
      rest: args.slice(1)
    } : null;
  }

  return null;
}

async function needTarget(ctx) {
  return reply(ctx, "رد على رسالة الشخص أو اكتب @يوزره المسجل في البوت 👆");
}

async function runCommand(ctx, entry, args) {
  if (Date.now() - (throttle.get(ctx.from.id) || 0) < 500) return;
  throttle.set(ctx.from.id, Date.now());

  if (entry.group && ctx.chat.type === "private") {
    return reply(ctx, "الأمر ده في الجروبات بس 👥");
  }

  if (entry.owner && ctx.from.id !== cfg.owner) {
    return reply(ctx, "الأمر ده للمطور فقط 👑");
  }

  if (entry.admin && !(await isAdmin(ctx))) {
    return reply(ctx, "الأمر ده للمشرفين بس.");
  }

  try {
    await entry.fn(ctx, args);
  } catch (error) {
    console.error("Command error:", error);
    await reply(ctx, "حصل خطأ أثناء تنفيذ الأمر. جرّب تاني بعد شوية.").catch(() => {});
  }
}

// Keep user/chat records current without making database hiccups stop message handling.
const touched = new Map();

bot.use(async (ctx, next) => {
  try {
    if (ctx.from && !ctx.from.is_bot && Date.now() - (touched.get(`u${ctx.from.id}`) || 0) > 300_000) {
      touched.set(`u${ctx.from.id}`, Date.now());
      await db.upsertUser(ctx.from);
    }

    if (ctx.chat && Date.now() - (touched.get(`c${ctx.chat.id}`) || 0) > 300_000) {
      touched.set(`c${ctx.chat.id}`, Date.now());
      await db.touchChat(ctx.chat);
    }
  } catch (error) {
    console.error("database touch:", error.message);
  }

  return next();
});

// Link moderation.
const LINK_RE = /(https?:\/\/|t\.me\/|telegram\.me\/|www\.|\b[a-z0-9-]+\.(com|net|org|io|me|xyz|info|ly)\b)/i;

async function guardLinks(ctx, text) {
  if (ctx.chat.type === "private") return false;

  const settings = await db.getChat(ctx.chat.id);
  if (!settings.antilink) return false;

  const entities = ctx.message.entities || [];

  if (!entities.some((e) => e.type === "url" || e.type === "text_link") && !LINK_RE.test(text)) {
    return false;
  }

  if (await isAdmin(ctx)) return false;

  try {
    await ctx.deleteMessage();

    await ctx.api.sendMessage(
      ctx.chat.id,
      `🚫 ${mention(ctx.from.id, ctx.from.first_name)} الروابط ممنوعة هنا.`,
      { parse_mode: "HTML" }
    );

    return true;
  } catch {
    return false;
  }
}

// XP with a per-user cooldown.
const xpCooldown = new Map();

async function awardXp(ctx) {
  if (Date.now() - (xpCooldown.get(ctx.from.id) || 0) < 45_000) return;

  xpCooldown.set(ctx.from.id, Date.now());

  const result = await db.addXp(ctx.from.id, rand(3, 8));
  if (!result) return;

  const before = levelOf(result.old);
  const after = levelOf(result.xp);

  if (after > before) {
    const bonus = after * 150;
    await db.addCoins(ctx.from.id, bonus);

    await reply(
      ctx,
      `🎉 ${mention(ctx.from.id, ctx.from.first_name)} وصلت للمستوى <b>${after}</b>! مكافأة +${fmt(bonus)} 💰`
    );
  }
}

// First-correct-answer challenges.
const challenges = new Map();

async function checkChallenge(ctx, text) {
  const challenge = challenges.get(ctx.chat.id);
  if (!challenge) return false;

  if (Date.now() > challenge.expires) {
    challenges.delete(ctx.chat.id);
    return false;
  }

  if (!challenge.answers.includes(norm(text))) return false;

  challenges.delete(ctx.chat.id);
  clearTimeout(challenge.timer);

  await db.addCoins(ctx.from.id, challenge.reward);

  await reply(
    ctx,
    `🏆 ${mention(ctx.from.id, ctx.from.first_name)} جاوب صح! الإجابة <b>${esc(challenge.answer)}</b>\n+${fmt(challenge.reward)} 💰`
  );

  return true;
}

async function startChallenge(ctx, {
  question,
  answers,
  answer,
  reward,
  seconds = 40
}) {
  const current = challenges.get(ctx.chat.id);

  if (current && Date.now() < current.expires) {
    return reply(ctx, "فيه تحدي شغال بالفعل، خلّصوه الأول 🔥");
  }

  const challenge = {
    answers: answers.map(norm),
    answer,
    reward,
    expires: Date.now() + seconds * 1000,
    timer: null
  };

  challenge.timer = setTimeout(() => {
    if (challenges.get(ctx.chat.id) === challenge) {
      challenges.delete(ctx.chat.id);

      bot.api.sendMessage(
        ctx.chat.id,
        `⏰ الوقت خلص! الإجابة: <b>${esc(answer)}</b>`,
        { parse_mode: "HTML" }
      ).catch(() => {});
    }
  }, seconds * 1000);

  challenges.set(ctx.chat.id, challenge);

  return reply(
    ctx,
    `${question}\n\n⏱ معاكم ${seconds} ثانية • الجايزة <b>${fmt(reward)}</b> 💰`
  );
}

bot.on("message:new_chat_members", async (ctx) => {
  const settings = await db.getChat(ctx.chat.id);

  for (const member of ctx.message.new_chat_members) {
    if (member.id === ctx.me.id) {
      await reply(
        ctx,
        "💎 ملك وصلت! ارفعوني مشرفة بالصلاحيات المطلوبة، واكتبوا /help لمعرفة الأوامر."
      );
    } else if (!member.is_bot && settings.welcome_on) {
      await ctx.reply(
        pick(D.welcomes)(
          mention(member.id, member.first_name),
          esc(ctx.chat.title)
        ),
        { parse_mode: "HTML" }
      );
    }
  }
});

async function maybeAI(ctx, text) {
  const username = ctx.me.username || "";
  const mentioned = username && new RegExp(`@${username}`, "i").test(text);
  const repliedToBot = ctx.message.reply_to_message?.from?.id === ctx.me.id;
  const called = /^(يا\s+)?(ملك|malek)(?=$|[\s،,!؟?.])/i.test(text);

  if (!(ctx.chat.type === "private" || mentioned || repliedToBot || called)) {
    return;
  }

  const key = `${ctx.chat.id}:${ctx.from.id}`;

  if (Date.now() - (aiCooldown.get(key) || 0) < 1800) return;
  aiCooldown.set(key, Date.now());

  const prompt = text
    .replace(new RegExp(`@${username}`, "ig"), "")
    .replace(/^(يا\s+)?(ملك|malek)[\s،,]*/i, "")
    .trim();

  if (!prompt) return reply(ctx, "أيوه، قول سؤالك 😄");

  if (/(مين|من|who).*(طورك|صنعك|عملك|برمجك|صممك|مطورك|made you|created you)/i.test(norm(prompt))) {
    return reply(ctx, D.DEV_ANSWER);
  }

  await ctx.api.sendChatAction(ctx.chat.id, "typing").catch(() => {});

  const answer = await ai.chat(key, ctx.from.first_name, prompt);

  return reply(
    ctx,
    answer
      ? esc(answer)
      : "مش قادرة أوصل لخدمة الذكاء الاصطناعي دلوقتي. جرّب بعد شوية."
  );
}

const aiCooldown = new Map();

bot.on("message:text", async (ctx) => {
  if (ctx.from.is_bot) return;

  const text = ctx.message.text.trim();

  if (await guardLinks(ctx, text)) return;
  if (await checkChallenge(ctx, text)) return;

  if (ctx.chat.type !== "private") {
    awardXp(ctx).catch((e) => console.error("XP:", e.message));
  }

  const parsed = commandParts(text, ctx.me.username);

  if (parsed) {
    const entry = commands.get(parsed.name);
    if (entry) return runCommand(ctx, entry, parsed.args);
  }

  await maybeAI(ctx, text);
});

// AI and light entertainment.
cmd(["ask", "اسال", "اسألني", "جاوب"], async (ctx, args) => {
  const prompt = args.join(" ") || ctx.message.reply_to_message?.text || "";

  if (!prompt) {
    return reply(ctx, "اكتب سؤالك بعد الأمر، مثال: <code>اسال ما عاصمة مصر؟</code>");
  }

  if (/(مين|من|who).*(طورك|صنعك|عملك|برمجك|صممك|مطورك|made you|created you)/i.test(norm(prompt))) {
    return reply(ctx, D.DEV_ANSWER);
  }

  await ctx.api.sendChatAction(ctx.chat.id, "typing").catch(() => {});

  const answer = await ai.chat(
    `${ctx.chat.id}:${ctx.from.id}`,
    ctx.from.first_name,
    prompt
  );

  return reply(
    ctx,
    answer
      ? esc(answer)
      : "خدمة الذكاء الاصطناعي مش متاحة دلوقتي. جرّب بعد شوية."
  );
});

cmd(["joke", "نكته", "نكتة", "هزار"], async (ctx) => {
  const joke = await ai.joke();
  return reply(ctx, `😂 ${esc(joke || pick(D.jokes))}`);
});

cmd(["roast", "روست", "اتريق", "هزأه"], async (ctx, args) => {
  const target = await getTarget(ctx, args);
  const name = target?.name || ctx.from.first_name;
  const text = await ai.roast(name);

  return reply(ctx, esc(text || pick(D.roasts).replace("{n}", name)));
});

// Help and basic commands.
cmd(["start", "help", "اوامر", "الاوامر", "مساعده", "ابدا"], async (ctx) => reply(ctx,
`💎 <b>ملك — بوت الجروبات والترفيه</b>

<b>💰 الاقتصاد</b>
رصيد • يومي • شغل • ايداع • سحب • تحويل • سرقة • حماية • توب

<b>🎮 الألعاب</b>
سلوت [مبلغ] • عملة [طرة/كتابة] [مبلغ] • كورة [مبلغ] • سلة [مبلغ] • سهم [مبلغ] • حجر [مبلغ] • اكس
سؤال • لغز • حساب • اسرع

<b>🕌 الصلاة</b>
اذان • تفعيل_الاذان • ايقاف_الاذان

<b>🤖 الذكاء والمرح</b>
ملك [سؤالك] • اسال [سؤالك] • نكتة • روست

<b>🛡 الإدارة (للمشرفين)</b>
حظر • فك_حظر • طرد • كتم [مدة] • فك_كتم • رفع • تنزيل • تحذير • إزالة_تحذير • تحذيرات • مسح • تثبيت • منع_الروابط • ترحيب

في الجروب: رد على رسالة الشخص أو اكتب @يوزره المسجل.`));

cmd(["balance", "bal", "رصيد", "فلوسي", "بطاقتي", "بطاقه", "حسابي", "انا"], async (ctx) => {
  const targetUser = ctx.message.reply_to_message?.from;

  if (targetUser && !targetUser.is_bot) {
    await db.upsertUser(targetUser);
  }

  const id = targetUser && !targetUser.is_bot ? targetUser.id : ctx.from.id;
  const user = await db.getUser(id);

  if (!user) return reply(ctx, "المستخدم لسه مش مسجل.");

  const rank = await db.rank(id);
  const shield = user.shield_until && new Date(user.shield_until) > new Date()
    ? "🛡 مفعّلة"
    : "—";

  return reply(
    ctx,
    `💳 <b>بطاقة ${esc(user.name)}</b>
━━━━━━━━━━━━
⭐ المستوى: <b>${levelOf(user.xp)}</b> (XP ${fmt(user.xp)})
👛 المحفظة: <b>${fmt(user.coins)}</b> 💰
🏦 البنك: <b>${fmt(user.bank)}</b> 💰
💎 الإجمالي: <b>${fmt(user.coins + user.bank)}</b> 💰
🔥 الستريك: <b>${user.streak}</b> يوم
🛡 الحماية: ${shield}
🏆 الترتيب: <b>#${rank}</b>`
  );
});

cmd(["daily", "يومي", "مكافاه"], async (ctx) => {
  const cooldown = await db.cooldown(ctx.from.id, "daily", 20 * 3600);

  if (cooldown) {
    return reply(ctx, `⏳ استلمت مكافأتك بالفعل. ارجع بعد <b>${fmtT(cooldown)}</b>`);
  }

  const user = await db.getUser(ctx.from.id);
  const recent = user.last_daily && Date.now() - new Date(user.last_daily).getTime() < 48 * 3600 * 1000;
  const streak = recent ? user.streak + 1 : 1;
  const reward = 300 + Math.min(streak, 30) * 50;

  await db.q(
    "UPDATE users SET coins=coins+$2, streak=$3, last_daily=now() WHERE id=$1",
    [ctx.from.id, reward, streak]
  );

  return reply(
    ctx,
    `🎁 <b>المكافأة اليومية</b>\n+${fmt(reward)} 💰\n🔥 الستريك: ${streak} يوم`
  );
});

cmd(["work", "شغل", "اشتغل", "عمل"], async (ctx) => {
  const cooldown = await db.cooldown(ctx.from.id, "work", 3600);

  if (cooldown) {
    return reply(ctx, `😮‍💨 استريح وارجع بعد <b>${fmtT(cooldown)}</b>`);
  }

  const user = await db.getUser(ctx.from.id);
  const job = pick(D.jobs);
  const pay = Math.floor(rand(job.min, job.max) * (1 + levelOf(user.xp) * 0.04));

  await db.addCoins(ctx.from.id, pay);
  await db.addXp(ctx.from.id, 10);

  return reply(ctx, `${job.t}\n💵 +${fmt(pay)} 💰`);
});

cmd(["deposit", "ايداع", "ودع"], async (ctx, args) => {
  const user = await db.getUser(ctx.from.id);
  const amount = parseAmount(args[0], user.coins);

  if (!Number.isSafeInteger(amount) || amount < 1) {
    return reply(ctx, "اكتب: <code>ايداع 500</code> أو <code>ايداع كله</code>");
  }

  const result = await db.q(
    "UPDATE users SET coins=coins-$2, bank=bank+$2 WHERE id=$1 AND coins >= $2 RETURNING coins",
    [ctx.from.id, amount]
  );

  if (!result.rowCount) return reply(ctx, "رصيد المحفظة مش كفاية.");

  return reply(ctx, `🏦 تم إيداع <b>${fmt(amount)}</b> 💰`);
});

cmd(["withdraw", "سحب", "اسحب"], async (ctx, args) => {
  const user = await db.getUser(ctx.from.id);
  const amount = parseAmount(args[0], user.bank);

  if (!Number.isSafeInteger(amount) || amount < 1) {
    return reply(ctx, "اكتب: <code>سحب 500</code> أو <code>سحب كله</code>");
  }

  const result = await db.q(
    "UPDATE users SET coins=coins+$2, bank=bank-$2 WHERE id=$1 AND bank >= $2 RETURNING coins",
    [ctx.from.id, amount]
  );

  if (!result.rowCount) return reply(ctx, "رصيد البنك مش كفاية.");

  return reply(ctx, `🏧 تم سحب <b>${fmt(amount)}</b> 💰`);
});

cmd(["send", "حول", "تحويل"], async (ctx, args) => {
  const target = await getTarget(ctx, args);

  if (!target) return needTarget(ctx);
  if (target.id === ctx.from.id) return reply(ctx, "مينفعش تحول لنفسك 😅");

  const amount = parseAmount(target.rest[0], 0);

  if (!Number.isSafeInteger(amount) || amount < 1) {
    return reply(ctx, "اكتب المبلغ بعد الأمر، مثال: <code>تحويل 500</code>");
  }

  try {
    if (!(await db.transferCoins(ctx.from.id, target.id, amount))) {
      return reply(ctx, "رصيدك مش كفاية.");
    }

    return reply(
      ctx,
      `💸 تم تحويل <b>${fmt(amount)}</b> 💰 إلى ${mention(target.id, target.name)}`
    );
  } catch (error) {
    console.error("transfer:", error);
    return reply(ctx, "التحويل لم يكتمل ولم يتم اعتماده. جرّب تاني.");
  }
});

cmd(["rob", "سرقه", "اسرق", "سرق"], async (ctx, args) => {
  const target = await getTarget(ctx, args);

  if (!target) return needTarget(ctx);
  if (target.id === ctx.from.id) return reply(ctx, "مينفعش تسرق نفسك 😅");
  if (target.id === ctx.me.id || await isAdmin(ctx, target.id)) {
    return reply(ctx, "مش هينفع تستهدف البوت أو مشرف الجروب.");
  }

  const thief = await db.getUser(ctx.from.id);
  const victim = await db.getUser(target.id);

  if (!victim) return reply(ctx, "الشخص ده مش مسجل في البوت.");

  if (thief.coins < 200 || victim.coins < 300) {
    return reply(ctx, "لازم يكون معاك 200 والهدف معاه 300 عملة على الأقل.");
  }

  if (victim.shield_until && new Date(victim.shield_until) > new Date()) {
    return reply(ctx, "🛡 الشخص ده عنده حماية فعالة.");
  }

  const cooldown = await db.cooldown(ctx.from.id, "rob", 600);

  if (cooldown) {
    return reply(ctx, `🚔 استنى ${fmtT(cooldown)} قبل محاولة تانية.`);
  }

  if (Math.random() < 0.45) {
    const amount = Math.max(1, Math.floor(victim.coins * rand(10, 30) / 100));
    const moved = await db.transferCoins(target.id, ctx.from.id, amount);

    if (!moved) return reply(ctx, "الهدف صرف رصيده قبل ما المحاولة تكتمل.");

    return reply(
      ctx,
      `🥷 نجحت! كسبت ${fmt(amount)} 💰 من ${mention(target.id, target.name)}.`
    );
  }

  const fine = Math.min(thief.coins, rand(100, 400));
  const paid = await db.transferCoins(ctx.from.id, target.id, fine);

  return reply(
    ctx,
    paid ? `🚔 فشلت المحاولة واتخصم منك ${fmt(fine)} 💰 كغرامة.` : "فشلت المحاولة."
  );
}, { group: true });

cmd(["shield", "حمايه", "درع"], async (ctx) => {
  const result = await db.q(
    `UPDATE users
     SET coins=coins-2000,
         shield_until=GREATEST(COALESCE(shield_until,now()),now())+interval '24 hours'
     WHERE id=$1 AND coins>=2000
     RETURNING shield_until`,
    [ctx.from.id]
  );

  if (!result.rowCount) {
    return reply(ctx, "الحماية تكلف 2,000 💰 ورصيدك غير كافٍ.");
  }

  return reply(ctx, "🛡 تم تفعيل الحماية لمدة 24 ساعة.");
});

cmd(["top", "توب", "الاغنياء", "ترتيب"], async (ctx) => {
  const rows = await db.top(10);
  const medals = ["🥇", "🥈", "🥉"];

  return reply(
    ctx,
    "🏆 <b>أغنى 10 لاعبين</b>\n\n" +
    rows.map((r, i) =>
      `${medals[i] || `${i + 1}.`} ${esc(r.name)} — <b>${fmt(r.total)}</b> 💰`
    ).join("\n")
  );
});

async function placeBet(ctx, raw, min = 10, max = 100000) {
  const user = await db.getUser(ctx.from.id);
  const amount = parseAmount(raw, Math.min(user.coins, max));

  if (!Number.isSafeInteger(amount) || amount < min || amount > max) {
    await reply(ctx, `اكتب رهان من ${fmt(min)} إلى ${fmt(max)} 💰`);
    return null;
  }

  if (await db.addCoins(ctx.from.id, -amount) === null) {
    await reply(ctx, "رصيدك مش كفاية.");
    return null;
  }

  return amount;
}

cmd(["slots", "سلوت", "ماكينه", "سلوتس"], async (ctx, args) => {
  const bet = await placeBet(ctx, args[0]);
  if (!bet) return;

  const dice = await ctx.replyWithDice("🎰");
  await sleep(2600);

  const value = dice.dice.value - 1;
  const reels = [value & 3, (value >> 2) & 3, (value >> 4) & 3];
  const symbols = ["🍫", "🍇", "🍋", "7️⃣"];
  const line = reels.map((v) => symbols[v]).join(" | ");

  let multiplier = 0;

  if (reels.every((v) => v === reels[0])) {
    multiplier = reels[0] === 3 ? 10 : 5;
  } else if (
    reels[0] === reels[1] ||
    reels[1] === reels[2] ||
    reels[0] === reels[2]
  ) {
    multiplier = 1.5;
  }

  if (!multiplier) {
    return reply(ctx, `🎰 ${line}\n💔 خسرت ${fmt(bet)} 💰`);
  }

  const payout = Math.floor(bet * multiplier);
  await db.addCoins(ctx.from.id, payout);

  return reply(
    ctx,
    `🎰 ${line}\n🏆 رجعلك إجمالي ${fmt(payout)} 💰 (صافي الربح ${fmt(payout - bet)})`
  );
});

cmd(["flip", "عمله", "طره", "قلب"], async (ctx, args) => {
  const side = args.find((x) =>
    ["طره", "صوره", "كتابه", "head", "heads", "tail", "tails", "كتابة", "طرة", "صورة"].includes(norm(x))
  );

  const raw = args.find((x) => x !== side);

  if (!side) {
    return reply(ctx, "اختار: <code>عملة طرة 500</code> أو <code>عملة كتابة 500</code>");
  }

  const bet = await placeBet(ctx, raw);
  if (!bet) return;

  const chosen = ["طره", "صوره", "head", "heads"].includes(norm(side)) ? "H" : "T";
  const result = Math.random() < 0.5 ? "H" : "T";

  if (chosen === result) {
    await db.addCoins(ctx.from.id, bet * 2);
    return reply(ctx, `🪙 ${result === "H" ? "طرة" : "كتابة"}\n🏆 كسبت ${fmt(bet)} 💰`);
  }

  return reply(ctx, `🪙 ${result === "H" ? "طرة" : "كتابة"}\n💔 خسرت ${fmt(bet)} 💰`);
});

for (const [names, emoji, wins, multiplier, delay] of [
  [["football", "كوره", "goal"], "⚽", (v) => v >= 3, 2, 3800],
  [["basket", "سله"], "🏀", (v) => v >= 4, 2.5, 3500],
  [["dart", "سهم", "دارت"], "🎯", (v) => v === 6, 4, 3200],
]) {
  cmd(names, async (ctx, args) => {
    const bet = await placeBet(ctx, args[0]);
    if (!bet) return;

    const dice = await ctx.replyWithDice(emoji);
    await sleep(delay);

    if (wins(dice.dice.value)) {
      const payout = Math.floor(bet * multiplier);
      await db.addCoins(ctx.from.id, payout);
      return reply(ctx, `🔥 كسبت صافي ${fmt(payout - bet)} 💰`);
    }

    return reply(ctx, `💔 المحاولة ما نجحتش. خسرت ${fmt(bet)} 💰`);
  });
}

// Rock-paper-scissors buttons. The stake is debited only after the owner presses.
const rpsGames = new Map();

cmd(["rps", "حجر", "حجره", "مقص"], async (ctx, args) => {
  const user = await db.getUser(ctx.from.id);
  const bet = args[0]
    ? parseAmount(args[0], Math.min(user.coins, 100000))
    : 0;

  if (!Number.isSafeInteger(bet) || bet < 0 || bet > user.coins) {
    return reply(ctx, "قيمة الرهان غير صحيحة أو رصيدك غير كافٍ.");
  }

  const id = Math.random().toString(36).slice(2, 10);
  rpsGames.set(id, { uid: ctx.from.id, bet });

  setTimeout(() => rpsGames.delete(id), 10 * 60_000);

  const kb = new InlineKeyboard()
    .text("🪨 حجر", `rps:${id}:r`)
    .text("📄 ورقة", `rps:${id}:p`)
    .text("✂️ مقص", `rps:${id}:s`);

  return reply(
    ctx,
    `🎮 <b>حجر ورقة مقص</b> — ${bet ? `رهان ${fmt(bet)} 💰` : "للتسلية"}\nاختار حركتك:`,
    { reply_markup: kb }
  );
});

bot.callbackQuery(/^rps:([a-z0-9]+):([rps])$/, async (ctx) => {
  const [, id, choice] = ctx.match;
  const game = rpsGames.get(id);

  if (!game) {
    return ctx.answerCallbackQuery({ text: "اللعبة انتهت." });
  }

  if (ctx.from.id !== game.uid) {
    return ctx.answerCallbackQuery({ text: "اللعبة دي مش بتاعتك." });
  }

  rpsGames.delete(id);

  if (game.bet && await db.addCoins(game.uid, -game.bet) === null) {
    await ctx.answerCallbackQuery({ text: "رصيدك لم يعد كافيًا." });
    return ctx.editMessageText("الرصيد غير كافٍ لإكمال اللعبة.");
  }

  const botChoice = pick(["r", "p", "s"]);
  const beats = { r: "s", p: "r", s: "p" };
  const names = { r: "حجر 🪨", p: "ورقة 📄", s: "مقص ✂️" };

  let result;

  if (choice === botChoice) {
    if (game.bet) await db.addCoins(game.uid, game.bet);
    result = "تعادل — رجعنا الرهان.";
  } else if (beats[choice] === botChoice) {
    if (game.bet) await db.addCoins(game.uid, game.bet * 2);
    result = `كسبت! ${game.bet ? `صافي +${fmt(game.bet)} 💰` : ""}`;
  } else {
    result = `خسرت. ${game.bet ? `-${fmt(game.bet)} 💰` : ""}`;
  }

  await ctx.answerCallbackQuery();

  return ctx.editMessageText(
    `اختيارك: ${names[choice]}\nاختياري: ${names[botChoice]}\n\n🏁 ${result}`
  );
});

// Tic-tac-toe against the bot.
const xoGames = new Map();

const lines = [
  [0, 1, 2],
  [3, 4, 5],
  [6, 7, 8],
  [0, 3, 6],
  [1, 4, 7],
  [2, 5, 8],
  [0, 4, 8],
  [2, 4, 6]
];

function xoWinner(board) {
  for (const line of lines) {
    const [a, b, c] = line;

    if (board[a] && board[a] === board[b] && board[a] === board[c]) {
      return board[a];
    }
  }

  return board.every(Boolean) ? "draw" : null;
}

function xoBotMove(board) {
  const find = (symbol) =>
    lines.find((line) =>
      line.filter((i) => board[i] === symbol).length === 2 &&
      line.some((i) => !board[i])
    )?.find((i) => !board[i]) ?? -1;

  let move = find("O");

  if (move < 0) move = find("X");
  if (move < 0 && !board[4]) move = 4;

  if (move < 0) {
    move = pick(board.map((v, i) => v ? -1 : i).filter((i) => i >= 0));
  }

  board[move] = "O";
}

function xoKeyboard(id, board, finished = false) {
  const kb = new InlineKeyboard();

  board.forEach((v, i) => {
    kb.text(
      v === "X" ? "❌" : v === "O" ? "⭕" : "▫️",
      finished || v ? "noop" : `xo:${id}:${i}`
    );

    if (i % 3 === 2 && i !== 8) kb.row();
  });

  return kb;
}

cmd(["xo", "اكس", "اكس_او", "اكسو"], async (ctx) => {
  const id = Math.random().toString(36).slice(2, 9);
  const game = {
    uid: ctx.from.id,
    board: Array(9).fill(null)
  };

  xoGames.set(id, game);
  setTimeout(() => xoGames.delete(id), 30 * 60_000);

  return reply(
    ctx,
    "❌⭕ <b>إكس أو ضد ملك</b>\nأنت ❌ وأنا ⭕ — ابدأ! المكافأة +200 💰",
    { reply_markup: xoKeyboard(id, game.board) }
  );
});

bot.callbackQuery("noop", (ctx) => ctx.answerCallbackQuery());

bot.callbackQuery(/^xo:([a-z0-9]+):(\d)$/, async (ctx) => {
  const [, id, indexText] = ctx.match;
  const game = xoGames.get(id);

  if (!game) {
    return ctx.answerCallbackQuery({ text: "اللعبة انتهت." });
  }

  if (ctx.from.id !== game.uid) {
    return ctx.answerCallbackQuery({ text: "دي مش لعبتك." });
  }

  const index = Number(indexText);

  if (game.board[index]) {
    return ctx.answerCallbackQuery({ text: "الخانة محجوزة." });
  }

  game.board[index] = "X";

  let winner = xoWinner(game.board);

  if (!winner) {
    xoBotMove(game.board);
    winner = xoWinner(game.board);
  }

  await ctx.answerCallbackQuery();

  if (winner) {
    xoGames.delete(id);

    let result = "تعادل! +30 💰";

    if (winner === "X") {
      await db.addCoins(game.uid, 200);
      result = "🏆 كسبت! +200 💰";
    } else if (winner === "O") {
      result = "ملك كسبت الجولة. حظ أوفر!";
    } else {
      await db.addCoins(game.uid, 30);
    }

    return ctx.editMessageText(
      `❌⭕ <b>انتهت اللعبة</b>\n${result}`,
      {
        parse_mode: "HTML",
        reply_markup: xoKeyboard(id, game.board, true)
      }
    );
  }

  return ctx.editMessageReplyMarkup({
    reply_markup: xoKeyboard(id, game.board)
  });
});

// Trivia buttons: answer each question once per user; first correct answer wins.
const triviaGames = new Map();

function shuffledTrivia(item) {
  const options = item.o.map((value, index) => ({
    value,
    correct: index === item.a
  }));

  for (let i = options.length - 1; i > 0; i--) {
    const j = rand(0, i);
    [options[i], options[j]] = [options[j], options[i]];
  }

  return {
    q: item.q,
    o: options.map((x) => x.value),
    a: options.findIndex((x) => x.correct)
  };
}

cmd(["trivia", "سؤال", "اسئله", "سوال"], async (ctx) => {
  await ctx.api.sendChatAction(ctx.chat.id, "typing").catch(() => {});

  const generated = await ai.genTrivia();
  const item = shuffledTrivia(generated || pick(D.trivia));

  const id = Math.random().toString(36).slice(2, 10);
  const kb = new InlineKeyboard();

  item.o.forEach((option, index) => {
    kb.text(option, `tq:${id}:${index}`).row();
  });

  const message = await reply(
    ctx,
    `🧠 <b>سؤال ثقافة عامة</b>\n\n${esc(item.q)}\n\n⏱ 45 ثانية • أول إجابة صحيحة تكسب`,
    { reply_markup: kb }
  );

  const game = {
    ...item,
    tried: new Set(),
    timer: null,
    chatId: ctx.chat.id,
    messageId: message.message_id
  };

  game.timer = setTimeout(async () => {
    if (triviaGames.get(id) !== game) return;

    triviaGames.delete(id);

    await bot.api.editMessageText(
      game.chatId,
      game.messageId,
      `🧠 ${esc(game.q)}\n\n⌛ انتهى الوقت! الإجابة: <b>${esc(game.o[game.a])}</b>`,
      { parse_mode: "HTML" }
    ).catch(() => {});
  }, 45_000);

  triviaGames.set(id, game);
});

bot.callbackQuery(/^tq:([a-z0-9]+):(\d)$/, async (ctx) => {
  const [, id, indexText] = ctx.match;
  const game = triviaGames.get(id);

  if (!game) {
    return ctx.answerCallbackQuery({ text: "السؤال انتهى." });
  }

  if (game.tried.has(ctx.from.id)) {
    return ctx.answerCallbackQuery({ text: "سجلت إجابتك بالفعل." });
  }

  game.tried.add(ctx.from.id);

  if (Number(indexText) !== game.a) {
    return ctx.answerCallbackQuery({
      text: "إجابة غير صحيحة، حاول في السؤال القادم."
    });
  }

  triviaGames.delete(id);
  clearTimeout(game.timer);

  const reward = rand(150, 300);
  await db.addCoins(ctx.from.id, reward);

  await ctx.answerCallbackQuery({ text: "إجابة صحيحة! 🎉" });

  return ctx.editMessageText(
    `🧠 ${esc(game.q)}\n\n✅ الإجابة: <b>${esc(game.o[game.a])}</b>\n🏆 ${mention(ctx.from.id, ctx.from.first_name)} كسب ${fmt(reward)} 💰`,
    { parse_mode: "HTML" }
  );
});

cmd(["riddle", "لغز", "فزوره"], async (ctx) => {
  const item = pick(D.riddles);

  return startChallenge(ctx, {
    question: `🧩 <b>لغز</b>\n\n${esc(item.q)}`,
    answers: item.a,
    answer: item.a[0],
    reward: rand(150, 300),
    seconds: 45
  });
});

cmd(["math", "حساب", "حسبها"], async (ctx) => {
  const a = rand(12, 99);
  const b = rand(11, 60);
  const op = pick(["+", "-", "×"]);

  const answer = op === "+"
    ? a + b
    : op === "-"
      ? a - b
      : a * b;

  return startChallenge(ctx, {
    question: `🧮 <b>تحدي الحساب</b>\n\nأسرع واحد يحل: <code>${a} ${op} ${b}</code> = ؟`,
    answers: [String(answer)],
    answer: String(answer),
    reward: rand(100, 200),
    seconds: 30
  });
});

cmd(["typing", "اسرع", "كتابه", "تحدي"], async (ctx) => {
  const word = pick(D.words);

  return startChallenge(ctx, {
    question: `⌨️ <b>تحدي السرعة</b>\n\nاكتب الجملة دي بالضبط:\n<code>${esc(word)}</code>`,
    answers: [word],
    answer: word,
    reward: rand(100, 200),
    seconds: 30
  });
});

// Prayer times and scheduled adhan. Audio is sent only when a user-provided authorized file/URL is configured.
cmd(["azan", "اذان", "الاذان", "صلاه", "الصلاه", "مواعيد", "مواعيد_الصلاه"], async (ctx) => {
  try {
    return reply(ctx, await prayer.timesText());
  } catch (error) {
    console.error("prayer times:", error.message);
    return reply(ctx, "تعذر جلب مواعيد الصلاة الآن. حاول بعد قليل.");
  }
});

cmd(["azan_on", "تفعيل_الاذان"], async (ctx) => {
  await db.setChat(ctx.chat.id, "prayer_on", true);
  return reply(ctx, "🕌 تم تفعيل تنبيهات الصلاة لهذا الشات.");
}, { admin: true });

cmd(["azan_off", "ايقاف_الاذان", "تعطيل_الاذان"], async (ctx) => {
  await db.setChat(ctx.chat.id, "prayer_on", false);
  return reply(ctx, "تم إيقاف تنبيهات الصلاة.");
}, { admin: true });

// Moderation commands.
const parseDuration = (raw) => {
  const m = norm(raw || "").match(/^(\d+)(m|h|d|د|س|ي)?$/);
  if (!m) return 0;

  return Number(m[1]) * ({
    m: 60,
    "د": 60,
    h: 3600,
    "س": 3600,
    d: 86400,
    "ي": 86400
  }[m[2] || "m"]);
};

async function protectTarget(ctx, id) {
  if (id === ctx.me.id) {
    await reply(ctx, "مش هقدر أنفذ الأمر على البوت نفسه.");
    return true;
  }

  if (await isAdmin(ctx, id)) {
    await reply(ctx, "مش هقدر أنفذ الأمر على مشرف.");
    return true;
  }

  return false;
}

async function moderationError(ctx, error) {
  console.error("moderation:", error);

  return reply(
    ctx,
    `فشل تنفيذ الأمر. تأكد من صلاحياتي كمشرف.\n<code>${esc(error.description || error.message)}</code>`
  );
}

cmd(["ban", "حظر", "بان"], async (ctx, args) => {
  const t = await getTarget(ctx, args);

  if (!t) return needTarget(ctx);
  if (await protectTarget(ctx, t.id)) return;

  try {
    await ctx.api.banChatMember(ctx.chat.id, t.id);
    return reply(ctx, `🔨 تم حظر ${mention(t.id, t.name)}.`);
  } catch (e) {
    return moderationError(ctx, e);
  }
}, { group: true, admin: true });

cmd(["unban", "فك_حظر", "الغاء_حظر"], async (ctx, args) => {
  const t = await getTarget(ctx, args);

  if (!t) return needTarget(ctx);

  try {
    await ctx.api.unbanChatMember(ctx.chat.id, t.id, { only_if_banned: true });
    return reply(ctx, `✅ تم فك الحظر عن ${mention(t.id, t.name)}.`);
  } catch (e) {
    return moderationError(ctx, e);
  }
}, { group: true, admin: true });

cmd(["kick", "طرد", "اطرد"], async (ctx, args) => {
  const t = await getTarget(ctx, args);

  if (!t) return needTarget(ctx);
  if (await protectTarget(ctx, t.id)) return;

  try {
    await ctx.api.banChatMember(ctx.chat.id, t.id);
    await ctx.api.unbanChatMember(ctx.chat.id, t.id);

    return reply(ctx, `👢 تم طرد ${mention(t.id, t.name)}.`);
  } catch (e) {
    return moderationError(ctx, e);
  }
}, { group: true, admin: true });

cmd(["mute", "كتم", "اكتم"], async (ctx, args) => {
  const t = await getTarget(ctx, args);

  if (!t) return needTarget(ctx);
  if (await protectTarget(ctx, t.id)) return;

  const seconds = parseDuration(t.rest[0]);

  try {
    await ctx.api.restrictChatMember(
      ctx.chat.id,
      t.id,
      { can_send_messages: false },
      seconds
        ? { until_date: Math.floor(Date.now() / 1000) + seconds }
        : {}
    );

    return reply(
      ctx,
      `🤐 تم كتم ${mention(t.id, t.name)} ${seconds ? `لمدة ${fmtT(seconds)}` : "بدون مدة"}.`
    );
  } catch (e) {
    return moderationError(ctx, e);
  }
}, { group: true, admin: true });

cmd(["unmute", "فك_كتم", "الغاء_كتم"], async (ctx, args) => {
  const t = await getTarget(ctx, args);

  if (!t) return needTarget(ctx);

  try {
    await ctx.api.restrictChatMember(ctx.chat.id, t.id, {
      can_send_messages: true,
      can_send_audios: true,
      can_send_documents: true,
      can_send_photos: true,
      can_send_videos: true,
      can_send_video_notes: true,
      can_send_voice_notes: true,
      can_send_polls: true,
      can_send_other_messages: true,
      can_add_web_page_previews: true
    });

    return reply(ctx, `🔊 تم فك كتم ${mention(t.id, t.name)}.`);
  } catch (e) {
    return moderationError(ctx, e);
  }
}, { group: true, admin: true });

cmd(["promote", "رفع", "ارفع", "رفع_مشرف"], async (ctx, args) => {
  const target = await getTarget(ctx, args);

  if (!target) return needTarget(ctx);

  try {
    await ctx.api.promoteChatMember(ctx.chat.id, target.id, {
      can_manage_chat: true,
      can_delete_messages: true,
      can_restrict_members: true,
      can_pin_messages: true,
      can_invite_users: true
    });

    adminCache.delete(`${ctx.chat.id}:${target.id}`);

    return reply(ctx, `👑 تم ترقية ${mention(target.id, target.name)} لمشرف.`);
  } catch (error) {
    return moderationError(ctx, error);
  }
}, { group: true, admin: true });

cmd(["demote", "تنزيل", "نزل", "تنزيل_مشرف"], async (ctx, args) => {
  const target = await getTarget(ctx, args);

  if (!target) return needTarget(ctx);

  try {
    await ctx.api.promoteChatMember(ctx.chat.id, target.id, {
      can_manage_chat: false,
      can_delete_messages: false,
      can_restrict_members: false,
      can_pin_messages: false,
      can_invite_users: false,
      can_promote_members: false,
      can_change_info: false,
      can_manage_video_chats: false
    });

    adminCache.delete(`${ctx.chat.id}:${target.id}`);

    return reply(ctx, `⬇️ تم تنزيل ${mention(target.id, target.name)} من الإشراف.`);
  } catch (error) {
    return moderationError(ctx, error);
  }
}, { group: true, admin: true });

cmd(["warn", "تحذير", "انذار", "حذر"], async (ctx, args) => {
  const t = await getTarget(ctx, args);

  if (!t) return needTarget(ctx);
  if (await protectTarget(ctx, t.id)) return;

  const row = (await db.q(
    `INSERT INTO warns(chat_id,user_id,n)
     VALUES($1,$2,1)
     ON CONFLICT(chat_id,user_id)
     DO UPDATE SET n=warns.n+1
     RETURNING n`,
    [ctx.chat.id, t.id]
  )).rows[0];

  if (row.n >= 3) {
    try {
      await ctx.api.banChatMember(ctx.chat.id, t.id);
      await db.q(
        "DELETE FROM warns WHERE chat_id=$1 AND user_id=$2",
        [ctx.chat.id, t.id]
      );

      return reply(
        ctx,
        `⚠️ ${mention(t.id, t.name)} وصل 3 تحذيرات وتم حظره.`
      );
    } catch (e) {
      return moderationError(ctx, e);
    }
  }

  return reply(
    ctx,
    `⚠️ ${mention(t.id, t.name)} حصل على تحذير ${row.n}/3.`
  );
}, { group: true, admin: true });

cmd(["unwarn", "ازاله_تحذير", "الغاء_تحذير"], async (ctx, args) => {
  const target = await getTarget(ctx, args);

  if (!target) return needTarget(ctx);

  const result = await db.q(
    "UPDATE warns SET n=GREATEST(n-1,0) WHERE chat_id=$1 AND user_id=$2 RETURNING n",
    [ctx.chat.id, target.id]
  );

  return reply(
    ctx,
    `✅ التحذيرات الحالية لـ ${mention(target.id, target.name)}: ${result.rows[0]?.n ?? 0}/3`
  );
}, { group: true, admin: true });

cmd(["warns", "تحذيرات", "انذارات"], async (ctx, args) => {
  const t = (await getTarget(ctx, args)) || {
    id: ctx.from.id,
    name: ctx.from.first_name
  };

  const row = (await db.q(
    "SELECT n FROM warns WHERE chat_id=$1 AND user_id=$2",
    [ctx.chat.id, t.id]
  )).rows[0];

  return reply(
    ctx,
    `⚠️ تحذيرات ${mention(t.id, t.name)}: <b>${row?.n || 0}/3</b>`
  );
}, { group: true });

cmd(["del", "مسح", "احذف", "امسح"], async (ctx) => {
  const msg = ctx.message.reply_to_message;

  if (!msg) return reply(ctx, "رد على الرسالة اللي عايز تمسحها.");

  try {
    await ctx.api.deleteMessage(ctx.chat.id, msg.message_id);
    await ctx.deleteMessage().catch(() => {});
  } catch (e) {
    return moderationError(ctx, e);
  }
}, { group: true, admin: true });

cmd(["pin", "تثبيت", "ثبت"], async (ctx) => {
  const msg = ctx.message.reply_to_message;

  if (!msg) return reply(ctx, "رد على الرسالة اللي عايز تثبتها.");

  try {
    await ctx.api.pinChatMessage(ctx.chat.id, msg.message_id);
    return reply(ctx, "📌 تم تثبيت الرسالة.");
  } catch (e) {
    return moderationError(ctx, e);
  }
}, { group: true, admin: true });

cmd(["unpin", "الغاء_تثبيت", "فك_تثبيت"], async (ctx) => {
  try {
    const msg = ctx.message.reply_to_message;

    await ctx.api.unpinChatMessage(
      ctx.chat.id,
      msg ? { message_id: msg.message_id } : {}
    );

    return reply(ctx, "تم إلغاء التثبيت.");
  } catch (e) {
    return moderationError(ctx, e);
  }
}, { group: true, admin: true });

cmd(["antilink", "منع_الروابط", "الروابط"], async (ctx) => {
  const value = await db.toggleChat(ctx.chat.id, "antilink");

  return reply(
    ctx,
    value ? "🚫 منع الروابط: <b>شغال</b>" : "🔗 منع الروابط: <b>متوقف</b>"
  );
}, { group: true, admin: true });

cmd(["welcome", "ترحيب", "الترحيب"], async (ctx) => {
  const value = await db.toggleChat(ctx.chat.id, "welcome_on");

  return reply(
    ctx,
    value ? "👋 الترحيب: <b>شغال</b>" : "الترحيب: <b>متوقف</b>"
  );
}, { group: true, admin: true });

// Owner utilities.
cmd(["give", "اعطاء", "اضافه_فلوس"], async (ctx, args) => {
  const t = await getTarget(ctx, args);

  if (!t) return needTarget(ctx);

  const amount = Number(args[0] === "" ? NaN : t.rest[0]);
  const n = Number.isSafeInteger(amount)
    ? amount
    : parseAmount(t.rest[0], 0);

  if (!Number.isSafeInteger(n) || n === 0) {
    return reply(ctx, "اكتب مبلغًا صحيحًا موجبًا أو سالبًا.");
  }

  const result = await db.addCoins(t.id, n);

  return reply(
    ctx,
    result === null
      ? "لا يمكن خصم هذا المبلغ من الرصيد الحالي."
      : `تم تعديل رصيد ${mention(t.id, t.name)} بمقدار ${n > 0 ? "+" : ""}${fmt(n)}.`
  );
}, { owner: true });

cmd(["broadcast", "اذاعه", "اذاعة"], async (ctx, args) => {
  const message = args.join(" ");

  if (!message) {
    return reply(ctx, "اكتب نص الرسالة بعد الأمر.");
  }

  const rows = (await db.q("SELECT id FROM chats")).rows;
  let sent = 0;

  for (const { id } of rows) {
    try {
      await bot.api.sendMessage(
        id,
        `📢 ${esc(message)}`,
        { parse_mode: "HTML" }
      );

      sent++;
    } catch {}

    await sleep(60);
  }

  return reply(ctx, `📢 تم الإرسال إلى ${sent}/${rows.length} شات.`);
}, { owner: true });

cmd(["stats", "احصائيات"], async (ctx) => {
  const users = (await db.q(
    "SELECT COUNT(*)::int AS n, COALESCE(SUM(coins+bank),0) AS total FROM users"
  )).rows[0];

  const chats = (await db.q(
    "SELECT COUNT(*)::int AS n FROM chats"
  )).rows[0];

  return reply(
    ctx,
    `📊 المستخدمون: <b>${users.n}</b>\n💬 الشاتات: <b>${chats.n}</b>\n💰 إجمالي العملات: <b>${fmt(users.total)}</b>`
  );
}, { owner: true });

const UPDATES = ["message", "callback_query"];

async function main() {
  await db.initDb();
  await bot.init();

  await bot.api.setMyCommands([
    { command: "help", description: "كل الأوامر" },
    { command: "balance", description: "رصيدك" },
    { command: "daily", description: "المكافأة اليومية" },
    { command: "work", description: "اكسب عملات" },
    { command: "slots", description: "ماكينة الحظ" },
    { command: "trivia", description: "سؤال ثقافة عامة" },
    { command: "xo", description: "إكس أو" },
    { command: "top", description: "أغنى اللاعبين" },
    { command: "azan", description: "مواعيد الصلاة" },
    { command: "ask", description: "اسأل ملك" }
  ]).catch((e) => console.error("setMyCommands:", e.message));

  const hookPath = `/${cfg.webhookPath}`;
  const useWebhook = cfg.mode === "webhook" && Boolean(cfg.webhookDomain);

  const handler = useWebhook
    ? webhookCallback(bot, "http", {
        secretToken: cfg.webhookSecret || undefined,
        timeoutMilliseconds: 55_000,
        onTimeout: "return"
      })
    : null;

  const server = http.createServer((req, res) => {
    if (req.url === "/" || req.url === "/health") {
      res.writeHead(200, {
        "content-type": "text/plain; charset=utf-8"
      });

      return res.end("Malek bot is alive 💎");
    }

    if (handler && req.method === "POST" && req.url === hookPath) {
      return handler(req, res);
    }

    res.writeHead(404);
    res.end("Not found");
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(cfg.port, "0.0.0.0", resolve);
  });

  console.log(`🌐 HTTP on :${cfg.port} (${useWebhook ? "webhook" : "polling"})`);

  if (useWebhook) {
    await bot.api.setWebhook(
      cfg.webhookDomain + hookPath,
      {
        secret_token: cfg.webhookSecret || undefined,
        drop_pending_updates: false,
        allowed_updates: UPDATES
      }
    );

    console.log("✅ Webhook set:", cfg.webhookDomain + hookPath);
  } else {
    await bot.api.deleteWebhook({ drop_pending_updates: false });

    run(bot, {
      runner: {
        fetch: {
          allowed_updates: UPDATES
        }
      }
    });

    console.log("✅ Polling started");
  }

  prayer.startScheduler(bot);

  console.log(`💎 Malek bot is up as @${bot.botInfo.username}`);

  const shutdown = async () => {
    console.log("Shutting down...");

    try {
      await bot.api.deleteWebhook({ drop_pending_updates: false });
    } catch {}

    server.close();
    await db.pool.end().catch(() => {});
    process.exit(0);
  };

  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}

main().catch((error) => {
  console.error("FATAL:", error);
  process.exit(1);
});

process.on("unhandledRejection", (error) => {
  console.error("Unhandled rejection:", error);
});
