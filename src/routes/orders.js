import express from "express";
import { requireAuth } from "../middleware/auth.js";
import {
    createOrder, listOrders, getOrder, updateOrderStatus,
    claimPayment, confirmPayment, rejectPayment, setPaymentMethod,
    updateOrderItems, quoteCustomOrder, respondToQuote,
    startWork, endWork, startMemberWork, endMemberWork,acknowledgeRefund, 
} from "../services/orderService.js";
import { getStudioSettings, generateDynamicQr } from "../services/settingsService.js";
import { notifyAdmins, notifyUser } from "../socket.js";
import { generateEventToken } from "./events.js";
import { nextDailyToken } from "../services/queueService.js";

const router = express.Router();

async function generateGroupTokens(order) {
    const count = order.members?.length || 0;
    if (!count) return [];
    const tokens = [];
    if (order.eventId) {
        for (let i = 0; i < count; i++) tokens.push(await generateEventToken(order.eventId));
    } else {
        for (let i = 0; i < count; i++) tokens.push(await nextDailyToken());
    }
    return tokens;
}

/* ---------- Create order ---------- */
router.post("/", requireAuth, async (req, res) => {
    try {
        const { items, requestedDate, requestedTime, notes, eventId, paymentMethod, isGroup, members } = req.body || {};
        const status = eventId ? "approved" : "pending";
        const order = await createOrder({
            user: req.user,
            items: items || [],
            requestedDate, requestedTime, notes, eventId,
            status,
            paymentMethod: paymentMethod || "upi",
            isGroup: Boolean(isGroup),
            members: members || [],
        });
        notifyAdmins({
            type: "new-order",
            title: isGroup
                ? `New group booking (${order.members.length} people)`
                : (eventId ? "New Event Order (Auto-Approved)" : "New appointment request"),
            body: `${order.username} requested ${order.requestedDate} at ${order.requestedTime}`,
            orderId: order.id,
            at: new Date().toISOString(),
        });
        res.status(201).json(order);
    } catch (err) {
        res.status(400).json({ message: err.message });
    }
});

/* ---------- Custom order ---------- */
router.post("/custom", requireAuth, async (req, res) => {
    try {
        const { customDescription, customImageId, customImage, suggestedPrice, requestedDate, requestedTime, notes, eventId, paymentMethod } = req.body || {};
        const order = await createOrder({
            user: req.user,
            items: [],
            type: "custom",
            customDescription, customImageId, customImage, suggestedPrice,
            requestedDate, requestedTime, notes, eventId,
            status: "custom-pending",
            paymentMethod: paymentMethod || "upi",
        });
        notifyAdmins({
            type: "new-order",
            title: `🎨 Custom request · suggested £${order.suggestedPrice}`,
            body: `${order.username} wants a custom design. Review and respond.`,
            orderId: order.id,
            at: new Date().toISOString(),
        });
        res.status(201).json(order);
    } catch (err) {
        res.status(400).json({ message: err.message });
    }
});

/* ---------- List / Single ---------- */
router.get("/", requireAuth, async (req, res) => {
    try {
        const orders = await listOrders({ userId: req.user.id, role: req.user.role });
        res.json(orders);
    } catch (err) { res.status(500).json({ message: err.message }); }
});

router.get("/:id", requireAuth, async (req, res) => {
    try {
        const order = await getOrder(req.params.id);
        if (!order) return res.status(404).json({ message: "Order not found" });
        if (req.user.role !== "ADMIN" && order.userId !== req.user.id) return res.status(403).json({ message: "Forbidden" });
        res.json(order);
    } catch (err) { res.status(500).json({ message: err.message }); }
});

/* =========================================================
   Dynamic QR — charges ONLY the current balance due
========================================================= */
router.get("/:id/qr", requireAuth, async (req, res) => {
    try {
        const order = await getOrder(req.params.id);
        if (!order) return res.status(404).json({ message: "Order not found" });
        if (order.userId !== req.user.id) return res.status(403).json({ message: "Forbidden" });
        if (order.status !== "approved") return res.status(400).json({ message: "Order is not payable" });

        // FIX: charge only the outstanding balance (top-ups charge just the diff)
        const amountDue = Number(order.balanceDue) > 0 ? Number(order.balanceDue) : Number(order.total);

        const settings = await getStudioSettings();
        if (!settings.upiId) return res.status(400).json({ message: "UPI ID not configured" });

        const { uri, dataUrl } = await generateDynamicQr({
            upiId: settings.upiId,
            merchantName: settings.merchantName || "Mehndi Studio",
            amount: amountDue,
            note: `Mehndi Order ${order.id.slice(0, 8)}`,
            txnRef: `MEH${order.id.slice(0, 8).toUpperCase()}`,
        });

        res.json({
            uri, qrCodeDataUrl: dataUrl,
            upiId: settings.upiId,
            merchantName: settings.merchantName,
            amount: amountDue,
        });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

/* ---------- Payment method ---------- */
router.patch("/:id/payment-method", requireAuth, async (req, res) => {
    try {
        const { method } = req.body || {};
        const order = await setPaymentMethod({ id: req.params.id, userId: req.user.id, method });
        notifyAdmins({
            type: "order-update",
            title: method === "cash" ? `💵 Customer will pay cash at counter` : `💳 Customer will pay by card at counter`,
            body: `${order.username} · Order #${order.id.slice(0, 8)} — confirm at counter when they arrive.`,
            orderId: order.id,
            at: new Date().toISOString(),
        });
        res.json(order);
    } catch (err) { res.status(400).json({ message: err.message }); }
});

/* ---------- Admin approve / reject / reschedule ---------- */
router.patch("/:id/status", requireAuth, async (req, res) => {
    if (req.user.role !== "ADMIN") return res.status(403).json({ message: "Admin only" });
    try {
        const { status, adminNote, proposedDate, proposedTime } = req.body || {};
        const order = await updateOrderStatus({ id: req.params.id, status, adminNote, proposedDate, proposedTime });
        notifyUser(order.userId, {
            type: "order-update",
            title: status === "approved" ? "Your appointment is confirmed ✓" : "Your appointment was declined",
            body: status === "approved"
                ? `${order.proposedDate || order.requestedDate} at ${order.proposedTime || order.requestedTime}`
                : adminNote || "Please try booking another slot.",
            orderId: order.id,
            status,
            at: new Date().toISOString(),
        });
        res.json(order);
    } catch (err) { res.status(400).json({ message: err.message }); }
});

/* =========================================================
   Modify items — notification reflects top-up vs. refund
========================================================= */
router.patch("/:id/items", requireAuth, async (req, res) => {
    try {
        const order = await updateOrderItems({
            id: req.params.id,
            userId: req.user.id,
            items: req.body?.items,
        });

        const balance = Number(order.balanceDue) || 0;
        const refund = Number(order.refundDue) || 0;
        const summaryLabel =
            refund > 0 ? `-£${refund.toFixed(2)} (refund due)`
                : balance > 0 ? `+£${balance.toFixed(2)} (top-up)`
                    : "no charge";

        notifyAdmins({
            type: "order-update",
            title: `✏️ Order modified (${summaryLabel})`,
            body: `${order.username} changed designs for Order #${order.id.slice(0, 8)}`,
            orderId: order.id,
            at: new Date().toISOString(),
        });

        notifyUser(order.userId, {
            type: "order-update",
            title: "Order updated",
            body:
                refund > 0 ? `£${refund.toFixed(2)} will be refunded to you.`
                    : balance > 0 ? `Please pay the remaining £${balance.toFixed(2)}.`
                        : "Your changes have been saved.",
            orderId: order.id,
            status: order.status,
            at: new Date().toISOString(),
        });

        res.json(order);
    } catch (err) { res.status(400).json({ message: err.message }); }
});

/* ---------- Claim payment (submits UTR) ---------- */
router.post("/:id/claim-payment", requireAuth, async (req, res) => {
    try {
        const existingOrder = await getOrder(req.params.id);
        if (!existingOrder) return res.status(404).json({ message: "Order not found" });

        if (existingOrder.paymentMethod !== "upi") {
            try { await setPaymentMethod({ id: req.params.id, userId: req.user.id, method: "upi" }); } catch { }
        }

        let tokenNumber = null;
        let tokenNumbers = [];

        if (existingOrder.isGroup) {
            tokenNumbers = await generateGroupTokens(existingOrder);
        } else if (existingOrder.eventId && !existingOrder.tokenNumber) {
            tokenNumber = await generateEventToken(existingOrder.eventId);
        }

        const order = await claimPayment({
            id: req.params.id,
            userId: req.user.id,
            utr: req.body?.utr,
            tokenNumber,
            tokenNumbers,
        });

        notifyAdmins({
            type: "payment-claim",
            title: order.isGroup
                ? `Group payment claimed · ${order.members.length} tokens`
                : `Payment claimed — verify ⏳`,
            body: order.isGroup
                ? `${order.username} paid £${order.total} · Tokens ${tokenNumbers.map(t => `#${t}`).join(", ")}`
                : `${order.username} paid £${order.balanceDue || order.total} · UTR: ${order.utr}`,
            orderId: order.id,
            at: new Date().toISOString(),
        });
        res.json(order);
    } catch (err) { res.status(400).json({ message: err.message }); }
});

/* ---------- Admin confirms payment ---------- */
router.post("/:id/confirm-payment", requireAuth, async (req, res) => {
    if (req.user.role !== "ADMIN") return res.status(403).json({ message: "Admin only" });
    try {
        const existingOrder = await getOrder(req.params.id);
        if (!existingOrder) return res.status(404).json({ message: "Order not found" });

        const isUpiVerification = existingOrder.status === "awaiting-verification";
        const isCounterPayment =
            existingOrder.status === "approved" &&
            ["cash", "card"].includes(existingOrder.paymentMethod);

        if (!isUpiVerification && !isCounterPayment) {
            return res.status(400).json({ message: "Order is not awaiting payment confirmation" });
        }

        let tokenNumber = null;
        let tokenNumbers = [];

        if (existingOrder.isGroup && isCounterPayment) {
            tokenNumbers = await generateGroupTokens(existingOrder);
        } else if (existingOrder.eventId && !existingOrder.tokenNumber && isCounterPayment) {
            tokenNumber = await generateEventToken(existingOrder.eventId);
        }

        const order = await confirmPayment({
            id: req.params.id,
            paymentNote: req.body?.note,
            tokenNumber,
            tokenNumbers,
        });

        notifyUser(order.userId, {
            type: "order-update",
            title: "Payment verified ✓",
            body: order.isGroup
                ? `Your group of ${order.members.length} is confirmed. Tokens: ${order.members.map(m => `#${m.tokenNumber}`).join(", ")}`
                : `Thanks! Your appointment is confirmed. Ref: ${order.paymentId}`,
            orderId: order.id,
            status: "paid",
            at: new Date().toISOString(),
        });

        res.json(order);
    } catch (err) { res.status(400).json({ message: err.message }); }
});

/* ---------- Admin rejects payment ---------- */
router.post("/:id/reject-payment", requireAuth, async (req, res) => {
    if (req.user.role !== "ADMIN") return res.status(403).json({ message: "Admin only" });
    try {
        const order = await rejectPayment({ id: req.params.id, reason: req.body?.reason });
        notifyUser(order.userId, {
            type: "order-update",
            title: "Payment not received",
            body: order.paymentRejectReason || "We couldn't match your payment. Please try again.",
            orderId: order.id,
            status: "approved",
            at: new Date().toISOString(),
        });
        res.json(order);
    } catch (err) { res.status(400).json({ message: err.message }); }
});

/* ---------- Admin: mark refund as given ---------- */
router.post("/:id/acknowledge-refund", requireAuth, async (req, res) => {
    if (req.user.role !== "ADMIN") return res.status(403).json({ message: "Admin only" });
    try {
        const order = await acknowledgeRefund({
            id: req.params.id,
            note: req.body?.note,
        });

        notifyUser(order.userId, {
            type: "order-update",
            title: "Refund issued",
            body: "The studio has processed your refund. It should reach you shortly.",
            orderId: order.id,
            status: order.status,
            at: new Date().toISOString(),
        });

        res.json(order);
    } catch (err) {
        res.status(400).json({ message: err.message });
    }
});

/* ---------- Start / End work (unchanged) ---------- */
router.post("/:id/start-work", requireAuth, async (req, res) => {
    if (req.user.role !== "ADMIN") return res.status(403).json({ message: "Admin only" });
    try {
        const order = await startWork({ id: req.params.id });
        notifyUser(order.userId, {
            type: "order-update",
            title: "Your Mehndi session started ✨",
            body: "The studio has started working on your design.",
            orderId: order.id, status: "in-progress", startedAt: order.startedAt,
            at: new Date().toISOString(),
        });
        res.json(order);
    } catch (err) { res.status(400).json({ message: err.message }); }
});

router.post("/:id/end-work", requireAuth, async (req, res) => {
    if (req.user.role !== "ADMIN") return res.status(403).json({ message: "Admin only" });
    try {
        const order = await endWork({ id: req.params.id, workNote: req.body?.note });
        notifyUser(order.userId, {
            type: "order-update",
            title: "Your Mehndi is ready! 🎨",
            body: `Thanks for choosing Mehndi Studio. Total time: ${Math.round(order.durationSeconds / 60)} minutes.`,
            orderId: order.id, status: "completed", durationSeconds: order.durationSeconds,
            at: new Date().toISOString(),
        });
        notifyAdmins({
            type: "order-completed",
            title: "Session completed ✅",
            body: `${order.username} · ${Math.round(order.durationSeconds / 60)} min`,
            orderId: order.id,
            at: new Date().toISOString(),
        });
        res.json(order);
    } catch (err) { res.status(400).json({ message: err.message }); }
});

/* ---------- Group member start / end ---------- */
router.post("/:id/members/:memberId/start", requireAuth, async (req, res) => {
    if (req.user.role !== "ADMIN") return res.status(403).json({ message: "Admin only" });
    try {
        const order = await startMemberWork({ orderId: req.params.id, memberId: req.params.memberId });
        const m = order.members.find(x => x.memberId === req.params.memberId);
        notifyUser(order.userId, {
            type: "order-update",
            title: `Session started for ${m.name} ✨`,
            body: m.tokenNumber ? `Token #${m.tokenNumber}` : "",
            orderId: order.id, status: "in-progress", startedAt: m.startedAt,
            at: new Date().toISOString(),
        });
        res.json(order);
    } catch (err) { res.status(400).json({ message: err.message }); }
});

router.post("/:id/members/:memberId/end", requireAuth, async (req, res) => {
    if (req.user.role !== "ADMIN") return res.status(403).json({ message: "Admin only" });
    try {
        const order = await endMemberWork({ orderId: req.params.id, memberId: req.params.memberId });
        const m = order.members.find(x => x.memberId === req.params.memberId);
        notifyUser(order.userId, {
            type: "order-update",
            title: `${m.name} is ready! 🎨`,
            body: `Total time: ${Math.round(m.durationSeconds / 60)} min.`,
            orderId: order.id, status: "completed", durationSeconds: m.durationSeconds,
            at: new Date().toISOString(),
        });
        res.json(order);
    } catch (err) { res.status(400).json({ message: err.message }); }
});

/* ---------- Custom quote flow ---------- */
router.patch("/:id/quote", requireAuth, async (req, res) => {
    if (req.user.role !== "ADMIN") return res.status(403).json({ message: "Admin only" });
    try {
        const { action, quotedPrice, adminNote } = req.body || {};
        const order = await quoteCustomOrder({ id: req.params.id, action, quotedPrice, adminNote });
        let title = "", body = "";
        if (action === "accept") {
            title = `Quote accepted at £${order.total}`;
            body = "Your custom design request has been confirmed. Open My Orders to pay.";
        } else if (action === "counter") {
            title = `New price proposed: £${order.quotedPrice}`;
            body = adminNote || "Review the counter-offer in My Orders.";
        } else {
            title = "Custom design request declined";
            body = adminNote || "Please try a different design.";
        }
        notifyUser(order.userId, { type: "order-update", title, body, orderId: order.id, status: order.status, at: new Date().toISOString() });
        res.json(order);
    } catch (err) { res.status(400).json({ message: err.message }); }
});

router.patch("/:id/quote-response", requireAuth, async (req, res) => {
    try {
        const { action } = req.body || {};
        const order = await respondToQuote({ id: req.params.id, userId: req.user.id, action });
        notifyAdmins({
            type: "order-update",
            title: action === "accept" ? `✅ Quote accepted · £${order.total}` : `❌ Counter-offer declined`,
            body: action === "accept" ? `${order.username} accepted. Awaiting payment.` : `${order.username} declined. Review and send a new price.`,
            orderId: order.id,
            at: new Date().toISOString(),
        });
        res.json(order);
    } catch (err) { res.status(400).json({ message: err.message }); }
});

export default router;