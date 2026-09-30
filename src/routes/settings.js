import express from "express";
import multer from "multer";
import { requireAuth, requireAdmin } from "../middleware/auth.js";
import {
    getStudioSettings,
    saveStudioSettings,
    uploadQrCode,
    getQrCode,
} from "../services/settingsService.js";

const router = express.Router();

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: (_req, file, cb) => {
        const allowed = ["image/jpeg", "image/png", "image/webp", "image/jpg"];
        cb(null, allowed.includes(file.mimetype));
    },
});

/* Public — exposes UPI ID + merchant name (users need these) */
router.get("/public", async (_req, res) => {
    try {
        const settings = await getStudioSettings();
        res.json({
            upiId: settings.upiId || "",
            merchantName: settings.merchantName || "Mehndi Studio",
        });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

/* Admin — full settings + QR preview */
router.get("/", requireAuth, requireAdmin, async (_req, res) => {
    try {
        const [settings, qr] = await Promise.all([
            getStudioSettings(),
            getQrCode(),
        ]);
        res.json({
            ...settings,
            staticQrUrl: qr?.url || null,
            staticQrFileId: qr?.id || null,
        });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

/* Admin — save UPI ID + merchant name */
router.post("/", requireAuth, requireAdmin, async (req, res) => {
    try {
        const { upiId, merchantName } = req.body || {};
        if (!upiId?.trim()) {
            return res.status(400).json({ message: "UPI ID is required" });
        }
        const settings = await saveStudioSettings({
            upiId: upiId.trim(),
            merchantName: (merchantName || "Mehndi Studio").trim(),
        });
        res.json({ ok: true, ...settings });
    } catch (err) {
        res.status(400).json({ message: err.message });
    }
});

/* Admin — upload static QR (optional fallback) */
router.post("/qr", requireAuth, requireAdmin, upload.single("image"), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ message: "QR image required" });
        const uploaded = await uploadQrCode({
            buffer: req.file.buffer,
            mimeType: req.file.mimetype,
        });
        res.json({
            ok: true,
            staticQrUrl: `https://drive.google.com/thumbnail?id=${uploaded.id}&sz=w600`,
            staticQrFileId: uploaded.id,
        });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

export default router;