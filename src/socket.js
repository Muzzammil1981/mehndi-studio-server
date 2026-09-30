import { Server } from "socket.io";
import jwt from "jsonwebtoken";

let io = null;

export function initSocket(httpServer) {
    io = new Server(httpServer, {
        cors: { origin: process.env.CLIENT_URL, credentials: true },
    });

    io.use((socket, next) => {
        const token = socket.handshake.auth?.token;
        if (!token) return next();
        try {
            socket.user = jwt.verify(token, process.env.JWT_SECRET);
        } catch { /* ignore */ }
        next();
    });

    io.on("connection", (socket) => {
        const role = socket.user?.role || "GUEST";
        const userId = socket.user?.id;

        console.log(`🔌 ${role} connected: ${socket.id}`);

        socket.join(role === "ADMIN" ? "admins" : "users");
        if (userId) socket.join(`user:${userId}`);

        socket.on("disconnect", () => console.log(`❌ ${socket.id} left`));
    });

    return io;
}

export function getIO() { return io; }

/** Admin → all Users */
export function notifyUsers(payload) {
    io?.to("users").emit("notification", payload);
}

/** Users → all Admins */
export function notifyAdmins(payload) {
    io?.to("admins").emit("notification", payload);
}

/** Direct message to one user by id */
export function notifyUser(userId, payload) {
    io?.to(`user:${userId}`).emit("notification", payload);
}