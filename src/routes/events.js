import express from "express";
import { requireAuth } from "../middleware/auth.js";
import {
    getStudioFolders,
    readJson,
    writeJson,
    isConnected,
} from "../services/googleDrive.js";

const router = express.Router();

/* =========================================================
   PREVENT BROWSER CACHING
========================================================= */
router.use((req, res, next) => {
    res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    res.set("Pragma", "no-cache");
    res.set("Expires", "0");
    next();
});

/* =========================================================
   EVENT CACHE
========================================================= */
const CACHE_MS = 60 * 1000;
let cache = { events: null, at: 0 };

/* =========================================================
   LOAD EVENTS
========================================================= */
async function loadEvents({ fresh = false } = {}) {
    if (!isConnected()) return cache.events || [];
    if (!fresh && cache.events && Date.now() - cache.at < CACHE_MS) return cache.events;

    try {
        const { dataId } = await getStudioFolders();
        const doc = await readJson("events.json", dataId);
        let events = [];
        if (doc?.data?.events) events = Array.isArray(doc.data.events) ? doc.data.events : [];
        else if (Array.isArray(doc?.data)) events = doc.data;
        else if (Array.isArray(doc)) events = doc;

        cache = { events, at: Date.now() };
        return events;
    } catch (err) {
        console.error("❌ loadEvents failed:", err.message);
        if (cache.events) return cache.events;
        return [];
    }
}

/* =========================================================
   SAVE EVENTS
========================================================= */
async function saveEvents(events) {
    try {
        const { dataId } = await getStudioFolders();
        await writeJson("events.json", { events }, dataId);
        cache = { events: [...events], at: Date.now() };
    } catch (err) {
        console.error("❌ saveEvents failed:", err);
        throw err;
    }
}

/* =========================================================
   EXPORTED: Generate Token (First Come, First Serve)
========================================================= */
export async function generateEventToken(eventId) {
    const events = await loadEvents({ fresh: true });
    const event = events.find(e => e.id === eventId);
    if (!event) throw new Error("Event not found");

    event.tokenCounter = (event.tokenCounter || 0) + 1;
    await saveEvents(events);
    return event.tokenCounter;
}

/* =========================================================
   GET /api/events/active
   IMPORTANT: Must be declared BEFORE /:id
========================================================= */
router.get("/active", async (req, res) => {
    try {
        const events = await loadEvents();
        const now = new Date();
        const activeEvent = events.find(event => {
            if (!event?.startDate || !event?.endDate) return false;
            const start = new Date(event.startDate);
            const end = new Date(event.endDate);
            if (isNaN(start.getTime()) || isNaN(end.getTime())) return false;
            return now >= start && now <= end;
        });

        if (!activeEvent) return res.json({ active: false });
        return res.json({ active: true, event: activeEvent, currentToken: activeEvent.tokenCounter || 0 });
    } catch (err) {
        return res.status(500).json({ message: err.message || "Failed to load active event" });
    }
});

/* =========================================================
   GET /api/events/:id (Public - for QR code scans)
   NEW: Fetch any event by ID, regardless of active status
========================================================= */
router.get("/:id", async (req, res) => {
    try {
        const events = await loadEvents({ fresh: true });
        const event = events.find(e => e.id === req.params.id);

        if (!event) {
            return res.status(404).json({ message: "Event not found" });
        }

        return res.json({ active: true, event, currentToken: event.tokenCounter || 0 });
    } catch (err) {
        return res.status(500).json({ message: err.message || "Failed to load event" });
    }
});

/* =========================================================
   GET /api/events (Admin) - List all
========================================================= */
router.get("/", requireAuth, async (req, res) => {
    if (!["ADMIN", "SUPERADMIN"].includes(req.user.role)) return res.status(403).json({ message: "Admin only" });
    try {
        const events = await loadEvents({ fresh: true });
        return res.json(events);
    } catch (err) {
        return res.status(500).json({ message: err.message || "Failed to load events" });
    }
});

/* =========================================================
   POST /api/events (Admin)
========================================================= */
router.post("/", requireAuth, async (req, res) => {
    if (!["ADMIN", "SUPERADMIN"].includes(req.user.role)) return res.status(403).json({ message: "Admin only" });
    try {
        const { name, startDate, endDate, designIds, priceOverrides } = req.body || {};
        if (!name || !startDate || !endDate) return res.status(400).json({ message: "Name, start date, and end date are required" });

        const start = new Date(startDate);
        const end = new Date(endDate);
        if (isNaN(start.getTime()) || isNaN(end.getTime())) return res.status(400).json({ message: "Invalid dates" });
        if (end <= start) return res.status(400).json({ message: "End date must be after start date" });

        const newEvent = {
            id: `event-${Date.now()}`,
            name: String(name).trim(),
            startDate,
            endDate,
            designIds: Array.isArray(designIds) ? designIds : [],
            priceOverrides: priceOverrides && typeof priceOverrides === "object" && !Array.isArray(priceOverrides) ? priceOverrides : {},
            tokenCounter: 0,
            createdAt: new Date().toISOString(),
        };

        const events = await loadEvents({ fresh: true });
        events.push(newEvent);
        await saveEvents(events);
        return res.status(201).json(newEvent);
    } catch (err) {
        return res.status(500).json({ message: err.message || "Failed to create event" });
    }
});

/* =========================================================
   DELETE /api/events/:id (Admin)
========================================================= */
router.delete("/:id", requireAuth, async (req, res) => {
    if (!["ADMIN", "SUPERADMIN"].includes(req.user.role)) return res.status(403).json({ message: "Admin only" });
    try {
        let events = await loadEvents({ fresh: true });
        const originalLength = events.length;
        events = events.filter(event => event.id !== req.params.id);
        if (events.length === originalLength) return res.status(404).json({ message: "Event not found" });
        await saveEvents(events);
        return res.json({ message: "Event deleted" });
    } catch (err) {
        return res.status(500).json({ message: err.message || "Failed to delete event" });
    }
});

/* =========================================================
   GET /api/events/:id/queue (Public - for Monitor Display)
   Returns live queue status: now serving, up next, completed
========================================================= */
/* =========================================================
   GET /api/events/:id/queue (Public — for Monitor Display)
========================================================= */
router.get("/:id/queue", async (req, res) => {
    try {
        const events = await loadEvents({ fresh: true });
        const event = events.find(e => e.id === req.params.id);
        if (!event) return res.status(404).json({ message: "Event not found" });

        const { dataId } = await getStudioFolders();
        const doc = await readJson("orders.json", dataId);
        const allOrders = doc?.data?.orders || [];

        const eventOrders = allOrders.filter(o => o.eventId === event.id && o.tokenNumber);

        // UPDATED: include image + startedAt for the now-serving token
        const nowServing = eventOrders
            .filter(o => o.status === "in-progress")
            .sort((a, b) => a.tokenNumber - b.tokenNumber)
            .map(o => ({
                tokenNumber: o.tokenNumber,
                username: o.username,
                image: o.items?.[0]?.image || null,
                itemName: o.items?.[0]?.name || null,
                startedAt: o.startedAt || null,
            }));

        const upNext = eventOrders
            .filter(o => o.status === "paid")
            .sort((a, b) => a.tokenNumber - b.tokenNumber)
            .slice(0, 6)
            .map(o => ({
                tokenNumber: o.tokenNumber,
                username: o.username,
                image: o.items?.[0]?.image || null,
            }));

        const recentlyCompleted = eventOrders
            .filter(o => o.status === "completed")
            .sort((a, b) => b.tokenNumber - a.tokenNumber)
            .slice(0, 4)
            .map(o => ({
                tokenNumber: o.tokenNumber,
                username: o.username,
                durationSeconds: o.durationSeconds || 0,
            }));

        res.json({
            event: { id: event.id, name: event.name },
            nowServing,
            upNext,
            recentlyCompleted,
            totalTokens: event.tokenCounter || 0,
            lastUpdated: new Date().toISOString(),
        });
    } catch (err) {
        res.status(500).json({ message: err.message || "Failed to load queue" });
    }
});

export default router;