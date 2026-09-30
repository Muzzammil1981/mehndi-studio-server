import * as XLSX from "xlsx";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import {
    getStudioFolders, ensureFolder,
    findFileByName, downloadFileBuffer, uploadFile, updateFileBuffer,
} from "./googleDrive.js";

const USERS_FILE = "users.xlsx";
const MIME_XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

async function getUsersFolderId() {
    const { rootId } = await getStudioFolders();
    return ensureFolder("Users", rootId);
}

/* ---------- Load ---------- */
export async function loadUsers() {
    const folderId = await getUsersFolderId();
    const existing = await findFileByName(USERS_FILE, folderId);
    if (!existing) return { users: [], fileId: null, folderId };

    const buffer = await downloadFileBuffer(existing.id);
    if (!buffer || buffer.length === 0) return { users: [], fileId: existing.id, folderId };

    const wb = XLSX.read(buffer, { type: "buffer" });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const users = XLSX.utils.sheet_to_json(sheet, { defval: "" });
    return { users, fileId: existing.id, folderId };
}

/* ---------- Save (writes users.xlsx) ---------- */
export async function saveUsers(users, fileId, folderId) {
    const headers = [
        "id", "username", "email", "fullName", "passwordHash",
        "role", "createdAt", "lastLogin", "active",
    ];

    const rows = users.map(u => ({
        id: u.id,
        username: u.username,
        email: u.email,
        fullName: u.fullName || "",
        passwordHash: u.passwordHash,
        role: u.role || "USER",
        createdAt: u.createdAt || "",
        lastLogin: u.lastLogin || "",
        active: u.active !== false,
    }));

    const ws = XLSX.utils.json_to_sheet(rows, { header: headers });
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Users");
    const buffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });

    if (fileId) {
        await updateFileBuffer(fileId, buffer, MIME_XLSX);
        return fileId;
    }

    const uploaded = await uploadFile({
        name: USERS_FILE,
        mimeType: MIME_XLSX,
        buffer,
        parentId: folderId,
    });
    return uploaded.id;
}

/* ---------- Register ---------- */
export async function registerUser({ username, email, password, fullName }) {
    if (!username?.trim()) throw new Error("Username is required");
    if (!email?.trim()) throw new Error("Email is required");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("Invalid email format");
    if (!password || password.length < 6) throw new Error("Password must be at least 6 characters");

    const { users, fileId, folderId } = await loadUsers();

    const lu = username.trim().toLowerCase();
    const le = email.trim().toLowerCase();

    if (users.some(u => String(u.username).toLowerCase() === lu)) {
        throw new Error("Username already taken");
    }
    if (users.some(u => String(u.email).toLowerCase() === le)) {
        throw new Error("Email already registered");
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const user = {
        id: crypto.randomUUID(),
        username: username.trim(),
        email: email.trim(),
        fullName: (fullName || "").trim(),
        passwordHash,
        role: "USER",
        createdAt: new Date().toISOString(),
        lastLogin: new Date().toISOString(),
        active: true,
    };

    users.push(user);
    await saveUsers(users, fileId, folderId);

    const { passwordHash: _, ...safe } = user;
    return safe;
}

/* ---------- Login ---------- */
export async function loginUser({ identifier, password }) {
    if (!identifier?.trim()) throw new Error("Username or email is required");
    if (!password) throw new Error("Password is required");

    const { users, fileId, folderId } = await loadUsers();
    const id = identifier.trim().toLowerCase();

    const user = users.find(u =>
        String(u.username).toLowerCase() === id ||
        String(u.email).toLowerCase() === id
    );

    if (!user) throw new Error("Invalid credentials");
    if (user.active === false) throw new Error("Account is disabled");

    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) throw new Error("Invalid credentials");

    user.lastLogin = new Date().toISOString();
    await saveUsers(users, fileId, folderId);

    const { passwordHash: _, ...safe } = user;
    return safe;
}

/* ---------- Public list (for admin panel) ---------- */
export async function listUsers() {
    const { users } = await loadUsers();
    return users.map(({ passwordHash, ...u }) => u);
}

/* ---------- Change own password ---------- */
export async function changePassword({ userId, currentPassword, newPassword }) {
    if (!currentPassword) throw new Error("Current password is required");
    if (!newPassword || newPassword.length < 6) throw new Error("New password must be at least 6 characters");

    const { users, fileId, folderId } = await loadUsers();
    const user = users.find(u => u.id === userId);
    if (!user) throw new Error("User not found");

    const ok = await bcrypt.compare(currentPassword, user.passwordHash);
    if (!ok) throw new Error("Current password is incorrect");

    user.passwordHash = await bcrypt.hash(newPassword, 10);
    user.passwordChangedAt = new Date().toISOString();
    await saveUsers(users, fileId, folderId);

    return { ok: true };
}

/* ---------- Admin: reset any user's password ---------- */
export async function adminResetPassword({ userId, newPassword }) {
    if (!newPassword || newPassword.length < 6) throw new Error("New password must be at least 6 characters");

    const { users, fileId, folderId } = await loadUsers();
    const user = users.find(u => u.id === userId);
    if (!user) throw new Error("User not found");

    user.passwordHash = await bcrypt.hash(newPassword, 10);
    user.passwordChangedAt = new Date().toISOString();
    await saveUsers(users, fileId, folderId);

    return { ok: true, username: user.username };
}