const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');

const DATA_DIR = path.resolve(__dirname, '..', 'data');
const DB_FILE = process.env.DATABASE_FILE
  ? path.resolve(process.env.DATABASE_FILE)
  : path.join(DATA_DIR, 'dreamhost.sqlite');

let db;

const now = () => new Date().toISOString();
const createId = (prefix) => `${prefix}_${crypto.randomBytes(12).toString('hex')}`;

const getDb = () => {
  if (!db) {
    fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
    db = new sqlite3.Database(DB_FILE);
  }
  return db;
};

const run = (sql, params = []) =>
  new Promise((resolve, reject) => {
    getDb().run(sql, params, function onRun(err) {
      if (err) return reject(err);
      resolve({ id: this.lastID, changes: this.changes });
    });
  });

const get = (sql, params = []) =>
  new Promise((resolve, reject) => {
    getDb().get(sql, params, (err, row) => {
      if (err) return reject(err);
      resolve(row);
    });
  });

const all = (sql, params = []) =>
  new Promise((resolve, reject) => {
    getDb().all(sql, params, (err, rows) => {
      if (err) return reject(err);
      resolve(rows);
    });
  });

const ensureColumn = async (tableName, columnName, definition) => {
  const columns = await all(`PRAGMA table_info(${tableName})`);
  if (!columns.some((column) => column.name === columnName)) {
    await run(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
  }
};

const parseJson = (value, fallback = {}) => {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
};

const publicUser = (row) => {
  if (!row) return null;
  const profile = parseJson(row.profile_json);
  const publicProfile = { ...profile };
  if (publicProfile.admin2fa) {
    publicProfile.admin2fa = { enabled: Boolean(publicProfile.admin2fa.enabled) };
  }
  const displayName = profile.fullName || profile.firstName || row.username || row.email;

  return {
    id: row.id,
    _id: row.id,
    username: row.username,
    name: displayName,
    email: row.email,
    role: row.role,
    plan: row.plan,
    balance: Number(row.balance || 0),
    status: row.status,
    isEmailVerified: Boolean(row.is_email_verified),
    profile: publicProfile,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastLogin: row.last_login,
  };
};

const seedPlans = async () => {
  const common = ['DDoS shield', 'Instant setup', '24/7 support'];
  const plan = (id, name, type, monthly, specs, features = common, isPopular = 0, stock = -1) => ({
    id,
    name,
    type,
    monthly_price: monthly,
    yearly_price: Number((monthly * 10).toFixed(2)),
    specs_json: specs,
    features_json: features,
    is_popular: isPopular,
    stock,
  });

  const plans = [
    plan('plan_vps_nano', 'Nano VPS', 'vps', 4.99, { cpu: '1 vCPU', ram: '2GB', storage: '40GB NVMe', bandwidth: '2TB', network: '1Gbps' }),
    plan('plan_vps_micro', 'Micro VPS', 'vps', 8.99, { cpu: '2 vCPU', ram: '4GB', storage: '80GB NVMe', bandwidth: '4TB', network: '2Gbps' }),
    plan('plan_vps_dev', 'Developer Starter', 'vps', 12.99, { cpu: '4 vCPU', ram: '8GB', storage: '120GB NVMe', bandwidth: '6TB', network: '2.5Gbps' }, ['Snapshots', 'SSH access', 'DDoS shield'], 1),
    plan('plan_vps_growth', 'Growth VPS', 'vps', 22.99, { cpu: '6 vCPU', ram: '16GB', storage: '240GB NVMe', bandwidth: '10TB', network: '5Gbps' }, ['Private network', 'Backups ready', 'DDoS shield']),
    plan('plan_vps_pro', 'Business Pro', 'vps', 34.99, { cpu: '8 vCPU', ram: '32GB', storage: '400GB NVMe', bandwidth: '12TB', network: '10Gbps' }, ['Priority CPU', 'Snapshots', 'Managed firewall']),
    plan('plan_vps_max', 'Enterprise Max', 'vps', 79.99, { cpu: '16 vCPU', ram: '64GB', storage: '1TB NVMe', bandwidth: '24TB', network: '20Gbps' }, ['High IOPS', 'Premium routing', 'Priority support']),
    plan('plan_vps_memory', 'Memory Optimized', 'vps', 99.99, { cpu: '16 vCPU', ram: '128GB', storage: '800GB NVMe', bandwidth: '30TB', network: '20Gbps' }, ['Redis ready', 'DB workloads', 'Private VLAN']),
    plan('plan_vps_ultimate', 'Ultimate Cloud VPS', 'vps', 149.99, { cpu: '32 vCPU', ram: '128GB', storage: '2TB NVMe', bandwidth: '50TB', network: '40Gbps' }, ['Dedicated uplink', 'Enterprise SLA', 'Advanced monitoring']),
    plan('plan_dedicated_entry', 'Entry EPYC', 'dedicated', 89, { cpu: '16 cores', ram: '64GB ECC', storage: '2x 960GB NVMe', bandwidth: 'Unmetered', network: '1Gbps' }, ['IPMI', 'Root access', 'DDoS shield'], 0, 12),
    plan('plan_dedicated_epyc', 'EPYC Dedicated', 'dedicated', 149, { cpu: '32 cores / 64 threads', ram: '128GB ECC', storage: '2x 1.92TB NVMe', bandwidth: 'Unmetered', network: '1Gbps' }, ['IPMI', 'Hardware SLA', 'Private VLAN'], 1, 8),
    plan('plan_dedicated_intel', 'Intel Performance', 'dedicated', 219, { cpu: '40 cores', ram: '192GB ECC', storage: '4x 1.92TB NVMe', bandwidth: '30TB', network: '5Gbps' }, ['Turbo clocks', 'RAID options', 'Managed firewall'], 0, 6),
    plan('plan_dedicated_dual', 'Dual Intel Pro', 'dedicated', 299, { cpu: '48 cores', ram: '256GB ECC', storage: '4x 3.84TB NVMe', bandwidth: 'Unmetered', network: '10Gbps' }, ['Dual socket', 'IPMI', 'Priority replacement'], 0, 4),
    plan('plan_dedicated_storage', 'Storage Vault', 'dedicated', 349, { cpu: '24 cores', ram: '128GB ECC', storage: '8x 8TB HDD + NVMe', bandwidth: 'Unmetered', network: '10Gbps' }, ['Backup storage', 'RAID 10', 'Snapshot ready'], 0, 5),
    plan('plan_dedicated_gpu', 'GPU Compute', 'dedicated', 499, { cpu: '32 cores', ram: '256GB ECC', storage: '2x 3.84TB NVMe', bandwidth: '30TB', network: '10Gbps' }, ['AI workloads', 'CUDA ready', 'Premium cooling'], 0, 3),
    plan('plan_dedicated_extreme', 'Extreme Cluster', 'dedicated', 599, { cpu: '128 cores', ram: '1TB DDR5', storage: '10x 7.68TB NVMe', bandwidth: 'Unmetered', network: '40Gbps' }, ['Cluster-ready', 'Enterprise SLA', 'Dedicated engineer'], 0, 2),
    plan('plan_cloud_s', 'Cloud Instance S', 'cloud', 19.99, { cpu: '2 vCPU', ram: '8GB', storage: '100GB Cloud Storage', bandwidth: '6TB', network: '2Gbps' }, ['Auto heal', 'Firewall', 'Snapshots']),
    plan('plan_cloud_m', 'Cloud Instance M', 'cloud', 39.99, { cpu: '4 vCPU', ram: '16GB', storage: '250GB Cloud Storage', bandwidth: '12TB', network: '5Gbps' }, ['Auto-scaling', 'Private network', 'Monitoring'], 1),
    plan('plan_cloud_l', 'Cloud Instance L', 'cloud', 69.99, { cpu: '8 vCPU', ram: '32GB', storage: '500GB Cloud Storage', bandwidth: '20TB', network: '10Gbps' }, ['Load balancer ready', 'Snapshots', 'DDoS shield']),
    plan('plan_cloud_db', 'Managed Database Node', 'cloud', 89, { cpu: '8 vCPU', ram: '48GB', storage: '600GB NVMe', bandwidth: '12TB', network: '10Gbps' }, ['PostgreSQL ready', 'Redis ready', 'Backup policy']),
    plan('plan_cloud_ha', 'Enterprise HA Cluster', 'cloud', 159, { cpu: '16 vCPU', ram: '64GB', storage: '1TB Cloud Storage', bandwidth: '30TB', network: '20Gbps' }, ['Multi-node HA', 'Failover', 'Priority support']),
    plan('plan_cloud_edge', 'Edge Compute', 'cloud', 199, { cpu: '24 vCPU', ram: '96GB', storage: '1.5TB NVMe', bandwidth: '50TB', network: 'Anycast Edge' }, ['Global edge', 'Low latency', 'Traffic burst']),
    plan('plan_gaming_starter', 'Starter Gamer', 'gaming', 9.99, { cpu: 'Ryzen 5 5600X', ram: '8GB', storage: '50GB SSD', bandwidth: '3TB', network: 'Basic DDoS Filter' }, ['Minecraft ready', 'SFTP access', 'Backups']),
    plan('plan_gaming_core', 'Gamer Core', 'gaming', 15, { cpu: 'i9-14900K', ram: '16GB', storage: '100GB NVMe', bandwidth: '6TB', network: 'Game Shield Pro' }, ['Game panel', 'Modpack ready', 'Low latency'], 1),
    plan('plan_gaming_rust', 'Rust Performance', 'gaming', 28, { cpu: 'Ryzen 7 7800X3D', ram: '24GB', storage: '180GB NVMe', bandwidth: '8TB', network: 'Anti-DDoS' }, ['Rust tuned', 'Fast wipes', 'Console access']),
    plan('plan_gaming_tournament', 'Tournament Host', 'gaming', 45, { cpu: 'Ryzen 9 7950X', ram: '32GB', storage: '500GB NVMe', bandwidth: '12TB', network: 'Custom Filter' }, ['High slots', 'Priority CPU', 'Realtime console']),
    plan('plan_gaming_enterprise', 'Gaming Enterprise', 'gaming', 120, { cpu: 'Dual Xeon Gold', ram: '128GB', storage: '1TB NVMe', bandwidth: '30TB', network: 'Unlimited Slots' }, ['Multi-game hosting', 'Dedicated IP', 'Priority support']),
    plan('plan_network_ddos', 'DDoS Shield Pro', 'network', 25, { cpu: 'Layer 3/4/7', ram: 'Managed', storage: 'Attack logs', bandwidth: '1.5Tbps Protection', network: 'Real-time filter' }, ['L3/L4/L7 filter', 'Attack reports', 'Always-on mode']),
    plan('plan_network_cdn', 'Edge CDN', 'network', 10, { cpu: '32+ locations', ram: 'Smart cache', storage: 'Image cache', bandwidth: '2TB Included', network: 'Anycast Network' }, ['SSL included', 'Purge API', 'Image cache'], 1),
    plan('plan_network_ip_block', 'Dedicated IP Block', 'network', 5, { cpu: 'IPv4 /29', ram: 'rDNS panel', storage: 'Clean reputation', bandwidth: 'Routed subnet', network: 'BGP ready' }, ['rDNS panel', 'Routing support', 'Abuse monitoring']),
    plan('plan_network_lb', 'Load Balancer', 'network', 18, { cpu: 'Layer 4', ram: 'Health checks', storage: 'Metrics', bandwidth: '5TB Included', network: 'SSL passthrough' }, ['Failover', 'Metrics', 'Sticky sessions']),
    plan('plan_network_vpn', 'Private VPN Gateway', 'network', 12, { cpu: 'WireGuard', ram: 'Team access', storage: 'Access logs', bandwidth: '2TB Included', network: 'Private routes' }, ['Site-to-site', 'Access logs', 'Private subnets']),
    plan('plan_storage_backup_1tb', 'Backup Vault 1TB', 'cloud', 7.99, { cpu: 'Backup service', ram: 'Encrypted', storage: '1TB Backup Space', bandwidth: 'SFTP + API', network: 'Daily retention' }, ['Encrypted storage', 'Retention rules', 'Restore support']),
    plan('plan_storage_backup_5tb', 'Backup Vault 5TB', 'cloud', 29.99, { cpu: 'Backup service', ram: 'Object lock', storage: '5TB Backup Space', bandwidth: 'SFTP + API', network: 'Fast restore' }, ['Object lock', 'SFTP + API', 'Restore reports'], 1),
    plan('plan_storage_object', 'Object Storage Pro', 'cloud', 19.99, { cpu: 'S3 compatible', ram: 'Buckets', storage: '2TB Object Storage', bandwidth: 'CDN ready', network: 'Lifecycle rules' }, ['S3 API', 'Buckets', 'Lifecycle rules']),
    plan('plan_storage_archive', 'Cold Archive', 'cloud', 14.99, { cpu: 'Archive service', ram: 'Immutable option', storage: '4TB Archive', bandwidth: 'Monthly restore', network: 'Audit logs' }, ['Compliance ready', 'Immutable option', 'Audit logs']),
  ];

  await run(
    `UPDATE plans SET is_active = 0
     WHERE id NOT IN (${plans.map(() => '?').join(',')})`,
    plans.map((item) => item.id),
  );

  for (const plan of plans) {
    await run(
      `INSERT INTO plans
       (id, name, type, monthly_price, yearly_price, specs_json, features_json, is_popular, is_active, stock, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         type = excluded.type,
         monthly_price = excluded.monthly_price,
         yearly_price = excluded.yearly_price,
         specs_json = excluded.specs_json,
         features_json = excluded.features_json,
         is_popular = excluded.is_popular,
         is_active = 1,
         stock = excluded.stock`,
      [
        plan.id,
        plan.name,
        plan.type,
        plan.monthly_price,
        plan.yearly_price,
        JSON.stringify(plan.specs_json),
        JSON.stringify(plan.features_json),
        plan.is_popular,
        plan.stock,
        now(),
      ],
    );
  }
};

const importLegacyUsers = async () => {
  const count = await get('SELECT COUNT(*) AS total FROM users');
  if (count.total > 0) return;

  const legacyPath = path.join(DATA_DIR, 'users.json');
  if (!fs.existsSync(legacyPath)) return;

  const legacyUsers = parseJson(fs.readFileSync(legacyPath, 'utf8'), []);
  if (!Array.isArray(legacyUsers)) return;

  for (const user of legacyUsers) {
    if (!user.email || !user.password) continue;
    const createdAt = user.createdAt ? new Date(user.createdAt).toISOString() : now();
    await run(
      `INSERT OR IGNORE INTO users
       (id, username, email, password_hash, role, profile_json, plan, balance, status, is_email_verified, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        user._id || createId('usr'),
        user.username || user.email.split('@')[0],
        String(user.email).trim().toLowerCase(),
        user.password,
        user.role || 'user',
        JSON.stringify(user.profile || {}),
        user.plan || 'Pro Account',
        Number(user.balance || 0),
        user.status || 'active',
        user.isEmailVerified ? 1 : 0,
        createdAt,
        now(),
      ],
    );
  }
};

const seedAdmin = async () => {
  const adminEmail = (process.env.ADMIN_EMAIL || 'dreamhost.secure.panel@gmail.com').trim().toLowerCase();
  const adminUsername = (process.env.ADMIN_USERNAME || 'dreamhost_admin').trim();
  const adminPassword = process.env.ADMIN_PASSWORD || 'DH-Admin-2026!Secure-Vault-9fK7-qL42-Network#A1';
  const existingAdmin = await get('SELECT id, role, status FROM users WHERE LOWER(email) = LOWER(?) LIMIT 1', [adminEmail]);

  if (existingAdmin) {
    if (existingAdmin.role !== 'admin' || existingAdmin.status !== 'active') {
      await run('UPDATE users SET role = ?, status = ?, is_email_verified = 1, updated_at = ? WHERE id = ?', [
        'admin',
        'active',
        now(),
        existingAdmin.id,
      ]);
    }
    return;
  }

  const passwordHash = await bcrypt.hash(adminPassword, 12);
  await run(
    `INSERT INTO users
     (id, username, email, password_hash, role, profile_json, plan, balance, status, is_email_verified, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'admin', ?, 'Admin Console', 0, 'active', 1, ?, ?)`,
    [
      createId('adm'),
      adminUsername,
      adminEmail,
      passwordHash,
      JSON.stringify({ fullName: 'DreamHost Admin' }),
      now(),
      now(),
    ],
  );

  console.log('Admin user ready. Use configured ADMIN_EMAIL and ADMIN_PASSWORD.');
};

const initDatabase = async () => {
  fs.mkdirSync(DATA_DIR, { recursive: true });

  await run('PRAGMA foreign_keys = ON');
  await run('PRAGMA journal_mode = WAL');

  await run(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin', 'support')),
      profile_json TEXT NOT NULL DEFAULT '{}',
      plan TEXT NOT NULL DEFAULT 'Starter Cloud',
      balance REAL NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'banned')),
      is_email_verified INTEGER NOT NULL DEFAULT 0,
      last_login TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  await run('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username ON users(LOWER(username))');
  await run('CREATE INDEX IF NOT EXISTS idx_users_role ON users(role)');

  await run(`
    CREATE TABLE IF NOT EXISTS plans (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL CHECK (type IN ('vps', 'dedicated', 'cloud', 'gaming', 'network')),
      monthly_price REAL NOT NULL,
      yearly_price REAL,
      specs_json TEXT NOT NULL DEFAULT '{}',
      features_json TEXT NOT NULL DEFAULT '[]',
      is_popular INTEGER NOT NULL DEFAULT 0,
      is_active INTEGER NOT NULL DEFAULT 1,
      stock INTEGER NOT NULL DEFAULT -1,
      created_at TEXT NOT NULL
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS server_instances (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      plan_id TEXT NOT NULL,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      ip_address TEXT,
      status TEXT NOT NULL DEFAULT 'provisioning' CHECK (status IN ('provisioning', 'running', 'stopped', 'suspended', 'terminated')),
      region TEXT NOT NULL,
      os TEXT NOT NULL DEFAULT 'Ubuntu 24.04 LTS',
      cpu_usage REAL NOT NULL DEFAULT 0,
      ram_usage REAL NOT NULL DEFAULT 0,
      ram_total REAL NOT NULL DEFAULT 0,
      storage_used REAL NOT NULL DEFAULT 0,
      storage_total REAL NOT NULL DEFAULT 0,
      monthly_price REAL NOT NULL DEFAULT 0,
      add_ons_json TEXT NOT NULL DEFAULT '[]',
      auto_renew INTEGER NOT NULL DEFAULT 1,
      expires_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (plan_id) REFERENCES plans(id)
    )
  `);

  await run('CREATE INDEX IF NOT EXISTS idx_servers_user ON server_instances(user_id)');
  await run('CREATE INDEX IF NOT EXISTS idx_servers_status ON server_instances(status)');
  await ensureColumn('server_instances', 'monthly_price', 'REAL NOT NULL DEFAULT 0');
  await ensureColumn('server_instances', 'add_ons_json', "TEXT NOT NULL DEFAULT '[]'");
  await ensureColumn('server_instances', 'custom_config_json', "TEXT NOT NULL DEFAULT '{}'");
  await ensureColumn('server_instances', 'cpu_cores', 'REAL NOT NULL DEFAULT 0');
  await ensureColumn('server_instances', 'bandwidth_tb', 'REAL NOT NULL DEFAULT 0');
  await ensureColumn('server_instances', 'network_gbps', 'REAL NOT NULL DEFAULT 0');
  await ensureColumn('server_instances', 'storage_type', "TEXT NOT NULL DEFAULT 'NVMe'");

  await run(`
    CREATE TABLE IF NOT EXISTS audit_logs (
      id TEXT PRIMARY KEY,
      actor_id TEXT,
      action TEXT NOT NULL,
      target TEXT,
      ip_address TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS support_requests (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      subject TEXT,
      priority TEXT NOT NULL DEFAULT 'normal',
      category TEXT NOT NULL DEFAULT 'support',
      assigned_admin_id TEXT,
      message TEXT NOT NULL,
      transcript_json TEXT NOT NULL DEFAULT '[]',
      email_to TEXT,
      email_sent INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'read', 'closed')),
      ip_address TEXT,
      user_agent TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL,
      FOREIGN KEY (assigned_admin_id) REFERENCES users(id) ON DELETE SET NULL
    )
  `);

  await run('CREATE INDEX IF NOT EXISTS idx_support_requests_status ON support_requests(status)');
  await run('CREATE INDEX IF NOT EXISTS idx_support_requests_created ON support_requests(created_at)');
  await ensureColumn('support_requests', 'user_id', 'TEXT');
  await ensureColumn('support_requests', 'subject', 'TEXT');
  await ensureColumn('support_requests', 'priority', "TEXT NOT NULL DEFAULT 'normal'");
  await ensureColumn('support_requests', 'category', "TEXT NOT NULL DEFAULT 'support'");
  await ensureColumn('support_requests', 'assigned_admin_id', 'TEXT');

  await run(`
    CREATE TABLE IF NOT EXISTS invoices (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      amount REAL NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'paid' CHECK (status IN ('draft', 'paid', 'open', 'void')),
      description TEXT NOT NULL DEFAULT '',
      items_json TEXT NOT NULL DEFAULT '[]',
      due_at TEXT,
      paid_at TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  await run('CREATE INDEX IF NOT EXISTS idx_invoices_user ON invoices(user_id)');

  await importLegacyUsers();
  await seedPlans();
  await seedAdmin();

  return { file: DB_FILE };
};

const closeDatabase = () =>
  new Promise((resolve, reject) => {
    if (!db) return resolve();
    db.close((err) => {
      if (err) return reject(err);
      db = null;
      resolve();
    });
  });

module.exports = {
  DB_FILE,
  all,
  closeDatabase,
  createId,
  get,
  initDatabase,
  now,
  publicUser,
  run,
};
