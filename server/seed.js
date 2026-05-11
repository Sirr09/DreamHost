require('dotenv').config();

const bcrypt = require('bcryptjs');
const { createId, get, initDatabase, now, run, closeDatabase } = require('./config/database');

const seedAdmin = async () => {
  await initDatabase();

  const email = (process.env.ADMIN_EMAIL || 'dreamhost.secure.panel@gmail.com').trim().toLowerCase();
  const username = (process.env.ADMIN_USERNAME || 'dreamhost_admin').trim();
  const password = process.env.ADMIN_PASSWORD || 'DH-Admin-2026!Secure-Vault-9fK7-qL42-Network#A1';
  const passwordHash = await bcrypt.hash(password, 12);
  const existing = await get('SELECT id FROM users WHERE LOWER(email) = LOWER(?)', [email]);

  if (existing) {
    await run(
      `UPDATE users
       SET username = ?, password_hash = ?, role = 'admin', status = 'active', is_email_verified = 1, updated_at = ?
       WHERE id = ?`,
      [username, passwordHash, now(), existing.id],
    );
  } else {
    await run(
      `INSERT INTO users
       (id, username, email, password_hash, role, profile_json, plan, balance, status, is_email_verified, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'admin', ?, 'Admin Console', 0, 'active', 1, ?, ?)`,
      [
        createId('adm'),
        username,
        email,
        passwordHash,
        JSON.stringify({ fullName: 'DreamHost Admin' }),
        now(),
        now(),
      ],
    );
  }

  await run(
    `UPDATE users
     SET role = 'user', status = 'suspended', updated_at = ?
     WHERE LOWER(email) = LOWER(?) AND LOWER(email) <> LOWER(?)`,
    [now(), 'admin@dreamhost.az', email],
  );

  console.log('Admin account ready. Use ADMIN_EMAIL and ADMIN_PASSWORD from the environment.');
};

seedAdmin()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => closeDatabase());
