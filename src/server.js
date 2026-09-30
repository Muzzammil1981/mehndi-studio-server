import "dotenv/config";

import express from "express";
import cors from "cors";
import http from "http";
import path from "path";
import { fileURLToPath } from "url";

import authRoutes from "./routes/auth.js";
import googleRoutes from "./routes/google.js";
import notificationRoutes from "./routes/notifications.js";
import designsRoutes from "./routes/designs.js";
import { initSocket } from "./socket.js";
import { categories } from "./data/categories.js";
import { isConnected } from "./services/googleDrive.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
const server = http.createServer(app);

app.use(cors({ origin: process.env.CLIENT_URL, credentials: true }));
app.use(express.json({ limit: "1mb" }));

/* Legacy local uploads — kept for any old designs still pointing there */
app.use("/uploads", express.static(path.resolve(__dirname, "../uploads")));

app.get("/api/health", (_req, res) =>
  res.json({ ok: true, service: "mehndi-studio-api", drive: isConnected() })
);

app.get("/api/categories", (_req, res) => res.json(categories));

app.use("/api/auth", authRoutes);
app.use("/api/google", googleRoutes);
app.use("/api/notifications", notificationRoutes);
app.use("/api/designs", designsRoutes);

import usersRoutes from "./routes/users.js";
app.use("/api/users", usersRoutes);

import ordersRoutes from "./routes/orders.js";
app.use("/api/orders", ordersRoutes);

import settingsRoutes from "./routes/settings.js";
app.use("/api/settings", settingsRoutes);

import reportsRoutes from "./routes/reports.js";
app.use("/api/reports", reportsRoutes);

initSocket(server);

const PORT = process.env.PORT || 5000;
server.listen(PORT, () =>
  console.log(`🌸 Mehndi Studio API → http://localhost:${PORT}`)
);