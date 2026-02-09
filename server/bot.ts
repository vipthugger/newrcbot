import { Telegraf, Context } from "telegraf";
import { storage } from "./storage";
import { type User } from "@shared/schema";

type BotContext = Context & {
  user?: User;
};

// ==================== CONFIGURATION ====================

const MIN_PRICE_TSHIRT = 1500;
const MIN_PRICE_DEFAULT = 3000;

// Subscription limits (like Python: CooldownManager)
const SUBSCRIPTION_LIMITS = {
  "BASIC": { hours: 24, limit: 1 },
  "BASIC+": { hours: 12, limit: 3 },
  "SHOP": { hours: 12, limit: 10 }
};

// Rank thresholds (like Python: XPSystem.rank_thresholds)
const RANK_THRESHOLDS: [number, string][] = [
  [0, "Новачок"],
  [50, "Учасник"],
  [150, "Активіст"],
  [300, "Авторитет"],
  [600, "Ветеран"],
  [1000, "Легенда"],
];

// Special ranks (like Python: XPSystem.special_ranks)
const SPECIAL_RANKS = ["Ресейлер", "Адміністратор"];

// Spam patterns for XP (like Python: XPSystem.spam_patterns)
const SPAM_PATTERNS = [
  /^[+\-\.]$/,
  /^(ок|ok|да|не|нет)$/i,
  /^[+\-]*$/,
  /^\s*$/,
  /^.{1,2}$/,
];

// Allowed commands
const ALLOWED_COMMANDS = [
  '/resale_topic', '/resale', '/notification', '/report', '/resetcd', '/changecd', 
  '/set_report_chat', '/myprofile', '/perks', '/top', '/addxp', '/removexp', 
  '/setrank', '/resetxp', '/set', '/unset', '/admsub'
];

// ==================== RULES TEXT ====================

  const RULES_TEXT = `<b>🔰 Правила для гілки #продам та #куплю</b>

  <b>📌 Обов’язково в оголошенні:</b>
  • хештег <b>#продам</b> або <b>#куплю</b>
  • чіткий опис товару
  • вказана ціна у форматі <b>ціна: XXXX грн</b>
  • якісні фото, розмір та стан речі

  <b>💸 Мінімальна ціна:</b>
  • #футболка — <b>від 1500 грн</b>
  • інші товари — <b>від 3000 грн</b>

  <b>📎 Формат за підписками:</b>
  • <b>BASIC</b> — стандартний формат  
  • <b>BASIC+</b> — стандартний формат  
  • <b>SHOP / SELLER+</b> — вільний формат, облік за словами  
    <b>ціна / цена / price + число</b>

  <b>⏱ Ліміти:</b>
  • <b>BASIC:</b> 1 оголошення / 24 години  
  • <b>BASIC+:</b> 3 оголошення / 12 годин  
  • <b>SHOP:</b> 10 оголошень / 12 годин

  <b>🚫 Заборонено:</b>
  • продаж фейків, реплік, копій у будь-якому вигляді  
  • обхід ціни (подвійні ціни, «в лс дешевше»)  
  • спам, дублювання, масова скупка речей  
  • реклама сторонніх каналів і посилань  
  • оголошення не про одяг/взуття/аксесуари  
  • пересилання постів зі своїх каналів  
  • публікація кількох речей в одному оголошенні  
  • використання #куплю без конкретного товару  
  • обхід роботи бота або маніпуляції форматом

  <b>❗ Угоди здійснюються на відповідальність сторін</b>

  🛡 Для скарги: відповідь на повідомлення  
  <b>/report [причина]</b>`;

// ==================== GLOBAL STATE ====================

let reportChatId: number | null = null;
const reportedMessages: Set<string> = new Set();
const userWarningCooldown: Map<number, number> = new Map();

interface MediaGroupBuffer {
  messages: Array<{ messageId: number; text: string; hasMedia: boolean; hasSticker: boolean }>;
  chatId: number;
  threadId?: number;
  fromId: number;
  user?: any;
  timer: ReturnType<typeof setTimeout>;
}
const mediaGroupBuffers: Map<string, MediaGroupBuffer> = new Map();

// ==================== HELPER FUNCTIONS ====================

function calculateRankFromXp(xp: number): string {
  for (let i = RANK_THRESHOLDS.length - 1; i >= 0; i--) {
    if (xp >= RANK_THRESHOLDS[i][0]) {
      return RANK_THRESHOLDS[i][1];
    }
  }
  return "Новачок";
}

function isSpamMessage(text: string): boolean {
  if (!text) return true;
  const trimmed = text.trim().toLowerCase();
  return SPAM_PATTERNS.some(p => p.test(trimmed));
}

function formatTimeRemaining(ms: number): string {
  if (ms <= 0) return "0 хв";
  const totalMinutes = Math.ceil(ms / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours > 0 && minutes > 0) return `${hours} год ${minutes} хв`;
  if (hours > 0) return `${hours} год`;
  return `${minutes} хв`;
}

const MEDIA_GROUP_WAIT_MS = 2000;

// ==================== BOT CLASS ====================

export class ResaleBot {
  private bot: Telegraf<BotContext>;
  private resaleTopicId: number | null = null;
  private resaleMarketChatId: number | null = null;
  private subCheckInterval: ReturnType<typeof setInterval> | null = null;
  private notifiedExpiring: Set<number> = new Set();

  constructor(token: string) {
    this.bot = new Telegraf<BotContext>(token);
    this.bot.catch((err: any, ctx: any) => {
      console.error(`Bot error for ${ctx.updateType}:`, err.message || err);
    });
    this.setupMiddleware();
    this.setupHandlers();
    
    process.once('SIGINT', () => this.bot.stop('SIGINT'));
    process.once('SIGTERM', () => this.bot.stop('SIGTERM'));
  }

  async launch() {
    await this.bot.launch();
    console.log("Bot started successfully");
    this.startSubscriptionChecker();
  }

  private startSubscriptionChecker() {
    this.subCheckInterval = setInterval(async () => {
      try {
        const expired = await storage.getExpiredSubscriptions();
        for (const user of expired) {
          await storage.updateUserSubscription(user.id, "BASIC", null);
          console.log(`Auto-expired subscription for ${user.username || user.telegramId}`);
          this.notifiedExpiring.delete(user.id);
        }

        const activeSubs = await storage.getActiveSubscriptions();
        const now = Date.now();
        for (const user of activeSubs) {
          if (!user.subscriptionExpiresAt) continue;
          const diff = new Date(user.subscriptionExpiresAt).getTime() - now;
          if (diff <= 3 * 24 * 60 * 60 * 1000 && diff > 0 && !this.notifiedExpiring.has(user.id)) {
            this.notifiedExpiring.add(user.id);
            const days = Math.ceil(diff / (24 * 60 * 60 * 1000));
            const name = user.username ? `@${user.username}` : (user.firstName || user.telegramId);
            console.log(`Subscription warning: ${name} (${user.subscription}) expires in ${days} days`);
          }
        }
      } catch (e) {
        console.error("Subscription checker error:", e);
      }
    }, 60 * 60 * 1000);
  }

  // ==================== MIDDLEWARE ====================

  private setupMiddleware() {
    this.bot.use(async (ctx, next) => {
      if (ctx.from) {
        const telegramId = ctx.from.id.toString();
        let user = await storage.getUser(telegramId);

        let adminStatus = false;
        if (ctx.chat && (ctx.chat.type === 'group' || ctx.chat.type === 'supergroup')) {
          try {
            const member = await ctx.telegram.getChatMember(ctx.chat.id, ctx.from.id);
            adminStatus = ['creator', 'administrator'].includes(member.status);
          } catch {}
        }
        
        if (!user) {
          user = await storage.createUser({
            telegramId,
            username: ctx.from.username,
            firstName: ctx.from.first_name,
            rank: adminStatus ? "Адміністратор" : "Новачок",
            subscription: "BASIC",
            xp: 0,
            dailyXp: 0,
            isAdmin: adminStatus
          });
        } else {
          if (user.subscription !== "BASIC" && user.subscriptionExpiresAt && new Date(user.subscriptionExpiresAt) <= new Date()) {
            await storage.updateUserSubscription(user.id, "BASIC", null);
            user = { ...user, subscription: "BASIC", subscriptionExpiresAt: null };
            console.log(`Subscription expired for @${ctx.from.username || telegramId}, reverted to BASIC`);
          }

          const needsUpdate = user.username !== ctx.from.username 
            || user.firstName !== ctx.from.first_name
            || user.isAdmin !== adminStatus;
          if (needsUpdate) {
            const updates: any = {
              username: ctx.from.username,
              firstName: ctx.from.first_name,
              isAdmin: adminStatus
            };
            if (adminStatus && !user.isAdmin) {
              updates.rank = "Адміністратор";
            }
            user = await storage.updateUser(telegramId, updates);
          }
        }
        
        ctx.user = user;
      }
      return next();
    });
  }

  // ==================== SETUP HANDLERS ====================

  private setupHandlers() {
    // Admin Commands
    this.bot.command("resale_topic", this.handleSetResaleTopic.bind(this));
    this.bot.command("resale", this.handleSetResaleMarket.bind(this));
    this.bot.command("set", this.handleSetSubscription.bind(this));
    this.bot.command("unset", this.handleUnsetSubscription.bind(this));
    this.bot.command("resetcd", this.handleResetCooldown.bind(this));
    this.bot.command("notification", this.handleNotification.bind(this));
    this.bot.command("set_report_chat", this.handleSetReportChat.bind(this));
    
    // XP Admin Commands (like Python)
    this.bot.command("addxp", this.handleAddXp.bind(this));
    this.bot.command("removexp", this.handleRemoveXp.bind(this));
    this.bot.command("setrank", this.handleSetRank.bind(this));
    this.bot.command("resetxp", this.handleResetXp.bind(this));
    
    this.bot.command("admsub", this.handleAdmSub.bind(this));
    
    // User Commands (like Python)
    this.bot.command("myprofile", this.handleMyProfile.bind(this));
    this.bot.command("perks", this.handlePerks.bind(this));
    this.bot.command("top", this.handleTop.bind(this));
    this.bot.command("report", this.handleReport.bind(this));
    
    // Message Handler (must be last)
    this.bot.on(["message"], this.handleMessage.bind(this));
  }

  // ==================== ADMIN COMMANDS ====================

  private async handleSetResaleTopic(ctx: BotContext) {
    if (!ctx.from || !ctx.chat) return;
    
    try {
      const isAdmin = await this.isAdmin(ctx);
      if (!isAdmin) {
        try { await ctx.deleteMessage(); } catch {}
        return ctx.reply("❌ Ця команда тільки для адміністраторів.");
      }

      const msg = ctx.message;
      if (msg && 'message_thread_id' in msg && msg.message_thread_id) {
        this.resaleTopicId = msg.message_thread_id;
        console.log(`Resale topic set to ${this.resaleTopicId} by @${ctx.from.username}`);
        try { await ctx.deleteMessage(); } catch {}
        await ctx.reply(RULES_TEXT, { parse_mode: "HTML" });
      } else {
        await ctx.reply("❌ Використовуйте цю команду в гілці (topic), яку хочете встановити для оголошень.");
      }
    } catch (e) {
      console.error("Error in resale_topic:", e);
    }
  }

  private async handleSetResaleMarket(ctx: BotContext) {
    if (!ctx.from || !ctx.chat) return;
    
    try {
      const isAdmin = await this.isAdmin(ctx);
      if (!isAdmin) {
        try { await ctx.deleteMessage(); } catch {}
        return ctx.reply("❌ Ця команда тільки для адміністраторів.");
      }

      const msg = ctx.message;
      const args = msg && 'text' in msg ? msg.text.split(" ").slice(1) : [];
      
      if (args.length >= 1) {
        const chatId = parseInt(args[0]);
        if (isNaN(chatId)) {
          return ctx.reply("❌ Невірний ID групи. Використання: /resale -1001234567890");
        }
        this.resaleMarketChatId = chatId;
        console.log(`Resale market chat set to ${this.resaleMarketChatId} by @${ctx.from.username}`);
        try { await ctx.deleteMessage(); } catch {}
        return ctx.reply(`✅ Market група встановлена (ID: ${chatId}). Бот модеруватиме оголошення в цій групі.`);
      }
      
      this.resaleMarketChatId = ctx.chat.id;
      console.log(`Resale market chat set to ${this.resaleMarketChatId} (current chat) by @${ctx.from.username}`);
      try { await ctx.deleteMessage(); } catch {}
      await ctx.reply(RULES_TEXT, { parse_mode: "HTML" });
    } catch (e) {
      console.error("Error in resale:", e);
    }
  }

  private async handleSetSubscription(ctx: BotContext) {
    if (!ctx.user || !ctx.chat) return;

    const isAdmin = await this.isAdmin(ctx);
    if (!isAdmin) return ctx.reply("❌ Ця команда тільки для адміністраторів.");

    const msg = ctx.message;
    const args = msg && 'text' in msg ? msg.text.split(" ") : [];
    if (args.length < 2) return ctx.reply("❌ Використання: /set [basic+|shop] (відповіддю на повідомлення)");

    const subType = args[1].toLowerCase();
    let targetSub = "";
    if (subType === "basic+") targetSub = "BASIC+";
    else if (subType === "shop" || subType === "seller+") targetSub = "SHOP";
    else return ctx.reply("❌ Невірний тип підписки. Використовуйте 'basic+' або 'shop'.");

    const reply = msg && 'reply_to_message' in msg ? msg.reply_to_message : null;
    if (!reply || !reply.from) return ctx.reply("❌ Відповідайте на повідомлення користувача.");

    const targetTelegramId = reply.from.id.toString();
    let targetUser = await storage.getUser(targetTelegramId);
    
    if (!targetUser) {
      targetUser = await storage.createUser({
        telegramId: targetTelegramId,
        username: reply.from.username,
        firstName: reply.from.first_name,
        rank: "Новачок",
        subscription: "BASIC",
        xp: 0,
        dailyXp: 0
      });
    }

    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    await storage.updateUserSubscription(targetUser.id, targetSub, expiresAt);
    const expiresStr = expiresAt.toLocaleDateString("uk-UA");
    const targetUsername = reply.from.username || reply.from.first_name || "користувач";
    return ctx.reply(`✅ Користувачу @${targetUsername} встановлено підписку ${targetSub}\n📅 Дійсна до: ${expiresStr} (30 днів)`);
  }

  private async handleUnsetSubscription(ctx: BotContext) {
    if (!ctx.user || !ctx.chat) return;
    if (!(await this.isAdmin(ctx))) return ctx.reply("❌ Ця команда тільки для адміністраторів.");

    const msg = ctx.message;
    const reply = msg && 'reply_to_message' in msg ? msg.reply_to_message : null;
    if (!reply || !reply.from) return ctx.reply("❌ Відповідайте на повідомлення користувача.");

    const targetTelegramId = reply.from.id.toString();
    const targetUser = await storage.getUser(targetTelegramId);
    
    if (targetUser) {
      await storage.updateUserSubscription(targetUser.id, "BASIC", null);
      const targetUsername = reply.from.username || reply.from.first_name || "користувач";
      return ctx.reply(`✅ Підписку @${targetUsername} скинуто до BASIC`);
    }
  }

  private async handleAdmSub(ctx: BotContext) {
    if (!ctx.from || !ctx.chat) return;
    if (!(await this.isAdmin(ctx))) return ctx.reply("❌ Ця команда тільки для адміністраторів.");

    try {
      const activeSubs = await storage.getActiveSubscriptions();
      
      if (activeSubs.length === 0) {
        return ctx.reply("📋 Немає активних підписок.");
      }

      let text = "<b>📋 Активні підписки:</b>\n\n";
      const now = Date.now();

      for (const user of activeSubs) {
        const name = user.username ? `@${user.username}` : (user.firstName || user.telegramId);
        const expiresAt = user.subscriptionExpiresAt ? new Date(user.subscriptionExpiresAt) : null;
        
        if (!expiresAt) {
          text += `-- <b>${name}</b> — ${user.subscription}\n   Безстрокова (встановлена до оновлення)\n\n`;
          continue;
        }

        let statusIcon = "[OK]";
        let timeLeft = "";
        
        const diff = expiresAt.getTime() - now;
        if (diff <= 0) {
          statusIcon = "[!!]";
          timeLeft = "прострочена";
        } else if (diff <= 3 * 24 * 60 * 60 * 1000) {
          statusIcon = "[!]";
          const days = Math.ceil(diff / (24 * 60 * 60 * 1000));
          timeLeft = `${days} дн.`;
        } else {
          const days = Math.ceil(diff / (24 * 60 * 60 * 1000));
          timeLeft = `${days} дн.`;
        }
        const dateStr = expiresAt.toLocaleDateString("uk-UA");
        text += `${statusIcon} <b>${name}</b> — ${user.subscription}\n   До: ${dateStr} (${timeLeft})\n\n`;
      }

      text += "<b>Легенда:</b> [OK] активна | [!] менше 3 днів | [!!] прострочена";
      
      return ctx.reply(text, { parse_mode: "HTML" });
    } catch (e) {
      console.error("Error in /admsub:", e);
      return ctx.reply("❌ Помилка при отриманні підписок.");
    }
  }

  private async handleResetCooldown(ctx: BotContext) {
    if (!ctx.from || !ctx.chat) return;
    if (!(await this.isAdmin(ctx))) return ctx.reply("❌ Ця команда тільки для адміністраторів.");

    const msg = ctx.message;
    const reply = msg && 'reply_to_message' in msg ? msg.reply_to_message : null;
    if (!reply || !reply.from) {
      return ctx.reply("❌ Відповідайте на повідомлення користувача.\nВикористання: /resetcd [buy/sell/all]");
    }

    const args = msg && 'text' in msg ? msg.text.split(" ").slice(1) : [];
    const categoryArg = args[0]?.toLowerCase() || "all";
    
    const targetTelegramId = reply.from.id.toString();
    const targetUsername = reply.from.username || reply.from.first_name || "користувач";

    const validCategories: Record<string, string> = { buy: "buy", sell: "sell", shop_ad: "shop_ad", all: "all" };
    const dbCategory = validCategories[categoryArg] || "all";

    if (dbCategory === "all") {
      await storage.deleteRecentPosts(targetTelegramId, "all");
    } else {
      await storage.deleteRecentPosts(targetTelegramId, dbCategory);
    }

    const categoryText = categoryArg === "all" ? "всіх категорій" : categoryArg === "buy" ? "#куплю" : "#продам";
    
    await ctx.reply(`✅ Кулдаун @${targetUsername} для ${categoryText} скинуто`);
    console.log(`Cooldown reset for @${targetUsername} (telegramId: ${targetTelegramId}) by admin @${ctx.from.username}, category: ${dbCategory}`);
  }

  private async handleNotification(ctx: BotContext) {
    if (!ctx.from) return;
    if (!(await this.isAdmin(ctx))) return ctx.reply("❌ Ця команда тільки для адміністраторів.");
    await ctx.reply(RULES_TEXT, { parse_mode: "HTML" });
  }

  private async handleSetReportChat(ctx: BotContext) {
    if (!ctx.from || !ctx.chat) return;
    if (!(await this.isAdmin(ctx))) return ctx.reply("❌ Ця команда тільки для адміністраторів.");
    
    reportChatId = ctx.chat.id;
    await ctx.reply("✅ Цей чат встановлено для отримання скарг.");
    console.log(`Report chat set to ${reportChatId}`);
  }

  // ==================== XP ADMIN COMMANDS ====================

  private async handleAddXp(ctx: BotContext) {
    if (!ctx.from) return;
    if (!(await this.isAdmin(ctx))) return ctx.reply("❌ Ця команда тільки для адміністраторів.");

    const msg = ctx.message;
    const reply = msg && 'reply_to_message' in msg ? msg.reply_to_message : null;
    if (!reply || !reply.from) {
      return ctx.reply("❌ Відповідайте на повідомлення користувача.\nВикористання: /addxp 100");
    }

    const args = msg && 'text' in msg ? msg.text.split(" ").slice(1) : [];
    const amount = parseInt(args[0]);
    if (isNaN(amount) || amount <= 0) {
      return ctx.reply("❌ Вкажіть коректну кількість XP.");
    }

    const targetTelegramId = reply.from.id.toString();
    const user = await storage.getUser(targetTelegramId);
    
    if (user) {
      const newXp = (user.xp || 0) + amount;
      const newRank = SPECIAL_RANKS.includes(user.rank || "") ? user.rank : calculateRankFromXp(newXp);
      await storage.updateUser(targetTelegramId, { xp: newXp, rank: newRank });
      
      const targetUsername = reply.from.username || reply.from.first_name || "користувач";
      await ctx.reply(`✅ Додано ${amount} XP користувачу @${targetUsername}`);
    } else {
      await ctx.reply("❌ Користувача не знайдено.");
    }
  }

  private async handleRemoveXp(ctx: BotContext) {
    if (!ctx.from) return;
    if (!(await this.isAdmin(ctx))) return ctx.reply("❌ Ця команда тільки для адміністраторів.");

    const msg = ctx.message;
    const reply = msg && 'reply_to_message' in msg ? msg.reply_to_message : null;
    if (!reply || !reply.from) {
      return ctx.reply("❌ Відповідайте на повідомлення користувача.\nВикористання: /removexp 100");
    }

    const args = msg && 'text' in msg ? msg.text.split(" ").slice(1) : [];
    const amount = parseInt(args[0]);
    if (isNaN(amount) || amount <= 0) {
      return ctx.reply("❌ Вкажіть коректну кількість XP.");
    }

    const targetTelegramId = reply.from.id.toString();
    const user = await storage.getUser(targetTelegramId);
    
    if (user) {
      const newXp = Math.max(0, (user.xp || 0) - amount);
      const newRank = SPECIAL_RANKS.includes(user.rank || "") ? user.rank : calculateRankFromXp(newXp);
      await storage.updateUser(targetTelegramId, { xp: newXp, rank: newRank });
      
      const targetUsername = reply.from.username || reply.from.first_name || "користувач";
      await ctx.reply(`✅ Забрано ${amount} XP у користувача @${targetUsername}`);
    } else {
      await ctx.reply("❌ Користувача не знайдено.");
    }
  }

  private async handleSetRank(ctx: BotContext) {
    if (!ctx.from) return;
    if (!(await this.isAdmin(ctx))) return ctx.reply("❌ Ця команда тільки для адміністраторів.");

    const msg = ctx.message;
    const reply = msg && 'reply_to_message' in msg ? msg.reply_to_message : null;
    if (!reply || !reply.from) {
      return ctx.reply("❌ Відповідайте на повідомлення користувача.\nВикористання: /setrank Ресейлер");
    }

    const args = msg && 'text' in msg ? msg.text.split(" ").slice(1).join(" ") : "";
    if (!args) {
      return ctx.reply("❌ Вкажіть назву рангу.");
    }

    const targetTelegramId = reply.from.id.toString();
    await storage.updateUser(targetTelegramId, { rank: args });
    
    const targetUsername = reply.from.username || reply.from.first_name || "користувач";
    await ctx.reply(`✅ Встановлено ранг "${args}" користувачу @${targetUsername}`);
  }

  private async handleResetXp(ctx: BotContext) {
    if (!ctx.from) return;
    if (!(await this.isAdmin(ctx))) return ctx.reply("❌ Ця команда тільки для адміністраторів.");

    const msg = ctx.message;
    const reply = msg && 'reply_to_message' in msg ? msg.reply_to_message : null;
    if (!reply || !reply.from) {
      return ctx.reply("❌ Відповідайте на повідомлення користувача.");
    }

    const targetTelegramId = reply.from.id.toString();
    await storage.updateUser(targetTelegramId, { xp: 0, rank: "Новачок" });
    
    const targetUsername = reply.from.username || reply.from.first_name || "користувач";
    await ctx.reply(`✅ XP користувача @${targetUsername} скинуто`);
  }

  // ==================== USER COMMANDS ====================

  private async handleMyProfile(ctx: BotContext) {
    if (!ctx.user || !ctx.from) return;
    
    const isAdmin = ctx.user.isAdmin;

    if (isAdmin) {
      let profileText = `<b>Профіль користувача</b>\n\n`;
      profileText += `<b>Ім'я:</b> ${ctx.user.firstName || 'Не вказано'}\n`;
      if (ctx.user.username) {
        profileText += `<b>Username:</b> @${ctx.user.username}\n`;
      }
      profileText += `<b>Ранг:</b> Адміністратор`;
      return ctx.reply(profileText, { parse_mode: "HTML" });
    }

    const sub = ctx.user.subscription || "BASIC";
    const limits = SUBSCRIPTION_LIMITS[sub as keyof typeof SUBSCRIPTION_LIMITS] || SUBSCRIPTION_LIMITS["BASIC"];
    const displayRank = ctx.user.rank || "Новачок";
    
    let profileText = `<b>Профіль користувача</b>\n\n`;
    profileText += `<b>Ім'я:</b> ${ctx.user.firstName || 'Не вказано'}\n`;
    if (ctx.user.username) {
      profileText += `<b>Username:</b> @${ctx.user.username}\n`;
    }
    profileText += `<b>XP:</b> ${ctx.user.xp || 0}\n`;
    profileText += `<b>Ранг:</b> ${displayRank}\n`;
    profileText += `<b>XP сьогодні:</b> ${ctx.user.dailyXp}/100\n`;
    profileText += `<b>Підписка:</b> ${sub}\n`;
    if (sub !== "BASIC" && ctx.user.subscriptionExpiresAt) {
      const expiresAt = new Date(ctx.user.subscriptionExpiresAt);
      const daysLeft = Math.ceil((expiresAt.getTime() - Date.now()) / (24 * 60 * 60 * 1000));
      const dateStr = expiresAt.toLocaleDateString("uk-UA");
      profileText += `<b>Дійсна до:</b> ${dateStr} (${daysLeft > 0 ? `${daysLeft} дн.` : 'прострочена'})\n`;
    }
    profileText += `<b>Ліміт:</b> ${limits.limit} оголошень / ${limits.hours} годин`;
    
    if (!SPECIAL_RANKS.includes(displayRank) && displayRank !== "Легенда") {
      const currentXp = ctx.user.xp || 0;
      for (const [threshold, rank] of RANK_THRESHOLDS) {
        if (threshold > currentXp) {
          profileText += `\n\n<b>Наступний ранг:</b> ${rank}\n`;
          profileText += `<b>Потрібно XP:</b> ${threshold - currentXp}`;
          break;
        }
      }
    }
    
    if (ctx.user.rank === "Ресейлер") {
      profileText += `\n\n<b>Бонуси:</b>\n• +1 оголошення на годину`;
    }
    
    ctx.reply(profileText, { parse_mode: "HTML" });
  }

  private async handlePerks(ctx: BotContext) {
    let text = "<b>🏆 Ранги та вимоги:</b>\n\n";
    for (const [threshold, rank] of RANK_THRESHOLDS) {
      text += `• <b>${rank}</b> — ${threshold} XP\n`;
    }
    text += `\n<b>Спеціальні ранги:</b>\n`;
    text += `• <b>Ресейлер</b> — призначається адмінами\n`;
    text += `• <b>Адміністратор</b> — для адмінів чату`;
    await ctx.reply(text, { parse_mode: "HTML" });
  }

  private async handleTop(ctx: BotContext) {
    try {
      const topUsers = await storage.getTopUsers(10);
      if (!topUsers.length) {
        return ctx.reply("❌ Рейтинг порожній.");
      }

      let text = "<b>🏆 Топ користувачів за XP</b>\n\n";
      topUsers.forEach((user, i) => {
        const medal = i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : `${i + 1}.`;
        const displayName = user.firstName || user.username || "Користувач";
        const name = user.username ? `<a href="https://t.me/${user.username}">${displayName}</a>` : displayName;
        text += `${medal} ${name} — ${user.xp} XP (${user.rank})\n`;
      });

      await ctx.reply(text, { parse_mode: "HTML", link_preview_options: { is_disabled: true } });
    } catch (e) {
      console.error("Error in top command:", e);
      await ctx.reply("❌ Помилка при отриманні рейтингу.");
    }
  }

  private async handleReport(ctx: BotContext) {
    const msg = ctx.message;
    const reply = msg && 'reply_to_message' in msg ? msg.reply_to_message : null;
    
    if (!reply) {
      return ctx.reply("❌ Ви повинні відповісти на повідомлення, щоб залишити скаргу.");
    }

    if (!reportChatId) {
      return ctx.reply("❌ Адміністратори ще не налаштували чат для скарг.");
    }

    const msgId = `${ctx.chat?.id}_${reply.message_id}`;
    if (reportedMessages.has(msgId)) {
      return ctx.reply("❌ Це повідомлення вже було відправлено адміністраторам.");
    }

    reportedMessages.add(msgId);

    const text = msg && 'text' in msg ? msg.text : "";
    const reason = text.replace("/report", "").trim() || "Причина не вказана";
    const reportedUser = reply.from;

    let messageLink = "";
    try {
      if (ctx.chat && 'id' in ctx.chat) {
        messageLink = `https://t.me/c/${String(ctx.chat.id).slice(4)}/${reply.message_id}`;
      }
    } catch {}

    const reportText = 
      `<b>🔔 Нова скарга!</b>\n` +
      `Відправник: @${ctx.from?.username || 'Anonymous'}\n` +
      `Порушник: @${reportedUser?.username || 'Anonymous'}\n` +
      `Причина: ${reason}\n` +
      `Посилання: ${messageLink}`;

    try {
      await ctx.telegram.sendMessage(reportChatId, reportText, { parse_mode: "HTML" });
      await ctx.telegram.forwardMessage(reportChatId, ctx.chat!.id, reply.message_id);
    } catch (e) {
      console.error("Error forwarding report:", e);
    }

    await ctx.reply("✅ Скаргу відправлено адміністрації.");
    
    // Add XP for report (like Python)
    if (ctx.user) {
      const newXp = (ctx.user.xp || 0) + 5;
      await storage.updateUser(ctx.from!.id.toString(), { xp: newXp });
    }
  }

  // ==================== MAIN MESSAGE HANDLER ====================

  private async handleMessage(ctx: BotContext) {
    if (!ctx.chat || (ctx.chat.type !== 'group' && ctx.chat.type !== 'supergroup')) return;
    if (!ctx.from || !ctx.message) return;

    const msg = ctx.message;
    // @ts-ignore
    const mediaGroupId: string | undefined = msg.media_group_id;
    // @ts-ignore
    const text = (msg.text || msg.caption || "").trim();
    const messageId = msg.message_id;

    // Process XP for ALL messages (not just resale topic) — skip admins
    if (text && !text.startsWith('/') && !isSpamMessage(text) && ctx.user && !ctx.user.isAdmin) {
      await this.processXp(ctx);
    }

    // Check if message is in resale topic OR in market chat
    const isInResaleTopic = this.resaleTopicId !== null 
      && 'message_thread_id' in msg 
      && msg.message_thread_id === this.resaleTopicId;
    const isInMarketChat = this.resaleMarketChatId !== null 
      && ctx.chat.id === this.resaleMarketChatId;

    // Skip if not in any moderated zone
    if (!isInResaleTopic && !isInMarketChat) return;

    // Skip bot messages
    if (ctx.from.is_bot) return;

    // Skip admin messages
    try {
      const isAdmin = await this.isAdmin(ctx);
      if (isAdmin) {
        console.log(`Skipping admin message from @${ctx.from.username}`);
        return;
      }
    } catch (e) {
      console.error("Error checking admin status:", e);
    }

    // === MEDIA GROUP: buffer messages, wait 2s for all photos to arrive ===
    // Voice messages are never part of media groups, but delete them in resale topic
    if ('voice' in msg || 'video_note' in msg) {
      await this.deleteAndWarn(ctx, "❌ Голосові повідомлення заборонені у цій гілці.");
      return;
    }

    if (mediaGroupId) {
      const hasMedia = ('photo' in msg || 'video' in msg || 'document' in msg || 'animation' in msg);
      const hasSticker = ('sticker' in msg && !!msg.sticker);
      const threadId = 'message_thread_id' in msg ? msg.message_thread_id : undefined;

      if (mediaGroupBuffers.has(mediaGroupId)) {
        const buf = mediaGroupBuffers.get(mediaGroupId)!;
        if (buf.chatId === ctx.chat.id && buf.fromId === ctx.from.id) {
          buf.messages.push({ messageId, text, hasMedia, hasSticker });
          clearTimeout(buf.timer);
          buf.timer = setTimeout(() => {
            this.processMediaGroup(mediaGroupId, buf, ctx.telegram);
          }, MEDIA_GROUP_WAIT_MS);
        }
        return;
      }

      const buf: MediaGroupBuffer = {
        messages: [{ messageId, text, hasMedia, hasSticker }],
        chatId: ctx.chat.id,
        threadId,
        fromId: ctx.from.id,
        user: ctx.user,
      } as MediaGroupBuffer;

      buf.timer = setTimeout(() => {
        this.processMediaGroup(mediaGroupId, buf, ctx.telegram);
      }, MEDIA_GROUP_WAIT_MS);

      mediaGroupBuffers.set(mediaGroupId, buf);
      return;
    }

    // === SINGLE MESSAGE (no media group) ===
    await this.processResaleMessage(ctx, text, msg.message_id);
  }

  private async processMediaGroup(
    mediaGroupId: string,
    buf: MediaGroupBuffer,
    telegram: any
  ) {
    mediaGroupBuffers.delete(mediaGroupId);

    const captionMsg = buf.messages.find(m => m.text) || buf.messages[0];
    const text = captionMsg.text;
    const allMessageIds = buf.messages.map(m => m.messageId);

    const user = buf.user;
    if (!user) return;

    // Skip if caption is a legitimate command
    if (text && text.startsWith('/')) {
      const commandPart = text.split(' ')[0];
      if (ALLOWED_COMMANDS.includes(commandPart)) return;
    }

    const sub = user.subscription || "BASIC";
    const isShop = sub === "SHOP";

    // Sticker in media group
    if (buf.messages.some(m => m.hasSticker)) {
      await this.deleteAndWarnDirect(telegram, buf.chatId, allMessageIds, buf.threadId, user,
        "❌ Стікери заборонені у цій гілці.", buf.fromId);
      return;
    }

    // No text/caption in the entire group
    if (!text) {
      if (buf.messages.some(m => m.hasMedia)) {
        await this.deleteAndWarnDirect(telegram, buf.chatId, allMessageIds, buf.threadId, user,
          "❌ Ваше повідомлення було видалено, оскільки воно не містить опису.", buf.fromId);
        return;
      }
      return;
    }

    // === SHOP Logic ===
    if (isShop) {
      if (!this.hasShopTrigger(text)) {
        await this.deleteAndWarnDirect(telegram, buf.chatId, allMessageIds, buf.threadId, user,
          "❌ Ваше повідомлення було видалено. Для підписки SHOP потрібно вказати ціну (наприклад: 5000 грн).", buf.fromId);
        return;
      }

      const rule = SUBSCRIPTION_LIMITS["SHOP"];
      const count = await storage.getRecentPostsCount(user.telegramId, "shop_ad", rule.hours);

      if (count >= rule.limit) {
        const oldest = await storage.getOldestRecentPost(user.telegramId, "shop_ad", rule.hours);
        let timerText = "";
        if (oldest) {
          const expiresAt = oldest.getTime() + rule.hours * 60 * 60 * 1000;
          const remaining = expiresAt - Date.now();
          if (remaining > 0) timerText = `\n⏳ Наступне оголошення через: ${formatTimeRemaining(remaining)}`;
        }
        await this.deleteAndWarnDirect(telegram, buf.chatId, allMessageIds, buf.threadId, user,
          `<b>⏰ Ліміт вичерпано.</b>\n💎 Використано ${count}/${rule.limit} оголошень за ${rule.hours} год.${timerText}`, buf.fromId);
        return;
      }

      await storage.createPost({ userId: user.id, telegramId: user.telegramId, category: "shop_ad", content: text.slice(0, 50) });
      console.log(`SHOP ad (media group) approved for user ${user.telegramId}`);
      return;
    }

    // === BASIC / BASIC+ Logic ===
    const category = this.getCategory(text);
    if (!category) {
      await this.deleteAndWarnDirect(telegram, buf.chatId, allMessageIds, buf.threadId, user,
        `❌ Ваше повідомлення було видалено, оскільки воно не містить хештегів '#куплю' або '#продам'.`, buf.fromId);
      return;
    }

    const rule = SUBSCRIPTION_LIMITS[sub as keyof typeof SUBSCRIPTION_LIMITS] || SUBSCRIPTION_LIMITS["BASIC"];
    const count = await storage.getRecentPostsCount(user.telegramId, category, rule.hours);

    if (count >= rule.limit) {
      const oldest = await storage.getOldestRecentPost(user.telegramId, category, rule.hours);
      let timerText = "";
      if (oldest) {
        const expiresAt = oldest.getTime() + rule.hours * 60 * 60 * 1000;
        const remaining = expiresAt - Date.now();
        if (remaining > 0) timerText = `\n⏳ Наступне оголошення через: ${formatTimeRemaining(remaining)}`;
      }
      const categoryName = category === 'buy' ? '#куплю' : '#продам';
      await this.deleteAndWarnDirect(telegram, buf.chatId, allMessageIds, buf.threadId, user,
        `<b>⏰ Ви вичерпали ліміт оголошень.</b>\n💎 Використано ${count}/${rule.limit} в категорії ${categoryName} за ${rule.hours} год.${timerText}`, buf.fromId);
      return;
    }

    if (category === 'sell') {
      const price = this.extractPrice(text);
      const minPrice = text.toLowerCase().includes("#футболка") ? MIN_PRICE_TSHIRT : MIN_PRICE_DEFAULT;
      if (price === null) {
        await this.deleteAndWarnDirect(telegram, buf.chatId, allMessageIds, buf.threadId, user,
          `❌ Ваше повідомлення було видалено, оскільки воно не містить ціни. Мінімальна ціна: ${minPrice} грн.`, buf.fromId);
        return;
      }
      if (price < minPrice) {
        await this.deleteAndWarnDirect(telegram, buf.chatId, allMessageIds, buf.threadId, user,
          `❌ Ваше повідомлення було видалено, оскільки ціна ${price} грн нижча за мінімальну (${minPrice} грн).`, buf.fromId);
        return;
      }
      console.log(`Valid sell post (media group) approved for user ${user.telegramId}, price: ${price} грн`);
    } else {
      console.log(`Valid buy post (media group) approved for user ${user.telegramId}`);
    }

    await storage.createPost({ userId: user.id, telegramId: user.telegramId, category, content: text.slice(0, 50) });
  }

  private async processResaleMessage(ctx: BotContext, text: string, messageId: number) {
    // Skip legitimate commands
    if (text.startsWith('/')) {
      const commandPart = text.split(' ')[0];
      if (ALLOWED_COMMANDS.includes(commandPart)) return;
      await this.deleteAndWarn(ctx, `❌ Ваше повідомлення було видалено, оскільки воно не містить хештегів '#куплю' або '#продам'.`);
      return;
    }

    const msg = ctx.message!;

    // Check for stickers
    if ('sticker' in msg && msg.sticker) {
      await this.deleteAndWarn(ctx, "❌ Стікери заборонені у цій гілці.");
      return;
    }

    // Check for voice/video notes
    if ('voice' in msg || 'video_note' in msg) {
      await this.deleteAndWarn(ctx, "❌ Голосові повідомлення заборонені у цій гілці.");
      return;
    }

    // Check for media without text
    if (!text) {
      if ('photo' in msg || 'video' in msg || 'document' in msg || 'animation' in msg) {
        await this.deleteAndWarn(ctx, "❌ Ваше повідомлення було видалено, оскільки воно не містить опису.");
        return;
      }
      return;
    }

    const sub = ctx.user?.subscription || "BASIC";
    const isShop = sub === "SHOP";

    // === SHOP Logic ===
    if (isShop) {
      if (!this.hasShopTrigger(text)) {
        await this.deleteAndWarn(ctx, "❌ Ваше повідомлення було видалено. Для підписки SHOP потрібно вказати ціну (наприклад: 5000 грн).");
        return;
      }

      const rule = SUBSCRIPTION_LIMITS["SHOP"];
      const count = await storage.getRecentPostsCount(ctx.user!.telegramId, "shop_ad", rule.hours);

      if (count >= rule.limit) {
        const oldest = await storage.getOldestRecentPost(ctx.user!.telegramId, "shop_ad", rule.hours);
        let timerText = "";
        if (oldest) {
          const expiresAt = oldest.getTime() + rule.hours * 60 * 60 * 1000;
          const remaining = expiresAt - Date.now();
          if (remaining > 0) timerText = `\n⏳ Наступне оголошення через: ${formatTimeRemaining(remaining)}`;
        }
        await this.deleteAndWarn(ctx, `<b>⏰ Ліміт вичерпано.</b>\n💎 Використано ${count}/${rule.limit} оголошень за ${rule.hours} год.${timerText}`);
        return;
      }

      await storage.createPost({ userId: ctx.user!.id, telegramId: ctx.user!.telegramId, category: "shop_ad", content: text.slice(0, 50) });
      console.log(`SHOP ad approved for @${ctx.from!.username}`);
      return;
    }

    // === BASIC / BASIC+ Logic ===
    const category = this.getCategory(text);
    if (!category) {
      await this.deleteAndWarn(ctx, `❌ Ваше повідомлення було видалено, оскільки воно не містить хештегів '#куплю' або '#продам'.`);
      return;
    }

    const rule = SUBSCRIPTION_LIMITS[sub as keyof typeof SUBSCRIPTION_LIMITS] || SUBSCRIPTION_LIMITS["BASIC"];
    const count = await storage.getRecentPostsCount(ctx.user!.telegramId, category, rule.hours);

    if (count >= rule.limit) {
      const oldest = await storage.getOldestRecentPost(ctx.user!.telegramId, category, rule.hours);
      let timerText = "";
      if (oldest) {
        const expiresAt = oldest.getTime() + rule.hours * 60 * 60 * 1000;
        const remaining = expiresAt - Date.now();
        if (remaining > 0) timerText = `\n⏳ Наступне оголошення через: ${formatTimeRemaining(remaining)}`;
      }
      const categoryName = category === 'buy' ? '#куплю' : '#продам';
      await this.deleteAndWarn(ctx, `<b>⏰ Ви вичерпали ліміт оголошень.</b>\n💎 Використано ${count}/${rule.limit} в категорії ${categoryName} за ${rule.hours} год.${timerText}`);
      return;
    }

    if (category === 'sell') {
      const price = this.extractPrice(text);
      const minPrice = text.toLowerCase().includes("#футболка") ? MIN_PRICE_TSHIRT : MIN_PRICE_DEFAULT;
      if (price === null) {
        await this.deleteAndWarn(ctx, `❌ Ваше повідомлення було видалено, оскільки воно не містить ціни. Мінімальна ціна: ${minPrice} грн.`);
        return;
      }
      if (price < minPrice) {
        await this.deleteAndWarn(ctx, `❌ Ваше повідомлення було видалено, оскільки ціна ${price} грн нижча за мінімальну (${minPrice} грн).`);
        return;
      }
      console.log(`Valid sell post approved for @${ctx.from!.username}, price: ${price} грн`);
    } else {
      console.log(`Valid buy post approved for @${ctx.from!.username} (price not required)`);
    }

    await storage.createPost({ userId: ctx.user!.id, telegramId: ctx.user!.telegramId, category, content: text.slice(0, 50) });
  }

  // ==================== XP PROCESSING ====================

  private async processXp(ctx: BotContext) {
    if (!ctx.user || !ctx.from) return;
    
    try {
      const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
      const lastXpDate = ctx.user.dailyXpDate || null;
      
      if (lastXpDate !== today) {
        // New day - reset daily XP counter and add 1 XP
        const newXp = (ctx.user.xp || 0) + 1;
        const newRank = SPECIAL_RANKS.includes(ctx.user.rank || "") ? ctx.user.rank : calculateRankFromXp(newXp);
        await storage.updateUser(ctx.from.id.toString(), { 
          xp: newXp, 
          dailyXp: 1, 
          dailyXpDate: today,
          lastXpTime: new Date(),
          rank: newRank
        });
      } else if ((ctx.user.dailyXp || 0) < 100) {
        // Add XP (daily limit 100)
        const newXp = (ctx.user.xp || 0) + 1;
        const newRank = SPECIAL_RANKS.includes(ctx.user.rank || "") ? ctx.user.rank : calculateRankFromXp(newXp);
        await storage.updateUser(ctx.from.id.toString(), { 
          xp: newXp, 
          dailyXp: (ctx.user.dailyXp || 0) + 1,
          lastXpTime: new Date(),
          rank: newRank
        });
      }
    } catch (e) {
      console.error("Error processing XP:", e);
    }
  }

  // ==================== HELPERS ====================

  private getCategory(text: string): string | null {
    const lower = text.toLowerCase();
    if (lower.includes("#куплю") || lower.includes("#купим")) return "buy";
    if (lower.includes("#продам") || lower.includes("#продаю")) return "sell";
    return null;
  }

  private hasShopTrigger(text: string): boolean {
    // (price|ціна|цена) followed by number (like Python)
    const regex = /(price|ціна|цена)\s*[:\-]?\s*\d+/i;
    return regex.test(text) || /\d+\s*(грн|uah|usd|₴)/i.test(text);
  }

  private extractPrice(text: string): number | null {
    const keywordRegex = /(?:ціна:|price:|цена:|ціна\s*:|\$)(?:[^0-9]*?)(\d+(?:[.,]\d{3})*(?:[.,]\d{1,2})?)\s*(грн|uah|usd|k|к|kг|тис|₴|\$|гривен)?/i;
    const match = text.match(keywordRegex);
    
    if (match) {
      return this.parsePriceStr(match[1], match[2]);
    }
    
    const fallbackRegex = /(\d+(?:[.,]\d{3})*(?:[.,]\d{1,2})?)\s*(грн|uah|usd|k|к|kг|тис|₴|\$|гривен)?/gi;
    let maxPrice = 0;
    let m;
    while ((m = fallbackRegex.exec(text)) !== null) {
      const val = this.parsePriceStr(m[1], m[2]);
      if (val >= 100 && val > maxPrice) maxPrice = val;
    }
    
    return maxPrice > 0 ? maxPrice : null;
  }
  
  private parsePriceStr(priceStr: string, currency: string | undefined): number {
    let s = priceStr.replace(',', '.');
    if (s.split('.').length > 1) {
      const parts = s.split('.');
      const last = parts[parts.length - 1];
      if (parts.length > 2 || last.length === 3) {
        s = s.replace(/\./g, '');
      }
    }
    
    let val = parseFloat(s);
    if (isNaN(val)) return 0;
    
    if (currency && ['k', 'к', 'тис'].includes(currency.toLowerCase())) {
      val *= 1000;
    }
    return val;
  }

  private async deleteAndWarnDirect(
    telegram: any,
    chatId: number,
    messageIds: number[],
    threadId: number | undefined,
    user: any,
    text: string,
    fromId?: number
  ) {
    const userId = fromId || (user?.telegramId ? parseInt(user.telegramId) : null);

    if (userId) {
      const lastWarning = userWarningCooldown.get(userId);
      if (lastWarning && Date.now() - lastWarning < 30000) {
        console.log(`Warning suppressed for user ${userId} (anti-flood)`);
        for (const mid of messageIds) {
          try { await telegram.deleteMessage(chatId, mid); } catch {}
        }
        return;
      }
      userWarningCooldown.set(userId, Date.now());
    }

    for (const mid of messageIds) {
      try {
        await telegram.deleteMessage(chatId, mid);
      } catch (e) {
        console.error("Failed to delete message", mid, e);
      }
    }

    try {
      let finalText = text;
      if (user?.username) {
        if (text.startsWith("❌")) {
          finalText = `❌<b>@${user.username}</b>, ${text.slice(2).trim()}`;
        } else if (text.includes("⏰")) {
          finalText = `⏰<b>@${user.username}</b>, ${text.replace("⏰", "").replace(/<\/?b>/g, "").trim()}`;
        }
      }

      const warning = await telegram.sendMessage(chatId, finalText, {
        parse_mode: "HTML",
        message_thread_id: threadId
      });

      setTimeout(() => {
        telegram.deleteMessage(chatId, warning.message_id).catch(() => {});
      }, 3000);
    } catch (e) {
      console.error("Failed to send warning", e);
    }
  }

  private async deleteAndWarn(ctx: BotContext, text: string) {
    const userId = ctx.from?.id;
    
    // Anti-flood: one warning per user per 30 seconds (like Python)
    if (userId) {
      const lastWarning = userWarningCooldown.get(userId);
      if (lastWarning && Date.now() - lastWarning < 30000) {
        console.log(`Warning suppressed for user ${userId} (anti-flood)`);
        try { await ctx.deleteMessage(); } catch {}
        return;
      }
      userWarningCooldown.set(userId, Date.now());
    }
    
    try {
      await ctx.deleteMessage();
    } catch(e) {
      console.error("Failed to delete message", e);
    }
    
    try {
      const msg = ctx.message;
      const threadId = msg && 'message_thread_id' in msg ? msg.message_thread_id : undefined;
      
      // Add user mention (like Python)
      let finalText = text;
      if (ctx.user?.username) {
        if (text.startsWith("❌")) {
          finalText = `❌<b>@${ctx.user.username}</b>, ${text.slice(2).trim()}`;
        } else if (text.includes("⏰")) {
          finalText = `⏰<b>@${ctx.user.username}</b>, ${text.replace("⏰", "").replace(/<\/?b>/g, "").trim()}`;
        }
      }
      
      const warning = await ctx.reply(finalText, { 
        parse_mode: "HTML",
        message_thread_id: threadId 
      });
      
      // Auto-delete warning after 3 seconds (like Python)
      setTimeout(() => {
        ctx.telegram.deleteMessage(ctx.chat!.id, warning.message_id).catch(() => {});
      }, 3000);
    } catch(e) {
      console.error("Failed to send warning", e);
    }
  }
  
  private async isAdmin(ctx: BotContext): Promise<boolean> {
    if (!ctx.chat || !ctx.from) return false;
    try {
      const member = await ctx.telegram.getChatMember(ctx.chat.id, ctx.from.id);
      return ['creator', 'administrator'].includes(member.status);
    } catch {
      return false;
    }
  }
}
