const nodemailer = require('nodemailer');
const validator = require('validator');
const { all, createId, get, now, run } = require('../config/database');

const GEMINI_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';
const DEFAULT_MODEL = 'gemini-3-flash-preview';
const MEMORY_TTL_MS = 12 * 60 * 60 * 1000;
const MAX_MEMORY_MESSAGES = 120;
const MAX_CLIENT_HISTORY = 80;
const MAX_MODEL_HISTORY = 60;

const OUT_OF_SCOPE_REPLY = 'Bu chat yalniz DreamHost server, hosting, plan, deploy, billing ve hesab desteyi ucundur.';
const NEED_MORE_DETAIL_REPLY = 'Zehmet olmasa DreamHost plan, server, deploy, billing, login ve ya support movzusunu konkret yazin.';
const chatMemory = new Map();
let lastMemorySweep = 0;

const systemInstruction = `
You are DreamHost Support for a server hosting sales website.
Answer in the user's language. Azerbaijani is the default.
Use only the catalog provided in the request context for product names, prices, specs and links.
When recommending a product, include a markdown link like [Plan name](/products?category=vps&plan=plan_id#plan_id).
Answer only the asked site-support information. Do not add greetings, marketing text, unrelated details or long explanations.
If the user asks about anything outside DreamHost hosting, server plans, deploy, billing, login, dashboard, security or support, refuse with this exact sentence: "${OUT_OF_SCOPE_REPLY}"
Never ask for passwords, card data, API keys or private tokens.
Do not claim you changed a real server, payment or account. Risky account/server actions require admin confirmation.
Use the previous conversation messages as memory. If the current message is a follow-up, connect it to earlier user details instead of restarting.
For long conversations, keep the same context, ask only the missing technical details, and continue naturally.
`;

const safeText = (value, limit = 8000) =>
  String(value || '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .trim()
    .slice(0, limit);

const normalize = (value) =>
  safeText(value, 2000)
    .toLowerCase()
    .replace(/[\u0259\u04d9]/g, 'e')
    .replace(/[\u0131\u0130]/g, 'i')
    .replace(/[\u015f]/g, 's')
    .replace(/[\u00e7]/g, 'c')
    .replace(/[\u00f6]/g, 'o')
    .replace(/[\u00fc]/g, 'u')
    .replace(/[\u011f]/g, 'g')
    .replace(/\s+/g, ' ');

const parseJson = (value, fallback) => {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
};

const sanitizeConversationId = (value) => {
  const cleanId = safeText(value, 120).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80);
  return cleanId || createId('chat');
};

const normalizeSender = (sender) => {
  if (sender === 'bot' || sender === 'model' || sender === 'admin') return 'bot';
  return 'user';
};

const normalizePlainHistory = (history = [], limit = MAX_CLIENT_HISTORY) => {
  if (!Array.isArray(history)) return [];

  return history
    .slice(-limit)
    .filter((item) => item && typeof item.text === 'string' && item.text.trim())
    .map((item) => ({
      sender: normalizeSender(item.sender),
      text: safeText(item.text, 4000),
      timestamp: safeText(item.timestamp, 40),
    }));
};

const compactHistory = (items = []) => {
  const compacted = [];

  for (const item of items) {
    if (!item?.text) continue;
    const current = {
      sender: normalizeSender(item.sender),
      text: safeText(item.text, 4000),
      timestamp: safeText(item.timestamp, 40),
    };
    const previous = compacted[compacted.length - 1];

    if (previous && previous.sender === current.sender && normalize(previous.text) === normalize(current.text)) {
      continue;
    }

    compacted.push(current);
  }

  return compacted.slice(-MAX_MEMORY_MESSAGES);
};

const pruneMemory = () => {
  const currentTime = Date.now();
  if (currentTime - lastMemorySweep < 10 * 60 * 1000) return;
  lastMemorySweep = currentTime;

  for (const [conversationId, entry] of chatMemory.entries()) {
    if (currentTime - entry.lastSeen > MEMORY_TTL_MS) {
      chatMemory.delete(conversationId);
    }
  }
};

const getConversationMemory = (conversationId) => {
  pruneMemory();
  const existing = chatMemory.get(conversationId);
  if (existing) {
    existing.lastSeen = Date.now();
    return existing;
  }

  const created = { messages: [], lastSeen: Date.now() };
  chatMemory.set(conversationId, created);
  return created;
};

const mergeMemoryHistory = (conversationId, clientHistory) => {
  const memory = getConversationMemory(conversationId);
  memory.messages = compactHistory([...memory.messages, ...clientHistory]);
  return memory.messages;
};

const rememberTurn = (conversationId, history, userText, botText, model) => {
  const memory = getConversationMemory(conversationId);
  memory.messages = compactHistory([
    ...history,
    { sender: 'user', text: userText },
    { sender: 'bot', text: botText, model },
  ]);
  memory.lastSeen = Date.now();
  return memory.messages;
};

const historyText = (history = [], limit = 20) =>
  history
    .slice(-limit)
    .map((item) => `${item.sender === 'user' ? 'User' : 'Support'}: ${safeText(item.text, 700)}`)
    .join('\n');

const getCategory = (plan) => {
  if (plan.id.startsWith('plan_storage')) return 'storage';
  return plan.type;
};

const planLink = (plan) => {
  const category = getCategory(plan);
  return `/products?category=${category}&plan=${encodeURIComponent(plan.id)}#${encodeURIComponent(plan.id)}`;
};

const normalizePlan = (row) => ({
  id: row.id,
  name: row.name,
  type: row.type,
  category: getCategory(row),
  price: Number(row.monthly_price || 0),
  specs: parseJson(row.specs_json, {}),
  features: parseJson(row.features_json, []),
  isPopular: Boolean(row.is_popular),
  link: planLink(row),
});

const loadPlans = async () => {
  const rows = await all(
    `SELECT id, name, type, monthly_price, specs_json, features_json, is_popular
     FROM plans
     WHERE is_active = 1
     ORDER BY monthly_price ASC, name ASC`,
  );

  return rows.map(normalizePlan);
};

const specsText = (plan) =>
  Object.values(plan.specs)
    .filter(Boolean)
    .slice(0, 5)
    .join(', ');

const planLine = (plan) =>
  `[${plan.name}](${plan.link}) - $${plan.price.toFixed(2)}/ay. ${specsText(plan)}.`;

const catalogText = (plans) =>
  plans
    .map((plan) => `${plan.name} | ${plan.category} | $${plan.price.toFixed(2)}/ay | ${specsText(plan)} | ${plan.link}`)
    .join('\n');

const hasAny = (text, keywords) => keywords.some((keyword) => text.includes(keyword));

const hashText = (value) => {
  let hash = 0;
  const text = String(value || '');
  for (let i = 0; i < text.length; i += 1) {
    hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
};

const chooseVariant = (seed, variants) => variants[hashText(`${seed}:${Date.now()}`) % variants.length];

const buildReply = (type, seed, lines) => {
  const leads = {
    discord: [
      'Discord botlari ucun duzgun istiqamet VPS-dir.',
      'Bu istifade ucun server secimini VPS-den baslamaq daha dogrudur.',
      'Botlari 24/7 stabil saxlamaq ucun VPS planlari uygundur.',
    ],
    website: [
      'Website-i public etmek ucun en rahat yol VPS planidir.',
      'Sayti yayinlamaq ucun evvelce workload-a uygun VPS secmek lazimdir.',
      'Website ucun server secimini trafik ve backend yukune gore edirik.',
    ],
    general: [
      'Melumata gore size en uygun istiqameti bele secmek olar.',
      'Server secimini istifade senarisine gore quraq.',
      'Bu halda en risksiz secim workload-a uygun VPS-den baslamaqdir.',
    ],
    help: [
      'Basa dusdum, DreamHost server desteyi uzre komek edirem.',
      'Komek ederem, server ve hosting movzusunda sualinizi deqiqlestirek.',
      'Buradayam, plan, deploy, billing ve hesab desteyi ucun yaza bilersiniz.',
    ],
    price: [
      'Hazirki kataloqa gore secimler bunlardir.',
      'Qiymet ve plan melumati bele gorunur.',
      'Bu movzu ucun uygun planlari asagida verdim.',
    ],
  };

  return [chooseVariant(seed || `${type}:${lines.join('|')}`, leads[type] || leads.general), ...lines]
    .filter(Boolean)
    .join('\n');
};

const hostingActionKeywords = [
  'server', 'hosting', 'host', 'vps', 'deploy', 'push', 'public', 'online', 'yukle',
  'yuklemek', 'qaldir', 'qaldirmaq', 'run', 'isletmek', 'saxlamaq', 'lazim',
  'lazimdir', 'tovsiye', 'meslehet', 'publish', 'yayinla',
];

const supportKeywords = [
  'dreamhost', 'site', 'sayt', 'server', 'hosting', 'host', 'vps', 'dedicated', 'bare metal',
  'cloud', 'gaming', 'game server', 'network', 'ddos', 'cdn', 'ip', 'storage', 'backup',
  'bot', 'bots', 'discord bot', 'telegram bot',
  'deploy', 'push', 'public', 'online', 'yukle', 'yuklemek', 'qaldir', 'qaldirmaq',
  'web', 'website', 'publish', 'yayinla', 'plan', 'paket', 'qiymet', 'price', 'ucuz',
  'bahali', 'login', 'giris', 'register', 'qeydiyyat', 'dashboard', 'admin', 'billing',
  'payment', 'odenis', 'odeme', 'refund', 'iade', 'sla', 'support', 'ticket', 'domain',
  'dns', 'ssl', 'email', 'mail', 'smtp', 'ftp', 'sftp', 'api', 'ram', 'cpu', 'nvme',
  'ssd', 'hdd', 'bandwidth', 'traffic', 'region', 'windows', 'ubuntu', 'debian', 'centos',
  'console', 'ssh', 'database', 'firewall', 'vpn', 'load balancer', 'balancer', 'uptime',
  'provision', 'instance', 'node', 'control panel', 'hesab', 'sifre', 'parol', 'mehsul',
  'kateqoriya', 'almaq', 'satinal', 'satin al', 'xidmet',
];

const greetingOrHelpPatterns = [
  /^salam\b/,
  /^hello\b/,
  /^hi\b/,
  /^hey\b/,
  /\bkomek\b/,
  /\byardim\b/,
  /\bhelp\b/,
  /\bdestek\b/,
  /ne ede bilersen/,
];

const isDiscordBotHostingQuery = (message) => {
  const lower = normalize(message);
  return lower.includes('discord') && lower.includes('bot') && hasAny(lower, hostingActionKeywords);
};

const isWebsiteHostingQuery = (message) => {
  const lower = normalize(message);
  const webIntent = lower.includes('web') || lower.includes('website') || lower.includes('sayt') || lower.includes('site');
  return webIntent && hasAny(lower, hostingActionKeywords);
};

const isGeneralServerRecommendationQuery = (message) => {
  const lower = normalize(message);
  return lower.includes('server') && hasAny(lower, ['lazim', 'lazimdir', 'tovsiye', 'meslehet', 'ne goturum', 'hansi']);
};

const isSupportScope = (message) => {
  const lower = normalize(message);
  if (!lower) return false;
  if (greetingOrHelpPatterns.some((pattern) => pattern.test(lower))) return true;
  if (isDiscordBotHostingQuery(message) || isWebsiteHostingQuery(message) || isGeneralServerRecommendationQuery(message)) return true;
  return supportKeywords.some((keyword) => lower.includes(keyword));
};

const isGenericSupportPrompt = (message) => {
  const lower = normalize(message);
  return greetingOrHelpPatterns.some((pattern) => pattern.test(lower));
};

const isContextualFollowUp = (message) => {
  const lower = normalize(message);
  if (!lower || lower.length > 220) return false;

  return hasAny(lower, [
    'bu', 'bunu', 'buna', 'bele', 'bes', 'bəs', 'onda', 'onu', 'orada', 'indi',
    'hansi', 'nece', 'ne qeder', 'qiymeti', 'olarmi', 'uygundur', 'yaxsi',
    'daha', 'elave', 'mende', 'var', 'yoxdur', 'cpu', 'ram', 'gb', 'user',
    'trafik', 'database', 'db', 'node', 'python', 'php', 'laravel', 'react',
    'bot', 'bots', 'guild', 'voice', 'music',
  ]);
};

const categoryFromMessage = (message) => {
  const lower = normalize(message);
  if (lower.includes('vps')) return 'vps';
  if (lower.includes('dedicated') || lower.includes('bare') || lower.includes('fiziki')) return 'dedicated';
  if (lower.includes('cloud')) return 'cloud';
  if (lower.includes('game') || lower.includes('gaming') || lower.includes('oyun')) return 'gaming';
  if (lower.includes('network') || lower.includes('ddos') || lower.includes('cdn') || lower.includes('ip ')) return 'network';
  if (lower.includes('storage') || lower.includes('backup') || lower.includes('yedek')) return 'storage';
  return null;
};

const isCheapestQuery = (message) => {
  const lower = normalize(message);
  return lower.includes('en ucuz') || lower.includes('ucuz') || lower.includes('cheapest') || lower.includes('minimum');
};

const isPriceQuery = (message) => {
  const lower = normalize(message);
  return lower.includes('qiymet') || lower.includes('price') || lower.includes('plan') || lower.includes('paket');
};

const planById = (plans, id) => plans.find((plan) => plan.id === id);

const discordBotReply = (plans, seed = '') => {
  const nano = planById(plans, 'plan_vps_nano') || plans.find((plan) => plan.category === 'vps') || plans[0];
  const dev = planById(plans, 'plan_vps_dev') || nano;
  const growth = planById(plans, 'plan_vps_growth') || dev;

  return buildReply('discord', seed, [
    `Baslangic ucun ${planLine(nano)}`,
    `Bir nece bot, database, queue, dashboard ve ya daha cox guild istifadesi varsa ${planLine(dev)} daha rahat secimdir.`,
    `Botlar cox aktivdirse ve RAM/CPU yuklenmesi gozlenilirse ${planLine(growth)} secmek daha dogru olar.`,
    'Deqiq plan secmek ucun yazin: bot sayi, bot dili Node.js/Python hansidir, database varmi, nece guild/user var, voice/music funksiyasi varmi, 24/7 uptime ve budget ne qederdir.',
  ]);
};

const websiteHostingReply = (plans, seed = '') => {
  const nano = planById(plans, 'plan_vps_nano') || plans.find((plan) => plan.category === 'vps') || plans[0];
  const dev = planById(plans, 'plan_vps_dev') || nano;
  const growth = planById(plans, 'plan_vps_growth') || dev;

  return buildReply('website', seed, [
    `Kicik landing page, portfolio ve sade sayt ucun ${planLine(nano)}`,
    `Biz website ucun ilkin olaraq ${planLine(dev)} tovsiye edirik; CPU/RAM ehtiyati daha rahatdir, API ve database ile daha stabil isleyir.`,
    `Trafik artirsa, e-commerce/API yuklenmesi varsa ${planLine(growth)} daha uygundur.`,
    'Deqiq server gucunu secmek ucun sayt haqqinda bunlari yazin: sayt tipi, gunluk/ayliq ziyaretci, istifade olunan stack, database varmi, fayl/storage hecmi, region ve budget.',
  ]);
};

const generalServerReply = (plans, seed = '') => {
  const nano = planById(plans, 'plan_vps_nano') || plans.find((plan) => plan.category === 'vps') || plans[0];
  const dev = planById(plans, 'plan_vps_dev') || nano;

  return buildReply('general', seed, [
    `Baslangic server ucun ${planLine(nano)}`,
    `Production website, Discord bot, API ve database birlikde olacaqsa ${planLine(dev)} daha rahat secimdir.`,
    'Deqiq plan ucun ne isledeceyinizi yazin: website/API/bot, trafik ve ya user sayi, database, RAM ehtiyaci, region ve budget.',
  ]);
};

const parseCountNear = (text, label) => {
  const match = normalize(text).match(new RegExp(`(\\d+)\\s*(?:eded\\s*)?${label}`));
  return match ? Number(match[1]) : 0;
};

const memoryAwareBotReply = (message, history, plans) => {
  const combined = `${historyText(history, 20)}\nUser: ${message}`;
  const lower = normalize(combined);
  const botCount = parseCountNear(combined, 'bot');
  const hasDatabase = hasAny(lower, ['database', 'sqlite', 'mysql', 'postgres', 'mongodb', 'redis', 'db']);
  const hasVoice = hasAny(lower, ['voice', 'music', 'səs', 'ses', 'audio']);

  const nano = planById(plans, 'plan_vps_nano') || plans.find((plan) => plan.category === 'vps') || plans[0];
  const micro = planById(plans, 'plan_vps_micro') || nano;
  const dev = planById(plans, 'plan_vps_dev') || micro;
  const growth = planById(plans, 'plan_vps_growth') || dev;

  let recommended = nano;
  if (botCount >= 3 || hasDatabase) recommended = micro;
  if (botCount >= 5 || (hasDatabase && botCount >= 3)) recommended = dev;
  if (botCount >= 10 || hasVoice) recommended = growth;

  return buildReply('discord', `memory-bot:${message}:${history.length}`, [
    'Evvelki sohbeti yadda saxladim: Discord botlarinizi servere yuklemek isteyirsiniz.',
    botCount ? `${botCount} bot ucun ${planLine(recommended)} tovsiye edirem.` : `Bu is ucun ${planLine(recommended)} tovsiye edirem.`,
    hasDatabase ? 'Database istifade etdiyiniz ucun RAM ve disk ehtiyati olan plan secmek daha stabildir.' : '',
    'Daha deqiq secim ucun guild/user sayi, 24/7 trafik, voice/music funksiyasi ve aylıq budget yazin.',
  ].filter(Boolean));
};

const memoryAwareWebsiteReply = (message, history, plans) => {
  const combined = `${historyText(history, 20)}\nUser: ${message}`;
  const lower = normalize(combined);
  const hasDatabase = hasAny(lower, ['database', 'mysql', 'postgres', 'mongodb', 'redis', 'db']);
  const hasShop = hasAny(lower, ['shop', 'magaza', 'ecommerce', 'payment', 'odenis']);
  const hasApi = hasAny(lower, ['api', 'backend', 'node', 'laravel', 'django']);

  const nano = planById(plans, 'plan_vps_nano') || plans.find((plan) => plan.category === 'vps') || plans[0];
  const dev = planById(plans, 'plan_vps_dev') || nano;
  const growth = planById(plans, 'plan_vps_growth') || dev;
  const recommended = hasShop || hasApi || hasDatabase ? dev : nano;
  const scalePlan = hasShop || hasApi || hasDatabase ? growth : dev;

  return buildReply('website', `memory-web:${message}:${history.length}`, [
    'Evvelki sohbeti yadda saxladim: website-i public etmek ucun server axtarirsiniz.',
    `Hazirki melumata gore ${planLine(recommended)} tovsiye edirem.`,
    `Trafik ve ya backend/database yuklenmesi artarsa ${planLine(scalePlan)} daha rahat olar.`,
    'Daha deqiq secim ucun sayt tipi, stack, ziyaretci sayi, database ve budget yazin.',
  ]);
};

const memoryFallbackReply = (message, plans, history, topic = 'general') => {
  const combinedContext = `${historyText(history, 20)}\nUser: ${message}`;
  if (isDiscordBotHostingQuery(combinedContext)) return memoryAwareBotReply(message, history, plans);
  if (isWebsiteHostingQuery(combinedContext)) return memoryAwareWebsiteReply(message, history, plans);
  if (isGeneralServerRecommendationQuery(combinedContext)) return generalServerReply(plans, `memory-general:${message}:${history.length}`);
  return genericMemoryReply(history, plans, topic);
};

const isIncompleteReply = (reply) => {
  const text = safeText(reply, 2000);
  if (!text || text.length < 20) return true;
  if (/\[[^\]]+\]\([^)\n]*$/.test(text)) return true;
  if (text.endsWith('/products?category') || text.endsWith('#plan')) return true;
  return false;
};

const genericMemoryReply = (history, plans, topic = 'general') => {
  const context = historyText(history, 12);
  const normalizedTopic = ['vps', 'dedicated', 'cloud', 'gaming', 'network', 'storage'].includes(topic)
    ? topic
    : '';

  if (isDiscordBotHostingQuery(context)) {
    return buildReply('discord', `generic-discord:${history.length}`, [
      'Evvelki mesajlara gore Discord botlariniz ucun server secirik.',
      'Duzgun plan secmek ucun indi bunlari yazin: bot sayi, Node.js/Python, database varmi, serverlerin/guildlerin sayi, voice/music funksiyasi varmi ve budget.',
    ]);
  }

  if (isWebsiteHostingQuery(context)) {
    return buildReply('website', `generic-website:${history.length}`, [
      'Evvelki mesajlara gore website ucun server secirik.',
      'Duzgun plan ucun bunlari yazin: sayt tipi, stack, gunluk/ayliq ziyaretci, database varmi, fayl hecmi, region ve budget.',
    ]);
  }

  if (normalizedTopic) {
    const starter = plans.find((plan) => plan.category === normalizedTopic) || plans[0];
    return buildReply('help', `generic-topic:${normalizedTopic}:${history.length}`, [
      `${normalizedTopic.toUpperCase()} chatindasiniz. Bu mehsul uzre plan, qiymet, deploy, region, OS ve add-on suallarina komek ede bilerem.`,
      starter ? `Bu kateqoriya ucun baslangic numune: ${planLine(starter)}` : '',
      'Daha deqiq cavab ucun ne isledeceyinizi, trafik/user sayini, RAM/CPU ehtiyacini ve budgeti yazin.',
    ].filter(Boolean));
  }

  const starter = planById(plans, 'plan_vps_nano') || plans.find((plan) => plan.category === 'vps') || plans[0];
  return buildReply('help', `generic:${history.length}`, [
    'Duzgun server secmek ucun ne isledeceyinizi yazin: website, Discord bot, oyun serveri, API/database, storage/backup ve ya network xidmeti.',
    starter ? `Baslangic ucun numune plan: ${planLine(starter)}` : '',
  ].filter(Boolean));
};

const localCatalogReply = (message, plans, history = [], topic = 'general') => {
  const lower = normalize(message);
  const combinedContext = `${historyText(history, 16)}\nUser: ${message}`;
  const topicCategory = ['vps', 'dedicated', 'cloud', 'gaming', 'network', 'storage'].includes(topic) ? topic : null;
  const category = categoryFromMessage(message) || topicCategory;
  const serverCategories = ['vps', 'dedicated', 'cloud', 'gaming'];
  const filtered = plans.filter((plan) => {
    if (category) return plan.category === category;
    if (lower.includes('server')) return serverCategories.includes(plan.category);
    return true;
  });

  if (isGenericSupportPrompt(message)) {
    return genericMemoryReply(history, plans, topic);
  }

  if (isDiscordBotHostingQuery(message)) return discordBotReply(plans, `discord:${message}:${history.length}`);
  if (isWebsiteHostingQuery(message)) return websiteHostingReply(plans, `website:${message}:${history.length}`);
  if (isContextualFollowUp(message) && isDiscordBotHostingQuery(combinedContext) && isCheapestQuery(message)) {
    return discordBotReply(plans, `discord-follow:${message}:${history.length}`);
  }
  if (isContextualFollowUp(message) && isWebsiteHostingQuery(combinedContext) && isCheapestQuery(message)) {
    return websiteHostingReply(plans, `website-follow:${message}:${history.length}`);
  }

  if (isCheapestQuery(message) && filtered.length) {
    const label = category || (lower.includes('server') ? 'server' : 'plan');
    return buildReply('price', `cheapest:${message}:${history.length}`, [`En ucuz ${label}: ${planLine(filtered[0])}`]);
  }

  if (isGeneralServerRecommendationQuery(message)) return generalServerReply(plans, `general:${message}:${history.length}`);

  if (isPriceQuery(message) && filtered.length) {
    return buildReply('price', `price:${message}:${history.length}`, filtered.slice(0, 4).map(planLine));
  }

  if (lower.includes('login') || lower.includes('giris')) {
    return 'Login email ve sifre ile isleyir. Admin panele yalniz admin rolu olan hesab daxil ola biler.';
  }

  if (lower.includes('deploy') || lower.includes('server yarat') || lower.includes('qaldir')) {
    const cheapest = plans.find((plan) => plan.category === 'vps') || plans[0];
    return `Deploy ucun plan secin: [Products](/products). Baslamaq ucun uygun numune: ${planLine(cheapest)}`;
  }

  if (lower.includes('admin')) {
    return 'Adminle elaqe ucun chat penceresinin yuxari hissesindeki admin ikonuna basin.';
  }

  return '';
};

const toGeminiHistory = (history = []) =>
  history
    .slice(-MAX_MODEL_HISTORY)
    .filter((item) => item && item.text)
    .map((item) => ({
      role: item.sender === 'user' ? 'user' : 'model',
      parts: [{ text: safeText(item.text, 1000) }],
    }));

const extractGeminiText = (payload) => {
  const parts = payload?.candidates?.[0]?.content?.parts || [];
  return parts.map((part) => part.text).filter(Boolean).join('\n').trim();
};

const callGemini = async ({ apiKey, model, contents, plans }) => {
  const response = await fetch(`${GEMINI_ENDPOINT}/${model}:generateContent`, {
    method: 'POST',
    signal: AbortSignal.timeout(12000),
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKey,
    },
    body: JSON.stringify({
      systemInstruction: {
        parts: [{ text: `${systemInstruction}\nCatalog:\n${catalogText(plans)}` }],
      },
      contents,
      generationConfig: {
        temperature: 0.46,
        topP: 0.9,
        maxOutputTokens: 3072,
      },
    }),
  });

  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    const error = new Error(payload?.error?.message || 'Gemini API request failed.');
    error.statusCode = response.status;
    throw error;
  }

  return extractGeminiText(payload);
};

const smtpConfigured = () => Boolean(process.env.SMTP_HOST && process.env.SMTP_PORT);

const sendAdminMail = async ({ requestId, message, history }) => {
  const to = process.env.SUPPORT_NOTIFY_TO || process.env.ADMIN_EMAIL || 'hsmov09@gmail.com';
  if (!smtpConfigured()) return { sent: false, to };

  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT),
    secure: String(process.env.SMTP_SECURE || '').toLowerCase() === 'true',
    auth: process.env.SMTP_USER
      ? {
          user: process.env.SMTP_USER,
          pass: process.env.SMTP_PASS || '',
        }
      : undefined,
  });

  const transcript = history
    .slice(-12)
    .map((item) => `${item.sender || 'user'}: ${safeText(item.text, 1000)}`)
    .join('\n');

  await transporter.sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER || to,
    to,
    subject: `DreamHost support request ${requestId}`,
    text: `Yeni admin elaqe sorgusu\n\nID: ${requestId}\nMesaj: ${message}\n\nTranscript:\n${transcript || message}`,
  });

  return { sent: true, to };
};

const mapTicket = (row) => ({
  id: row.id,
  userId: row.user_id,
  subject: row.subject || 'Support request',
  priority: row.priority || 'normal',
  category: row.category || 'support',
  message: row.message,
  transcript: parseJson(row.transcript_json, []),
  emailTo: row.email_to,
  emailSent: Boolean(row.email_sent),
  status: row.status,
  ipAddress: row.ip_address,
  userAgent: row.user_agent,
  assignedAdminId: row.assigned_admin_id,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const audit = async (req, action, target, metadata = {}) => {
  try {
    await run(
      'INSERT INTO audit_logs (id, actor_id, action, target, ip_address, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [createId('aud'), req.user?.id || null, action, target, req.ip, JSON.stringify(metadata), now()],
    );
  } catch {
    // Keep support actions resilient even if audit logging fails.
  }
};

exports.listTickets = async (req, res, next) => {
  try {
    const rows = await all(
      `SELECT * FROM support_requests
       WHERE user_id = ?
       ORDER BY datetime(updated_at) DESC, datetime(created_at) DESC`,
      [req.user.id],
    );

    res.status(200).json({ status: 'success', data: { tickets: rows.map(mapTicket) } });
  } catch (err) {
    next(err);
  }
};

exports.createTicket = async (req, res, next) => {
  try {
    const subject = safeText(req.body.subject || 'Support request', 160);
    const message = safeText(req.body.message, 4000);
    const category = safeText(req.body.category || 'support', 40).toLowerCase();
    const priority = ['low', 'normal', 'high', 'urgent'].includes(String(req.body.priority))
      ? String(req.body.priority)
      : 'normal';

    if (!message) {
      return res.status(400).json({ status: 'fail', message: 'Message is required.' });
    }

    const ticketId = createId('tic');
    const transcript = [
      {
        sender: 'user',
        author: req.user.username || req.user.email,
        text: message,
        timestamp: now(),
      },
    ];

    await run(
      `INSERT INTO support_requests
       (id, user_id, subject, priority, category, message, transcript_json, email_to, email_sent, status, ip_address, user_agent, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 'new', ?, ?, ?, ?)`,
      [
        ticketId,
        req.user.id,
        subject,
        priority,
        category,
        message,
        JSON.stringify(transcript),
        process.env.SUPPORT_NOTIFY_TO || process.env.ADMIN_EMAIL || 'hsmov09@gmail.com',
        req.ip,
        safeText(req.get('user-agent'), 500),
        now(),
        now(),
      ],
    );

    const row = await get('SELECT * FROM support_requests WHERE id = ?', [ticketId]);
    await audit(req, 'support.ticket.create', ticketId, { subject, priority, category });
    res.status(201).json({ status: 'success', data: { ticket: mapTicket(row) } });
  } catch (err) {
    next(err);
  }
};

exports.replyTicket = async (req, res, next) => {
  try {
    const text = safeText(req.body.message || req.body.text, 4000);
    if (!text) {
      return res.status(400).json({ status: 'fail', message: 'Message is required.' });
    }

    const row = await get('SELECT * FROM support_requests WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
    if (!row) {
      return res.status(404).json({ status: 'fail', message: 'Ticket not found.' });
    }
    if (row.status === 'closed') {
      return res.status(409).json({ status: 'fail', message: 'Ticket is closed.' });
    }

    const transcript = parseJson(row.transcript_json, []);
    transcript.push({
      sender: 'user',
      author: req.user.username || req.user.email,
      text,
      timestamp: now(),
    });

    await run(
      `UPDATE support_requests
       SET transcript_json = ?, message = ?, status = 'new', updated_at = ?
       WHERE id = ? AND user_id = ?`,
      [JSON.stringify(transcript), text, now(), req.params.id, req.user.id],
    );

    const updated = await get('SELECT * FROM support_requests WHERE id = ?', [req.params.id]);
    await audit(req, 'support.ticket.reply', req.params.id);
    res.status(200).json({ status: 'success', data: { ticket: mapTicket(updated) } });
  } catch (err) {
    next(err);
  }
};

exports.closeTicket = async (req, res, next) => {
  try {
    const result = await run(
      `UPDATE support_requests SET status = 'closed', updated_at = ? WHERE id = ? AND user_id = ?`,
      [now(), req.params.id, req.user.id],
    );
    if (!result.changes) {
      return res.status(404).json({ status: 'fail', message: 'Ticket not found.' });
    }

    await audit(req, 'support.ticket.close', req.params.id);
    const updated = await get('SELECT * FROM support_requests WHERE id = ?', [req.params.id]);
    res.status(200).json({ status: 'success', data: { ticket: mapTicket(updated) } });
  } catch (err) {
    next(err);
  }
};

exports.chat = async (req, res, next) => {
  try {
    const apiKey = process.env.GEMINI_API_KEY;
    const model = process.env.GEMINI_MODEL || DEFAULT_MODEL;
    const fallbackModel = process.env.GEMINI_FALLBACK_MODEL || 'gemini-2.5-flash';
    const message = safeText(req.body.message);
    const conversationId = sanitizeConversationId(req.body.conversationId);
    const topic = safeText(req.body.topic, 40).toLowerCase();
    const clientHistory = normalizePlainHistory(req.body.history, MAX_CLIENT_HISTORY);
    const rememberedHistory = mergeMemoryHistory(conversationId, clientHistory);

    if (!message) {
      return res.status(400).json({ status: 'fail', message: 'Message is required.' });
    }

    if (!validator.isLength(message, { min: 1, max: 8000 })) {
      return res.status(400).json({ status: 'fail', message: 'Message must be under 8000 characters.' });
    }

    const plans = await loadPlans();
    const hasScopedMemory = rememberedHistory.some((item) => isSupportScope(item.text) && !isGenericSupportPrompt(item.text));
    const isScopedMessage = isSupportScope(message) || (hasScopedMemory && isContextualFollowUp(message));

    if (!isScopedMessage) {
      const reply = OUT_OF_SCOPE_REPLY;
      rememberTurn(conversationId, rememberedHistory, message, reply, 'scope-filter');
      return res.status(200).json({
        status: 'success',
        data: {
          reply,
          model: 'scope-filter',
          conversationId,
          memorySize: getConversationMemory(conversationId).messages.length,
        },
      });
    }

    const localReply = localCatalogReply(message, plans, rememberedHistory, topic);

    if (localReply) {
      rememberTurn(conversationId, rememberedHistory, message, localReply, 'catalog-local');
      return res.status(200).json({
        status: 'success',
        data: {
          reply: localReply,
          model: 'catalog-local',
          conversationId,
          memorySize: getConversationMemory(conversationId).messages.length,
        },
      });
    }

    const contents = [
      ...toGeminiHistory(rememberedHistory),
      {
        role: 'user',
        parts: [{ text: message }],
      },
    ];

    if (!apiKey || apiKey.includes('your-google')) {
      const fallbackReply = memoryFallbackReply(message, plans, rememberedHistory, topic) || NEED_MORE_DETAIL_REPLY;
      rememberTurn(conversationId, rememberedHistory, message, fallbackReply, 'local-fallback');
      return res.status(200).json({
        status: 'success',
        data: {
          reply: fallbackReply,
          model: 'local-fallback',
          conversationId,
          memorySize: getConversationMemory(conversationId).messages.length,
        },
      });
    }

    let reply;
    let usedModel = model;
    let warning;

    try {
      reply = await callGemini({ apiKey, model, contents, plans });
    } catch (err) {
      if (err.statusCode === 404 && fallbackModel && fallbackModel !== model) {
        usedModel = fallbackModel;
        try {
          reply = await callGemini({ apiKey, model: fallbackModel, contents, plans });
        } catch (fallbackErr) {
          usedModel = 'local-fallback';
          warning = fallbackErr.message;
          reply = memoryFallbackReply(message, plans, rememberedHistory, topic) || NEED_MORE_DETAIL_REPLY;
        }
      } else {
        usedModel = 'local-fallback';
        warning = err.message;
        reply = memoryFallbackReply(message, plans, rememberedHistory, topic) || NEED_MORE_DETAIL_REPLY;
      }
    }

    let finalReply = reply || NEED_MORE_DETAIL_REPLY;
    if (isIncompleteReply(finalReply)) {
      warning = warning || 'AI reply was incomplete; local memory fallback used.';
      usedModel = `${usedModel}-memory-fallback`;
      finalReply = memoryFallbackReply(message, plans, rememberedHistory, topic) || NEED_MORE_DETAIL_REPLY;
    }
    rememberTurn(conversationId, rememberedHistory, message, finalReply, usedModel);

    res.status(200).json({
      status: 'success',
      data: {
        reply: finalReply,
        model: usedModel,
        warning,
        conversationId,
        memorySize: getConversationMemory(conversationId).messages.length,
      },
    });
  } catch (err) {
    if (err.statusCode === 400 || err.statusCode === 401 || err.statusCode === 403 || err.statusCode === 429) {
      return res.status(err.statusCode).json({
        status: 'fail',
        message: err.message,
      });
    }

    next(err);
  }
};

exports.adminContact = async (req, res, next) => {
  try {
    const conversationId = sanitizeConversationId(req.body.conversationId);
    const message = safeText(req.body.message || 'Admin contact request', 1200);
    const clientHistory = normalizePlainHistory(req.body.history, MAX_CLIENT_HISTORY);
    const rememberedHistory = mergeMemoryHistory(conversationId, clientHistory);
    const history = compactHistory([
      ...rememberedHistory,
      { sender: 'user', text: message },
    ]).slice(-MAX_CLIENT_HISTORY);

    if (!message) {
      return res.status(400).json({ status: 'fail', message: 'Message is required.' });
    }

    const requestId = createId('sup');
    let mail = { sent: false, to: process.env.SUPPORT_NOTIFY_TO || process.env.ADMIN_EMAIL || 'hsmov09@gmail.com' };
    let mailError;

    try {
      mail = await sendAdminMail({ requestId, message, history });
    } catch (err) {
      mailError = err.message;
    }

    await run(
      `INSERT INTO support_requests
       (id, message, transcript_json, email_to, email_sent, status, ip_address, user_agent, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'new', ?, ?, ?, ?)`,
      [
        requestId,
        message,
        JSON.stringify(history),
        mail.to,
        mail.sent ? 1 : 0,
        req.ip,
        safeText(req.get('user-agent'), 500),
        now(),
        now(),
      ],
    );

    rememberTurn(
      conversationId,
      rememberedHistory,
      message,
      mail.sent
        ? 'Admin bildirisi email ile aldi. Sizinle qisa zamanda elaqe saxlayacaq.'
        : 'Admin bildirisi aldi. Sizinle qisa zamanda elaqe saxlayacaq.',
      'admin-contact',
    );

    res.status(200).json({
      status: 'success',
      data: {
        requestId,
        emailSent: mail.sent,
        emailTo: mail.to,
        conversationId,
        warning: mailError,
      },
    });
  } catch (err) {
    next(err);
  }
};
