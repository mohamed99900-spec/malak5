import http from "node:http";
import { Bot, InlineKeyboard, webhookCallback } from "grammy";
import { run } from "@grammyjs/runner";
import { cfg } from "./config.js";
import * as db from "./db.js";
import * as ai from "./ai.js";
import * as prayer from "./prayer.js";
import * as D from "./data.js";

const bot = new Bot(cfg.token);
bot.catch((e) => console.error("BOT ERROR:", e.error?.description || e.error || e));

/* ======================= أدوات مساعدة ======================= */
const rand = (a, b) => Math.floor(Math.random() * (b - a + 1)) + a;
const pick = (a) => a[Math.floor(Math.random() * a.length)];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fmt = (n) => Number(n).toLocaleString("en-US");
const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const mention = (id, name) => `<a href="tg://user?id=${id}">${esc(name || "مجهول")}</a>`;
const levelOf = (xp) => Math.floor(Math.sqrt(xp / 40)) + 1;
const norm = (s) =>
  String(s || "").toLowerCase()
    .replace(/[\u064B-\u065F\u0670\u0640]/g, "")
    .replace(/[أإآٱ]/g, "ا").replace(/ى/g, "ي").replace(/ة/g, "ه")
    .replace(/[٠-٩]/g, (d) => "٠١٢٣٤٥٦٧٨٩".indexOf(d))
    .trim();
const fmtT = (s) => (s < 60 ? `${s} ثانية` : s < 3600 ? `${Math.ceil(s / 60)} دقيقة` : `${Math.floor(s / 3600)} س و ${Math.ceil((s % 3600) / 60)} د`);

const reply = (ctx, text, extra = {}) =>
  ctx.reply(text, {
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
    reply_parameters: ctx.message ? { message_id: ctx.message.message_id, allow_sending_without_reply: true } : undefined,
    ...extra,
  });

function parseAmount(s, max) {
  if (!s) return NaN;
  s = norm(s);
  if (["all", "كله", "الكل", "كل", "max"].includes(s)) return max;
  const m = s.match(/^(\d+(?:\.\d+)?)(k|ك|الف)?$/);
  if (!m) return NaN;
  let n = Number(m[1]);
  if (m[2]) n *= 1000;
  return Math.floor(n);
}

async function takeBet(ctx, raw, { min = 10, max = 100000 } = {}) {
  const u = await db.getUser(ctx.from.id);
  const bet = parseAmount(raw, Math.min(u.coins, max));
  if (!Number.isFinite(bet) || bet < min) {
    await reply(ctx, `اكتب المبلغ صح يا معلم 💸 (الحد الأدنى ${fmt(min)})\nمثال: <code>${ctx.message.text.split(/\s/)[0]} 500</code>`);
    return null;
  }
  if (bet > max) { await reply(ctx, `الحد الأقصى للرهان ${fmt(max)} 💰`); return null; }
  const left = await db.addCoins(ctx.from.id, -bet);
  if (left === null) { await reply(ctx, `رصيدك مش مكفي يا فقير 😂 معاك ${fmt(u.coins)} 💰`); return null; }
  return bet;
}

/* ======================= صلاحيات وأهداف ======================= */
const adminCache = new Map();
async function isAdmin(ctx, uid = ctx.from.id) {
  if (uid === cfg.owner) return true;
  if (ctx.chat.type === "private") return false;
  const k = `${ctx.chat.id}:${uid}`;
  const c = adminCache.get(k);
  if (c && Date.now() - c.t < 60000) return c.v;
  try {
    const m = await ctx.api.getChatMember(ctx.chat.id, uid);
    const v = ["creator", "administrator"].includes(m.status);
    adminCache.set(k, { t: Date.now(), v });
    return v;
  } catch { return false; }
}

async function getTarget(ctx, args) {
  const r = ctx.message.reply_to_message;
  if (r?.from && !r.from.is_bot) {
    await db.upsertUser(r.from);
    return { id: r.from.id, name: r.from.first_name, rest: args };
  }
  const a = args[0];
  if (!a) return null;
  if (/^\d{5,}$/.test(a)) {
    const u = await db.getUser(Number(a));
    return { id: Number(a), name: u?.name || a, rest: args.slice(1) };
  }
  if (a.startsWith("@")) {
    const u = (await db.q("SELECT id,name FROM users WHERE lower(username)=lower($1)", [a.slice(1)])).rows[0];
    if (u) return { id: u.id, name: u.name, rest: args.slice(1) };
  }
  return null;
}

async function protect(ctx, id) {
  if (id === ctx.me.id) { await reply(ctx, "عايز تلعب عليا انا؟ 😂 احا يا زفت ملكش دعوة بيا"); return true; }
  if (await isAdmin(ctx, id)) { await reply(ctx, "ده مشرف يا معلم، مقدرش المس شعره 😅"); return true; }
  return false;
}
const tgErr = (ctx, e) =>
  reply(ctx, `معرفتش انفذ ❌ اتأكد اني <b>مشرف</b> وعندي الصلاحيات.\n<code>${esc(e.description || e.message)}</code>`);
const needTarget = (ctx) => reply(ctx, "رد على رسالة الشخص او اكتب @يوزره او الـ ID يا معلم 👆");

/* ======================= Middleware ======================= */
const touched = new Map();
bot.use(async (ctx, next) => {
  try {
    if (ctx.from && !ctx.from.is_bot) {
      const k = "u" + ctx.from.id;
      if (Date.now() - (touched.get(k) || 0) > 600000) { touched.set(k, Date.now()); await db.upsertUser(ctx.from); }
    }
    if (ctx.chat) {
      const k = "c" + ctx.chat.id;
      if (Date.now() - (touched.get(k) || 0) > 600000) { touched.set(k, Date.now()); await db.touchChat(ctx.chat); }
    }
  } catch (e) { console.error("touch:", e.message); }
  return next();
});

/* ======================= نظام الاوامر ======================= */
const commands = new Map();
function cmd(names, fn, opts = {}) {
  for (const n of names) commands.set(norm(n), { fn, ...opts });
}

function parse(ctx, text) {
  const m = text.match(/^(\/)?([^\s@\/]+)(?:@(\w+))?(?:\s+([\s\S]*))?$/);
  if (!m) return null;
  if (m[3] && m[3].toLowerCase() !== ctx.me.username.toLowerCase()) return null;
  const name = norm(m[2]);
  if (!m[1] && /^[a-z]/.test(name)) return null; // الانجليزي لازم "/"
  return { name, args: (m[4] || "").trim().split(/\s+/).filter(Boolean) };
}

const throttle = new Map();
async function runCmd(ctx, c, args) {
  const priv = ctx.chat.type === "private";
  if (Date.now() - (throttle.get(ctx.from.id) || 0) < 700) return;
  throttle.set(ctx.from.id, Date.now());
  if (c.group && priv) return reply(ctx, "الامر ده في الجروبات بس يا معلم 👥");
  if (c.owner && ctx.from.id !== cfg.owner) return reply(ctx, "ده للمطور بس 👑");
  if (c.admin && !priv && !(await isAdmin(ctx))) return reply(ctx, "للمشرفين بس يا حبيبي 😏✋");
  try { await c.fn(ctx, args); }
  catch (e) { console.error("cmd error:", e); await reply(ctx, "حصلت مشكلة صغيرة، جرب تاني 🙏").catch(() => {}); }
}

/* ======================= مراقبة الروابط ======================= */
const LINK_RE = /(https?:\/\/|t\.me\/|telegram\.me\/|www\.|\b[a-z0-9-]+\.(com|net|org|io|me|xyz|info|ly)\b)/i;
async function guardLinks(ctx, text) {
  const st = await db.getChat(ctx.chat.id);
  if (!st.antilink) return false;
  const ent = (ctx.message.entities || []).some((e) => e.type === "url" || e.type === "text_link");
  if (!ent && !LINK_RE.test(text)) return false;
  if (await isAdmin(ctx)) return false;
  try {
    await ctx.deleteMessage();
    await ctx.api.sendMessage(ctx.chat.id, `🚫 ${mention(ctx.from.id, ctx.from.first_name)} ممنوع الروابط هنا يا معلم!`, { parse_mode: "HTML" });
    return true;
  } catch { return false; }
}

/* ======================= XP ======================= */
const xpCd = new Map();
async function xpTick(ctx) {
  const id = ctx.from.id;
  if (Date.now() - (xpCd.get(id) || 0) < 45000) return;
  xpCd.set(id, Date.now());
  const r = await db.addXp(id, rand(3, 8));
  if (!r) return;
  const a = levelOf(r.old), b = levelOf(r.xp);
  if (b > a) {
    const bonus = b * 150;
    await db.addCoins(id, bonus);
    await ctx.reply(`🎉 ${mention(id, ctx.from.first_name)} طلعت <b>لفل ${b}</b>! هدية: +${fmt(bonus)} 💰`, { parse_mode: "HTML" });
  }
}

/* ======================= التحديات (اسرع واحد) ======================= */
const challenges = new Map();
async function checkChallenge(ctx, text) {
  const ch = challenges.get(ctx.chat.id);
  if (!ch) return false;
  if (Date.now() > ch.exp) { challenges.delete(ctx.chat.id); return false; }
  if (!ch.answers.includes(norm(text))) return false;
  challenges.delete(ctx.chat.id);
  await db.addCoins(ctx.from.id, ch.reward);
  await reply(ctx, `🏆 ${mention(ctx.from.id, ctx.from.first_name)} جاوب صح! الاجابة: <b>${esc(ch.show)}</b>\n+${fmt(ch.reward)} 💰`);
  return true;
}
async function startChallenge(ctx, { text, answers, show, reward, secs = 40 }) {
  const cur = challenges.get(ctx.chat.id);
  if (cur && Date.now() < cur.exp) return reply(ctx, "فيه تحدي شغال لسه! خلصوه الاول 🔥");
  const ch = { answers: answers.map(norm), show, reward, exp: Date.now() + secs * 1000 };
  challenges.set(ctx.chat.id, ch);
  const chatId = ctx.chat.id;
  setTimeout(() => {
    if (challenges.get(chatId) === ch) {
      challenges.delete(chatId);
      bot.api.sendMessage(chatId, `⏰ الوقت خلص ومحدش جاوب 😂 الاجابة: <b>${esc(show)}</b>`, { parse_mode: "HTML" }).catch(() => {});
    }
  }, secs * 1000);
  await reply(ctx, `${text}\n\n⏱ معاكم ${secs} ثانية • الجايزة <b>${fmt(reward)}</b> 💰`);
}

/* ======================= المعالج الرئيسي ======================= */
bot.on("message:new_chat_members", async (ctx) => {
  const st = await db.getChat(ctx.chat.id);
  for (const m of ctx.message.new_chat_members) {
    if (m.id === ctx.me.id) {
      await ctx.reply("💎 <b>ملك وصلت!</b>\nارفعوني مشرفة عشان اقدر ادير الجروب، واكتبوا <b>اوامر</b> 😎", { parse_mode: "HTML" });
      continue;
    }
    if (m.is_bot || !st.welcome_on) continue;
    await ctx.reply(pick(D.welcomes)(mention(m.id, m.first_name), esc(ctx.chat.title)), { parse_mode: "HTML" });
  }
});

bot.on("message:text", async (ctx) => {
  if (ctx.from.is_bot) return;
  const text = ctx.message.text.trim();
  const priv = ctx.chat.type === "private";

  if (!priv && (await guardLinks(ctx, text))) return;
  if (await checkChallenge(ctx, text)) return;
  if (!priv) xpTick(ctx).catch(() => {});

  const p = parse(ctx, text);
  if (p) {
    const c = commands.get(p.name);
    if (c) return runCmd(ctx, c, p.args);
  }
  await maybeAI(ctx, text);
});

/* ======================= الذكاء الاصطناعي ======================= */
const DEV_RE = /(مين|من|who).*(طورك|صنعك|عملك|برمجك|صممك|مطورك|صانعك|مبرمجك|ابوك|خلقك|made you|created you|developed you|built you)/i;
const aiCd = new Map();
async function maybeAI(ctx, text) {
  const priv = ctx.chat.type === "private";
  const mentioned = new RegExp("@" + ctx.me.username, "i").test(text);
  const toBot = ctx.message.reply_to_message?.from?.id === ctx.me.id;
  const called = /^(يا\s+)?(ملك|malek)(?=$|[\s،,!؟?.])/i.test(text);
  if (!(priv || mentioned || toBot || called)) return;
  if (Date.now() - (aiCd.get(ctx.from.id) || 0) < 2000) return;
  aiCd.set(ctx.from.id, Date.now());

  const prompt = text
    .replace(new RegExp("@" + ctx.me.username, "ig"), "")
    .replace(/^(يا\s+)?(ملك|malek)[\s،,]*/i, "")
    .trim();
  if (!prompt) return reply(ctx, pick(["ايوه يا معلم؟ 😎", "قول يا باشا، سامعاك 👂", "نعم؟ عايز ايه يا قمر 😏"]));
  if (DEV_RE.test(norm(prompt))) return reply(ctx, D.DEV_ANSWER);

  await ctx.api.sendChatAction(ctx.chat.id, "typing").catch(() => {});
  const out = await ai.chat(ctx.chat.id, ctx.from.first_name, prompt);
  await reply(ctx, out ? esc(out) : "دماغي هنجت ثانية 😅 اسأل تاني");
}

cmd(["ask", "اسال", "اسألني", "جاوب"], async (ctx, args) => {
  const prompt = args.join(" ") || ctx.message.reply_to_message?.text || "";
  if (!prompt) return reply(ctx, "اكتب سؤالك بعد الامر يا معلم. مثال: <code>اسال مين اخترع الكهربا</code>");
  if (DEV_RE.test(norm(prompt))) return reply(ctx, D.DEV_ANSWER);
  await ctx.api.sendChatAction(ctx.chat.id, "typing").catch(() => {});
  const out = await ai.chat(ctx.chat.id, ctx.from.first_name, prompt);
  await reply(ctx, out ? esc(out) : "دماغي هنجت ثانية 😅 اسأل تاني");
});

cmd(["joke", "نكته", "نكتة", "هزار"], async (ctx) => {
  const j = (await ai.joke()) || pick(D.jokes);
  await reply(ctx, "😂 " + esc(j));
});

cmd(["roast", "روست", "اتريق", "هزأه"], async (ctx, args) => {
  const t = await getTarget(ctx, args);
  const name = t?.name || ctx.from.first_name;
  const out = (await ai.roast(name)) || pick(D.roasts).replace("{n}", name);
  await reply(ctx, esc(out));
});

cmd(["love", "حب", "نسبه_الحب"], async (ctx, args) => {
  const t = await getTarget(ctx, args);
  if (!t) return reply(ctx, "رد على حد عشان اقيس نسبة الحب 💘");
  const s = [ctx.from.id, t.id].sort().join(":");
  let x = 0;
  for (const ch of s) x = (x * 31 + ch.charCodeAt(0)) % 101;
  const bar = "❤️".repeat(Math.round(x / 10)) + "🖤".repeat(10 - Math.round(x / 10));
  await reply(ctx, `💘 نسبة الحب بين ${mention(ctx.from.id, ctx.from.first_name)} و ${mention(t.id, t.name)}\n${bar}\n<b>${x}%</b>`);
});

/* ======================= المساعدة ======================= */
cmd(["start", "help", "اوامر", "الاوامر", "مساعده", "ابدا"], async (ctx) => {
  await reply(ctx,
`💎 <b>ملك — اقوى بوت مصري</b> 💎
انا ملك رضوان حبيبه ابو فرج وبس 😎
<i>الاوامر شغالة بالعربي من غير "/"</i>

<b>💰 الاقتصاد</b>
رصيد • يومي • شغل • ايداع • سحب • تحويل • سرقة • حماية • توب

<b>🎮 الالعاب</b>
سلوت [مبلغ] • عملة [طرة/كتابة] [مبلغ]
كورة • سلة • سهم [مبلغ] • حجر [مبلغ] • اكس
سؤال • لغز • حساب • اسرع

<b>🕌 الصلاة (توقيت القاهرة)</b>
اذان • تفعيل_الاذان • ايقاف_الاذان

<b>🤖 ذكاء ومرح</b>
ملك [سؤالك] • اسال • نكتة • روست • حب

<b>🛡 ادارة (للمشرفين)</b>
حظر • فك_حظر • طرد • كتم [مدة] • فك_كتم
رفع • تنزيل • تحذير • ازالة_تحذير • تحذيرات
مسح • تثبيت • الغاء_تثبيت • منع_الروابط • ترحيب

<i>الجروبات: رد على الشخص او اكتب @يوزره</i>`);
});

/* ======================= الاقتصاد ======================= */
cmd(["balance", "bal", "رصيد", "فلوسي", "بطاقتي", "بطاقه", "حسابي", "انا"], async (ctx) => {
  const tg = ctx.message.reply_to_message?.from;
  if (tg && !tg.is_bot) await db.upsertUser(tg);
  const id = tg && !tg.is_bot ? tg.id : ctx.from.id;
  const u = await db.getUser(id);
  const lvl = levelOf(u.xp);
  const rank = await db.rank(id);
  const shield = u.shield_until && new Date(u.shield_until) > new Date() ? "🛡 شغالة" : "—";
  await reply(ctx,
`💳 <b>بطاقة ${esc(u.name)}</b>
━━━━━━━━━━━━
⭐ المستوى: <b>${lvl}</b>  (XP ${fmt(u.xp)}/${fmt(40 * lvl * lvl)})
👛 المحفظة: <b>${fmt(u.coins)}</b> 💰
🏦 البنك: <b>${fmt(u.bank)}</b> 💰
💎 الاجمالي: <b>${fmt(u.coins + u.bank)}</b> 💰
🔥 الستريك: <b>${u.streak}</b> يوم
🛡 الحماية: ${shield}
🏆 الترتيب: <b>#${rank}</b>`);
});

cmd(["daily", "يومي", "راتب", "مكافاه"], async (ctx) => {
  const cd = await db.cooldown(ctx.from.id, "daily", 20 * 3600);
  if (cd) return reply(ctx, `⏳ خدت يوميتك خلاص! ارجع بعد <b>${fmtT(cd)}</b>`);
  const u = await db.getUser(ctx.from.id);
  const fresh = u.last_daily && Date.now() - new Date(u.last_daily).getTime() < 48 * 3600 * 1000;
  const streak = fresh ? u.streak + 1 : 1;
  const reward = 300 + Math.min(streak, 30) * 50;
  await db.q("UPDATE users SET coins=coins+$2, streak=$3, last_daily=now() WHERE id=$1", [ctx.from.id, reward, streak]);
  await reply(ctx, `🎁 <b>المكافأة اليومية</b>\n+${fmt(reward)} 💰\n🔥 ستريك: ${streak} يوم ${streak >= 7 ? "— انت وحش! 🦁" : ""}`);
});

cmd(["work", "شغل", "اشتغل", "عمل"], async (ctx) => {
  const cd = await db.cooldown(ctx.from.id, "work", 3600);
  if (cd) return reply(ctx, `😮‍💨 تعبان! ارتاح <b>${fmtT(cd)}</b> الاول`);
  const u = await db.getUser(ctx.from.id);
  const j = pick(D.jobs);
  const pay = Math.floor(rand(j.min, j.max) * (1 + levelOf(u.xp) * 0.04));
  await db.addCoins(ctx.from.id, pay);
  await db.addXp(ctx.from.id, 10);
  await reply(ctx, `${j.t}\n💵 +${fmt(pay)} 💰`);
});

cmd(["deposit", "ايداع", "ودع", "dep"], async (ctx, args) => {
  const u = await db.getUser(ctx.from.id);
  const n = parseAmount(args[0], u.coins);
  if (!Number.isFinite(n) || n < 1) return reply(ctx, "اكتب المبلغ: <code>ايداع 500</code> او <code>ايداع كله</code>");
  const r = await db.q("UPDATE users SET coins=coins-$2, bank=bank+$2 WHERE id=$1 AND coins>=$2 RETURNING coins,bank", [ctx.from.id, n]);
  if (!r.rowCount) return reply(ctx, "فلوس المحفظة مش كفاية 😅");
  await reply(ctx, `🏦 ودعت <b>${fmt(n)}</b> 💰 في البنك (محمية من السرقة)`);
});

cmd(["withdraw", "سحب", "اسحب", "with"], async (ctx, args) => {
  const u = await db.getUser(ctx.from.id);
  const n = parseAmount(args[0], u.bank);
  if (!Number.isFinite(n) || n < 1) return reply(ctx, "اكتب المبلغ: <code>سحب 500</code> او <code>سحب كله</code>");
  const r = await db.q("UPDATE users SET coins=coins+$2, bank=bank-$2 WHERE id=$1 AND bank>=$2 RETURNING coins,bank", [ctx.from.id, n]);
  if (!r.rowCount) return reply(ctx, "رصيد البنك مش كفاية 😅");
  await reply(ctx, `🏧 سحبت <b>${fmt(n)}</b> 💰 من البنك`);
});

cmd(["send", "حول", "تحويل", "اديله"], async (ctx, args) => {
  const t = await getTarget(ctx, args);
  if (!t) return needTarget(ctx);
  if (t.id === ctx.from.id) return reply(ctx, "بتحول لنفسك؟ 😂");
  const n = parseAmount(t.rest[0], 0);
  if (!Number.isFinite(n) || n < 1) return reply(ctx, "اكتب المبلغ: رد على الشخص واكتب <code>تحويل 500</code>");
  if ((await db.addCoins(ctx.from.id, -n)) === null) return reply(ctx, "رصيدك مش كفاية 😂");
  await db.addCoins(t.id, n);
  await reply(ctx, `💸 ${mention(ctx.from.id, ctx.from.first_name)} حوّل <b>${fmt(n)}</b> 💰 لـ ${mention(t.id, t.name)}`);
});

cmd(["rob", "سرقه", "اسرق", "سرق"], async (ctx, args) => {
  const t = await getTarget(ctx, args);
  if (!t) return needTarget(ctx);
  if (t.id === ctx.from.id) return reply(ctx, "تسرق نفسك؟ ده انت عبقري 😂");
  if (t.id === ctx.me.id) return reply(ctx, "تسرقني انا؟ احا يا زفت دي انا ملك! 😂");
  const thief = await db.getUser(ctx.from.id);
  const vic = await db.getUser(t.id);
  if (!vic) return reply(ctx, "الشخص ده لسه مسجلش في البوت");
  if (thief.coins < 200) return reply(ctx, "لازم يبقى معاك 200 💰 على الاقل عشان تتجرأ 😏");
  if (vic.shield_until && new Date(vic.shield_until) > new Date()) return reply(ctx, "🛡 الراجل ده معاه حماية، مفيش نصيب!");
  if (vic.coins < 300) return reply(ctx, "ده مفلس اصلا، هتسرق منه ايه؟ 😂");
  const cd = await db.cooldown(ctx.from.id, "rob", 600);
  if (cd) return reply(ctx, `🚔 الشرطة بتدور عليك! استنى <b>${fmtT(cd)}</b>`);
  if (Math.random() < 0.45) {
    const amt = Math.floor(vic.coins * rand(10, 30) / 100);
    if ((await db.addCoins(t.id, -amt)) === null) return reply(ctx, "الضحية صرف فلوسه قبل ما تلحق 😂");
    await db.addCoins(ctx.from.id, amt);
    await reply(ctx, `🥷 نجحت! سرقت <b>${fmt(amt)}</b> 💰 من ${mention(t.id, t.name)}`);
  } else {
    const fine = Math.min(thief.coins, rand(100, 400));
    await db.addCoins(ctx.from.id, -fine);
    await db.addCoins(t.id, fine);
    await reply(ctx, `🚔 اتمسكت! دفعت غرامة <b>${fmt(fine)}</b> 💰 لـ ${mention(t.id, t.name)} 😂`);
  }
}, { group: true });

cmd(["shield", "حمايه", "درع"], async (ctx) => {
  const r = await db.q(
    `UPDATE users SET coins=coins-2000,
       shield_until=GREATEST(COALESCE(shield_until,now()),now())+interval '24 hours'
     WHERE id=$1 AND coins>=2000 RETURNING shield_until`, [ctx.from.id]);
  if (!r.rowCount) return reply(ctx, "الحماية بـ <b>2,000</b> 💰 ورصيدك مش كفاية");
  await reply(ctx, "🛡 اتفعلت حماية 24 ساعة ضد السرقة!");
});

cmd(["top", "توب", "الاغنياء", "ترتيب"], async (ctx) => {
  const rows = await db.top(10);
  const m = ["🥇", "🥈", "🥉"];
  await reply(ctx, "🏆 <b>اغنى 10 في ملك</b>\n\n" + rows.map((r, i) => `${m[i] || `<b>${i + 1}.</b>`} ${esc(r.name)} — <b>${fmt(r.total)}</b> 💰`).join("\n"));
});

/* ======================= الالعاب ======================= */
cmd(["slots", "سلوت", "ماكينه", "سلوتس"], async (ctx, args) => {
  const bet = await takeBet(ctx, args[0]);
  if (!bet) return;
  const d = await ctx.replyWithDice("🎰");
  await sleep(2700);
  const v = d.dice.value - 1;
  const r = [v & 3, (v >> 2) & 3, (v >> 4) & 3];
  const sym = ["🍫BAR", "🍇", "🍋", "7️⃣"];
  const line = r.map((x) => sym[x]).join(" | ");
  let mult = 0, label = "";
  if (r[0] === r[1] && r[1] === r[2]) { mult = r[0] === 3 ? 10 : 5; label = r[0] === 3 ? "💎 جاكبوت 777!!" : "🔥 ثلاثة متشابهين!"; }
  else if (r[0] === r[1] || r[1] === r[2] || r[0] === r[2]) { mult = 1.5; label = "✨ اتنين متشابهين"; }
  if (mult) {
    const pay = Math.floor(bet * mult);
    await db.addCoins(ctx.from.id, pay);
    await reply(ctx, `🎰 ${line}\n${label}\n🏆 كسبت <b>${fmt(pay - bet)}</b> 💰`);
  } else {
    await reply(ctx, `🎰 ${line}\n💔 ${pick(D.loseBanter)} -${fmt(bet)} 💰`);
  }
});

cmd(["flip", "عمله", "طره", "قلب"], async (ctx, args) => {
  const side = args.find((a) => ["طره", "صوره", "كتابه", "head", "heads", "tail", "tails", "كتابة", "طرة", "صورة"].includes(norm(a)));
  const amt = args.find((a) => a !== side);
  if (!side) return reply(ctx, "اختار: <code>عملة طرة 500</code> او <code>عملة كتابة 500</code>");
  const bet = await takeBet(ctx, amt);
  if (!bet) return;
  const mine = ["طره", "صوره", "head", "heads"].includes(norm(side)) ? "H" : "T";
  const res = Math.random() < 0.5 ? "H" : "T";
  const nm = { H: "🪙 طرة", T: "🪙 كتابة" };
  if (mine === res) {
    await db.addCoins(ctx.from.id, bet * 2);
    await reply(ctx, `${nm[res]}\n🏆 كسبت <b>${fmt(bet)}</b> 💰`);
  } else await reply(ctx, `${nm[res]}\n💔 ${pick(D.loseBanter)} -${fmt(bet)} 💰`);
});

const DICE = [
  [["football", "كوره", "goal"], "⚽", (v) => v >= 3, 2, 3800],
  [["basket", "سله"], "🏀", (v) => v >= 4, 2.5, 3500],
  [["dart", "سهم", "دارت"], "🎯", (v) => v === 6, 4, 3200],
];
for (const [names, emoji, isWin, mult, wait] of DICE) {
  cmd(names, async (ctx, args) => {
    const bet = await takeBet(ctx, args[0]);
    if (!bet) return;
    const d = await ctx.replyWithDice(emoji);
    await sleep(wait);
    if (isWin(d.dice.value)) {
      const pay = Math.floor(bet * mult);
      await db.addCoins(ctx.from.id, pay);
      await reply(ctx, `🔥 تصويبة جامدة! كسبت <b>${fmt(pay - bet)}</b> 💰`);
    } else await reply(ctx, `💔 ضاعت منك! ${pick(D.loseBanter)} -${fmt(bet)} 💰`);
  });
}

// حجر ورقة مقص
const rpsUsed = new Set();
cmd(["rps", "حجر", "حجره", "مقص"], async (ctx, args) => {
  let bet = 0;
  if (args[0]) {
    const u = await db.getUser(ctx.from.id);
    bet = parseAmount(args[0], Math.min(u.coins, 100000));
    if (!Number.isFinite(bet) || bet < 0) return reply(ctx, "المبلغ غلط يا معلم");
    if (bet > u.coins) return reply(ctx, "رصيدك مش كفاية 😂");
  }
  const kb = new InlineKeyboard()
    .text("🪨 حجر", `rps:${ctx.from.id}:${bet}:r`)
    .text("📄 ورقة", `rps:${ctx.from.id}:${bet}:p`)
    .text("✂️ مقص", `rps:${ctx.from.id}:${bet}:s`);
  await reply(ctx, `🎮 <b>حجر ورقة مقص</b> ${bet ? `— الرهان ${fmt(bet)} 💰` : "(تسلية)"}\nاختار:`, { reply_markup: kb });
});
bot.callbackQuery(/^rps:(\d+):(\d+):([rps])$/, async (ctx) => {
  const [, uid, betS, ch] = ctx.match;
  if (ctx.from.id !== Number(uid)) return ctx.answerCallbackQuery({ text: "دي مش لعبتك يا حشري 😂" });
  const key = `${ctx.chat?.id}:${ctx.callbackQuery.message?.message_id}`;
  if (rpsUsed.has(key)) return ctx.answerCallbackQuery();
  rpsUsed.add(key);
  const bet = Number(betS);
  if (bet > 0 && (await db.addCoins(ctx.from.id, -bet)) === null) {
    await ctx.answerCallbackQuery();
    return ctx.editMessageText("رصيدك مش كفاية 😂");
  }
  const bc = pick(["r", "p", "s"]);
  const beats = { r: "s", p: "r", s: "p" };
  const nm = { r: "🪨 حجر", p: "📄 ورقة", s: "✂️ مقص" };
  let txt;
  if (ch === bc) { if (bet) await db.addCoins(ctx.from.id, bet); txt = "🤝 تعادل" + (bet ? " — فلوسك رجعتلك" : ""); }
  else if (beats[ch] === bc) { if (bet) await db.addCoins(ctx.from.id, bet * 2); txt = `🏆 كسبت${bet ? ` +${fmt(bet)} 💰` : "!"}`; }
  else txt = `😂 خسرت${bet ? ` -${fmt(bet)} 💰` : ""}`;
  await ctx.answerCallbackQuery();
  await ctx.editMessageText(`انت: ${nm[ch]}\nانا: ${nm[bc]}\n\n${txt}`);
});

// اكس او
const xos = new Map();
const LINES = [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]];
const winner = (b) => {
  for (const [x, y, z] of LINES) if (b[x] && b[x] === b[y] && b[x] === b[z]) return b[x];
  return b.every(Boolean) ? "draw" : null;
};
function botMove(b) {
  const find = (p) => {
    for (const l of LINES) {
      const v = l.map((i) => b[i]);
      if (v.filter((x) => x === p).length === 2 && v.includes(null)) return l[v.indexOf(null)];
    }
    return -1;
  };
  const free = b.map((x, i) => (x ? -1 : i)).filter((i) => i >= 0);
  let i = -1;
  if (Math.random() > 0.25) { // 25% بتغلط عشان تعرف تكسبها
    i = find("O");
    if (i < 0) i = find("X");
    if (i < 0 && !b[4]) i = 4;
  }
  if (i < 0) i = pick(free);
  b[i] = "O";
}
function xoKb(id, b, done) {
  const kb = new InlineKeyboard();
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      const i = r * 3 + c, v = b[i];
      kb.text(v === "X" ? "❌" : v === "O" ? "⭕" : "▫️", done || v ? "noop" : `xo:${id}:${i}`);
    }
    kb.row();
  }
  return kb;
}
cmd(["xo", "اكس", "اكس_او", "اكسو"], async (ctx) => {
  const id = Math.random().toString(36).slice(2, 8);
  const g = { uid: ctx.from.id, b: Array(9).fill(null) };
  xos.set(id, g);
  setTimeout(() => xos.delete(id), 30 * 60 * 1000);
  await reply(ctx, "❌⭕ <b>اكس او ضد ملك</b>\nانت ❌ وانا ⭕ — ابدأ! (فوز +200 💰)", { reply_markup: xoKb(id, g.b) });
});
bot.callbackQuery("noop", (ctx) => ctx.answerCallbackQuery());
bot.callbackQuery(/^xo:(\w+):(\d)$/, async (ctx) => {
  const [, id, iS] = ctx.match;
  const g = xos.get(id);
  if (!g) return ctx.answerCallbackQuery({ text: "اللعبة خلصت ⌛" });
  if (ctx.from.id !== g.uid) return ctx.answerCallbackQuery({ text: "دي مش لعبتك يا حشري 😂" });
  const i = Number(iS);
  if (g.b[i]) return ctx.answerCallbackQuery();
  g.b[i] = "X";
  let w = winner(g.b);
  if (!w) { botMove(g.b); w = winner(g.b); }
  await ctx.answerCallbackQuery();
  if (w) {
    xos.delete(id);
    let txt;
    if (w === "X") { await db.addCoins(g.uid, 200); txt = "🏆 كسبت! +200 💰"; }
    else if (w === "O") txt = "😂 ملك غلبتك! حظ اوفر يا بطل";
    else { await db.addCoins(g.uid, 30); txt = "🤝 تعادل! +30 💰"; }
    await ctx.editMessageText(`❌⭕ <b>النتيجة</b>\n${txt}`, { parse_mode: "HTML", reply_markup: xoKb(id, g.b, true) });
  } else {
    await ctx.editMessageReplyMarkup({ reply_markup: xoKb(id, g.b) });
  }
});

// سؤال ثقافة عامة (بيتولد جديد كل مرة بالذكاء الاصطناعي + بنك احتياطي)
const trivias = new Map();
function shuffleQ(t) {
  const o = t.o.map((x, i) => ({ x, c: i === t.a }));
  for (let i = o.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [o[i], o[j]] = [o[j], o[i]]; }
  return { q: t.q, o: o.map((e) => e.x), a: o.findIndex((e) => e.c) };
}
cmd(["trivia", "سؤال", "اسئله", "سوال"], async (ctx) => {
  await ctx.api.sendChatAction(ctx.chat.id, "typing").catch(() => {});
  const t = shuffleQ((await ai.genTrivia()) || pick(D.trivia));
  const id = Math.random().toString(36).slice(2, 8);
  const kb = new InlineKeyboard();
  t.o.forEach((o, i) => kb.text(o, `tq:${id}:${i}`).row());
  const m = await reply(ctx, `🧠 <b>سؤال ثقافة عامة</b>\n\n${esc(t.q)}\n\n⏱ 45 ثانية • اول اجابة صح تكسب 💰`, { reply_markup: kb });
  const chatId = ctx.chat.id;
  const timer = setTimeout(() => {
    if (trivias.delete(id)) {
      bot.api.editMessageText(chatId, m.message_id, `🧠 ${esc(t.q)}\n\n⌛ الوقت خلص! الاجابة: <b>${esc(t.o[t.a])}</b>`, { parse_mode: "HTML" }).catch(() => {});
    }
  }, 45000);
  trivias.set(id, { ...t, tried: new Set(), timer });
});
bot.callbackQuery(/^tq:(\w+):(\d)$/, async (ctx) => {
  const [, id, iS] = ctx.match;
  const t = trivias.get(id);
  if (!t) return ctx.answerCallbackQuery({ text: "السؤال خلص ⌛" });
  if (t.tried.has(ctx.from.id)) return ctx.answerCallbackQuery({ text: "جاوبت قبل كده 😏" });
  t.tried.add(ctx.from.id);
  if (Number(iS) !== t.a) return ctx.answerCallbackQuery({ text: "غلط يا معلم ❌" });
  trivias.delete(id);
  clearTimeout(t.timer);
  const r = rand(150, 300);
  await db.addCoins(ctx.from.id, r);
  await ctx.answerCallbackQuery({ text: "صح! 🎉" });
  await ctx.editMessageText(
    `🧠 ${esc(t.q)}\n\n✅ الاجابة: <b>${esc(t.o[t.a])}</b>\n🏆 ${mention(ctx.from.id, ctx.from.first_name)} كسب ${r} 💰`,
    { parse_mode: "HTML" }
  );
});

cmd(["riddle", "لغز", "فزوره"], async (ctx) => {
  const r = pick(D.riddles);
  await startChallenge(ctx, { text: `🧩 <b>لغز</b>\n\n${r.q}`, answers: r.a, show: r.a[0], reward: rand(150, 300), secs: 45 });
});
cmd(["math", "حساب", "حسبها"], async (ctx) => {
  const a = rand(12, 99), b = rand(11, 60), op = pick(["+", "-", "×"]);
  const ans = op === "+" ? a + b : op === "-" ? a - b : a * b;
  await startChallenge(ctx, { text: `🧮 <b>تحدي الحساب</b>\n\nاسرع واحد يحل: <code>${a} ${op} ${b}</code> = ؟`, answers: [String(ans)], show: String(ans), reward: rand(100, 200), secs: 30 });
});
cmd(["typing", "اسرع", "كتابه", "تحدي"], async (ctx) => {
  const w = pick(D.words);
  await startChallenge(ctx, { text: `⌨️ <b>تحدي السرعة</b>\n\nاسرع واحد يكتب الجملة دي:\n<code>${w}</code>`, answers: [w], show: w, reward: rand(100, 200), secs: 30 });
});

/* ======================= الصلاة ======================= */
cmd(["azan", "اذان", "الاذان", "صلاه", "الصلاه", "مواعيد", "مواعيد_الصلاه"], async (ctx) => {
  try { await reply(ctx, await prayer.timesText()); }
  catch { await reply(ctx, "معرفتش اجيب المواعيد دلوقتي، جرب بعد شوية 🙏"); }
});
cmd(["azan_on", "تفعيل_الاذان"], async (ctx) => {
  await db.setChat(ctx.chat.id, "prayer_on", true);
  await reply(ctx, "🕌 تم تفعيل تنبيهات الاذان بتوقيت القاهرة ✅");
}, { admin: true });
cmd(["azan_off", "ايقاف_الاذان", "تعطيل_الاذان"], async (ctx) => {
  await db.setChat(ctx.chat.id, "prayer_on", false);
  await reply(ctx, "تم ايقاف تنبيهات الاذان ⛔");
}, { admin: true });

/* ======================= الادارة ======================= */
const parseDur = (s) => {
  const m = norm(s || "").match(/^(\d+)(m|h|d|د|س|ي)?$/);
  if (!m) return 0;
  const u = { m: 60, "د": 60, h: 3600, "س": 3600, d: 86400, "ي": 86400 }[m[2] || "m"];
  return Number(m[1]) * u;
};

cmd(["ban", "حظر", "بان"], async (ctx, args) => {
  const t = await getTarget(ctx, args);
  if (!t) return needTarget(ctx);
  if (await protect(ctx, t.id)) return;
  try { await ctx.api.banChatMember(ctx.chat.id, t.id); await reply(ctx, `🔨 ${mention(t.id, t.name)} اتحظر! مع السلامة 👋`); }
  catch (e) { await tgErr(ctx, e); }
}, { group: true, admin: true });

cmd(["unban", "فك_حظر", "الغاء_حظر"], async (ctx, args) => {
  const t = await getTarget(ctx, args);
  if (!t) return needTarget(ctx);
  try { await ctx.api.unbanChatMember(ctx.chat.id, t.id, { only_if_banned: true }); await reply(ctx, `✅ ${mention(t.id, t.name)} اتفك حظره`); }
  catch (e) { await tgErr(ctx, e); }
}, { group: true, admin: true });

cmd(["kick", "طرد", "اطرد"], async (ctx, args) => {
  const t = await getTarget(ctx, args);
  if (!t) return needTarget(ctx);
  if (await protect(ctx, t.id)) return;
  try {
    await ctx.api.banChatMember(ctx.chat.id, t.id);
    await ctx.api.unbanChatMember(ctx.chat.id, t.id);
    await reply(ctx, `👢 ${mention(t.id, t.name)} اتطرد من الجروب!`);
  } catch (e) { await tgErr(ctx, e); }
}, { group: true, admin: true });

cmd(["mute", "كتم", "اكتم"], async (ctx, args) => {
  const t = await getTarget(ctx, args);
  if (!t) return needTarget(ctx);
  if (await protect(ctx, t.id)) return;
  const secs = parseDur(t.rest[0]);
  try {
    await ctx.api.restrictChatMember(ctx.chat.id, t.id, { can_send_messages: false },
      secs ? { until_date: Math.floor(Date.now() / 1000) + secs } : {});
    await reply(ctx, `🤐 ${mention(t.id, t.name)} اتكتم ${secs ? `لمدة <b>${fmtT(secs)}</b>` : "<b>للأبد</b>"}`);
  } catch (e) { await tgErr(ctx, e); }
}, { group: true, admin: true });

cmd(["unmute", "فك_كتم", "الغاء_كتم"], async (ctx, args) => {
  const t = await getTarget(ctx, args);
  if (!t) return needTarget(ctx);
  try {
    const chat = await ctx.api.getChat(ctx.chat.id);
    await ctx.api.restrictChatMember(ctx.chat.id, t.id, chat.permissions || {
      can_send_messages: true, can_send_audios: true, can_send_documents: true, can_send_photos: true,
      can_send_videos: true, can_send_video_notes: true, can_send_voice_notes: true,
      can_send_polls: true, can_send_other_messages: true, can_add_web_page_previews: true,
    });
    await reply(ctx, `🔊 ${mention(t.id, t.name)} اتفك كتمه`);
  } catch (e) { await tgErr(ctx, e); }
}, { group: true, admin: true });

cmd(["promote", "رفع", "ارفع", "رفع_مشرف"], async (ctx, args) => {
  const t = await getTarget(ctx, args);
  if (!t) return needTarget(ctx);
  try {
    await ctx.api.promoteChatMember(ctx.chat.id, t.id, {
      can_manage_chat: true, can_delete_messages: true, can_restrict_members: true,
      can_pin_messages: true, can_invite_users: true,
    });
    adminCache.delete(`${ctx.chat.id}:${t.id}`);
    await reply(ctx, `👑 ${mention(t.id, t.name)} اترفع مشرف! مبروك يا باشا 🎉`);
  } catch (e) { await tgErr(ctx, e); }
}, { group: true, admin: true });

cmd(["demote", "تنزيل", "نزل", "تنزيل_مشرف"], async (ctx, args) => {
  const t = await getTarget(ctx, args);
  if (!t) return needTarget(ctx);
  try {
    await ctx.api.promoteChatMember(ctx.chat.id, t.id, {
      can_manage_chat: false, can_delete_messages: false, can_restrict_members: false,
      can_pin_messages: false, can_invite_users: false, can_promote_members: false,
      can_change_info: false, can_manage_video_chats: false,
    });
    adminCache.delete(`${ctx.chat.id}:${t.id}`);
    await reply(ctx, `⬇️ ${mention(t.id, t.name)} اتنزل من الاشراف`);
  } catch (e) { await tgErr(ctx, e); }
}, { group: true, admin: true });

cmd(["warn", "تحذير", "انذار", "حذر"], async (ctx, args) => {
  const t = await getTarget(ctx, args);
  if (!t) return needTarget(ctx);
  if (await protect(ctx, t.id)) return;
  const n = (await db.q(
    `INSERT INTO warns(chat_id,user_id,n) VALUES($1,$2,1)
     ON CONFLICT(chat_id,user_id) DO UPDATE SET n=warns.n+1 RETURNING n`, [ctx.chat.id, t.id])).rows[0].n;
  if (n >= 3) {
    try {
      await ctx.api.banChatMember(ctx.chat.id, t.id);
      await db.q("DELETE FROM warns WHERE chat_id=$1 AND user_id=$2", [ctx.chat.id, t.id]);
      return reply(ctx, `⚠️ ${mention(t.id, t.name)} وصل <b>3/3</b> تحذيرات واتحظر! 🔨`);
    } catch (e) { return tgErr(ctx, e); }
  }
  await reply(ctx, `⚠️ ${mention(t.id, t.name)} خد تحذير <b>${n}/3</b> — خلي بالك!`);
}, { group: true, admin: true });

cmd(["unwarn", "ازاله_تحذير", "الغاء_تحذير"], async (ctx, args) => {
  const t = await getTarget(ctx, args);
  if (!t) return needTarget(ctx);
  const r = await db.q("UPDATE warns SET n=GREATEST(n-1,0) WHERE chat_id=$1 AND user_id=$2 RETURNING n", [ctx.chat.id, t.id]);
  await reply(ctx, `✅ التحذيرات دلوقتي: <b>${r.rows[0]?.n ?? 0}/3</b> لـ ${mention(t.id, t.name)}`);
}, { group: true, admin: true });

cmd(["warns", "تحذيرات", "انذارات"], async (ctx, args) => {
  const t = (await getTarget(ctx, args)) || { id: ctx.from.id, name: ctx.from.first_name };
  const r = await db.q("SELECT n FROM warns WHERE chat_id=$1 AND user_id=$2", [ctx.chat.id, t.id]);
  await reply(ctx, `⚠️ تحذيرات ${mention(t.id, t.name)}: <b>${r.rows[0]?.n ?? 0}/3</b>`);
}, { group: true });

cmd(["del", "مسح", "احذف", "امسح"], async (ctx) => {
  const r = ctx.message.reply_to_message;
  if (!r) return reply(ctx, "رد على الرسالة اللي عايز تمسحها 🗑");
  try { await ctx.api.deleteMessage(ctx.chat.id, r.message_id); await ctx.deleteMessage().catch(() => {}); }
  catch (e) { await tgErr(ctx, e); }
}, { group: true, admin: true });

cmd(["pin", "تثبيت", "ثبت"], async (ctx) => {
  const r = ctx.message.reply_to_message;
  if (!r) return reply(ctx, "رد على الرسالة اللي عايز تثبتها 📌");
  try { await ctx.api.pinChatMessage(ctx.chat.id, r.message_id); }
  catch (e) { await tgErr(ctx, e); }
}, { group: true, admin: true });

cmd(["unpin", "الغاء_تثبيت", "فك_تثبيت"], async (ctx) => {
  try {
    const r = ctx.message.reply_to_message;
    await ctx.api.unpinChatMessage(ctx.chat.id, r ? { message_id: r.message_id } : {});
    await reply(ctx, "📌 اتلغى التثبيت");
  } catch (e) { await tgErr(ctx, e); }
}, { group: true, admin: true });

cmd(["antilink", "منع_الروابط", "الروابط"], async (ctx) => {
  const v = await db.toggleChat(ctx.chat.id, "antilink");
  await reply(ctx, v ? "🚫 منع الروابط: <b>شغال</b>" : "🔗 منع الروابط: <b>واقف</b>");
}, { group: true, admin: true });

cmd(["welcome", "ترحيب", "الترحيب"], async (ctx) => {
  const v = await db.toggleChat(ctx.chat.id, "welcome_on");
  await reply(ctx, v ? "👋 الترحيب: <b>شغال</b>" : "الترحيب: <b>واقف</b>");
}, { group: true, admin: true });

/* ======================= اوامر المطور ======================= */
cmd(["give", "اعطاء", "اضافه_فلوس"], async (ctx, args) => {
  const t = await getTarget(ctx, args);
  if (!t) return needTarget(ctx);
  const n = parseAmount(t.rest[0], 0);
  if (!Number.isFinite(n) || n === 0) return reply(ctx, "اكتب المبلغ");
  const left = await db.addCoins(t.id, n);
  await reply(ctx, left === null ? "الرصيد مش كفاية للخصم" : `✅ اتعدل رصيد ${mention(t.id, t.name)} (${n > 0 ? "+" : ""}${fmt(n)})`);
}, { owner: true });

cmd(["broadcast", "اذاعه", "اذاعة"], async (ctx, args) => {
  const text = args.join(" ");
  if (!text) return reply(ctx, "اكتب الرسالة بعد الامر");
  const rows = (await db.q("SELECT id FROM chats")).rows;
  let ok = 0;
  for (const { id } of rows) {
    try { await bot.api.sendMessage(id, `📢 ${esc(text)}`, { parse_mode: "HTML" }); ok++; } catch {}
    await sleep(60);
  }
  await reply(ctx, `📢 اتبعتت لـ ${ok}/${rows.length} شات`);
}, { owner: true });

cmd(["stats", "احصائيات"], async (ctx) => {
  const u = (await db.q("SELECT COUNT(*)::int AS n, COALESCE(SUM(coins+bank),0) AS m FROM users")).rows[0];
  const c = (await db.q("SELECT COUNT(*)::int AS n FROM chats")).rows[0];
  await reply(ctx, `📊 المستخدمين: <b>${u.n}</b>\n💬 الشاتات: <b>${c.n}</b>\n💰 الفلوس في السوق: <b>${fmt(u.m)}</b>`);
}, { owner: true });

/* ======================= التشغيل ======================= */
const UPDATES = ["message", "callback_query"];

async function main() {
  await db.initDb();
  await bot.init();

  await bot.api.setMyCommands([
    { command: "help", description: "كل الاوامر" },
    { command: "balance", description: "بطاقتك وفلوسك" },
    { command: "daily", description: "المكافأة اليومية" },
    { command: "work", description: "اشتغل واكسب" },
    { command: "slots", description: "ماكينة الحظ" },
    { command: "trivia", description: "سؤال عام بجايزة" },
    { command: "xo", description: "اكس او ضد ملك" },
    { command: "top", description: "اغنى الناس" },
    { command: "azan", description: "مواعيد الصلاة" },
    { command: "ask", description: "اسأل ملك" },
  ]).catch(() => {});

  const hookPath = `/${cfg.webhookPath}`;
  const useWebhook = cfg.mode === "webhook" && !!cfg.webhookDomain;
  const handler = useWebhook
    ? webhookCallback(bot, "http", {
        secretToken: cfg.webhookSecret || undefined,
        timeoutMilliseconds: 55000,
        onTimeout: "return",
      })
    : null;

  const server = http.createServer((req, res) => {
    if (req.url === "/" || req.url === "/health") {
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      return res.end("Malek bot is alive 💎");
    }
    if (handler && req.method === "POST" && req.url === hookPath) return handler(req, res);
    res.writeHead(404);
    res.end();
  });
  server.listen(cfg.port, "0.0.0.0", () => console.log(`🌐 HTTP on :${cfg.port} (${useWebhook ? "webhook" : "polling"})`));

  if (useWebhook) {
    await bot.api.setWebhook(cfg.webhookDomain + hookPath, {
      secret_token: cfg.webhookSecret || undefined,
      drop_pending_updates: true,
      allowed_updates: UPDATES,
    });
    console.log("✅ Webhook set:", cfg.webhookDomain + hookPath);
  } else {
    await bot.api.deleteWebhook({ drop_pending_updates: true });
    run(bot, { runner: { fetch: { allowed_updates: UPDATES } } });
    console.log("✅ Polling started");
  }

  prayer.startScheduler(bot);
  console.log(`💎 Malek bot is up as @${bot.botInfo.username}`);
}

main().catch((e) => { console.error("FATAL:", e); process.exit(1); });
process.on("unhandledRejection", (e) => console.error("unhandledRejection:", e));