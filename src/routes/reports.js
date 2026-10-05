import express from "express";
import { requireAuth } from "../middleware/auth.js";
import { buildReport } from "../services/orderService.js";
import { listUsers } from "../services/userService.js";
import { readJson, getStudioFolders, isConnected } from "../services/googleDrive.js"; // <-- Added imports

const router = express.Router();

/* GET /api/reports?from=...&to=...&userId=...&eventId=... */
router.get("/", requireAuth, async (req, res) => {
    if (req.user.role !== "ADMIN") return res.status(403).json({ message: "Admin only" });
    try {
        const { from, to, userId, eventId } = req.query; // <-- Added eventId
        const report = await buildReport({ from, to, userId, eventId });
        res.json(report);
    } catch (err) {
        console.error("reports failed:", err);
        res.status(500).json({ message: err.message });
    }
});

/* GET /api/reports/customers — list of all users (for filter dropdown) */
router.get("/customers", requireAuth, async (req, res) => {
    if (req.user.role !== "ADMIN") return res.status(403).json({ message: "Admin only" });
    try {
        const users = await listUsers();
        res.json(users.map(u => ({ id: u.id, username: u.username, email: u.email })));
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

/* GET /api/reports/events — list of all events (for filter dropdown) */
router.get("/events", requireAuth, async (req, res) => {
    if (req.user.role !== "ADMIN") return res.status(403).json({ message: "Admin only" });
    try {
        if (!isConnected()) return res.json([]);
        const { dataId } = await getStudioFolders();
        const doc = await readJson("events.json", dataId);
        const events = doc?.data?.events || (Array.isArray(doc) ? doc : []);
        res.json(events.map(e => ({ id: e.id, name: e.name })));
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

export default router;