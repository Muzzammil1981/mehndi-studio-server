import express from "express";
import multer from "multer";
import sharp from "sharp";
import { categories } from "../data/categories.js";
import {
    getStudioFolders, ensureFolder, uploadFile, makePublic, deleteFile,
    readJson, writeJson, isConnected, getFileStream, CATEGORY_ID_TO_FOLDER,
} from "../services/googleDrive.js";
import { notifyUsers } from "../socket.js";

const router = express.Router();

/* =========================================================
   IMAGE CACHES (true LRU, byte-limited)
   ========================================================= */
function createCache(maxBytes) {
    const map = new Map(); // id -> { buf, fileId, contentType, etag }
    let bytes = 0;
    return {
        get(id) {
            const e = map.get(id);
            if (e) { map.delete(id); map.set(id, e); } // refresh recency
            return e;
        },
        set(id, entry) {
            const old = map.get(id);
            if (old) { bytes -= old.buf.length; map.delete(id); }
            map.set(id, entry);
            bytes += entry.buf.length;
            for (const [k, v] of map) {               // evict least-recently used
                if (bytes <= maxBytes) break;
                map.delete(k); bytes -= v.buf.length;
            }
        },
        delete(id) {
            const old = map.get(id);
            if (old) { bytes -= old.buf.length; map.delete(id); }
        },
    };
}

const fullCache = createCache(100 * 1024 * 1024); // full-size images
const thumbCache = createCache(60 * 1024 * 1024); // 640px thumbnails (~50 KB each)
const fullInflight = new Map();
const thumbInflight = new Map();

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/* Concurrency limiter for Drive downloads (never exceeds `max`) */
let active = 0;
const waiting = [];
async function limit(fn, max = 4) {
    while (active >= max) await new Promise(r => waiting.push(r));
    active++;
    try { return await fn(); }
    finally { active--; waiting.shift()?.(); }
}

/* ---------- image processing ---------- */

/* Full-size: max 1600px, WebP q85. Use .webp({ lossless: true }) for zero loss. */
function optimize(buffer) {
    return sharp(buffer)
        .rotate()
        .resize({ width: 1600, height: 1600, fit: "inside", withoutEnlargement: true })
        .webp({ quality: 85 })
        .toBuffer();
}

const THUMB_WIDTH = 640;
function makeThumb(buffer) {
    return sharp(buffer)
        .rotate()
        .resize({ width: THUMB_WIDTH, withoutEnlargement: true })
        .webp({ quality: 80 })
        .toBuffer();
}

/* ---------- fetch from Drive (cached) ---------- */

async function getImage(design) {
    const hit = fullCache.get(design.id);
    if (hit && hit.fileId === design.driveFileId) return hit;
    if (fullInflight.has(design.id)) return fullInflight.get(design.id);

    const p = limit(async () => {
        let lastErr;
        for (let i = 0; i < 3; i++) {
            try {
                const { stream, contentType } = await getFileStream(design.driveFileId);
                const chunks = [];
                for await (const c of stream) chunks.push(c);
                const buf = Buffer.concat(chunks);
                const entry = {
                    buf,
                    fileId: design.driveFileId,
                    contentType: contentType?.startsWith("image/") ? contentType : "image/jpeg",
                    etag: `"${design.driveFileId}-${buf.length}"`,
                };
                fullCache.set(design.id, entry);
                return entry;
            } catch (err) {
                lastErr = err;
                if (err.code === 404) break;
                await sleep(300 * (i + 1));
            }
        }
        throw lastErr;
    }).finally(() => fullInflight.delete(design.id));

    fullInflight.set(design.id, p);
    return p;
}

/* Thumbnail generated lazily from the full image, then cached. */
async function getThumb(design) {
    const hit = thumbCache.get(design.id);
    if (hit && hit.fileId === design.driveFileId) return hit;
    if (thumbInflight.has(design.id)) return thumbInflight.get(design.id);

    const p = (async () => {
        const full = await getImage(design);
        try {
            const buf = await makeThumb(full.buf);
            const entry = {
                buf,
                fileId: design.driveFileId,
                contentType: "image/webp",
                etag: `"${design.driveFileId}-t-${buf.length}"`,
            };
            thumbCache.set(design.id, entry);
            return entry;
        } catch (err) {
            console.warn("thumb failed, serving full image:", err.message);
            return full;
        }
    })().finally(() => thumbInflight.delete(design.id));

    thumbInflight.set(design.id, p);
    return p;
}

/* =========================================================
   UPLOAD (multer) with proper JSON errors
   ========================================================= */
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 8 * 1024 * 1024 },
    fileFilter: (_req, file, cb) => {
        const allowed = ["image/jpeg", "image/png", "image/webp", "image/jpg"];
        cb(null, allowed.includes(file.mimetype));
    },
});

function uploadImage(req, res, next) {
    upload.single("image")(req, res, (err) => {
        if (!err) return next();
        const message = err.code === "LIMIT_FILE_SIZE"
            ? "Image is too large (max 8 MB)"
            : err.message || "Upload failed";
        res.status(400).json({ message });
    });
}

/* ---------- helpers ---------- */

function slugify(v) {
    return String(v).toLowerCase().trim()
        .replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

function proxyImagePath(designId) {
    return `/api/designs/${designId}/image`;
}

function withImageUrl(d) {
    return {
        ...d,
        image: d.driveFileId ? proxyImagePath(d.id) : d.image,
    };
}

/* Seeded PRNG + shuffle: same seed => same order, so pages of a random
   feed stay consistent while the user scrolls. A new seed => new order. */
function mulberry32(seed) {
    let a = seed | 0;
    return function () {
        a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function seededShuffle(arr, seed) {
    const a = [...arr];
    const rand = mulberry32(seed);
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
}

const byNewest = (a, b) => (b.createdAt || "").localeCompare(a.createdAt || "");
const byOldest = (a, b) => (a.createdAt || "").localeCompare(b.createdAt || "");
const clamp = (n, min, max) => Math.min(max, Math.max(min, n));

function matchesQuery(d, tokens) {
    const hay = `${d.name || ""} ${d.description || ""} ${d.categoryName || ""}`.toLowerCase();
    return tokens.every(t => hay.includes(t));
}

/* Warm the newest designs' thumbnails in the background, one at a time,
   so real user requests are never stuck behind the warm-up. */
const WARM_COUNT = 150;
export async function warmDesignImages() {
    const designs = await loadDesigns({ fresh: true });
    const newest = designs
        .filter(d => d.driveFileId)
        .sort(byNewest)
        .slice(0, WARM_COUNT);
    for (const d of newest) {
        await getThumb(d).catch(() => { });
    }
}

/* Small in-memory cache so every request doesn't re-read designs.json from Drive */
const CACHE_MS = 60 * 1000;
let cache = { designs: null, at: 0 };
let designsInflight = null;

async function loadDesigns({ fresh = false } = {}) {
    if (!isConnected()) {
        console.warn("loadDesigns: Drive not connected");
        return cache.designs ? [...cache.designs] : [];
    }
    if (!fresh && cache.designs && Date.now() - cache.at < CACHE_MS) {
        return [...cache.designs];
    }
    if (!fresh && designsInflight) return [...(await designsInflight)];

    const p = (async () => {
        try {
            const { dataId } = await getStudioFolders();
            const doc = await readJson("designs.json", dataId);
            const designs =
                doc?.data?.designs || doc?.designs || (Array.isArray(doc) ? doc : []);
            cache = { designs, at: Date.now() };
            return designs;
        } catch (err) {
            if (cache.designs) return cache.designs; // serve stale instead of failing
            throw err;
        }
    })();

    designsInflight = p;
    try { return [...(await p)]; }
    finally { if (designsInflight === p) designsInflight = null; }
}

async function saveDesigns(designs) {
    const { dataId } = await getStudioFolders();
    await writeJson("designs.json", { designs }, dataId);
    cache = { designs: [...designs], at: Date.now() };
}

/* =========================================================
   ROUTES
   ========================================================= */

/* GET /api/designs
   Paged mode (when `page` or `limit` is sent):
     ?page=1&limit=12
     &category=bridal | all
     &q=search words (all words must match name/description/category)
     &sort=newest | oldest | random      (random needs &seed=<int>)
     &featured=true
   -> { items, total, page, limit, hasMore }
   Without page/limit it still returns the full array (legacy). */
router.get("/", async (req, res) => {
    try {
        const all = await loadDesigns();

        const paged = req.query.page !== undefined || req.query.limit !== undefined;
        if (!paged) return res.json(all.map(withImageUrl));

        const limit = clamp(parseInt(req.query.limit, 10) || 12, 1, 60);
        const page = Math.max(1, parseInt(req.query.page, 10) || 1);
        const category = String(req.query.category || "all");
        const sort = String(req.query.sort || "newest");
        const seed = parseInt(req.query.seed, 10) || 1;
        const tokens = String(req.query.q || "").toLowerCase().split(/\s+/).filter(Boolean);

        let list = all;
        if (category !== "all") list = list.filter(d => d.categoryId === category);
        if (req.query.featured === "true") list = list.filter(d => d.featured);
        if (tokens.length) list = list.filter(d => matchesQuery(d, tokens));

        if (sort === "random") list = seededShuffle(list, seed);
        else if (sort === "oldest") list = [...list].sort(byOldest);
        else list = [...list].sort(byNewest);

        const total = list.length;
        const start = (page - 1) * limit;
        const items = list.slice(start, start + limit).map(withImageUrl);

        res.json({ items, total, page, limit, hasMore: start + items.length < total });
    } catch (err) {
        console.error("GET /designs failed:", err);
        res.json({ items: [], total: 0, page: 1, limit: 12, hasMore: false });
    }
});

/* GET /api/designs/summary?seed=123
   One random cover design + count per category (for the category cards).
   Must be declared BEFORE "/:id". */
router.get("/summary", async (req, res) => {
    try {
        const all = await loadDesigns();
        const rand = mulberry32(parseInt(req.query.seed, 10) || 1);

        const groups = {};
        for (const d of all) (groups[d.categoryId] ||= []).push(d);

        const out = {};
        for (const c of categories) {
            const list = groups[c.id];
            if (!list?.length) continue;
            const cover = list[Math.floor(rand() * list.length)];
            out[c.id] = { count: list.length, cover: withImageUrl(cover) };
        }
        res.json({ total: all.length, categories: out });
    } catch (err) {
        console.error("GET /designs/summary failed:", err);
        res.json({ total: 0, categories: {} });
    }
});

/* Image proxy — ?size=thumb returns a small 640px WebP. */
router.get("/:id/image", async (req, res) => {
    try {
        const design = (await loadDesigns()).find(d => d.id === req.params.id);
        if (!design?.driveFileId) return res.status(404).end();

        const img = req.query.size === "thumb"
            ? await getThumb(design)
            : await getImage(design);

        res.set({
            "Content-Type": img.contentType,
            "Cache-Control": "public, max-age=31536000, immutable",
            "Cross-Origin-Resource-Policy": "cross-origin",
            ETag: img.etag,
        });
        if (req.headers["if-none-match"] === img.etag) return res.status(304).end();
        res.end(img.buf);
    } catch (err) {
        console.error("GET /designs/:id/image failed:", err.message);
        if (!res.headersSent) res.status(err.code === 404 ? 404 : 502).end();
    }
});

router.get("/:id", async (req, res) => {
    try {
        const design = (await loadDesigns()).find(d => d.id === req.params.id);
        if (!design) return res.status(404).json({ message: "Design not found" });
        res.json(withImageUrl(design));
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

router.post("/", uploadImage, async (req, res) => {
    try {
        const { name, description, price, amountType, categoryId, featured } = req.body;
        const category = categories.find(c => c.id === categoryId);
        if (!category) return res.status(400).json({ message: "Valid category required" });
        if (!name?.trim()) return res.status(400).json({ message: "Design name required" });
        if (!req.file) {
            return res.status(400).json({ message: "Design image required (JPG, PNG or WebP only)" });
        }
        if (!isConnected()) return res.status(503).json({ message: "Google Drive not connected" });

        const { designsId } = await getStudioFolders();
        const folderName = CATEGORY_ID_TO_FOLDER[categoryId];
        const categoryFolderId = await ensureFolder(folderName, designsId);

        const safeName = slugify(name) || "design";
        const id = `${safeName}-${Date.now()}`;

        let imageBuffer = req.file.buffer;
        let mimeType = req.file.mimetype;
        let fileName;
        try {
            imageBuffer = await optimize(req.file.buffer);
            mimeType = "image/webp";
            fileName = `${id}.webp`;
        } catch (e) {
            console.warn("sharp failed, uploading original:", e.message);
            const ext = (req.file.originalname.split(".").pop() || "jpg").toLowerCase();
            fileName = `${id}.${ext}`;
        }

        const uploaded = await uploadFile({
            name: fileName,
            mimeType,
            buffer: imageBuffer,
            parentId: categoryFolderId,
        });

        try {
            await makePublic(uploaded.id);
        } catch (err) {
            console.error("⚠️  Could not make public, retrying in 1s…", err.message);
            await sleep(1000);
            try { await makePublic(uploaded.id); } catch { /* proxy still works */ }
        }

        /* Warm both caches so the very first view never waits on Drive */
        fullCache.set(id, {
            buf: imageBuffer,
            fileId: uploaded.id,
            contentType: mimeType,
            etag: `"${uploaded.id}-${imageBuffer.length}"`,
        });
        makeThumb(imageBuffer)
            .then(buf => thumbCache.set(id, {
                buf,
                fileId: uploaded.id,
                contentType: "image/webp",
                etag: `"${uploaded.id}-t-${buf.length}"`,
            }))
            .catch(() => { /* generated lazily on first request */ });

        const design = {
            id,
            name: name.trim(),
            description: String(description || "").trim(),
            price: Number(price || 0),
            amountType: amountType || "per design",
            categoryId,
            categoryName: category.name,
            featured: featured === "true" || featured === true,
            image: proxyImagePath(id),
            driveFileId: uploaded.id,
            createdAt: new Date().toISOString(),
        };

        const designs = await loadDesigns({ fresh: true });
        designs.push(design);
        await saveDesigns(designs);

        notifyUsers({
            id: Date.now().toString(),
            title: "New Mehndi design added",
            body: `${design.name} — ${design.categoryName}`,
            designId: design.id,
            at: new Date().toISOString(),
        });

        res.status(201).json(design);
    } catch (err) {
        console.error("POST /designs failed:", err);
        res.status(500).json({ message: err.message });
    }
});

router.delete("/:id", async (req, res) => {
    try {
        const designs = await loadDesigns({ fresh: true });
        const index = designs.findIndex(d => d.id === req.params.id);
        if (index === -1) return res.status(404).json({ message: "Design not found" });

        const [removed] = designs.splice(index, 1);
        if (removed.driveFileId) await deleteFile(removed.driveFileId);
        fullCache.delete(removed.id);
        thumbCache.delete(removed.id);

        await saveDesigns(designs);
        res.json({ message: "Design removed", id: removed.id });
    } catch (err) {
        console.error("DELETE /designs failed:", err);
        res.status(500).json({ message: err.message });
    }
});

export default router;