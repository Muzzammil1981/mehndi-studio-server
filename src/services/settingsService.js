import QRCode from "qrcode";
import {
    getStudioFolders, ensureFolder,
    readJson, writeJson, uploadFile, deleteFile, makePublic,
    findFileByName,
} from "./googleDrive.js";

const SETTINGS_FILE = "studio.json";
const QR_FILE_NAME = "upi-qr.png";

/* ---------- Settings folder ---------- */

async function getSettingsFolderId() {
    const { rootId } = await getStudioFolders();
    return ensureFolder("Settings", rootId);
}

/* ---------- Plain settings (UPI ID, merchant name) ---------- */

export async function getStudioSettings() {
    const folderId = await getSettingsFolderId();
    const doc = await readJson(SETTINGS_FILE, folderId);
    return doc?.data || {
        upiId: "",
        merchantName: "Mehndi Studio",
        staticQrUrl: null,
    };
}

export async function saveStudioSettings(settings) {
    const folderId = await getSettingsFolderId();
    const existing = (await readJson(SETTINGS_FILE, folderId))?.data || {};
    const merged = { ...existing, ...settings };
    await writeJson(SETTINGS_FILE, merged, folderId);
    return merged;
}

/* ---------- Static QR (optional fallback) ---------- */

export async function uploadQrCode({ buffer, mimeType }) {
    const folderId = await getSettingsFolderId();

    const existing = await findFileByName(QR_FILE_NAME, folderId);
    if (existing) await deleteFile(existing.id);

    const uploaded = await uploadFile({
        name: QR_FILE_NAME,
        mimeType,
        buffer,
        parentId: folderId,
    });
    await makePublic(uploaded.id);

    return uploaded;
}

export async function getQrCode() {
    const folderId = await getSettingsFolderId();
    const file = await findFileByName(QR_FILE_NAME, folderId);
    if (!file) return null;

    return {
        id: file.id,
        url: `https://drive.google.com/thumbnail?id=${file.id}&sz=w600`,
    };
}

/* ---------- Dynamic QR with amount pre-filled ---------- */

/**
 * Builds a UPI URI that most Indian UPI apps understand.
 * Format (as per NPCI spec):
 *   upi://pay?pa=<vpa>&pn=<name>&am=<amount>&cu=INR&tn=<note>&tr=<txnref>
 */
export function buildUpiUri({ upiId, merchantName, amount, note, txnRef }) {
    if (!upiId) throw new Error("UPI ID not configured");
    const params = new URLSearchParams({
        pa: upiId,
        pn: merchantName || "Mehndi Studio",
        am: Number(amount).toFixed(2),
        cu: "INR",
    });
    if (note) params.set("tn", note);
    if (txnRef) params.set("tr", txnRef);

    return `upi://pay?${params.toString()}`;
}

/** Returns a data URL (base64 PNG) of the dynamic QR. */
export async function generateDynamicQr({ upiId, merchantName, amount, note, txnRef }) {
    const uri = buildUpiUri({ upiId, merchantName, amount, note, txnRef });
    const dataUrl = await QRCode.toDataURL(uri, {
        width: 500,
        margin: 1,
        errorCorrectionLevel: "M",
        color: { dark: "#24170f", light: "#fffdf9" },
    });
    return { uri, dataUrl };
}