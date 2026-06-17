import { isDev } from '../config/env.js';

export function errorHandler(err, req, res, next) {
  if (err.name === 'ValidationError') {
    const errors = Object.values(err.errors).map((e) => e.message);
    return res.status(400).json({ error: 'Validatsiya xatosi', details: errors });
  }

  if (err.code === 11000) {
    const field = Object.keys(err.keyValue || {})[0];
    return res.status(409).json({ error: `${field} band` });
  }

  if (err.name === 'CastError') {
    return res.status(400).json({ error: 'Noto\'g\'ri ID' });
  }

  const status = err.status || err.statusCode || 500;
  console.error('[Error]', err);

  res.status(status).json({
    error: err.message || 'Server xatosi',
    ...(isDev && { stack: err.stack }),
  });
}

export function notFound(req, res) {
  res.status(404).json({ error: 'Endpoint topilmadi', path: req.path });
}
