import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.resolve(__dirname, "../../data/google-tokens.json");

fs.mkdirSync(path.dirname(FILE), { recursive: true });

function readFile() {
    try { return JSON.parse(fs.readFileSync(FILE, "utf8")); }
    catch { return null; }
}

export function readTokens() {
    const t = readFile();
    if (!t?.refresh_token && process.env.GOOGLE_REFRESH_TOKEN) {
        return { ...t, refresh_token: process.env.GOOGLE_REFRESH_TOKEN };
    }
    return t;
}

export function writeTokens(tokens) {
    const old = readFile() || {};
    const merged = { ...old, ...tokens };
    if (!tokens.refresh_token && old.refresh_token) merged.refresh_token = old.refresh_token;
    if (!tokens.folderId && old.folderId) merged.folderId = old.folderId;
    fs.writeFileSync(FILE, JSON.stringify(merged, null, 2));
}

export function clearTokens() {
    if (fs.existsSync(FILE)) fs.unlinkSync(FILE);
}

export function writeRootFolderId(id) {
    writeTokens({ folderId: id });
}

export function readRootFolderId() {
    return readFile()?.folderId || process.env.GOOGLE_ROOT_FOLDER_ID || null;
}