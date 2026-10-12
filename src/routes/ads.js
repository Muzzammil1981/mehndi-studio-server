import express from "express";
import { requireAuth } from "../middleware/auth.js";
import {
    listAds, listAdsAdmin, getAd,
    createAd, updateAd, deleteAd,
    startRun, endRun,
    buildAdReport,
} from "../services/adService.js";

const router = express.Router();

/* One reusable admin guard instead of repeating the role check in every route */
const requireAdmin = [
    requireAuth,
    (req, res, next) =>
        ["ADMIN", "SUPERADMIN"].includes(req.user?.role)
            ? next()
            : res.status(403).json({ message: "Admin only" }),
];

/* ---------- PUBLIC: active ads for a monitor ---------- */
router.get("/active", async (req, res) => {
    try {
        const { eventId } = req.query;
        if (!eventId) return res.status(400).json({ message: "eventId is required" });
        res.set("Cache-Control", "no-store"); // play counters must never come from a cache
        res.json(await listAds({ eventId }));
    } catch (err) { res.status(500).json({ message: err.message }); }
});

/* ---------- PUBLIC: run lifecycle (called by monitor) ---------- */
router.post("/:id/run-start", async (req, res) => {
    try {
        const videoId = req.body?.videoId;
        if (!videoId) return res.status(400).json({ message: "videoId is required" });
        res.json(await startRun({ id: req.params.id, videoId }));
    } catch (err) { res.status(400).json({ message: err.message }); }
});

router.post("/:id/run-end", async (req, res) => {
    try {
        const runId = req.body?.runId;
        if (!runId) return res.status(400).json({ message: "runId is required" });
        res.json(await endRun({
            id: req.params.id,
            runId,
            completed: Boolean(req.body?.completed),
            // "error" = video failed to load; endRun should NOT count it as a delivered play
            failed: req.body?.reason === "error",
        }));
    } catch (err) { res.status(400).json({ message: err.message }); }
});

/* ---------- ADMIN: CRUD ---------- */
router.get("/", requireAdmin, async (req, res) => {
    try { res.json(await listAdsAdmin({ eventId: req.query.eventId })); }
    catch (err) { res.status(500).json({ message: err.message }); }
});

router.get("/:id", requireAdmin, async (req, res) => {
    try {
        const ad = await getAd(req.params.id);
        if (!ad) return res.status(404).json({ message: "Ad not found" });
        res.json(ad);
    } catch (err) { res.status(500).json({ message: err.message }); }
});

router.post("/", requireAdmin, async (req, res) => {
    try { res.status(201).json(await createAd(req.body || {})); }
    catch (err) { res.status(400).json({ message: err.message }); }
});

router.patch("/:id", requireAdmin, async (req, res) => {
    try { res.json(await updateAd({ id: req.params.id, patch: req.body || {} })); }
    catch (err) { res.status(400).json({ message: err.message }); }
});

router.delete("/:id", requireAdmin, async (req, res) => {
    try { res.json(await deleteAd(req.params.id)); }
    catch (err) { res.status(400).json({ message: err.message }); }
});

router.get("/:id/report", requireAdmin, async (req, res) => {
    try {
        res.json(await buildAdReport({
            id: req.params.id,
            from: req.query.from,
            to: req.query.to,
        }));
    } catch (err) { res.status(400).json({ message: err.message }); }
});

export default router;