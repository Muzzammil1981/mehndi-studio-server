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

async function loadEventNameMap() {
    try {
        if (!isConnected()) return {};
        const { dataId } = await getStudioFolders();
        const doc = await readJson("events.json", dataId);
        const events = doc?.data?.events || (Array.isArray(doc) ? doc : []);
        return Object.fromEntries(events.map(e => [e.id, e.name]));
    } catch (err) {
        console.error("Failed to load events for name mapping:", err.message);
        return {};
    }
}

/* Helper: derive money fields from raw data (safe for legacy orders) */
function computeMoney(order) {
    const total = Number(order.total) || 0;
    const paidAmount = Number(order.paidAmount) || 0;
    order.total = total;
    order.paidAmount = paidAmount;
    order.balanceDue = Math.max(0, total - paidAmount);
    order.refundDue = Math.max(0, paidAmount - total);
    return order;
}

/* =========================================================
   CREATE ORDER
========================================================= */
export async function createOrder({
    user, items, requestedDate, requestedTime, notes,
    eventId, status, paymentMethod,
    type, customDescription, customImageId, customImage, suggestedPrice,
    isGroup, members,
}) {
    if (!user?.id) throw new Error("You must be signed in");

    if (type === "custom") {
        if (!customDescription?.trim()) throw new Error("Please describe your custom design");
        if (!suggestedPrice || Number(suggestedPrice) <= 0) {
            throw new Error("Please suggest a price for your custom design");
        }
        if (!eventId) {
            if (!requestedDate) throw new Error("Appointment date is required");
            if (!requestedTime) throw new Error("Appointment time is required");
        }
    } else if (isGroup) {
        if (!Array.isArray(members) || members.length < 2) {
            throw new Error("Group bookings require at least 2 members");
        }
        if (members.some(m => !m.name?.trim())) {
            throw new Error("Every group member needs a name");
        }
        if (members.some(m => !Array.isArray(m.items) || m.items.length === 0)) {
            throw new Error("Each member needs at least one design");
        }
        if (!requestedDate) throw new Error("Appointment date is required");
        if (!requestedTime) throw new Error("Appointment time is required");
    } else {
        if (!items?.length) throw new Error("Cart is empty");
        if (!requestedDate) throw new Error("Appointment date is required");
        if (!requestedTime) throw new Error("Appointment time is required");
    }

    const memberList = isGroup && Array.isArray(members)
        ? members.map((m, i) => {
            const mItems = Array.isArray(m.items) ? m.items : [];
            const subtotal = mItems.reduce((n, x) => n + x.qty * x.price, 0);
            return {
                memberId: m.memberId || `m-${i + 1}`,
                name: String(m.name || `Member ${i + 1}`).trim(),
                items: mItems,
                subtotal,
                tokenNumber: null,
                status: "pending",
                startedAt: "",
                endedAt: "",
                durationSeconds: 0,
            };
        })
        : [];

    const total = isGroup
        ? memberList.reduce((sum, m) => sum + m.subtotal, 0)
        : (items?.reduce((n, x) => n + x.qty * x.price, 0) || 0);

    const order = {
        id: crypto.randomUUID(),
        userId: user.id,
        username: user.username,
        email: user.email,
        type: type || "standard",
        isGroup: Boolean(isGroup),
        members: memberList,
        items: isGroup ? [] : (items || []),
        total,
        paidAmount: 0,
        balanceDue: total,
        refundDue: 0,
        requestedDate,
        requestedTime,
        notes: String(notes || "").trim(),
        status: status || "pending",
        paymentMethod: paymentMethod || "upi",
        eventId: eventId || null,
        tokenNumber: null,
        adminNote: "",
        proposedDate: "",
        proposedTime: "",

        customDescription: String(customDescription || "").trim(),
        customImageId: customImageId || null,
        customImage: customImage || null,
        suggestedPrice: suggestedPrice ? Number(suggestedPrice) : null,
        quotedPrice: null,
        negotiationHistory: [],

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
    const eventNameMap = await loadEventNameMap();

    const mappedOrders = orders.map(o => {
        const copy = { ...o };
        computeMoney(copy);
        copy.eventName = o.eventId ? (eventNameMap[o.eventId] || null) : null;
        return copy;
    });

    if (role === "ADMIN") return mappedOrders;
    return mappedOrders.filter(o => o.userId === userId);
}

export async function getOrder(id) {
    const order = (await loadAll()).find(o => o.id === id) || null;
    if (!order) return null;

    computeMoney(order);

    if (order.eventId) {
        const eventNameMap = await loadEventNameMap();
        order.eventName = eventNameMap[order.eventId] || null;
    } else {
        order.eventName = null;
    }
    return order;
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
    return computeMoney(order);
}

/* ---------- User: set payment method ---------- */
export async function setPaymentMethod({ id, userId, method }) {
    if (!["upi", "card", "cash"].includes(method)) throw new Error("Invalid payment method");
    const orders = await loadAll();
    const order = orders.find(o => o.id === id);
    if (!order) throw new Error("Order not found");
    if (order.userId !== userId) throw new Error("Forbidden");
    if (order.status !== "approved" && order.status !== "pending") {
        throw new Error("Order is not in a modifiable state");
    }

    order.paymentMethod = method;
    order.updatedAt = new Date().toISOString();
    await saveAll(orders);
    return computeMoney(order);
}

/* =========================================================
   User: modify order items
   — Only charges the DIFFERENCE when the order is already paid.
   — Handles three cases:
       * new total > paid  → status "approved", needs top-up
       * new total = paid  → status "paid",     no action
       * new total < paid  → status "paid",     refund due
========================================================= */
export async function updateOrderItems({ id, userId, items }) {
    if (!Array.isArray(items) || items.length === 0) {
        throw new Error("Order must contain at least one design");
    }
    const orders = await loadAll();
    const order = orders.find(o => o.id === id);
    if (!order) throw new Error("Order not found");
    if (order.userId !== userId) throw new Error("Forbidden");
    if (order.isGroup) throw new Error("Group orders can't be modified");

    const modifiable = ["pending", "approved", "awaiting-verification", "paid"];
    if (!modifiable.includes(order.status)) {
        throw new Error("This order can no longer be modified. Please contact the studio.");
    }

    const newTotal = items.reduce((n, x) => n + x.qty * x.price, 0);
    if (newTotal <= 0) throw new Error("New total must be greater than 0");

    const previousTotal = order.total;
    const previousItems = order.items;
    const difference = newTotal - previousTotal;
    const previousStatus = order.status;
    const previousPaidAmount = Number(order.paidAmount) || 0;

    order.modifications = order.modifications || [];
    order.modifications.push({
        at: new Date().toISOString(),
        previousItems, previousTotal, newItems: items, newTotal, difference,
        previousStatus, previousPaidAmount,
    });

    order.items = items;
    order.total = newTotal;
    order.previousTotal = previousTotal;
    order.totalDifference = difference;
    order.paidAmount = previousPaidAmount;
    order.balanceDue = Math.max(0, newTotal - previousPaidAmount);
    order.refundDue = Math.max(0, previousPaidAmount - newTotal);

    if (order.balanceDue > 0) {
        // Customer still owes money — need another payment round.
        order.status = "approved";
        order.utr = "";
        order.paymentClaimedAt = "";
        order.paymentRejectReason = "";
        // Note: we deliberately DO NOT wipe paymentId/paidAt — they record the
        // earlier successful payment. `paidAmount` above is the source of truth.
    } else {
        // Fully paid (or overpaid). Session can still proceed.
        order.status = "paid";
        // In the refund case, clear any half-finished payment attempt so the
        // admin doesn't see "awaiting verification" on a fully-paid order.
        if (previousStatus === "awaiting-verification") {
            order.utr = "";
            order.paymentClaimedAt = "";
        }
    }

    order.updatedAt = new Date().toISOString();
    await saveAll(orders);
    return computeMoney(order);
}

/* ---------- User: claim paid (submits UTR) ---------- */
export async function claimPayment({ id, userId, utr, tokenNumber, tokenNumbers }) {
    if (!utr || String(utr).trim().length < 6) {
        throw new Error("Please enter a valid UTR / Transaction ID (at least 6 characters)");
    }
    const orders = await loadAll();
    const order = orders.find(o => o.id === id);
    if (!order) throw new Error("Order not found");
    if (order.userId !== userId) throw new Error("Forbidden");
    if (order.status !== "approved") throw new Error("Order is not in a payable state");

    order.status = "awaiting-verification";
    order.utr = String(utr).trim().toUpperCase();
    order.paymentClaimedAt = new Date().toISOString();

    if (order.isGroup && Array.isArray(tokenNumbers) && tokenNumbers.length) {
        order.members = order.members.map((m, i) => ({
            ...m,
            tokenNumber: tokenNumbers[i] ?? null,
        }));
    } else if (tokenNumber) {
        order.tokenNumber = tokenNumber;
    }

    order.updatedAt = new Date().toISOString();
    await saveAll(orders);
    return computeMoney(order);
}

/* ---------- Admin: confirm payment received ---------- */
export async function confirmPayment({ id, paymentNote, tokenNumber, tokenNumbers }) {
    const orders = await loadAll();
    const order = orders.find(o => o.id === id);
    if (!order) throw new Error("Order not found");
    if (order.status !== "awaiting-verification" && order.status !== "approved") {
        throw new Error("Order is not awaiting payment confirmation");
    }

    // How much is being paid right now?
    // — If this order had already received partial payment (a top-up), it's balanceDue.
    // — Otherwise it's the whole total.
    const prevPaid = Number(order.paidAmount) || 0;
    const currentBalance = Math.max(0, (order.total || 0) - prevPaid);
    const amountPaidNow = currentBalance;

    order.paidAmount = prevPaid + amountPaidNow;
    order.balanceDue = Math.max(0, (order.total || 0) - order.paidAmount);
    order.refundDue = Math.max(0, order.paidAmount - (order.total || 0));

    order.status = "paid";
    order.paymentId = `PAY-${Date.now().toString(36).toUpperCase()}`;
    order.paidAt = new Date().toISOString();
    order.adminNote = String(paymentNote || order.adminNote || "").trim();

    if (order.isGroup && Array.isArray(tokenNumbers) && tokenNumbers.length) {
        order.members = order.members.map((m, i) => ({
            ...m,
            tokenNumber: tokenNumbers[i] ?? m.tokenNumber ?? null,
        }));
    } else if (tokenNumber) {
        order.tokenNumber = tokenNumber;
    }

    order.updatedAt = new Date().toISOString();
    await saveAll(orders);
    return computeMoney(order);
}

/* ---------- Admin: reject payment ---------- */
export async function rejectPayment({ id, reason }) {
    const orders = await loadAll();
    const order = orders.find(o => o.id === id);
    if (!order) throw new Error("Order not found");
    if (order.status !== "awaiting-verification") throw new Error("Order is not awaiting verification");

    // Keep paidAmount intact (nothing was actually received), just reset the pending state.
    order.status = "approved";
    order.paymentRejectReason = String(reason || "").trim();
    order.paymentRejectedAt = new Date().toISOString();
    order.utr = "";
    order.paymentClaimedAt = "";
    order.updatedAt = new Date().toISOString();
    await saveAll(orders);
    return computeMoney(order);
}


export async function acknowledgeRefund({ id, note }) {
    const orders = await loadAll();
    const order = orders.find(o => o.id === id);
    if (!order) throw new Error("Order not found");

    // FIX: recompute money fields from paidAmount & total so we don't
    // depend on the stored refundDue being present / correct on disk.
    // (Legacy orders and orders modified before this field existed will
    // have refundDue = 0 or missing on disk even though it's > 0 logically.)
    computeMoney(order);

    const refundAmount = Number(order.refundDue) || 0;
    if (refundAmount <= 0) {
        throw new Error("No refund is pending for this order");
    }

    order.refundHistory = order.refundHistory || [];
    order.refundHistory.push({
        at: new Date().toISOString(),
        amount: refundAmount,
        note: String(note || "").trim(),
    });

    // Reduce paidAmount by what was refunded so computeMoney() on every
    // future read yields refundDue = 0.
    const newPaid = Math.max(0, (Number(order.paidAmount) || 0) - refundAmount);
    order.paidAmount = newPaid;
    order.refundDue = 0;
    order.refundGivenAt = new Date().toISOString();

    order.updatedAt = new Date().toISOString();
    await saveAll(orders);
    return computeMoney(order);
}

/* ---------- Admin: Start work (single order) ---------- */
export async function startWork({ id }) {
    const orders = await loadAll();
    const order = orders.find(o => o.id === id);
    if (!order) throw new Error("Order not found");
    if (order.isGroup) throw new Error("Use per-member start for group orders");
    if (order.status !== "paid") throw new Error("Only paid orders can start work");
    if (order.startedAt && !order.endedAt) throw new Error("Work is already in progress");

    order.status = "in-progress";
    order.startedAt = new Date().toISOString();
    order.endedAt = "";
    order.durationSeconds = 0;
    order.updatedAt = new Date().toISOString();
    await saveAll(orders);
    return computeMoney(order);
}

/* ---------- Admin: End work (single order) ---------- */
export async function endWork({ id, workNote }) {
    const orders = await loadAll();
    const order = orders.find(o => o.id === id);
    if (!order) throw new Error("Order not found");
    if (order.isGroup) throw new Error("Use per-member end for group orders");
    if (order.status !== "in-progress") throw new Error("Work is not in progress");
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
    return computeMoney(order);
}

/* ---------- Admin: group member start/end (unchanged) ---------- */
export async function startMemberWork({ orderId, memberId }) {
    const orders = await loadAll();
    const order = orders.find(o => o.id === orderId);
    if (!order) throw new Error("Order not found");
    if (!order.isGroup) throw new Error("Not a group order");
    if (order.status !== "paid" && order.status !== "in-progress") {
        throw new Error("Payment not confirmed yet");
    }

    const m = order.members.find(x => x.memberId === memberId);
    if (!m) throw new Error("Member not found");
    if (m.status === "in-progress") throw new Error("Member already in progress");
    if (m.status === "completed") throw new Error("Member already completed");

    m.status = "in-progress";
    m.startedAt = new Date().toISOString();
    m.endedAt = "";
    m.durationSeconds = 0;

    if (order.status === "paid") order.status = "in-progress";

    order.updatedAt = new Date().toISOString();
    await saveAll(orders);
    return computeMoney(order);
}

export async function endMemberWork({ orderId, memberId }) {
    const orders = await loadAll();
    const order = orders.find(o => o.id === orderId);
    if (!order) throw new Error("Order not found");
    if (!order.isGroup) throw new Error("Not a group order");

    const m = order.members.find(x => x.memberId === memberId);
    if (!m) throw new Error("Member not found");
    if (m.status !== "in-progress") throw new Error("Member is not in progress");
    if (!m.startedAt) throw new Error("Never started");

    const endedAt = new Date();
    const startedAt = new Date(m.startedAt);
    m.status = "completed";
    m.endedAt = endedAt.toISOString();
    m.durationSeconds = Math.max(1, Math.round((endedAt - startedAt) / 1000));

    if (order.members.every(x => x.status === "completed")) {
        order.status = "completed";
    }

    order.updatedAt = new Date().toISOString();
    await saveAll(orders);
    return computeMoney(order);
}

/* ---------- Custom quote flow (unchanged) ---------- */
export async function quoteCustomOrder({ id, action, quotedPrice, adminNote }) {
    const orders = await loadAll();
    const order = orders.find(o => o.id === id);
    if (!order) throw new Error("Order not found");
    if (order.type !== "custom") throw new Error("This is not a custom order");

    order.negotiationHistory = order.negotiationHistory || [];

    if (action === "accept") {
        if (!order.suggestedPrice) throw new Error("Customer hasn't suggested a price");
        order.negotiationHistory.push({
            at: new Date().toISOString(), by: "admin",
            action: "accept", price: order.suggestedPrice, note: adminNote || "",
        });
        order.status = "approved";
        order.total = order.suggestedPrice;
        order.quotedPrice = order.suggestedPrice;
        order.balanceDue = Math.max(0, order.total - (Number(order.paidAmount) || 0));
        order.adminNote = String(adminNote || "").trim();
        order.updatedAt = new Date().toISOString();
        await saveAll(orders);
        return computeMoney(order);
    }

    if (action === "counter") {
        const price = Number(quotedPrice);
        if (!price || price <= 0) throw new Error("Please enter a valid price");
        order.negotiationHistory.push({
            at: new Date().toISOString(), by: "admin",
            action: "counter", price, note: adminNote || "",
        });
        order.status = "quote-proposed";
        order.quotedPrice = price;
        order.adminNote = String(adminNote || "").trim();
        order.updatedAt = new Date().toISOString();
        await saveAll(orders);
        return computeMoney(order);
    }

    if (action === "reject") {
        order.negotiationHistory.push({
            at: new Date().toISOString(), by: "admin",
            action: "reject", note: adminNote || "",
        });
        order.status = "rejected";
        order.adminNote = String(adminNote || "Custom request declined").trim();
        order.updatedAt = new Date().toISOString();
        await saveAll(orders);
        return computeMoney(order);
    }

    throw new Error("Invalid action");
}

export async function respondToQuote({ id, userId, action }) {
    const orders = await loadAll();
    const order = orders.find(o => o.id === id);
    if (!order) throw new Error("Order not found");
    if (order.userId !== userId) throw new Error("Forbidden");
    if (order.type !== "custom") throw new Error("This is not a custom order");
    if (order.status !== "quote-proposed") throw new Error("No active quote to respond to");

    order.negotiationHistory = order.negotiationHistory || [];

    if (action === "accept") {
        order.negotiationHistory.push({
            at: new Date().toISOString(), by: "customer",
            action: "accept", price: order.quotedPrice,
        });
        order.status = "approved";
        order.total = order.quotedPrice;
        order.balanceDue = Math.max(0, order.total - (Number(order.paidAmount) || 0));
        order.updatedAt = new Date().toISOString();
        await saveAll(orders);
        return computeMoney(order);
    }

    if (action === "decline") {
        order.negotiationHistory.push({
            at: new Date().toISOString(), by: "customer",
            action: "decline", price: order.quotedPrice,
        });
        order.status = "custom-pending";
        order.adminNote = "";
        order.updatedAt = new Date().toISOString();
        await saveAll(orders);
        return computeMoney(order);
    }

    throw new Error("Invalid action");
}

/* ---------- Reports (unchanged, plus paid-aware revenue) ---------- */
export async function buildReport({ from, to, userId, eventId }) {
    const orders = await loadAll();

    const fromMs = from ? new Date(from).getTime() : 0;
    const toMs = to ? new Date(to).getTime() + 24 * 60 * 60 * 1000 - 1 : Infinity;

    const filtered = orders.filter(o => {
        const t = new Date(o.updatedAt || o.createdAt).getTime();
        if (t < fromMs || t > toMs) return false;
        if (userId && o.userId !== userId) return false;
        if (eventId && o.eventId !== eventId) return false;
        return true;
    });

    const revenueEligible = filtered.filter(o => o.status === "paid" || o.status === "completed");
    const totalRevenue = revenueEligible.reduce((n, o) => n + (Number(o.paidAmount) || o.total || 0), 0);

    const completedSessions = filtered.filter(o => o.status === "completed" && o.durationSeconds > 0);
    const totalSeconds = completedSessions.reduce((n, o) => n + o.durationSeconds, 0);
    const avgSeconds = completedSessions.length ? Math.round(totalSeconds / completedSessions.length) : 0;

    const byDay = {};
    revenueEligible.forEach(o => {
        const day = new Date(o.paidAt || o.updatedAt || o.createdAt).toISOString().slice(0, 10);
        byDay[day] = (byDay[day] || 0) + (Number(o.paidAmount) || o.total || 0);
    });
    const dailyRevenue = Object.entries(byDay)
        .map(([date, amount]) => ({ date, amount }))
        .sort((a, b) => a.date.localeCompare(b.date));

    const byUser = {};
    revenueEligible.forEach(o => {
        const key = o.userId;
        if (!byUser[key]) byUser[key] = { userId: o.userId, username: o.username, email: o.email, count: 0, revenue: 0, totalSeconds: 0 };
        byUser[key].count += 1;
        byUser[key].revenue += Number(o.paidAmount) || o.total || 0;
        byUser[key].totalSeconds += o.durationSeconds || 0;
    });
    const topCustomers = Object.values(byUser).sort((a, b) => b.revenue - a.revenue).slice(0, 5);

    const byDesign = {};
    revenueEligible.forEach(o => {
        (o.items || []).forEach(it => {
            const key = it.name;
            if (!byDesign[key]) byDesign[key] = { name: it.name, qty: 0, revenue: 0 };
            byDesign[key].qty += it.qty || 0;
            byDesign[key].revenue += (it.qty || 0) * (it.price || 0);
        });
    });
    const topDesigns = Object.values(byDesign).sort((a, b) => b.revenue - a.revenue).slice(0, 5);

    const eventStats = {};
    filtered.forEach(o => {
        if (!o.eventId) return;
        if (!eventStats[o.eventId]) {
            eventStats[o.eventId] = { eventId: o.eventId, tokensIssued: 0, paidOrders: 0, revenue: 0 };
        }
        const stat = eventStats[o.eventId];
        if (o.tokenNumber) stat.tokensIssued += 1;
        if (o.isGroup) stat.tokensIssued += (o.members || []).filter(m => m.tokenNumber).length;
        if (o.status === "paid" || o.status === "completed") {
            stat.paidOrders += 1;
            stat.revenue += Number(o.paidAmount) || o.total || 0;
        }
    });
    const eventSummary = Object.values(eventStats).sort((a, b) => b.tokensIssued - a.tokensIssued);

    const sessions = filtered
        .filter(o => o.startedAt)
        .sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt))
        .slice(0, 100);

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
        eventSummary,
        sessions,
    };
}