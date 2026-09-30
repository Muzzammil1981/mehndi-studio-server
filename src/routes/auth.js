import express from "express";
import jwt from "jsonwebtoken";
import { requireAuth } from "../middleware/auth.js";

const router = express.Router();

router.post("/login", (req, res) => {
    const { username, password } = req.body || {};

    if (
        username !== process.env.SUPERADMIN_USERNAME ||
        password !== process.env.SUPERADMIN_PASSWORD
    ) {
        return res.status(401).json({ message: "Invalid username or password" });
    }

    const user = { username, role: "ADMIN" };
    const token = jwt.sign(user, process.env.JWT_SECRET, { expiresIn: "7d" });

    res.json({ token, user });
});

router.get("/me", requireAuth, (req, res) => {
    res.json({ user: req.user });
});

export default router;