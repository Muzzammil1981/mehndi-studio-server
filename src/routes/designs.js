import express from "express";
import multer from "multer";
import { categories } from "../data/categories.js";
import {
    getStudioFolders, ensureFolder, uploadFile, makePublic, deleteFile,
    readJson, writeJson, isConnected, getFileStream, CATEGORY_ID_TO_FOLDER,
} from "../services/googleDrive.js";
import { notifyUsers } from "../socket.js";

const router = express.Router();

/* Multer — keep image in memory so we can forward to Drive */
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 8 * 1024 * 1024 },
    fileFilter: (_req, file, cb) => {
        const allowed = ["image/jpeg", "image/png", "image/webp", "image/jpg"];
        cb(null, allowed.includes(file.mimetype));
    },
});

/* ---------- helpers ---------- */

function slugify(v) {
    return String(v).toLowerCase().trim()
        .replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

/* Images are served through our own API, so the browser never talks to Drive.
   The frontend's imageUrl() prefixes this relative path with VITE_API_URL. */
function proxyImagePath(designId) {
    return `/api/designs/${designId}/image`;
}

function withImageUrl(d) {
    return {
        ...d,
        image: d.driveFileId ? proxyImagePath(d.id) : d.image,
    };
}

/* Small in-memory cache so every image request doesn't re-read designs.json from Drive */
const CACHE_MS = 60 * 1000;
let cache = { designs: null, at: 0 };

async function loadDesigns({ fresh = false } = {}) {
    if (!isConnected()) {
        console.warn("loadDesigns: Drive not connected");
        return [];
    }
    if (!fresh && cache.designs && Date.now() - cache.at < CACHE_MS) {
        return [...cache.designs];
    }
    const { dataId } = await getStudioFolders();
    const doc = await readJson("designs.json", dataId);
    const designs =
        doc?.data?.designs || doc?.designs || (Array.isArray(doc) ? doc : []);
    cache = { designs, at: Date.now() };
    return [...designs];
}

async function saveDesigns(designs) {
    const { dataId } = await getStudioFolders();
    await writeJson("designs.json", { designs }, dataId);
    cache = { designs: [...designs], at: Date.now() };
}

/* ---------- routes ---------- */

router.get("/", async (_req, res) => {
    try {
        const designs = await loadDesigns();
        res.json(designs.map(withImageUrl));
    } catch (err) {
        console.error("GET /designs failed:", err);
        res.json([]); // graceful fallback so public site still renders
    }
});

/* Image proxy — streams the file from Drive through the backend.
   Only files that belong to a saved design can be fetched (the OAuth scope
   covers the whole Drive, so we never accept a raw file ID from the client). */
router.get("/:id/image", async (req, res) => {
    try {
        const design = (await loadDesigns()).find(d => d.id === req.params.id);
        if (!design?.driveFileId) return res.status(404).end();

        const { stream, contentType } = await getFileStream(design.driveFileId);

        res.setHeader(
            "Content-Type",
            contentType?.startsWith("image/") ? contentType : "image/jpeg"
        );
        res.setHeader("Cache-Control", "public, max-age=86400");

        stream.on("error", (err) => {
            console.error("Image stream error:", err.message);
            res.destroy(err);
        });
        stream.pipe(res);
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

router.post("/", upload.single("image"), async (req, res) => {
    try {
        const { name, description, price, amountType, categoryId, featured } = req.body;
        const category = categories.find(c => c.id === categoryId);
        if (!category) return res.status(400).json({ message: "Valid category required" });
        if (!name?.trim()) return res.status(400).json({ message: "Design name required" });
        if (!req.file) return res.status(400).json({ message: "Design image required" });
        if (!isConnected()) return res.status(503).json({ message: "Google Drive not connected" });

        const { designsId } = await getStudioFolders();
        const folderName = CATEGORY_ID_TO_FOLDER[categoryId];
        const categoryFolderId = await ensureFolder(folderName, designsId);

        const safeName = slugify(name) || "design";
        const ext = "." + (req.file.originalname.split(".").pop() || "jpg").toLowerCase();
        const fileName = `${safeName}-${Date.now()}${ext}`;

        const uploaded = await uploadFile({
            name: fileName,
            mimeType: req.file.mimetype,
            buffer: req.file.buffer,
            parentId: categoryFolderId,
        });

        /* Not strictly needed with the proxy, but harmless and keeps Drive links usable */
        try {
            await makePublic(uploaded.id);
        } catch (err) {
            console.error("⚠️  Could not make public, retrying in 1s…", err.message);
            await new Promise(r => setTimeout(r, 1000));
            try { await makePublic(uploaded.id); } catch { /* proxy still works */ }
        }

        const id = `${safeName}-${Date.now()}`;
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

        /* realtime broadcast to public users */
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

        await saveDesigns(designs);
        res.json({ message: "Design removed", id: removed.id });
    } catch (err) {
        console.error("DELETE /designs failed:", err);
        res.status(500).json({ message: err.message });
    }
});

export default router;