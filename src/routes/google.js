import express from "express";
import {
    getAuthUrl, exchangeCode, isConnected, getAccount,
    disconnect, setupStudioFolders,
} from "../services/googleDrive.js";
import { requireAuth, requireAdmin } from "../middleware/auth.js";

const router = express.Router();

router.get("/status", requireAuth, requireAdmin, (req, res) => {
    res.json({ connected: isConnected(), account: getAccount() });
});

// Returns the Google consent URL for the frontend to redirect to
router.get("/auth", requireAuth, requireAdmin, (req, res) => {
    res.json({ url: getAuthUrl() });
});

// Google redirects here — no JWT, so we trust state via the stored OAuth flow
router.get("/callback", async (req, res) => {
    try {
        const { code } = req.query;
        if (!code) return res.redirect(`${process.env.CLIENT_URL}/admin?google=error`);

        await exchangeCode(code);
        console.log("🔑 Tokens saved, creating folders…");

        const folders = await setupStudioFolders();
        console.log("🎉 Folders created:", folders);

        res.redirect(`${process.env.CLIENT_URL}/admin?google=connected`);
    } catch (err) {
        console.error("❌ Google callback error:", err?.message || err);
        console.error(err);
        res.redirect(`${process.env.CLIENT_URL}/admin?google=error`);
    }
});

router.post("/disconnect", requireAuth, requireAdmin, (req, res) => {
    disconnect();
    res.json({ ok: true });
});

// Manual trigger for folder setup with full error logging
router.post("/setup", requireAuth, requireAdmin, async (req, res) => {
    try {
        const result = await setupStudioFolders();
        res.json({ ok: true, ...result });
    } catch (err) {
        console.error("❌ /setup failed:", err?.message, err?.code, err?.errors);
        res.status(500).json({
            ok: false,
            message: err?.message,
            code: err?.code,
            errors: err?.errors,
        });
    }
});

export default router;