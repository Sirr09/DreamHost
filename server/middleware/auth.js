const jwt = require('jsonwebtoken');
const { promisify } = require('util');
const { get } = require('../config/database');

const jwtSecret = () => process.env.JWT_SECRET || 'dev-only-change-this-secret-before-production';

const readCookieToken = (req) => {
  const rawCookie = req.headers.cookie;
  if (!rawCookie) return null;

  return rawCookie
    .split(';')
    .map((cookie) => cookie.trim())
    .find((cookie) => cookie.startsWith('dh_access='))
    ?.split('=')
    .slice(1)
    .join('=');
};

exports.protect = async (req, res, next) => {
  try {
    let token;
    if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
      token = req.headers.authorization.split(' ')[1];
    }
    if (!token) token = readCookieToken(req);

    if (!token) {
      return res.status(401).json({ status: 'fail', message: 'You are not logged in.' });
    }

    const decoded = await promisify(jwt.verify)(token, jwtSecret());
    const currentUser = await get('SELECT * FROM users WHERE id = ?', [decoded.id]);

    if (!currentUser) {
      return res.status(401).json({ status: 'fail', message: 'The user belonging to this token no longer exists.' });
    }

    if (currentUser.status !== 'active') {
      return res.status(403).json({ status: 'fail', message: 'This account is not active.' });
    }

    req.user = currentUser;
    next();
  } catch (err) {
    next(err);
  }
};

exports.restrictTo = (...roles) => {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ status: 'fail', message: 'You do not have permission to perform this action.' });
    }
    next();
  };
};
