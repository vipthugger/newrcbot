import { pgTable, text, serial, integer, timestamp, boolean, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import { relations } from "drizzle-orm";

// === TABLE DEFINITIONS ===

export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  telegramId: text("telegram_id").unique().notNull(), // Stored as string to avoid BigInt issues
  username: text("username"),
  firstName: text("first_name"),
  xp: integer("xp").default(0).notNull(),
  rank: text("rank").default("Новачок").notNull(),
  subscription: text("subscription").default("BASIC").notNull(), // BASIC, BASIC+, SHOP
  dailyXp: integer("daily_xp").default(0).notNull(),
  dailyXpDate: text("daily_xp_date"), // ISO date string YYYY-MM-DD
  lastXpTime: timestamp("last_xp_time"),
  isAdmin: boolean("is_admin").default(false).notNull(),
  subscriptionExpiresAt: timestamp("subscription_expires_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const posts = pgTable("posts", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(), // Foreign key to users.id
  telegramId: text("telegram_id").notNull(), // Redundant but useful for quick lookups
  category: text("category").notNull(), // 'buy' or 'sell'
  content: text("content"), // Optional: store message content for logs
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const xpHistory = pgTable("xp_history", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  xpChange: integer("xp_change").notNull(),
  reason: text("reason").notNull(),
  adminId: text("admin_id"),
  timestamp: timestamp("timestamp").defaultNow().notNull(),
});

// === RELATIONS ===

export const usersRelations = relations(users, ({ many }) => ({
  posts: many(posts),
  xpHistory: many(xpHistory),
}));

export const postsRelations = relations(posts, ({ one }) => ({
  user: one(users, {
    fields: [posts.userId],
    references: [users.id],
  }),
}));

export const xpHistoryRelations = relations(xpHistory, ({ one }) => ({
  user: one(users, {
    fields: [xpHistory.userId],
    references: [users.id],
  }),
}));

// === BASE SCHEMAS ===

export const insertUserSchema = createInsertSchema(users).omit({ id: true, createdAt: true, updatedAt: true });
export const insertPostSchema = createInsertSchema(posts).omit({ id: true, createdAt: true });
export const insertXpHistorySchema = createInsertSchema(xpHistory).omit({ id: true, timestamp: true });

// === EXPLICIT API CONTRACT TYPES ===

export type User = typeof users.$inferSelect;
export type InsertUser = z.infer<typeof insertUserSchema>;

export type Post = typeof posts.$inferSelect;
export type InsertPost = z.infer<typeof insertPostSchema>;

export type XpHistory = typeof xpHistory.$inferSelect;
export type InsertXpHistory = z.infer<typeof insertXpHistorySchema>;

// Request types
export type UpdateUserSubscriptionRequest = {
  subscription: "BASIC" | "BASIC+" | "SHOP";
};

export type UpdateUserRankRequest = {
  rank: string;
};

export type AddXpRequest = {
  amount: number;
  reason: string;
  adminId?: string;
};

// Response types
export interface PaginatedResponse<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}
