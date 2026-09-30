import express from "express";
import { requireAuth, requireAdmin } from "../middleware/auth.js";
import { notifyUsers } from "../socket.js";

const router = express.Router();

router.post("/broadcast", requireAuth, requireAdmin, (req, res) => {
    const { title, body, designId } = req.body || {};
    const payload = {
        id: Date.now().toString(),
        title: title || "New Mehndi Design",
        body: body || "A new design has been added.",
        designId,
        at: new Date().toISOString(),
    };
    notifyUsers(payload);
    res.json({ ok: true, payload });
});

export default router;