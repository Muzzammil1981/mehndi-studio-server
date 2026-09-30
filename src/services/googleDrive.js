import dotenv from "dotenv";
dotenv.config();

import { google } from "googleapis";
import { Readable } from "stream";
import {
    readTokens, writeTokens, clearTokens,
    writeRootFolderId, readRootFolderId,
} from "./tokenStore.js";

export const CATEGORY_FOLDERS = [
    "Arabic", "Indian", "Pakistani", "Moroccan",
    "Indo-Arabic", "Minimal-Modern", "Bridal",
];

export const CATEGORY_ID_TO_FOLDER = {
    "arabic": "Arabic",
    "indian": "Indian",
    "pakistani": "Pakistani",
    "moroccan": "Moroccan",
    "indo-arabic": "Indo-Arabic",
    "minimal-modern": "Minimal-Modern",
    "bridal": "Bridal",
};

export const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
);

const saved = readTokens();
if (saved) oauth2Client.setCredentials(saved);

oauth2Client.on("tokens", (newTokens) => {
    const merged = { ...readTokens(), ...newTokens };
    writeTokens(merged);
    oauth2Client.setCredentials(merged);
});

/* ---------- OAuth ---------- */

export function getAuthUrl() {
    return oauth2Client.generateAuthUrl({
        access_type: "offline",
        prompt: "consent",
        scope: [
            "https://www.googleapis.com/auth/drive",
            "https://www.googleapis.com/auth/userinfo.email",
        ],
    });
}

export async function exchangeCode(code) {
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);
    writeTokens(tokens);

    const oauth2 = google.oauth2({ version: "v2", auth: oauth2Client });
    const me = await oauth2.userinfo.get();
    const merged = { ...tokens, email: me.data.email };
    writeTokens(merged);

    return merged;
}

export function isConnected() {
    const t = readTokens();
    return Boolean(t?.refresh_token);
}

export function getAccount() {
    const t = readTokens();
    return t ? { email: t.email, folderId: readRootFolderId() } : null;
}

export function disconnect() {
    clearTokens();
    oauth2Client.setCredentials({});
}

/* ---------- Drive helpers ---------- */

function drive() {
    return google.drive({ version: "v3", auth: oauth2Client });
}

async function findFolder(name, parentId) {
    const q = [
        `name='${name}'`,
        "mimeType='application/vnd.google-apps.folder'",
        "trashed=false",
        parentId ? `'${parentId}' in parents` : null,
    ].filter(Boolean).join(" and ");

    const res = await drive().files.list({ q, fields: "files(id,name)" });
    return res.data.files?.[0] || null;
}

export async function ensureFolder(name, parentId) {
    const existing = await findFolder(name, parentId);
    if (existing) return existing.id;

    const created = await drive().files.create({
        requestBody: {
            name,
            mimeType: "application/vnd.google-apps.folder",
            parents: parentId ? [parentId] : undefined,
        },
        fields: "id",
    });
    return created.data.id;
}

/* ---------- Studio setup ---------- */

export async function setupStudioFolders() {
    console.log("📁 setupStudioFolders() starting…");

    const rootId = await ensureFolder("Mehndi-Studio");
    console.log("✅ Root:", rootId);

    const usersId = await ensureFolder("Users", rootId);
    await ensureFolder("user-images", usersId);

    const designsId = await ensureFolder("Mehndi-Designs", rootId);
    for (const cat of CATEGORY_FOLDERS) {
        await ensureFolder(cat, designsId);
    }

    const dataId = await ensureFolder("Data", rootId);
    await ensureFolder("Settings", rootId);

    writeRootFolderId(rootId);
    console.log("🎉 Studio folders ready. Root ID:", rootId);

    return { rootId, usersId, designsId, dataId };
}

/** Returns the folder IDs we need for design uploads. Auto-creates missing ones. */
export async function getStudioFolders() {
    let rootId = readRootFolderId();
    if (!rootId) {
        if (!isConnected()) throw new Error("Connect Google Drive first.");
        ({ rootId } = await setupStudioFolders());
    }
    const designsId = await ensureFolder("Mehndi-Designs", rootId);
    const dataId = await ensureFolder("Data", rootId);
    return { rootId, designsId, dataId };
}

/* ---------- File operations ---------- */

export async function uploadFile({ name, mimeType, buffer, parentId }) {
    const created = await drive().files.create({
        requestBody: { name, parents: parentId ? [parentId] : undefined },
        media: { mimeType, body: Readable.from(buffer) },
        fields: "id, name, webViewLink",
    });
    return created.data;
}

export async function getFileStream(fileId) {
    const res = await drive().files.get(
        { fileId, alt: "media" },
        { responseType: "stream" }
    );
    return {
        stream: res.data,
        contentType: res.headers["content-type"] || "application/octet-stream",
    };
}
export async function makePublic(fileId) {
    try {
        await drive().permissions.create({
            fileId,
            requestBody: { role: "reader", type: "anyone" },
        });
        console.log("✅ Made public:", fileId);
    } catch (err) {
        console.error("❌ makePublic failed for", fileId, ":", err.message);
        // Fallback: try changing the parent folder's permissions
        throw err;
    }
}

export async function deleteFile(fileId) {
    try {
        await drive().files.delete({ fileId });
    } catch (err) {
        if (err.code !== 404) throw err;
    }
}

/* ---------- JSON helpers (Data/ folder) ---------- */

export async function readJson(fileName, parentId) {
    const q = `name='${fileName}' and '${parentId}' in parents and trashed=false`;
    const list = await drive().files.list({ q, fields: "files(id)" });
    const file = list.data.files?.[0];
    if (!file) return null;

    const res = await drive().files.get(
        { fileId: file.id, alt: "media" },
        { responseType: "json" }
    );
    return { fileId: file.id, data: res.data };
}

export async function writeJson(fileName, data, parentId) {
    const existing = await readJson(fileName, parentId);
    const media = {
        mimeType: "application/json",
        body: Readable.from(JSON.stringify(data, null, 2)),
    };

    if (existing) {
        await drive().files.update({ fileId: existing.fileId, media });
        return existing.fileId;
    }

    const created = await drive().files.create({
        requestBody: { name: fileName, parents: [parentId] },
        media,
        fields: "id",
    });
    return created.data.id;
}

/* ---------- Generic file helpers (for Excel, PDFs, etc.) ---------- */

export async function findFileByName(name, parentId) {
    const q = [
        `name='${name}'`,
        "trashed=false",
        "mimeType!='application/vnd.google-apps.folder'",
        parentId ? `'${parentId}' in parents` : null,
    ].filter(Boolean).join(" and ");

    const res = await drive().files.list({ q, fields: "files(id,name,mimeType)" });
    return res.data.files?.[0] || null;
}

export async function downloadFileBuffer(fileId) {
    const res = await drive().files.get(
        { fileId, alt: "media" },
        { responseType: "arraybuffer" }
    );
    return Buffer.from(res.data);
}

export async function updateFileBuffer(fileId, buffer, mimeType) {
    await drive().files.update({
        fileId,
        media: { mimeType, body: Readable.from(buffer) },
    });
}