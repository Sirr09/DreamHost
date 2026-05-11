const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const fs = require('fs');

const authRoutes = require('./routes/authRoutes');
const adminRoutes = require('./routes/adminRoutes');
const infrastructureRoutes = require('./routes/infrastructureRoutes');
const supportRoutes = require('./routes/supportRoutes');
const path = require('path');
const jwt = require('jsonwebtoken');
const { createId, now, run } = require('./config/database');

const app = express();

app.disable('x-powered-by');
app.set('trust proxy', 1);

const parseAllowedOrigins = () => {
  const port = process.env.PORT || 5000;
  const defaults = [
    'http://localhost:5173',
    'http://127.0.0.1:5173',
    `http://localhost:${port}`,
    `http://127.0.0.1:${port}`,
  ];
  const configured = (process.env.CLIENT_URL || process.env.CORS_ORIGIN || '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

  return [...new Set([...defaults, ...configured])];
};

const allowedOrigins = parseAllowedOrigins();

app.use(helmet({
  crossOriginOpenerPolicy: false,
  crossOriginResourcePolicy: false,
  hsts: process.env.NODE_ENV === 'production' ? undefined : false,
  originAgentCluster: false,
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      "default-src": ["'self'"],
      "script-src": ["'self'"],
      "style-src": ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      "font-src": ["'self'", 'https://fonts.gstatic.com', 'data:'],
      "img-src": ["'self'", 'data:', 'https:'],
      "connect-src": ["'self'", ...allowedOrigins],
      "object-src": ["'none'"],
      "base-uri": ["'self'"],
      "frame-ancestors": ["'none'"],
      "upgrade-insecure-requests": null,
    },
  },
}));
app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error('Not allowed by CORS'));
  },
  credentials: true,
}));

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { status: 'fail', message: 'Too many requests. Please try again later.' },
});
app.use('/api/', limiter);

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { status: 'fail', message: 'Too many login attempts. Please wait and try again.' },
});

app.use(express.json({ limit: '100kb' }));
app.use(express.urlencoded({ extended: true, limit: '100kb' }));

const ipCategory = (ip = '') => {
  const clean = String(ip).replace('::ffff:', '');
  if (clean === '::1' || clean === '127.0.0.1') return 'local';
  if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[0-1])\.)/.test(clean)) return 'private';
  return 'public';
};

const readBearerActor = (req) => {
  try {
    const auth = req.headers.authorization || '';
    const bearer = auth.startsWith('Bearer ') ? auth.split(' ')[1] : '';
    const cookieToken = String(req.headers.cookie || '')
      .split(';')
      .map((item) => item.trim())
      .find((item) => item.startsWith('dh_access='))
      ?.split('=')
      .slice(1)
      .join('=');
    const token = bearer || cookieToken;
    if (!token) return null;
    return jwt.verify(token, process.env.JWT_SECRET || 'dev-only-change-this-secret-before-production')?.id || null;
  } catch {
    return null;
  }
};

app.use((req, res, next) => {
  const started = Date.now();
  res.on('finish', () => {
    const isAsset = /\.(js|css|png|jpg|jpeg|svg|webm|ico|woff2?)$/i.test(req.path);
    const shouldLog = !isAsset && req.method !== 'OPTIONS' && req.path !== '/api/health';
    if (!shouldLog) return;

    const action = req.path.startsWith('/api')
      ? `api.${req.method.toLowerCase()}`
      : `page.${req.method.toLowerCase()}`;
    const metadata = {
      method: req.method,
      path: req.originalUrl,
      statusCode: res.statusCode,
      durationMs: Date.now() - started,
      ipCategory: ipCategory(req.ip),
      userAgent: req.get('user-agent') || '',
      referer: req.get('referer') || '',
    };

    run(
      'INSERT INTO audit_logs (id, actor_id, action, target, ip_address, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [createId('aud'), req.user?.id || readBearerActor(req), action, req.path, req.ip, JSON.stringify(metadata), now()],
    ).catch(() => {});
  });
  next();
});

if (process.env.NODE_ENV === 'development') {
  app.use(morgan('dev'));
}

app.use('/api/auth/login', authLimiter);
app.use('/api/auth/register', authLimiter);
app.use('/api/auth', authRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/support', supportRoutes);
app.use('/api', infrastructureRoutes);

app.get('/api/health', (req, res) => {
  res.status(200).json({
    status: 'success',
    message: 'DreamHost API is running',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
});

const buildPath = path.resolve(__dirname, 'public');
if (fs.existsSync(buildPath)) {
  app.use(express.static(buildPath, {
    index: false,
    etag: true,
    maxAge: process.env.NODE_ENV === 'production' ? '7d' : 0,
    setHeaders(res, filePath) {
      if (process.env.NODE_ENV !== 'production' || filePath.endsWith('index.html')) {
        res.setHeader('Cache-Control', 'no-store');
      }
    },
  }));
}

app.use((req, res, next) => {
  if (req.path.startsWith('/api')) return next();
  if (path.extname(req.path)) return next();

  const indexPath = path.join(buildPath, 'index.html');
  if (!fs.existsSync(indexPath)) {
    return res.status(503).send('Frontend build is missing. Run npm run build in the client folder.');
  }

  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(indexPath);
});

app.use('/api', (req, res) => {
  res.status(404).json({ status: 'fail', message: 'API route not found.' });
});

app.use((err, req, res, next) => {
  err.statusCode = err.statusCode || 500;
  err.status = err.status || 'error';

  res.status(err.statusCode).json({
    status: err.status,
    message: err.statusCode === 500 && process.env.NODE_ENV === 'production'
      ? 'Internal server error'
      : err.message,
    stack: process.env.NODE_ENV === 'development' ? err.stack : undefined
  });
});

if (require.main === module) {
  require('dotenv').config();
  const connectDB = require('./config/db');
  const { closeDatabase } = require('./config/database');
  const port = Number(process.env.PORT) || 5000;

  connectDB()
    .then(() => {
      const server = app.listen(port, () => {
        console.log(`DreamHost app running on port ${port}`);
      });

      const shutdown = async () => {
        await new Promise((resolve) => server.close(resolve));
        await closeDatabase();
        process.exit(0);
      };

      process.on('SIGTERM', shutdown);
      process.on('SIGINT', shutdown);
    })
    .catch((err) => {
      console.error(err);
      closeDatabase().finally(() => process.exit(1));
    });
}

module.exports = app;
