import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.resolve(__dirname, "../../data/google-tokens.json");

fs.mkdirSync(path.dirname(FILE), { recursive: true });

export function readTokens() {
    try { return JSON.parse(fs.readFileSync(FILE, "utf8")); }
    catch { return null; }
}

export function writeTokens(tokens) {
    fs.writeFileSync(FILE, JSON.stringify(tokens, null, 2));
}

export function clearTokens() {
    if (fs.existsSync(FILE)) fs.unlinkSync(FILE);
}

/* NEW — persist the studio root folder ID */
export function writeRootFolderId(id) {
    const t = readTokens() || {};
    t.folderId = id;
    writeTokens(t);
}

export function readRootFolderId() {
    const t = readTokens();
    return t?.folderId || null;
}