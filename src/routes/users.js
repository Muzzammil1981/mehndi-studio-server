import express from "express";
import jwt from "jsonwebtoken";
import { registerUser, loginUser, listUsers } from "../services/userService.js";
import { requireAuth } from "../middleware/auth.js";

const router = express.Router();

function signUser(user) {
    return jwt.sign(
        { id: user.id, username: user.username, email: user.email, role: user.role },
        process.env.JWT_SECRET,
        { expiresIn: "30d" }
    );
}

router.post("/register", async (req, res) => {
    try {
        const user = await registerUser(req.body || {});
        res.status(201).json({ token: signUser(user), user });
    } catch (err) {
        res.status(400).json({ message: err.message });
    }
});

router.post("/login", async (req, res) => {
    try {
        const user = await loginUser(req.body || {});
        res.json({ token: signUser(user), user });
    } catch (err) {
        res.status(401).json({ message: err.message });
    }
});

/* Returns current user from JWT */
router.get("/me", requireAuth, (req, res) => {
    res.json({ user: req.user });
});

/* Admin-only: full user list */
router.get("/", requireAuth, async (req, res) => {
    if (req.user?.role !== "ADMIN") return res.status(403).json({ message: "Admin only" });
    try {
        const users = await listUsers();
        res.json(users);
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

import { changePassword, adminResetPassword } from "../services/userService.js";
// ^ add to the existing import line at the top

/* User changes own password */
router.post("/change-password", requireAuth, async (req, res) => {
    try {
        const { currentPassword, newPassword } = req.body || {};
        await changePassword({ userId: req.user.id, currentPassword, newPassword });
        res.json({ ok: true });
    } catch (err) {
        res.status(400).json({ message: err.message });
    }
});

/* Admin resets someone else's password */
router.post("/:id/reset-password", requireAuth, async (req, res) => {
    if (req.user?.role !== "ADMIN") return res.status(403).json({ message: "Admin only" });
    try {
        const { newPassword } = req.body || {};
        const result = await adminResetPassword({ userId: req.params.id, newPassword });
        res.json(result);
    } catch (err) {
        res.status(400).json({ message: err.message });
    }
});

export default router;