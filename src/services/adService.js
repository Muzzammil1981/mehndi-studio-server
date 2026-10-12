import crypto from "crypto";
import { getStudioFolders, readJson, writeJson, isConnected } from "./googleDrive.js";

const FILE = "ads.json";

async function loadAll() {
    if (!isConnected()) return [];
    const { dataId } = await getStudioFolders();
    const doc = await readJson(FILE, dataId);
    return doc?.data?.ads || [];
}

async function saveAll(ads) {
    const { dataId } = await getStudioFolders();
    await writeJson(FILE, { ads }, dataId);
}

/* ---------- Derived fields (never stored, always recomputed) ---------- */
function deriveVideo(v) {
    const purchased = Number(v.purchasedPlays) || 0;
    const completed = Number(v.playsCompleted) || 0;
    const interrupted = Number(v.playsInterrupted) || 0;
    const delivered = completed + interrupted;
    v.deliveredPlays = delivered;
    v.remainingPlays = Math.max(0, purchased - delivered);
    v.exhausted = purchased > 0 && delivered >= purchased;
    return v;
}

function deriveCampaign(c) {
    c.videos = (c.videos || []).map(deriveVideo);
    const purchased = c.videos.reduce((n, v) => n + (v.purchasedPlays || 0), 0);
    const delivered = c.videos.reduce((n, v) => n + v.deliveredPlays, 0);
    c.totalPurchasedPlays = purchased;
    c.totalDeliveredPlays = delivered;
    c.remainingPlays = Math.max(0, purchased - delivered);
    c.exhausted = purchased > 0 && delivered >= purchased;
    c.totalCost = (Number(c.costPerPlay) || 0) * purchased;
    c.earnedCost = (Number(c.costPerPlay) || 0) * delivered;
    return c;
}

/* ---------- Public read (monitor) ---------- */
export async function listAds({ eventId }) {
    const ads = await loadAll();
    return ads
        .filter(a => a.eventId === eventId && a.active)
        .map(c => deriveCampaign(JSON.parse(JSON.stringify(c))))
        .filter(c => !c.exhausted);
}

/* ---------- Admin read ---------- */
export async function listAdsAdmin({ eventId }) {
    const ads = await loadAll();
    const scoped = eventId ? ads.filter(a => a.eventId === eventId) : ads;
    return scoped.map(c => deriveCampaign(JSON.parse(JSON.stringify(c))));
}

export async function getAd(id) {
    const ads = await loadAll();
    const c = ads.find(a => a.id === id);
    if (!c) return null;
    return deriveCampaign(JSON.parse(JSON.stringify(c)));
}

/* ---------- Create ---------- */
export async function createAd({
    eventId,
    advertiserName, advertiserContact, campaignTitle,
    playMode, intervalMinutes,
    costPerPlay, paid,
    videos,
}) {
    if (!eventId) throw new Error("Event is required");
    if (!advertiserName?.trim()) throw new Error("Advertiser name is required");
    if (!Array.isArray(videos) || videos.length === 0) throw new Error("At least one video is required");
    if (!["no-session", "interval", "no-session-and-interval"].includes(playMode)) {
        throw new Error("Invalid play mode");
    }
    if (playMode !== "no-session" && (!intervalMinutes || Number(intervalMinutes) < 1)) {
        throw new Error("Interval (minutes) is required for this play mode");
    }

    const normVideos = videos.map((v, i) => {
        if (!v.url?.trim()) throw new Error(`Video ${i + 1}: URL is missing`);
        if (!v.embedUrl?.trim()) throw new Error(`Video ${i + 1}: embed URL is missing`);
        if (!v.purchasedPlays || Number(v.purchasedPlays) < 1) {
            throw new Error(`Video ${i + 1}: purchased plays must be at least 1`);
        }
        if (!v.durationSeconds || Number(v.durationSeconds) < 5) {
            throw new Error(`Video ${i + 1}: duration must be at least 5 seconds`);
        }
        return {
            id: crypto.randomUUID(),
            url: String(v.url).trim(),
            embedUrl: String(v.embedUrl).trim(),
            title: String(v.title || `Video ${i + 1}`).trim(),
            durationSeconds: Number(v.durationSeconds),
            purchasedPlays: Number(v.purchasedPlays),
            playsCompleted: 0,
            playsInterrupted: 0,
        };
    });

    const campaign = {
        id: crypto.randomUUID(),
        eventId,
        advertiserName: String(advertiserName).trim(),
        advertiserContact: String(advertiserContact || "").trim(),
        campaignTitle: String(campaignTitle || "").trim(),
        playMode,
        intervalMinutes: playMode === "no-session" ? null : Number(intervalMinutes),
        costPerPlay: Number(costPerPlay) || 0,
        paid: Boolean(paid),
        active: true,
        videos: normVideos,
        lastPlayedAt: null,
        runs: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
    };

    const ads = await loadAll();
    ads.unshift(campaign);
    await saveAll(ads);
    return deriveCampaign(campaign);
}

/* ---------- Update ---------- */
export async function updateAd({ id, patch }) {
    const ads = await loadAll();
    const c = ads.find(a => a.id === id);
    if (!c) throw new Error("Ad not found");

    ["advertiserName", "advertiserContact", "campaignTitle", "playMode", "intervalMinutes", "costPerPlay", "paid", "active"]
        .forEach(k => { if (patch[k] !== undefined) c[k] = patch[k]; });

    if (Array.isArray(patch.videos)) {
        c.videos = patch.videos.map((v, i) => {
            const prev = (c.videos || []).find(x => x.id === v.id);
            return {
                id: v.id || crypto.randomUUID(),
                url: String(v.url || "").trim(),
                embedUrl: String(v.embedUrl || "").trim(),
                title: String(v.title || `Video ${i + 1}`).trim(),
                durationSeconds: Number(v.durationSeconds) || 30,
                purchasedPlays: Number(v.purchasedPlays) || 1,
                playsCompleted: prev?.playsCompleted || 0,
                playsInterrupted: prev?.playsInterrupted || 0,
            };
        });
    }

    c.updatedAt = new Date().toISOString();
    await saveAll(ads);
    return deriveCampaign(c);
}

export async function deleteAd(id) {
    const ads = await loadAll();
    const next = ads.filter(a => a.id !== id);
    if (next.length === ads.length) throw new Error("Ad not found");
    await saveAll(next);
    return { ok: true };
}

/* ---------- Run lifecycle ---------- */
export async function startRun({ id, videoId }) {
    const ads = await loadAll();
    const c = ads.find(a => a.id === id);
    if (!c) throw new Error("Ad not found");
    if (!c.active) throw new Error("Ad is paused");

    const v = c.videos.find(x => x.id === videoId);
    if (!v) throw new Error("Video not found");

    deriveVideo(v);
    if (v.exhausted) throw new Error("This video has reached its purchased plays");

    const run = {
        id: crypto.randomUUID(),
        videoId,
        videoTitle: v.title,              // ← NEW: freeze the title on the run record
        startedAt: new Date().toISOString(),
        endedAt: null,
        durationSeconds: 0,
        plannedDurationSeconds: v.durationSeconds,
        completed: false,
    };
    c.runs = c.runs || [];
    c.runs.push(run);
    c.lastPlayedAt = run.startedAt;
    c.updatedAt = new Date().toISOString();
    await saveAll(ads);

    return {
        runId: run.id,
        campaignId: id,
        videoId,
        startedAt: run.startedAt,
        plannedDurationSeconds: v.durationSeconds,
    };
}

export async function endRun({ id, runId, completed }) {
    const ads = await loadAll();
    const c = ads.find(a => a.id === id);
    if (!c) throw new Error("Ad not found");

    const run = (c.runs || []).find(r => r.id === runId);
    if (!run) throw new Error("Run not found");
    if (run.endedAt) return { ok: true, alreadyEnded: true };

    const endedAt = new Date();
    run.endedAt = endedAt.toISOString();
    run.durationSeconds = Math.max(0, Math.round((endedAt - new Date(run.startedAt)) / 1000));
    run.completed = Boolean(completed);

    // Guard: runs under 3 seconds don't count (spam protection)
    if (run.durationSeconds < 3) {
        run.rejected = true;
    } else {
        const v = c.videos.find(x => x.id === run.videoId);
        if (v) {
            if (run.completed) v.playsCompleted = (v.playsCompleted || 0) + 1;
            else v.playsInterrupted = (v.playsInterrupted || 0) + 1;
        }
    }

    deriveCampaign(c);
    if (c.exhausted) c.active = false;

    c.updatedAt = new Date().toISOString();
    await saveAll(ads);
    return { ok: true };
}

/* ---------- Sweeper (called every 60s) ---------- */
export async function sweepStaleRuns() {
    const ads = await loadAll();
    const now = Date.now();
    let changed = false;

    ads.forEach(c => {
        (c.runs || []).forEach(run => {
            if (run.endedAt) return;
            const age = (now - new Date(run.startedAt).getTime()) / 1000;
            const planned = run.plannedDurationSeconds || 30;
            if (age > planned + 30) {
                run.endedAt = new Date().toISOString();
                run.durationSeconds = Math.round(age);
                run.completed = false;
                run.rejected = run.durationSeconds < 3;
                if (!run.rejected) {
                    const v = c.videos.find(x => x.id === run.videoId);
                    if (v) v.playsInterrupted = (v.playsInterrupted || 0) + 1;
                }
                changed = true;
            }
        });
    });

    if (changed) await saveAll(ads);
    return { changed };
}

/* ---------- Report ---------- */
export async function buildAdReport({ id, from, to }) {
    const ads = await loadAll();
    const c = ads.find(a => a.id === id);
    if (!c) throw new Error("Ad not found");

    const fromMs = from ? new Date(from).getTime() : 0;
    const toMs = to ? new Date(to).getTime() + 24 * 3600 * 1000 - 1 : Infinity;

    const runs = (c.runs || [])
        .filter(r => {
            const t = new Date(r.startedAt).getTime();
            return t >= fromMs && t <= toMs;
        })
        .sort((a, b) => new Date(a.startedAt) - new Date(b.startedAt));

    const totalScreenTime = runs.reduce((n, r) => n + (r.durationSeconds || 0), 0);

    return {
        campaign: deriveCampaign(JSON.parse(JSON.stringify(c))),
        summary: {
            totalRuns: runs.length,
            completedRuns: runs.filter(r => r.completed).length,
            interruptedRuns: runs.filter(r => !r.completed && !r.rejected).length,
            rejectedRuns: runs.filter(r => r.rejected).length,
            totalScreenTime,
        },
        runs,
    };
}