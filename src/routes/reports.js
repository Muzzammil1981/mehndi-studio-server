import express from "express";
import { requireAuth } from "../middleware/auth.js";
import { buildReport } from "../services/orderService.js";
import { listUsers } from "../services/userService.js";

const router = express.Router();

/* GET /api/reports?from=2026-01-01&to=2026-09-30&userId=xxx */
router.get("/", requireAuth, async (req, res) => {
    if (req.user.role !== "ADMIN") return res.status(403).json({ message: "Admin only" });
    try {
        const { from, to, userId } = req.query;
        const report = await buildReport({ from, to, userId });
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

export default router;