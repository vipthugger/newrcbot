import type { Express } from "express";
import type { Server } from "http";
import { storage } from "./storage";
import { ResaleBot } from "./bot";

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {

  // Start Bot if Token exists
  if (process.env.TELEGRAM_BOT_TOKEN) {
    try {
        const bot = new ResaleBot(process.env.TELEGRAM_BOT_TOKEN);
        bot.launch().catch(err => console.error("Bot launch failed:", err));
    } catch (e) {
        console.error("Failed to initialize bot:", e);
    }
  } else {
      console.warn("TELEGRAM_BOT_TOKEN not provided. Bot will not start.");
  }

  // Health check endpoint
  app.get("/api/health", (req, res) => {
    res.json({ status: "ok" });
  });

  return httpServer;
}
