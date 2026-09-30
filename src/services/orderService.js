import crypto from "crypto";
import { getStudioFolders, readJson, writeJson, isConnected } from "./googleDrive.js";

const FILE = "orders.json";

async function loadAll() {
    if (!isConnected()) return [];
    const { dataId } = await getStudioFolders();
    const doc = await readJson(FILE, dataId);
    return doc?.data?.orders || [];
}

async function saveAll(orders) {
    const { dataId } = await getStudioFolders();
    await writeJson(FILE, { orders }, dataId);
}

/* ---------- Create ---------- */
export async function createOrder({ user, items, requestedDate, requestedTime, notes }) {
    if (!user?.id) throw new Error("You must be signed in");
    if (!items?.length) throw new Error("Cart is empty");
    if (!requestedDate) throw new Error("Appointment date is required");
    if (!requestedTime) throw new Error("Appointment time is required");

    const total = items.reduce((n, x) => n + x.qty * x.price, 0);

    const order = {
        id: crypto.randomUUID(),
        userId: user.id,
        username: user.username,
        email: user.email,
        items,
        total,
        requestedDate,
        requestedTime,
        notes: String(notes || "").trim(),
        status: "pending",           // pending | approved | rejected | awaiting-verification | paid
        adminNote: "",
        proposedDate: "",
        proposedTime: "",
        /* payment */
        utr: "",
        paymentClaimedAt: "",
        paymentId: "",
        paidAt: "",
        paymentRejectReason: "",
        paymentRejectedAt: "",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
    };

    const orders = await loadAll();
    orders.unshift(order);
    await saveAll(orders);
    return order;
}

/* ---------- Read ---------- */
export async function listOrders({ userId, role }) {
    const orders = await loadAll();
    if (role === "ADMIN") return orders;
    return orders.filter(o => o.userId === userId);
}

export async function getOrder(id) {
    return (await loadAll()).find(o => o.id === id) || null;
}

/* ---------- Admin: approve / reject / reschedule ---------- */
export async function updateOrderStatus({ id, status, adminNote, proposedDate, proposedTime }) {
    if (!["approved", "rejected"].includes(status)) throw new Error("Invalid status");
    const orders = await loadAll();
    const order = orders.find(o => o.id === id);
    if (!order) throw new Error("Order not found");

    order.status = status;
    order.adminNote = String(adminNote || "").trim();
    order.proposedDate = proposedDate || "";
    order.proposedTime = proposedTime || "";
    order.updatedAt = new Date().toISOString();
    await saveAll(orders);
    return order;
}

/* ---------- User: claim paid (submits UTR) ---------- */
export async function claimPayment({ id, userId, utr }) {
    if (!utr || String(utr).trim().length < 6) {
        throw new Error("Please enter a valid UTR / Transaction ID (at least 6 characters)");
    }

    const orders = await loadAll();
    const order = orders.find(o => o.id === id);
    if (!order) throw new Error("Order not found");
    if (order.userId !== userId) throw new Error("Forbidden");
    if (order.status !== "approved") {
        throw new Error("Order is not in a payable state");
    }

    order.status = "awaiting-verification";
    order.utr = String(utr).trim().toUpperCase();
    order.paymentClaimedAt = new Date().toISOString();
    order.updatedAt = new Date().toISOString();
    await saveAll(orders);
    return order;
}

/* ---------- Admin: confirm payment received ---------- */
export async function confirmPayment({ id, paymentNote }) {
    const orders = await loadAll();
    const order = orders.find(o => o.id === id);
    if (!order) throw new Error("Order not found");
    if (order.status !== "awaiting-verification") {
        throw new Error("Order is not awaiting verification");
    }

    order.status = "paid";
    order.paymentId = `PAY-${Date.now().toString(36).toUpperCase()}`;
    order.paidAt = new Date().toISOString();
    order.adminNote = String(paymentNote || order.adminNote || "").trim();
    order.updatedAt = new Date().toISOString();
    await saveAll(orders);
    return order;
}

/* ---------- Admin: reject payment (not received) ---------- */
export async function rejectPayment({ id, reason }) {
    const orders = await loadAll();
    const order = orders.find(o => o.id === id);
    if (!order) throw new Error("Order not found");
    if (order.status !== "awaiting-verification") {
        throw new Error("Order is not awaiting verification");
    }

    order.status = "approved";          // back to payable
    order.paymentRejectReason = String(reason || "").trim();
    order.paymentRejectedAt = new Date().toISOString();
    order.utr = "";
    order.paymentClaimedAt = "";
    order.updatedAt = new Date().toISOString();
    await saveAll(orders);
    return order;
}

/* ---------- Admin: Start work on the order ---------- */
export async function startWork({ id }) {
    const orders = await loadAll();
    const order = orders.find(o => o.id === id);
    if (!order) throw new Error("Order not found");
    if (order.status !== "paid") {
        throw new Error("Only paid orders can start work");
    }
    if (order.startedAt && !order.endedAt) {
        throw new Error("Work is already in progress for this order");
    }

    order.status = "in-progress";
    order.startedAt = new Date().toISOString();
    order.endedAt = "";
    order.durationSeconds = 0;
    order.updatedAt = new Date().toISOString();
    await saveAll(orders);
    return order;
}

/* ---------- Admin: End work ---------- */
export async function endWork({ id, workNote }) {
    const orders = await loadAll();
    const order = orders.find(o => o.id === id);
    if (!order) throw new Error("Order not found");
    if (order.status !== "in-progress") {
        throw new Error("Work is not in progress");
    }
    if (!order.startedAt) throw new Error("Work was never started");

    const endedAt = new Date();
    const startedAt = new Date(order.startedAt);
    const durationSeconds = Math.max(1, Math.round((endedAt - startedAt) / 1000));

    order.status = "completed";
    order.endedAt = endedAt.toISOString();
    order.durationSeconds = durationSeconds;
    if (workNote) order.workNote = String(workNote).trim();
    order.updatedAt = new Date().toISOString();
    await saveAll(orders);
    return order;
}

/* ---------- Reports: aggregate stats ---------- */
export async function buildReport({ from, to, userId }) {
    const orders = await loadAll();

    const fromMs = from ? new Date(from).getTime() : 0;
    const toMs = to ? new Date(to).getTime() + 24 * 60 * 60 * 1000 - 1 : Infinity;

    const filtered = orders.filter(o => {
        const t = new Date(o.updatedAt || o.createdAt).getTime();
        if (t < fromMs || t > toMs) return false;
        if (userId && o.userId !== userId) return false;
        return true;
    });

    /* Revenue only counts paid + completed orders */
    const revenueEligible = filtered.filter(o =>
        o.status === "paid" || o.status === "completed"
    );

    const totalRevenue = revenueEligible.reduce((n, o) => n + (o.total || 0), 0);

    const completedSessions = filtered.filter(o => o.status === "completed" && o.durationSeconds > 0);
    const totalSeconds = completedSessions.reduce((n, o) => n + o.durationSeconds, 0);
    const avgSeconds = completedSessions.length
        ? Math.round(totalSeconds / completedSessions.length)
        : 0;

    /* Group by day for the chart */
    const byDay = {};
    revenueEligible.forEach(o => {
        const day = new Date(o.paidAt || o.updatedAt || o.createdAt)
            .toISOString().slice(0, 10);
        byDay[day] = (byDay[day] || 0) + (o.total || 0);
    });
    const dailyRevenue = Object.entries(byDay)
        .map(([date, amount]) => ({ date, amount }))
        .sort((a, b) => a.date.localeCompare(b.date));

    /* Top customers */
    const byUser = {};
    revenueEligible.forEach(o => {
        const key = o.userId;
        if (!byUser[key]) byUser[key] = { userId: o.userId, username: o.username, email: o.email, count: 0, revenue: 0, totalSeconds: 0 };
        byUser[key].count += 1;
        byUser[key].revenue += o.total || 0;
        byUser[key].totalSeconds += o.durationSeconds || 0;
    });
    const topCustomers = Object.values(byUser)
        .sort((a, b) => b.revenue - a.revenue)
        .slice(0, 5);

    /* Top designs */
    const byDesign = {};
    revenueEligible.forEach(o => {
        (o.items || []).forEach(it => {
            const key = it.name;
            if (!byDesign[key]) byDesign[key] = { name: it.name, qty: 0, revenue: 0 };
            byDesign[key].qty += it.qty || 0;
            byDesign[key].revenue += (it.qty || 0) * (it.price || 0);
        });
    });
    const topDesigns = Object.values(byDesign)
        .sort((a, b) => b.revenue - a.revenue)
        .slice(0, 5);

    /* Recent sessions list (completed + in-progress) */
    const sessions = filtered
        .filter(o => o.startedAt)
        .sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt))
        .slice(0, 100);

    /* Unique customers set */
    const uniqueCustomers = new Set(revenueEligible.map(o => o.userId)).size;

    return {
        summary: {
            totalRevenue,
            totalOrders: revenueEligible.length,
            totalSessions: completedSessions.length,
            avgSeconds,
            uniqueCustomers,
            inProgressCount: filtered.filter(o => o.status === "in-progress").length,
        },
        dailyRevenue,
        topCustomers,
        topDesigns,
        sessions,
    };
}