import { Server } from 'socket.io';
import jwt from 'jsonwebtoken';
import { env, isDev } from '../config/env.js';
import User from '../models/User.js';

let io = null;

function userRoom(userId) {
  return `user:${userId}`;
}

export function initSocket(httpServer) {
  io = new Server(httpServer, {
    cors: {
      origin: (origin, callback) => callback(null, true),
      credentials: true,
    },
    pingInterval: 25000,
    pingTimeout: 20000,
  });

  io.use(async (socket, next) => {
    try {
      const token =
        socket.handshake.auth?.token ||
        socket.handshake.query?.token ||
        (socket.handshake.headers?.authorization || '').replace(/^Bearer\s+/i, '');

      if (!token) return next(new Error('Token kerak'));

      const decoded = jwt.verify(token, env.JWT_SECRET);
      const user = await User.findById(decoded.userId).select('_id isActive').lean();
      if (!user || !user.isActive) return next(new Error('Foydalanuvchi topilmadi'));

      socket.data.userId = user._id.toString();
      next();
    } catch {
      next(new Error('Yaroqsiz token'));
    }
  });

  io.on('connection', (socket) => {
    const userId = socket.data.userId;
    socket.join(userRoom(userId));
    if (isDev) console.log(`[socket] connect: ${userId} (${socket.id})`);

    socket.on('disconnect', (reason) => {
      if (isDev) console.log(`[socket] disconnect: ${userId} (${reason})`);
    });
  });

  console.log('[socket] Socket.IO yoqildi');
  return io;
}

export function getIO() {
  return io;
}

export function emitToUser(userId, event, payload) {
  if (!io || !userId) return false;
  io.to(userRoom(userId.toString())).emit(event, payload);
  return true;
}
