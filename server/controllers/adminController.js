const { all, createId, get, now, publicUser, run } = require('../config/database');

const parseJson = (value, fallback) => {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
};

const relativeTime = (isoDate) => {
  if (!isoDate) return 'never';
  const diff = Date.now() - new Date(isoDate).getTime();
  const minutes = Math.max(1, Math.round(diff / 60000));
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
};

const parseSpecNumber = (value, fallback = 0) => {
  const match = String(value || '').match(/(\d+(?:\.\d+)?)/);
  return match ? Number(match[1]) : fallback;
};

const parseCapacityGb = (value, fallback = 0) => {
  const text = String(value || '').toLowerCase();
  const multiMatch = text.match(/(\d+(?:\.\d+)?)\s*x\s*(\d+(?:\.\d+)?)\s*(tb|gb)/);
  if (multiMatch) {
    const total = Number(multiMatch[1]) * Number(multiMatch[2]);
    return Math.round(total * (multiMatch[3] === 'tb' ? 1024 : 1));
  }

  const match = text.match(/(\d+(?:\.\d+)?)\s*(tb|gb)/);
  if (!match) return fallback;
  return Math.round(Number(match[1]) * (match[2] === 'tb' ? 1024 : 1));
};

const mapAdminServer = (row) => {
  const customConfig = parseJson(row.custom_config_json, {});
  const planSpecs = parseJson(row.plan_specs_json, {});

  return {
    id: row.id,
    name: row.name,
    type: row.type,
    planId: row.plan_id,
    planName: row.plan_name,
    owner: {
      id: row.user_id,
      email: row.owner_email,
      username: row.owner_username,
    },
    ip: row.ip_address,
    status: row.status,
    region: row.region,
    os: row.os,
    resources: {
      cpuUsage: Number(row.cpu_usage || 0),
      cpuCores: Number(row.cpu_cores || customConfig.cpuCores || parseSpecNumber(planSpecs.cpu, 0)),
      ramUsage: Number(row.ram_usage || 0),
      ramTotal: Number(row.ram_total || customConfig.ramGb || parseCapacityGb(planSpecs.ram, 0)),
      storageUsed: Number(row.storage_used || 0),
      storageTotal: Number(row.storage_total || customConfig.storageGb || parseCapacityGb(planSpecs.storage, 0)),
      bandwidthTb: Number(row.bandwidth_tb || customConfig.bandwidthTb || parseSpecNumber(planSpecs.bandwidth, 0)),
      networkGbps: Number(row.network_gbps || customConfig.networkGbps || parseSpecNumber(planSpecs.network, 0)),
      storageType: row.storage_type || customConfig.storageType || (String(planSpecs.storage || '').toLowerCase().includes('ssd') ? 'SSD' : 'NVMe'),
    },
    billing: {
      monthly: Number(row.monthly_price || row.plan_monthly_price || 0),
      addOns: parseJson(row.add_ons_json, []),
      autoRenew: Boolean(row.auto_renew),
    },
    customConfig,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
};

const mapInvoice = (row) => ({
  id: row.id,
  userId: row.user_id,
  owner: {
    email: row.owner_email,
    username: row.owner_username,
  },
  amount: Number(row.amount || 0),
  status: row.status,
  description: row.description,
  items: parseJson(row.items_json, []),
  dueAt: row.due_at,
  paidAt: row.paid_at,
  createdAt: row.created_at,
});

exports.overview = async (req, res, next) => {
  try {
    const users = await get(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active,
        SUM(CASE WHEN role = 'admin' THEN 1 ELSE 0 END) AS admins
      FROM users
    `);

    const servers = await get(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) AS running,
        SUM(CASE WHEN status = 'suspended' THEN 1 ELSE 0 END) AS suspended
      FROM server_instances
    `);

    const revenue = await get(`
      SELECT COALESCE(SUM(CASE WHEN server_instances.monthly_price > 0 THEN server_instances.monthly_price ELSE plans.monthly_price END), 0) AS monthly
      FROM server_instances
      JOIN plans ON plans.id = server_instances.plan_id
      WHERE server_instances.status IN ('running', 'provisioning')
    `);

    const support = await get(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN status = 'new' THEN 1 ELSE 0 END) AS new_count,
        SUM(CASE WHEN status = 'read' THEN 1 ELSE 0 END) AS read_count,
        SUM(CASE WHEN status = 'closed' THEN 1 ELSE 0 END) AS closed_count
      FROM support_requests
    `);

    const invoices = await get(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END) AS open_count,
        SUM(CASE WHEN status = 'paid' THEN 1 ELSE 0 END) AS paid_count,
        COALESCE(SUM(CASE WHEN status = 'open' THEN amount ELSE 0 END), 0) AS open_amount,
        COALESCE(SUM(CASE WHEN status = 'paid' THEN amount ELSE 0 END), 0) AS paid_amount
      FROM invoices
    `);

    const recentUsers = await all(
      `SELECT * FROM users ORDER BY datetime(created_at) DESC LIMIT 8`,
    );

    const recentServers = await all(`
      SELECT server_instances.*, plans.name AS plan_name, plans.monthly_price AS plan_monthly_price, plans.specs_json AS plan_specs_json,
             users.email AS owner_email, users.username AS owner_username
      FROM server_instances
      JOIN plans ON plans.id = server_instances.plan_id
      LEFT JOIN users ON users.id = server_instances.user_id
      ORDER BY datetime(server_instances.created_at) DESC
      LIMIT 8
    `);

    const topRegions = await all(`
      SELECT region, COUNT(*) AS total
      FROM server_instances
      GROUP BY region
      ORDER BY total DESC
      LIMIT 8
    `);

    const osDistribution = await all(`
      SELECT os, COUNT(*) AS total
      FROM server_instances
      GROUP BY os
      ORDER BY total DESC
      LIMIT 8
    `);

    res.status(200).json({
      status: 'success',
      data: {
        metrics: {
          totalUsers: Number(users.total || 0),
          activeUsers: Number(users.active || 0),
          adminUsers: Number(users.admins || 0),
          activeServers: Number(servers.running || 0),
          totalServers: Number(servers.total || 0),
          suspendedServers: Number(servers.suspended || 0),
          monthlyRevenue: Number(revenue.monthly || 0),
          openTickets: Number(support.new_count || 0),
          totalTickets: Number(support.total || 0),
          closedTickets: Number(support.closed_count || 0),
          openInvoices: Number(invoices.open_count || 0),
          paidInvoices: Number(invoices.paid_count || 0),
          openInvoiceAmount: Number(invoices.open_amount || 0),
          paidInvoiceAmount: Number(invoices.paid_amount || 0),
          systemHealth: '99.99%',
        },
        recentUsers: recentUsers.map((user) => ({
          ...publicUser(user),
          joined: relativeTime(user.created_at),
        })),
        recentServers: recentServers.map(mapAdminServer),
        topRegions: topRegions.map((row) => ({ region: row.region || 'Unknown', total: Number(row.total || 0) })),
        osDistribution: osDistribution.map((row) => ({ os: row.os || 'Unknown', total: Number(row.total || 0) })),
      },
    });
  } catch (err) {
    next(err);
  }
};

exports.users = async (req, res, next) => {
  try {
    const rows = await all('SELECT * FROM users ORDER BY datetime(created_at) DESC LIMIT 100');
    res.status(200).json({
      status: 'success',
      data: {
        users: rows.map(publicUser),
      },
    });
  } catch (err) {
    next(err);
  }
};

exports.servers = async (req, res, next) => {
  try {
    const rows = await all(`
      SELECT server_instances.*, plans.name AS plan_name, plans.monthly_price AS plan_monthly_price, plans.specs_json AS plan_specs_json,
             users.email AS owner_email, users.username AS owner_username
      FROM server_instances
      JOIN plans ON plans.id = server_instances.plan_id
      LEFT JOIN users ON users.id = server_instances.user_id
      ORDER BY datetime(server_instances.created_at) DESC
      LIMIT 300
    `);

    res.status(200).json({
      status: 'success',
      data: {
        servers: rows.map(mapAdminServer),
      },
    });
  } catch (err) {
    next(err);
  }
};

exports.updateServerStatus = async (req, res, next) => {
  try {
    const requestedStatus = String(req.body.status || '').trim();
    const allowedStatuses = ['running', 'stopped', 'suspended', 'terminated', 'provisioning'];
    if (!allowedStatuses.includes(requestedStatus)) {
      return res.status(400).json({ status: 'fail', message: 'Invalid server status.' });
    }

    const result = await run(
      `UPDATE server_instances
       SET status = ?, cpu_usage = CASE WHEN ? = 'running' THEN MAX(cpu_usage, 8) ELSE 0 END, updated_at = ?
       WHERE id = ?`,
      [requestedStatus, requestedStatus, now(), req.params.id],
    );

    if (!result.changes) {
      return res.status(404).json({ status: 'fail', message: 'Server not found.' });
    }

    await run(
      'INSERT INTO audit_logs (id, actor_id, action, target, ip_address, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [
        createId('aud'),
        req.user.id,
        'admin.server.status',
        req.params.id,
        req.ip,
        JSON.stringify({ status: requestedStatus }),
        now(),
      ],
    );

    const server = await get(
      `SELECT server_instances.*, plans.name AS plan_name, plans.monthly_price AS plan_monthly_price, plans.specs_json AS plan_specs_json,
              users.email AS owner_email, users.username AS owner_username
       FROM server_instances
       JOIN plans ON plans.id = server_instances.plan_id
       LEFT JOIN users ON users.id = server_instances.user_id
       WHERE server_instances.id = ?`,
      [req.params.id],
    );

    res.status(200).json({ status: 'success', data: { server: mapAdminServer(server) } });
  } catch (err) {
    next(err);
  }
};

exports.invoices = async (req, res, next) => {
  try {
    const rows = await all(`
      SELECT invoices.*, users.email AS owner_email, users.username AS owner_username
      FROM invoices
      LEFT JOIN users ON users.id = invoices.user_id
      ORDER BY datetime(invoices.created_at) DESC
      LIMIT 300
    `);

    res.status(200).json({
      status: 'success',
      data: {
        invoices: rows.map(mapInvoice),
      },
    });
  } catch (err) {
    next(err);
  }
};

exports.updateInvoiceStatus = async (req, res, next) => {
  try {
    const status = String(req.body.status || '').trim();
    const allowedStatuses = ['open', 'paid', 'void', 'failed'];
    if (!allowedStatuses.includes(status)) {
      return res.status(400).json({ status: 'fail', message: 'Invalid invoice status.' });
    }

    const paidAt = status === 'paid' ? now() : null;
    const result = await run('UPDATE invoices SET status = ?, paid_at = ? WHERE id = ?', [
      status,
      paidAt,
      req.params.id,
    ]);

    if (!result.changes) {
      return res.status(404).json({ status: 'fail', message: 'Invoice not found.' });
    }

    await run(
      'INSERT INTO audit_logs (id, actor_id, action, target, ip_address, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [createId('aud'), req.user.id, 'admin.invoice.status', req.params.id, req.ip, JSON.stringify({ status }), now()],
    );

    const invoice = await get(
      `SELECT invoices.*, users.email AS owner_email, users.username AS owner_username
       FROM invoices
       LEFT JOIN users ON users.id = invoices.user_id
       WHERE invoices.id = ?`,
      [req.params.id],
    );

    res.status(200).json({ status: 'success', data: { invoice: mapInvoice(invoice) } });
  } catch (err) {
    next(err);
  }
};

exports.updateUserStatus = async (req, res, next) => {
  try {
    const { status } = req.body;
    const allowedStatuses = ['active', 'suspended', 'banned'];
    if (!allowedStatuses.includes(status)) {
      return res.status(400).json({ status: 'fail', message: 'Invalid user status.' });
    }

    if (req.params.id === req.user.id && status !== 'active') {
      return res.status(400).json({ status: 'fail', message: 'Admin cannot disable own account.' });
    }

    const result = await run('UPDATE users SET status = ?, updated_at = ? WHERE id = ?', [
      status,
      now(),
      req.params.id,
    ]);

    if (!result.changes) {
      return res.status(404).json({ status: 'fail', message: 'User not found.' });
    }

    await run(
      'INSERT INTO audit_logs (id, actor_id, action, target, ip_address, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [
        createId('aud'),
        req.user.id,
        'admin.user_status.update',
        req.params.id,
        req.ip,
        JSON.stringify({ status }),
        now(),
      ],
    );

    const user = await get('SELECT * FROM users WHERE id = ?', [req.params.id]);
    res.status(200).json({ status: 'success', data: { user: publicUser(user) } });
  } catch (err) {
    next(err);
  }
};

exports.auditLogs = async (req, res, next) => {
  try {
    const rows = await all(`
      SELECT audit_logs.*, users.email AS actor_email, users.username AS actor_username
      FROM audit_logs
      LEFT JOIN users ON users.id = audit_logs.actor_id
      ORDER BY datetime(audit_logs.created_at) DESC
      LIMIT 200
    `);
    res.status(200).json({
      status: 'success',
      data: {
        logs: rows.map((row) => ({
          ...row,
          metadata: parseJson(row.metadata_json, {}),
          actor: row.actor_id ? {
            id: row.actor_id,
            email: row.actor_email,
            username: row.actor_username,
          } : null,
        })),
      },
    });
  } catch (err) {
    next(err);
  }
};

exports.supportRequests = async (req, res, next) => {
  try {
    const rows = await all(`
      SELECT support_requests.*, users.email AS user_email, users.username AS username
      FROM support_requests
      LEFT JOIN users ON users.id = support_requests.user_id
      ORDER BY datetime(support_requests.created_at) DESC
      LIMIT 100
    `);

    res.status(200).json({
      status: 'success',
      data: {
        requests: rows.map((row) => ({
          id: row.id,
          userId: row.user_id,
          userEmail: row.user_email,
          username: row.username,
          subject: row.subject || 'Support request',
          priority: row.priority || 'normal',
          category: row.category || 'support',
          message: row.message,
          transcript: parseJson(row.transcript_json, []),
          emailTo: row.email_to,
          emailSent: Boolean(row.email_sent),
          status: row.status,
          ipAddress: row.ip_address,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        })),
      },
    });
  } catch (err) {
    next(err);
  }
};

exports.updateSupportRequest = async (req, res, next) => {
  try {
    const { status } = req.body;
    const allowedStatuses = ['new', 'read', 'closed'];
    if (!allowedStatuses.includes(status)) {
      return res.status(400).json({ status: 'fail', message: 'Invalid support request status.' });
    }

    const result = await run('UPDATE support_requests SET status = ?, updated_at = ? WHERE id = ?', [
      status,
      now(),
      req.params.id,
    ]);

    if (!result.changes) {
      return res.status(404).json({ status: 'fail', message: 'Support request not found.' });
    }

    await run(
      'INSERT INTO audit_logs (id, actor_id, action, target, ip_address, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [createId('aud'), req.user.id, 'admin.support.status', req.params.id, req.ip, JSON.stringify({ status }), now()],
    );

    res.status(200).json({ status: 'success', data: { id: req.params.id, status } });
  } catch (err) {
    next(err);
  }
};

exports.replySupportRequest = async (req, res, next) => {
  try {
    const text = String(req.body.message || req.body.text || '').trim().slice(0, 4000);
    if (!text) {
      return res.status(400).json({ status: 'fail', message: 'Message is required.' });
    }

    const row = await get('SELECT * FROM support_requests WHERE id = ?', [req.params.id]);
    if (!row) {
      return res.status(404).json({ status: 'fail', message: 'Support request not found.' });
    }

    const transcript = parseJson(row.transcript_json, []);
    transcript.push({
      sender: 'admin',
      author: req.user.username || 'Admin',
      adminId: req.user.id,
      text,
      timestamp: now(),
    });

    await run(
      `UPDATE support_requests
       SET transcript_json = ?, status = 'read', assigned_admin_id = ?, updated_at = ?
       WHERE id = ?`,
      [JSON.stringify(transcript), req.user.id, now(), req.params.id],
    );

    await run(
      'INSERT INTO audit_logs (id, actor_id, action, target, ip_address, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [createId('aud'), req.user.id, 'admin.support.reply', req.params.id, req.ip, JSON.stringify({ text: text.slice(0, 180) }), now()],
    );

    const updated = await get('SELECT * FROM support_requests WHERE id = ?', [req.params.id]);
    res.status(200).json({
      status: 'success',
      data: {
        request: {
          id: updated.id,
          subject: updated.subject || 'Support request',
          message: updated.message,
          transcript: parseJson(updated.transcript_json, []),
          status: updated.status,
          priority: updated.priority,
          category: updated.category,
          updatedAt: updated.updated_at,
        },
      },
    });
  } catch (err) {
    next(err);
  }
};

exports.deleteSupportRequest = async (req, res, next) => {
  try {
    const result = await run('DELETE FROM support_requests WHERE id = ?', [req.params.id]);
    if (!result.changes) {
      return res.status(404).json({ status: 'fail', message: 'Support request not found.' });
    }

    await run(
      'INSERT INTO audit_logs (id, actor_id, action, target, ip_address, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [createId('aud'), req.user.id, 'admin.support.delete', req.params.id, req.ip, '{}', now()],
    );

    res.status(200).json({ status: 'success', data: { id: req.params.id } });
  } catch (err) {
    next(err);
  }
};
