import { db } from "./db";
import {
  users, posts, xpHistory,
  type User, type InsertUser,
  type Post, type InsertPost,
  type XpHistory, type InsertXpHistory,
  type UpdateUserSubscriptionRequest
} from "@shared/schema";
import { eq, desc, sql, gte, and, ne, lte, isNotNull } from "drizzle-orm";

export interface IStorage {
  // User operations
  getUser(telegramId: number | string): Promise<User | undefined>;
  getUserById(id: number): Promise<User | undefined>;
  createUser(user: InsertUser): Promise<User>;
  updateUser(telegramId: number | string, updates: Partial<User>): Promise<User | undefined>;
  updateUserSubscription(id: number, subscription: string, expiresAt?: Date | null): Promise<User>;
  getActiveSubscriptions(): Promise<User[]>;
  getExpiredSubscriptions(): Promise<User[]>;
  getUsers(limit?: number, offset?: number): Promise<{ items: User[], total: number }>;
  getTopUsers(limit?: number): Promise<User[]>;
  
  // Post operations
  createPost(post: InsertPost): Promise<Post>;
  getRecentPostsCount(telegramId: string, category: string, hours: number): Promise<number>;
  getOldestRecentPost(telegramId: string, category: string, hours: number): Promise<Date | null>;
  deleteRecentPosts(telegramId: string, category: string | "all"): Promise<void>;
  
  // XP operations
  createXpHistory(history: InsertXpHistory): Promise<XpHistory>;
  getXpHistory(userId: number): Promise<XpHistory[]>;
  getLeaderboard(limit?: number): Promise<User[]>;
  getStats(): Promise<{ totalUsers: number; totalPosts: number; usersBySubscription: Record<string, number> }>;
}

export class DatabaseStorage implements IStorage {
  async getUser(telegramId: number | string): Promise<User | undefined> {
    const id = String(telegramId);
    const [user] = await db.select().from(users).where(eq(users.telegramId, id));
    return user;
  }

  async getUserById(id: number): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.id, id));
    return user;
  }

  async createUser(insertUser: InsertUser): Promise<User> {
    const [user] = await db.insert(users).values(insertUser).onConflictDoUpdate({
      target: users.telegramId,
      set: { 
        username: insertUser.username,
        firstName: insertUser.firstName,
        updatedAt: new Date()
      }
    }).returning();
    return user;
  }

  async updateUser(telegramId: number | string, updates: Partial<User>): Promise<User | undefined> {
    const id = String(telegramId);
    const [user] = await db.update(users)
      .set({ ...updates, updatedAt: new Date() })
      .where(eq(users.telegramId, id))
      .returning();
    return user;
  }

  async updateUserSubscription(id: number, subscription: string, expiresAt?: Date | null): Promise<User> {
    const setData: any = { subscription, updatedAt: new Date() };
    if (expiresAt !== undefined) {
      setData.subscriptionExpiresAt = expiresAt;
    }
    const [user] = await db.update(users)
      .set(setData)
      .where(eq(users.id, id))
      .returning();
    return user;
  }

  async getActiveSubscriptions(): Promise<User[]> {
    return db.select().from(users)
      .where(ne(users.subscription, "BASIC"))
      .orderBy(users.subscriptionExpiresAt);
  }

  async getExpiredSubscriptions(): Promise<User[]> {
    return db.select().from(users)
      .where(and(
        ne(users.subscription, "BASIC"),
        isNotNull(users.subscriptionExpiresAt),
        lte(users.subscriptionExpiresAt, new Date())
      ));
  }

  async getUsers(limit: number = 20, offset: number = 0): Promise<{ items: User[], total: number }> {
    const [countResult] = await db.select({ count: sql<number>`count(*)` }).from(users);
    const items = await db.select().from(users).limit(limit).offset(offset).orderBy(desc(users.xp));
    return { items, total: Number(countResult.count) };
  }

  async getTopUsers(limit: number = 10): Promise<User[]> {
    return db.select().from(users).where(and(gte(users.xp, 1), eq(users.isAdmin, false))).orderBy(desc(users.xp)).limit(limit);
  }

  async createPost(post: InsertPost): Promise<Post> {
    const [newPost] = await db.insert(posts).values(post).returning();
    return newPost;
  }

  async getRecentPostsCount(telegramId: string, category: string, hours: number): Promise<number> {
    const since = new Date(Date.now() - hours * 60 * 60 * 1000);
    
    const [result] = await db.select({ count: sql<number>`count(*)` })
      .from(posts)
      .where(and(
        eq(posts.telegramId, telegramId),
        eq(posts.category, category),
        gte(posts.createdAt, since)
      ));
      
    return Number(result.count);
  }
  
  async getOldestRecentPost(telegramId: string, category: string, hours: number): Promise<Date | null> {
    const since = new Date(Date.now() - hours * 60 * 60 * 1000);
    
    const [result] = await db.select({ oldest: sql<Date>`min(${posts.createdAt})` })
      .from(posts)
      .where(and(
        eq(posts.telegramId, telegramId),
        eq(posts.category, category),
        gte(posts.createdAt, since)
      ));
      
    return result?.oldest ? new Date(result.oldest) : null;
  }

  async deleteRecentPosts(telegramId: string, category: string | "all"): Promise<void> {
    if (category === "all") {
      await db.delete(posts).where(eq(posts.telegramId, telegramId));
    } else {
      await db.delete(posts).where(and(eq(posts.telegramId, telegramId), eq(posts.category, category)));
    }
  }

  async createXpHistory(history: InsertXpHistory): Promise<XpHistory> {
    const [record] = await db.insert(xpHistory).values(history).returning();
    return record;
  }

  async getXpHistory(userId: number): Promise<XpHistory[]> {
    return db.select().from(xpHistory).where(eq(xpHistory.userId, userId)).orderBy(desc(xpHistory.timestamp)).limit(50);
  }

  async getLeaderboard(limit: number = 10): Promise<User[]> {
    return db.select().from(users).where(gte(users.xp, 0)).orderBy(desc(users.xp)).limit(limit);
  }

  async getStats(): Promise<{ totalUsers: number; totalPosts: number; usersBySubscription: Record<string, number> }> {
    const [userCount] = await db.select({ count: sql<number>`count(*)` }).from(users);
    const [postCount] = await db.select({ count: sql<number>`count(*)` }).from(posts);
    
    const subs = await db.select({ 
      sub: users.subscription, 
      count: sql<number>`count(*)` 
    }).from(users).groupBy(users.subscription);
    
    const usersBySubscription: Record<string, number> = {};
    subs.forEach(s => {
      usersBySubscription[s.sub] = Number(s.count);
    });

    return {
      totalUsers: Number(userCount.count),
      totalPosts: Number(postCount.count),
      usersBySubscription
    };
  }
}

export const storage = new DatabaseStorage();
