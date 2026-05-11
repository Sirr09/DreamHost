const validator = require('validator');
const { all, createId, get, now, run } = require('../config/database');

const SERVER_ADDONS = [
  { id: 'backups', label: 'Automated Backups', price: 2 },
  { id: 'ipv6', label: 'IPv6 Networking', price: 0 },
  { id: 'snapshots', label: 'Daily Snapshots', price: 3 },
  { id: 'firewall', label: 'Managed Firewall', price: 5 },
  { id: 'floating_ip', label: 'Floating IP', price: 2 },
  { id: 'monitoring', label: 'Monitoring Agent', price: 0 },
];

const parseJson = (value, fallback) => {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
};

const normalizeAddOns = (value) => {
  if (!Array.isArray(value)) return [];
  const selected = new Set(value.map((item) => String(item).trim()));
  return SERVER_ADDONS.filter((addon) => selected.has(addon.id));
};

const audit = async (req, action, target, metadata = {}) => {
  try {
    await run(
      'INSERT INTO audit_logs (id, actor_id, action, target, ip_address, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [createId('aud'), req.user?.id || null, action, target, req.ip, JSON.stringify(metadata), now()],
    );
  } catch {
    // Audit logging should never break a customer action.
  }
};

const mapPlan = (plan) => ({
  id: plan.id,
  name: plan.name,
  type: plan.type,
  price: {
    monthly: Number(plan.monthly_price),
    yearly: Number(plan.yearly_price || 0),
  },
  specs: parseJson(plan.specs_json, {}),
  features: parseJson(plan.features_json, []),
  isPopular: Boolean(plan.is_popular),
  isActive: Boolean(plan.is_active),
  stock: Number(plan.stock),
});

const mapServer = (server) => {
  const customConfig = parseJson(server.custom_config_json, {});
  const planSpecs = parseJson(server.plan_specs_json, {});

  return {
    id: server.id,
    name: server.name,
    type: server.type,
    planId: server.plan_id,
    planName: server.plan_name,
    ip: server.ip_address,
    status: server.status,
    region: server.region,
    os: server.os,
    resources: {
      cpuUsage: Number(server.cpu_usage || 0),
      cpuCores: Number(server.cpu_cores || customConfig.cpuCores || parseSpecNumber(planSpecs.cpu, 0)),
      ramUsage: Number(server.ram_usage || 0),
      ramTotal: Number(server.ram_total || customConfig.ramGb || parseCapacityGb(planSpecs.ram, 0)),
      storageUsed: Number(server.storage_used || 0),
      storageTotal: Number(server.storage_total || customConfig.storageGb || parseCapacityGb(planSpecs.storage, 0)),
      bandwidthTb: Number(server.bandwidth_tb || customConfig.bandwidthTb || parseSpecNumber(planSpecs.bandwidth, 0)),
      networkGbps: Number(server.network_gbps || customConfig.networkGbps || parseSpecNumber(planSpecs.network, 0)),
      storageType: server.storage_type || customConfig.storageType || (String(planSpecs.storage || '').toLowerCase().includes('ssd') ? 'SSD' : 'NVMe'),
    },
    billing: {
      monthly: Number(server.monthly_price || server.plan_monthly_price || 0),
      addOns: parseJson(server.add_ons_json, []),
    },
    customConfig,
    autoRenew: Boolean(server.auto_renew),
    expiresAt: server.expires_at,
    createdAt: server.created_at,
  };
};

const allocateIp = () => {
  const third = Math.floor(Math.random() * 200) + 20;
  const fourth = Math.floor(Math.random() * 220) + 10;
  return `185.242.${third}.${fourth}`;
};

const parseCapacityGb = (value, fallback) => {
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

const parseSpecNumber = (value, fallback = 0) => {
  const match = String(value || '').match(/(\d+(?:\.\d+)?)/);
  return match ? Number(match[1]) : fallback;
};

const resourcesFromPlan = (plan) => {
  const specs = parseJson(plan.specs_json, {});

  return {
    cpuCores: parseSpecNumber(specs.cpu, 1),
    ramTotal: parseCapacityGb(specs.ram, 4),
    storageTotal: parseCapacityGb(specs.storage, 80),
    bandwidthTb: parseSpecNumber(specs.bandwidth, 2),
    networkGbps: parseSpecNumber(specs.network, 1),
    storageType: String(specs.storage || '').toLowerCase().includes('ssd') ? 'SSD' : 'NVMe',
  };
};

const clampNumber = (value, min, max, fallback) => {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, num));
};

const normalizeCustomConfig = (body = {}, planResources = {}) => {
  const cpuCores = Math.round(clampNumber(body.cpuCores ?? body.cpu, 1, 64, planResources.cpuCores || 2));
  const ramGb = Math.round(clampNumber(body.ramGb ?? body.ram, 1, 256, planResources.ramTotal || 4));
  const storageGb = Math.round(clampNumber(body.storageGb ?? body.storage, 20, 4096, planResources.storageTotal || 80));
  const bandwidthTb = Math.round(clampNumber(body.bandwidthTb ?? body.bandwidth, 1, 100, planResources.bandwidthTb || 2));
  const networkGbps = clampNumber(body.networkGbps ?? body.network, 1, 40, planResources.networkGbps || 1);
  const storageTypeRaw = String(body.storageType || planResources.storageType || 'NVMe').toUpperCase();
  const storageType = storageTypeRaw.includes('HDD') ? 'HDD' : storageTypeRaw.includes('SSD') ? 'SSD' : 'NVMe';
  const management = String(body.management || 'self-managed').slice(0, 40);
  const isCustom = Boolean(body.isCustom || planResources.isCustom);

  return {
    cpuCores,
    ramGb,
    storageGb,
    bandwidthTb,
    networkGbps,
    storageType,
    management,
    isCustom,
  };
};

const customMonthlyPrice = (config, addOns = []) => {
  const storageRate = config.storageType === 'HDD' ? 0.035 : config.storageType === 'SSD' ? 0.06 : 0.085;
  const base = 3.49
    + config.cpuCores * 2.15
    + config.ramGb * 0.92
    + config.storageGb * storageRate
    + config.bandwidthTb * 0.32
    + config.networkGbps * 0.75;
  const addons = addOns.reduce((total, addon) => total + addon.price, 0);
  return Number(Math.max(4.99, base + addons).toFixed(2));
};

exports.listPlans = async (req, res, next) => {
  try {
    const rows = await all('SELECT * FROM plans WHERE is_active = 1 ORDER BY monthly_price ASC');
    res.status(200).json({ status: 'success', data: { plans: rows.map(mapPlan) } });
  } catch (err) {
    next(err);
  }
};

exports.listServers = async (req, res, next) => {
  try {
    const rows = await all(
      `SELECT server_instances.*, plans.name AS plan_name
       , plans.monthly_price AS plan_monthly_price, plans.specs_json AS plan_specs_json
       FROM server_instances
       JOIN plans ON plans.id = server_instances.plan_id
       WHERE user_id = ?
       ORDER BY datetime(server_instances.created_at) DESC`,
      [req.user.id],
    );

    res.status(200).json({ status: 'success', data: { servers: rows.map(mapServer) } });
  } catch (err) {
    next(err);
  }
};

exports.createServer = async (req, res, next) => {
  try {
    const requestedCustom = Boolean(req.body.custom || req.body.isCustom || req.body.mode === 'custom');
    const planId = String(req.body.planId || 'plan_vps_nano').trim();
    const name = validator.escape(String(req.body.name || (requestedCustom ? 'Custom Server' : 'Production VPS')).trim()).slice(0, 80);
    const region = validator.escape(String(req.body.region || 'Frankfurt, DE').trim()).slice(0, 80);
    const os = validator.escape(String(req.body.os || 'Ubuntu 24.04 LTS').trim()).slice(0, 80);
    const addOns = normalizeAddOns(req.body.addOns);

    const plan = await get('SELECT * FROM plans WHERE id = ? AND is_active = 1', [planId]);
    if (!plan) {
      return res.status(404).json({ status: 'fail', message: 'Plan not found.' });
    }

    const planResources = resourcesFromPlan(plan);
    const customConfig = requestedCustom
      ? normalizeCustomConfig(req.body.customConfig || req.body, planResources)
      : normalizeCustomConfig(planResources, planResources);
    const monthlyPrice = requestedCustom
      ? customMonthlyPrice(customConfig, addOns)
      : Number(plan.monthly_price || 0) + addOns.reduce((total, addon) => total + addon.price, 0);
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    const serverId = createId('srv');

    await run(
      `INSERT INTO server_instances
       (id, user_id, plan_id, name, type, ip_address, status, region, os, cpu_usage, ram_usage, ram_total, storage_used, storage_total, monthly_price, add_ons_json, custom_config_json, cpu_cores, bandwidth_tb, network_gbps, storage_type, auto_renew, expires_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'running', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
      [
        serverId,
        req.user.id,
        plan.id,
        name,
        requestedCustom ? 'vps' : plan.type,
        allocateIp(),
        region,
        os,
        Math.floor(Math.random() * 22) + 8,
        Math.max(1, Math.round(customConfig.ramGb * 0.28)),
        customConfig.ramGb,
        Math.max(8, Math.round(customConfig.storageGb * 0.18)),
        customConfig.storageGb,
        monthlyPrice,
        JSON.stringify(addOns),
        JSON.stringify({ ...customConfig, isCustom: requestedCustom }),
        customConfig.cpuCores,
        customConfig.bandwidthTb,
        customConfig.networkGbps,
        customConfig.storageType,
        expiresAt,
        now(),
        now(),
      ],
    );

    await run(
      `INSERT INTO invoices (id, user_id, amount, status, description, items_json, due_at, created_at)
       VALUES (?, ?, ?, 'open', ?, ?, ?, ?)`,
      [
        createId('inv'),
        req.user.id,
        monthlyPrice,
        `Monthly subscription for ${name}`,
        JSON.stringify([
          { label: requestedCustom ? 'Custom server base' : plan.name, amount: Number((monthlyPrice - addOns.reduce((total, addon) => total + addon.price, 0)).toFixed(2)) },
          ...addOns.map((addon) => ({ label: addon.label, amount: addon.price })),
        ]),
        expiresAt,
        now(),
      ],
    );

    const server = await get(
      `SELECT server_instances.*, plans.name AS plan_name
       , plans.monthly_price AS plan_monthly_price, plans.specs_json AS plan_specs_json
       FROM server_instances
       JOIN plans ON plans.id = server_instances.plan_id
       WHERE server_instances.id = ?`,
      [serverId],
    );

    await audit(req, 'server.create', serverId, { name, os, region, custom: requestedCustom, monthlyPrice });
    res.status(201).json({ status: 'success', data: { server: mapServer(server) } });
  } catch (err) {
    next(err);
  }
};

exports.updateServer = async (req, res, next) => {
  try {
    const existing = await get('SELECT * FROM server_instances WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
    if (!existing) {
      return res.status(404).json({ status: 'fail', message: 'Server not found.' });
    }

    const addOns = Array.isArray(req.body.addOns) ? normalizeAddOns(req.body.addOns) : parseJson(existing.add_ons_json, []);
    const currentConfig = parseJson(existing.custom_config_json, {});
    const nextConfig = req.body.customConfig
      ? normalizeCustomConfig({ ...currentConfig, ...req.body.customConfig }, currentConfig)
      : currentConfig;
    const monthlyPrice = nextConfig?.isCustom || currentConfig?.isCustom
      ? customMonthlyPrice(nextConfig, addOns)
      : Number(existing.monthly_price || 0);
    const name = req.body.name
      ? validator.escape(String(req.body.name).trim()).slice(0, 80)
      : existing.name;
    const region = req.body.region
      ? validator.escape(String(req.body.region).trim()).slice(0, 80)
      : existing.region;
    const os = req.body.os
      ? validator.escape(String(req.body.os).trim()).slice(0, 80)
      : existing.os;

    await run(
      `UPDATE server_instances
       SET name = ?, region = ?, os = ?, ram_total = ?, storage_total = ?, monthly_price = ?,
           add_ons_json = ?, custom_config_json = ?, cpu_cores = ?, bandwidth_tb = ?,
           network_gbps = ?, storage_type = ?, updated_at = ?
       WHERE id = ? AND user_id = ?`,
      [
        name,
        region,
        os,
        Number(nextConfig.ramGb || existing.ram_total || 0),
        Number(nextConfig.storageGb || existing.storage_total || 0),
        monthlyPrice,
        JSON.stringify(addOns),
        JSON.stringify(nextConfig),
        Number(nextConfig.cpuCores || existing.cpu_cores || 0),
        Number(nextConfig.bandwidthTb || existing.bandwidth_tb || 0),
        Number(nextConfig.networkGbps || existing.network_gbps || 0),
        nextConfig.storageType || existing.storage_type || 'NVMe',
        now(),
        req.params.id,
        req.user.id,
      ],
    );

    const server = await get(
      `SELECT server_instances.*, plans.name AS plan_name, plans.monthly_price AS plan_monthly_price, plans.specs_json AS plan_specs_json
       FROM server_instances
       JOIN plans ON plans.id = server_instances.plan_id
       WHERE server_instances.id = ?`,
      [req.params.id],
    );

    await audit(req, 'server.update', req.params.id, { name, region, os });
    res.status(200).json({ status: 'success', data: { server: mapServer(server) } });
  } catch (err) {
    next(err);
  }
};

exports.deleteServer = async (req, res, next) => {
  try {
    const result = await run('DELETE FROM server_instances WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
    if (!result.changes) {
      return res.status(404).json({ status: 'fail', message: 'Server not found.' });
    }

    await audit(req, 'server.delete', req.params.id);
    res.status(200).json({ status: 'success', data: { id: req.params.id } });
  } catch (err) {
    next(err);
  }
};

exports.updateServerStatus = async (req, res, next) => {
  try {
    const allowedStatuses = ['running', 'stopped', 'suspended', 'terminated'];
    const requestedStatus = String(req.body.status || '').trim();
    if (!allowedStatuses.includes(requestedStatus)) {
      return res.status(400).json({ status: 'fail', message: 'Invalid server status.' });
    }

    const result = await run(
      `UPDATE server_instances
       SET status = ?, cpu_usage = CASE WHEN ? = 'running' THEN cpu_usage ELSE 0 END, updated_at = ?
       WHERE id = ? AND user_id = ?`,
      [requestedStatus, requestedStatus, now(), req.params.id, req.user.id],
    );

    if (!result.changes) {
      return res.status(404).json({ status: 'fail', message: 'Server not found.' });
    }

    const server = await get(
      `SELECT server_instances.*, plans.name AS plan_name
       , plans.monthly_price AS plan_monthly_price, plans.specs_json AS plan_specs_json
       FROM server_instances
       JOIN plans ON plans.id = server_instances.plan_id
       WHERE server_instances.id = ?`,
      [req.params.id],
    );

    await audit(req, 'server.status.update', req.params.id, { status: requestedStatus });
    res.status(200).json({ status: 'success', data: { server: mapServer(server) } });
  } catch (err) {
    next(err);
  }
};

const linuxResponses = (command, server) => ({
  pwd: '/home/dreamhost',
  whoami: 'root',
  hostname: server.name.toLowerCase().replace(/[^a-z0-9-]/g, '-'),
  uptime: ' 12:42:11 up 18 days,  4:13,  1 user,  load average: 0.18, 0.22, 0.19',
  'df -h': `Filesystem      Size  Used Avail Use% Mounted on\n/dev/vda1       ${server.storage_total || 80}G   ${server.storage_used || 12}G   ${Math.max(1, (server.storage_total || 80) - (server.storage_used || 12))}G  18% /`,
  'free -h': `               total        used        free\nMem:           ${server.ram_total || 4}Gi       ${server.ram_usage || 1}Gi       ${Math.max(1, (server.ram_total || 4) - (server.ram_usage || 1))}Gi`,
  'systemctl status nginx': 'nginx.service - A high performance web server\n   Active: active (running)\n   Main PID: 842 (nginx)',
  ls: 'apps  backups  deploy.sh  logs  public_html',
});

const windowsResponses = (command, server) => ({
  hostname: server.name.toUpperCase().replace(/[^A-Z0-9-]/g, '-'),
  whoami: 'dreamhost\\administrator',
  'ipconfig': `Windows IP Configuration\n\nEthernet adapter Ethernet0:\n   IPv4 Address. . . . . . . . . . . : ${server.ip_address}\n   Subnet Mask . . . . . . . . . . . : 255.255.255.0`,
  'dir': ' Directory of C:\\Users\\Administrator\n\n05/11/2026  10:24 AM    <DIR>          Deployments\n05/11/2026  10:24 AM    <DIR>          Logs\n05/11/2026  10:24 AM             1,024 README.txt',
  'Get-Service': 'Status   Name               DisplayName\n------   ----               -----------\nRunning  W3SVC              World Wide Web Publishing Service\nRunning  WinDefend          Microsoft Defender Antivirus',
  'systeminfo': `Host Name: ${server.name}\nOS Name: Microsoft Windows Server\nTotal Physical Memory: ${server.ram_total || 4} GB`,
});

exports.runConsoleCommand = async (req, res, next) => {
  try {
    const server = await get('SELECT * FROM server_instances WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
    if (!server) {
      return res.status(404).json({ status: 'fail', message: 'Server not found.' });
    }

    if (server.status !== 'running') {
      return res.status(409).json({ status: 'fail', message: 'Server must be running before opening console.' });
    }

    const rawCommand = String(req.body.command || '').trim().slice(0, 200);
    if (!rawCommand) {
      return res.status(400).json({ status: 'fail', message: 'Command is required.' });
    }

    const isWindows = String(server.os || '').toLowerCase().includes('windows');
    const commandKey = rawCommand.toLowerCase();
    const responses = isWindows ? windowsResponses(rawCommand, server) : linuxResponses(rawCommand, server);
    const output = responses[commandKey] || responses[rawCommand] || (
      isWindows
        ? `'${rawCommand}' is not recognized as an internal command in this simulated secure console. Try: dir, ipconfig, hostname, whoami, systeminfo, Get-Service.`
        : `bash: ${rawCommand}: command not found. Try: ls, pwd, whoami, uptime, df -h, free -h, systemctl status nginx.`
    );

    await audit(req, 'server.console.command', server.id, { command: rawCommand, os: server.os });
    res.status(200).json({
      status: 'success',
      data: {
        command: rawCommand,
        output,
        prompt: isWindows ? `PS C:\\Users\\Administrator>` : `root@${server.name.toLowerCase().replace(/[^a-z0-9-]/g, '-')}:~#`,
        osType: isWindows ? 'windows' : 'linux',
      },
    });
  } catch (err) {
    next(err);
  }
};

exports.billingSummary = async (req, res, next) => {
  try {
    const rows = await all(
      `SELECT server_instances.*, plans.name AS plan_name, plans.monthly_price AS plan_monthly_price, plans.specs_json AS plan_specs_json
       FROM server_instances
       JOIN plans ON plans.id = server_instances.plan_id
       WHERE server_instances.user_id = ?
       ORDER BY datetime(server_instances.created_at) DESC`,
      [req.user.id],
    );
    const invoices = await all('SELECT * FROM invoices WHERE user_id = ? ORDER BY datetime(created_at) DESC LIMIT 20', [req.user.id]);
    const monthly = rows
      .filter((server) => ['running', 'provisioning', 'stopped'].includes(server.status))
      .reduce((sum, server) => sum + Number(server.monthly_price || server.plan_monthly_price || 0), 0);
    const dueAt = new Date(Date.now() + 1000 * 60 * 60 * 24 * 30).toISOString();

    res.status(200).json({
      status: 'success',
      data: {
        balance: Number(req.user.balance || 0),
        monthlyTotal: Number(monthly.toFixed(2)),
        nextDueAt: dueAt,
        subscriptions: rows.map(mapServer),
        invoices: invoices.map((invoice) => ({
          id: invoice.id,
          amount: Number(invoice.amount || 0),
          status: invoice.status,
          description: invoice.description,
          items: parseJson(invoice.items_json, []),
          dueAt: invoice.due_at,
          paidAt: invoice.paid_at,
          createdAt: invoice.created_at,
        })),
      },
    });
  } catch (err) {
    next(err);
  }
};

exports.addFunds = async (req, res, next) => {
  try {
    const amount = clampNumber(req.body.amount, 1, 10000, 0);
    if (!amount) {
      return res.status(400).json({ status: 'fail', message: 'Invalid amount.' });
    }

    await run('UPDATE users SET balance = balance + ?, updated_at = ? WHERE id = ?', [amount, now(), req.user.id]);
    const user = await get('SELECT * FROM users WHERE id = ?', [req.user.id]);
    await run(
      `INSERT INTO invoices (id, user_id, amount, status, description, items_json, due_at, paid_at, created_at)
       VALUES (?, ?, ?, 'paid', ?, ?, ?, ?, ?)`,
      [
        createId('inv'),
        req.user.id,
        amount,
        'Account funds added',
        JSON.stringify([{ label: 'Account balance top-up', amount }]),
        now(),
        now(),
        now(),
      ],
    );

    await audit(req, 'billing.funds.add', req.user.id, { amount });
    res.status(200).json({ status: 'success', data: { balance: Number(user.balance || 0) } });
  } catch (err) {
    next(err);
  }
};
