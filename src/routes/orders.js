import express from "express";
import { requireAuth } from "../middleware/auth.js";
import {
    createOrder, listOrders, getOrder, updateOrderStatus,
    claimPayment, confirmPayment, rejectPayment,
} from "../services/orderService.js";
import { getStudioSettings, generateDynamicQr } from "../services/settingsService.js";
import { notifyAdmins, notifyUser } from "../socket.js";
import { generateEventToken } from "./events.js";

const router = express.Router();

/* =========================================================
   Create order (Auto-approves Event orders)
========================================================= */
router.post("/", requireAuth, async (req, res) => {
    try {
        const { items, requestedDate, requestedTime, notes, eventId } = req.body || {};

        // Auto-approve if it's an event order
        const status = eventId ? "approved" : "pending";

        const order = await createOrder({
            user: req.user,
            items,
            requestedDate,
            requestedTime,
            notes,
            eventId,
            status // Pass the status
        });

        // Notify admin
        notifyAdmins({
            type: "new-order",
            title: eventId ? `New Event Order (Auto-Approved)` : "New appointment request",
            body: `${order.username} requested ${order.requestedDate} at ${order.requestedTime}`,
            orderId: order.id,
            at: new Date().toISOString(),
        });

        res.status(201).json(order);
    } catch (err) {
        res.status(400).json({ message: err.message });
    }
});

/* List */
router.get("/", requireAuth, async (req, res) => {
    try {
        const orders = await listOrders({ userId: req.user.id, role: req.user.role });
        res.json(orders);
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

/* Single */
router.get("/:id", requireAuth, async (req, res) => {
    try {
        const order = await getOrder(req.params.id);
        if (!order) return res.status(404).json({ message: "Order not found" });
        if (req.user.role !== "ADMIN" && order.userId !== req.user.id) {
            return res.status(403).json({ message: "Forbidden" });
        }
        res.json(order);
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

/* Dynamic QR for PaymentModal */
router.get("/:id/qr", requireAuth, async (req, res) => {
    try {
        const order = await getOrder(req.params.id);
        if (!order) return res.status(404).json({ message: "Order not found" });
        if (order.userId !== req.user.id) return res.status(403).json({ message: "Forbidden" });
        if (order.status !== "approved") {
            return res.status(400).json({ message: "Order is not payable" });
        }

        const settings = await getStudioSettings();
        if (!settings.upiId) {
            return res.status(400).json({ message: "UPI ID not configured" });
        }

        const { uri, dataUrl } = await generateDynamicQr({
            upiId: settings.upiId,
            merchantName: settings.merchantName || "Mehndi Studio",
            amount: order.total,
            note: `Mehndi Order ${order.id.slice(0, 8)}`,
            txnRef: `MEH${order.id.slice(0, 8).toUpperCase()}`,
        });

        res.json({
            uri, qrCodeDataUrl: dataUrl,
            upiId: settings.upiId,
            merchantName: settings.merchantName,
            amount: order.total,
        });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

/* Admin approve/reject/reschedule */
router.patch("/:id/status", requireAuth, async (req, res) => {
    if (req.user.role !== "ADMIN") return res.status(403).json({ message: "Admin only" });
    try {
        const { status, adminNote, proposedDate, proposedTime } = req.body || {};
        const order = await updateOrderStatus({
            id: req.params.id, status, adminNote, proposedDate, proposedTime,
        });

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
    } catch (err) {
        res.status(400).json({ message: err.message });
    }
});

/* User submits UTR after paying (Generates Token for Events) */
router.post("/:id/claim-payment", requireAuth, async (req, res) => {
    try {
        const existingOrder = await getOrder(req.params.id);
        if (!existingOrder) return res.status(404).json({ message: "Order not found" });

        let tokenNumber = null;

        // NEW: Generate the token ONLY when the user submits the payment UTR
        if (existingOrder.eventId && !existingOrder.tokenNumber) {
            try {
                tokenNumber = await generateEventToken(existingOrder.eventId);
                console.log(`🎟️ Generated Event Token #${tokenNumber} at payment for event ${existingOrder.eventId}`);
            } catch (err) {
                console.error("❌ Failed to generate event token at payment:", err.message);
            }
        }

        const order = await claimPayment({
            id: req.params.id,
            userId: req.user.id,
            utr: req.body?.utr,
            tokenNumber // Pass the token to be saved
        });

        notifyAdmins({
            type: "payment-claim",
            title: "Payment claimed — verify ⏳",
            body: `${order.username} paid ₹${order.total} · UTR: ${order.utr}${tokenNumber ? ` · Token #${tokenNumber}` : ''}`,
            orderId: order.id,
            at: new Date().toISOString(),
        });

        res.json(order);
    } catch (err) {
        res.status(400).json({ message: err.message });
    }
});

/* Admin confirms payment received */
router.post("/:id/confirm-payment", requireAuth, async (req, res) => {
    if (req.user.role !== "ADMIN") return res.status(403).json({ message: "Admin only" });
    try {
        const order = await confirmPayment({
            id: req.params.id,
            paymentNote: req.body?.note,
        });

        notifyUser(order.userId, {
            type: "order-update",
            title: "Payment verified ✓",
            body: `Thanks! Your appointment is confirmed. Ref: ${order.paymentId}`,
            orderId: order.id,
            status: "paid",
            at: new Date().toISOString(),
        });

        res.json(order);
    } catch (err) {
        res.status(400).json({ message: err.message });
    }
});

/* Admin rejects payment */
router.post("/:id/reject-payment", requireAuth, async (req, res) => {
    if (req.user.role !== "ADMIN") return res.status(403).json({ message: "Admin only" });
    try {
        const order = await rejectPayment({
            id: req.params.id,
            reason: req.body?.reason,
        });

        notifyUser(order.userId, {
            type: "order-update",
            title: "Payment not received",
            body: order.paymentRejectReason
                || "We couldn't match your payment. Please try again.",
            orderId: order.id,
            status: "approved",
            at: new Date().toISOString(),
        });

        res.json(order);
    } catch (err) {
        res.status(400).json({ message: err.message });
    }
});

/* Admin starts work */
router.post("/:id/start-work", requireAuth, async (req, res) => {
    if (req.user.role !== "ADMIN") return res.status(403).json({ message: "Admin only" });
    try {
        const { startWork } = await import("../services/orderService.js");
        const order = await startWork({ id: req.params.id });

        notifyUser(order.userId, {
            type: "order-update",
            title: "Your Mehndi session started ✨",
            body: "The studio has started working on your design.",
            orderId: order.id,
            status: "in-progress",
            startedAt: order.startedAt,
            at: new Date().toISOString(),
        });

        res.json(order);
    } catch (err) {
        res.status(400).json({ message: err.message });
    }
});

/* Admin ends work */
router.post("/:id/end-work", requireAuth, async (req, res) => {
    if (req.user.role !== "ADMIN") return res.status(403).json({ message: "Admin only" });
    try {
        const { endWork } = await import("../services/orderService.js");
        const order = await endWork({
            id: req.params.id,
            workNote: req.body?.note,
        });

        notifyUser(order.userId, {
            type: "order-update",
            title: "Your Mehndi is ready! 🎨",
            body: `Thanks for choosing Mehndi Studio. Total time: ${Math.round(order.durationSeconds / 60)} minutes.`,
            orderId: order.id,
            status: "completed",
            durationSeconds: order.durationSeconds,
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
    } catch (err) {
        res.status(400).json({ message: err.message });
    }
});

export default router;