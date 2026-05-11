const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const validator = require('validator');
const { createId, get, now, publicUser, run } = require('../config/database');
const { createSecret, otpauthUrl, verifyTotp } = require('../utils/totp');

const cookieName = 'dh_access';

const jwtSecret = () => {
  const secret = process.env.JWT_SECRET || 'dev-only-change-this-secret-before-production';
  if (process.env.NODE_ENV === 'production' && secret.includes('dev-only')) {
    console.warn('WARNING: Set a strong JWT_SECRET in production.');
  }
  return secret;
};

const signToken = (id, role) => {
  return jwt.sign({ id, role }, jwtSecret(), {
    expiresIn: '30d',
  });
};

const setCookie = (res, token) => {
  res.cookie(cookieName, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 30 * 24 * 60 * 60 * 1000,
    path: '/',
  });
};

const createSendToken = (userRow, statusCode, res) => {
  const user = publicUser(userRow);
  const token = signToken(user.id, user.role);
  setCookie(res, token);

  res.status(statusCode).json({
    status: 'success',
    token,
    data: {
      user,
    },
  });
};

const parseJson = (value, fallback = {}) => {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
};

const saveUserProfile = async (userId, profile) => {
  await run('UPDATE users SET profile_json = ?, updated_at = ? WHERE id = ?', [
    JSON.stringify(profile),
    now(),
    userId,
  ]);
};

const validateRegistration = ({ username, email, password }) => {
  if (!username || !validator.isLength(String(username).trim(), { min: 2, max: 80 })) {
    return 'Name must be between 2 and 80 characters.';
  }

  if (!email || !validator.isEmail(String(email))) {
    return 'Please provide a valid email address.';
  }

  if (!password || !validator.isLength(String(password), { min: 8, max: 128 })) {
    return 'Password must be at least 8 characters.';
  }

  if (!/[A-Z]/.test(password) || !/[a-z]/.test(password) || !/[0-9]/.test(password)) {
    return 'Password must include uppercase, lowercase and number characters.';
  }

  return null;
};

exports.register = async (req, res, next) => {
  try {
    const { username, email, password, profile = {} } = req.body;
    const validationError = validateRegistration({ username, email, password });
    if (validationError) {
      return res.status(400).json({ status: 'fail', message: validationError });
    }

    const cleanEmail = String(email).trim().toLowerCase();
    const cleanUsername = validator.escape(String(username).trim());
    const existing = await get(
      'SELECT id FROM users WHERE LOWER(email) = LOWER(?) OR LOWER(username) = LOWER(?) LIMIT 1',
      [cleanEmail, cleanUsername],
    );

    if (existing) {
      return res.status(409).json({ status: 'fail', message: 'Email or username is already registered.' });
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const userId = createId('usr');
    const profileJson = JSON.stringify({
      ...profile,
      fullName: profile.fullName || cleanUsername,
    });

    await run(
      `INSERT INTO users
       (id, username, email, password_hash, role, profile_json, plan, balance, status, is_email_verified, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'user', ?, 'Starter Cloud', 0, 'active', 0, ?, ?)`,
      [userId, cleanUsername, cleanEmail, passwordHash, profileJson, now(), now()],
    );

    const newUser = await get('SELECT * FROM users WHERE id = ?', [userId]);
    createSendToken(newUser, 201, res);
  } catch (err) {
    next(err);
  }
};

exports.login = async (req, res, next) => {
  try {
    const identifier = String(req.body.identifier || req.body.email || '').trim().toLowerCase();
    const { password } = req.body;

    if (!identifier || !password) {
      return res.status(400).json({ status: 'fail', message: 'Please provide email/username and password.' });
    }

    const user = await get(
      'SELECT * FROM users WHERE LOWER(email) = LOWER(?) OR LOWER(username) = LOWER(?) LIMIT 1',
      [identifier, identifier],
    );

    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      return res.status(401).json({ status: 'fail', message: 'Incorrect email/username or password.' });
    }

    if (user.role === 'admin') {
      return res.status(403).json({
        status: 'fail',
        message: 'Admin accounts must sign in from /admin with 2FA verification.',
      });
    }

    if (user.status !== 'active') {
      return res.status(403).json({ status: 'fail', message: 'This account is not active.' });
    }

    await run('UPDATE users SET last_login = ?, updated_at = ? WHERE id = ?', [now(), now(), user.id]);
    const updatedUser = await get('SELECT * FROM users WHERE id = ?', [user.id]);

    await run(
      'INSERT INTO audit_logs (id, actor_id, action, target, ip_address, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [createId('aud'), user.id, 'auth.login', 'users', req.ip, '{}', now()],
    );

    createSendToken(updatedUser, 200, res);
  } catch (err) {
    next(err);
  }
};

exports.adminLogin = async (req, res, next) => {
  try {
    const identifier = String(req.body.identifier || req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    const otp = String(req.body.otp || req.body.code || '').replace(/\D/g, '').slice(0, 6);

    if (!identifier || !password) {
      return res.status(400).json({ status: 'fail', message: 'Admin email/username and password are required.' });
    }

    const user = await get(
      'SELECT * FROM users WHERE LOWER(email) = LOWER(?) OR LOWER(username) = LOWER(?) LIMIT 1',
      [identifier, identifier],
    );

    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      return res.status(401).json({ status: 'fail', message: 'Incorrect admin credentials.' });
    }

    if (user.role !== 'admin') {
      return res.status(403).json({ status: 'fail', message: 'This login is only for admin accounts.' });
    }

    if (user.status !== 'active') {
      return res.status(403).json({ status: 'fail', message: 'This admin account is not active.' });
    }

    const profile = parseJson(user.profile_json, {});
    const current2fa = profile.admin2fa && typeof profile.admin2fa === 'object' ? profile.admin2fa : {};
    let secret = current2fa.secret;
    let setupRequired = !current2fa.enabled;

    if (!secret) {
      secret = createSecret();
      setupRequired = true;
      profile.admin2fa = {
        secret,
        enabled: false,
        createdAt: now(),
      };
      await saveUserProfile(user.id, profile);
    }

    if (!otp) {
      return res.status(200).json({
        status: '2fa_required',
        data: {
          setupRequired,
          account: user.email,
          secret: setupRequired ? secret : undefined,
          otpauthUrl: setupRequired
            ? otpauthUrl({ issuer: 'DreamHost Admin', account: user.email, secret })
            : undefined,
          message: setupRequired
            ? 'Add this setup key to your Authenticator app, then enter the 6-digit code.'
            : 'Enter the 6-digit code from your Authenticator app.',
        },
      });
    }

    if (!verifyTotp(otp, secret)) {
      return res.status(401).json({ status: 'fail', message: 'Invalid 2FA code.' });
    }

    if (!current2fa.enabled) {
      profile.admin2fa = {
        ...current2fa,
        secret,
        enabled: true,
        enabledAt: now(),
      };
      await saveUserProfile(user.id, profile);
    }

    await run('UPDATE users SET last_login = ?, updated_at = ? WHERE id = ?', [now(), now(), user.id]);
    await run(
      'INSERT INTO audit_logs (id, actor_id, action, target, ip_address, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [createId('aud'), user.id, 'auth.admin_2fa.login', 'users', req.ip, '{}', now()],
    );

    const updatedUser = await get('SELECT * FROM users WHERE id = ?', [user.id]);
    createSendToken(updatedUser, 200, res);
  } catch (err) {
    next(err);
  }
};

exports.logout = (req, res) => {
  res.clearCookie(cookieName, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
  });

  res.status(200).json({ status: 'success' });
};

exports.me = async (req, res, next) => {
  try {
    res.status(200).json({
      status: 'success',
      data: {
        user: publicUser(req.user),
      },
    });
  } catch (err) {
    next(err);
  }
};

exports.updateMe = async (req, res, next) => {
  try {
    const {
      name,
      language,
      notifications,
      company,
      phone,
      timezone,
      address,
      securityAlerts,
      marketingEmails,
      currentPassword,
      newPassword,
    } = req.body;
    const currentProfile = req.user.profile_json ? JSON.parse(req.user.profile_json) : {};
    const profile = {
      ...currentProfile,
      fullName: name ? validator.escape(String(name).trim()) : currentProfile.fullName,
      company: company !== undefined ? validator.escape(String(company).trim()).slice(0, 120) : currentProfile.company,
      phone: phone !== undefined ? validator.escape(String(phone).trim()).slice(0, 40) : currentProfile.phone,
      language: language || currentProfile.language || 'en',
      timezone: timezone !== undefined ? validator.escape(String(timezone).trim()).slice(0, 80) : currentProfile.timezone,
      address: address !== undefined ? validator.escape(String(address).trim()).slice(0, 240) : currentProfile.address,
      notifications: notifications === undefined ? Boolean(currentProfile.notifications) : Boolean(notifications),
      securityAlerts: securityAlerts === undefined ? currentProfile.securityAlerts !== false : Boolean(securityAlerts),
      marketingEmails: marketingEmails === undefined ? Boolean(currentProfile.marketingEmails) : Boolean(marketingEmails),
    };

    let passwordHash = req.user.password_hash;
    if (newPassword) {
      if (!currentPassword || !(await bcrypt.compare(String(currentPassword), req.user.password_hash))) {
        return res.status(401).json({ status: 'fail', message: 'Current password is incorrect.' });
      }
      const validationError = validateRegistration({
        username: req.user.username,
        email: req.user.email,
        password: String(newPassword),
      });
      if (validationError) {
        return res.status(400).json({ status: 'fail', message: validationError });
      }
      passwordHash = await bcrypt.hash(String(newPassword), 12);
    }

    await run('UPDATE users SET profile_json = ?, password_hash = ?, updated_at = ? WHERE id = ?', [
      JSON.stringify(profile),
      passwordHash,
      now(),
      req.user.id,
    ]);

    await run(
      'INSERT INTO audit_logs (id, actor_id, action, target, ip_address, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [createId('aud'), req.user.id, newPassword ? 'account.settings.password_update' : 'account.settings.update', req.user.id, req.ip, '{}', now()],
    );

    const user = await get('SELECT * FROM users WHERE id = ?', [req.user.id]);
    createSendToken(user, 200, res);
  } catch (err) {
    next(err);
  }
};
