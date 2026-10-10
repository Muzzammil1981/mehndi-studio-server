import express from "express";
import { requireAuth } from "../middleware/auth.js";
import {
    listAds, listAdsAdmin, getAd,
    createAd, updateAd, deleteAd,
    startRun, endRun,
    buildAdReport,
} from "../services/adService.js";

const router = express.Router();

/* ---------- PUBLIC: active ads for a monitor ---------- */
router.get("/active", async (req, res) => {
    try {
        const { eventId } = req.query;
        if (!eventId) return res.status(400).json({ message: "eventId is required" });
        res.json(await listAds({ eventId }));
    } catch (err) { res.status(500).json({ message: err.message }); }
});

/* ---------- PUBLIC: run lifecycle (called by monitor) ---------- */
router.post("/:id/run-start", async (req, res) => {
    try {
        res.json(await startRun({ id: req.params.id, videoId: req.body?.videoId }));
    } catch (err) { res.status(400).json({ message: err.message }); }
});

router.post("/:id/run-end", async (req, res) => {
    try {
        res.json(await endRun({
            id: req.params.id,
            runId: req.body?.runId,
            completed: Boolean(req.body?.completed),
        }));
    } catch (err) { res.status(400).json({ message: err.message }); }
});

/* ---------- ADMIN: CRUD ---------- */
router.get("/", requireAuth, async (req, res) => {
    if (!["ADMIN", "SUPERADMIN"].includes(req.user.role)) return res.status(403).json({ message: "Admin only" });
    try { res.json(await listAdsAdmin({ eventId: req.query.eventId })); }
    catch (err) { res.status(500).json({ message: err.message }); }
});

router.get("/:id", requireAuth, async (req, res) => {
    if (!["ADMIN", "SUPERADMIN"].includes(req.user.role)) return res.status(403).json({ message: "Admin only" });
    try {
        const ad = await getAd(req.params.id);
        if (!ad) return res.status(404).json({ message: "Ad not found" });
        res.json(ad);
    } catch (err) { res.status(500).json({ message: err.message }); }
});

router.post("/", requireAuth, async (req, res) => {
    if (!["ADMIN", "SUPERADMIN"].includes(req.user.role)) return res.status(403).json({ message: "Admin only" });
    try { res.status(201).json(await createAd(req.body || {})); }
    catch (err) { res.status(400).json({ message: err.message }); }
});

router.patch("/:id", requireAuth, async (req, res) => {
    if (!["ADMIN", "SUPERADMIN"].includes(req.user.role)) return res.status(403).json({ message: "Admin only" });
    try { res.json(await updateAd({ id: req.params.id, patch: req.body || {} })); }
    catch (err) { res.status(400).json({ message: err.message }); }
});

router.delete("/:id", requireAuth, async (req, res) => {
    if (!["ADMIN", "SUPERADMIN"].includes(req.user.role)) return res.status(403).json({ message: "Admin only" });
    try { res.json(await deleteAd(req.params.id)); }
    catch (err) { res.status(400).json({ message: err.message }); }
});

router.get("/:id/report", requireAuth, async (req, res) => {
    if (!["ADMIN", "SUPERADMIN"].includes(req.user.role)) return res.status(403).json({ message: "Admin only" });
    try {
        res.json(await buildAdReport({
            id: req.params.id,
            from: req.query.from,
            to: req.query.to,
        }));
    } catch (err) { res.status(400).json({ message: err.message }); }
});

export default router;