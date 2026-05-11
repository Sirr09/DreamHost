const bcrypt = require('bcryptjs');
const fs = require('fs');
const path = require('path');

async function seedAdmin() {
  const password = 'dreaMmM003';
  const hashedPassword = await bcrypt.hash(password, 12);
  
  const adminUser = {
    _id: "admin_seed_" + Date.now(),
    username: "dreamh",
    email: "admin@dream.host",
    password: hashedPassword,
    role: "admin",
    createdAt: new Date()
  };

  const dbPath = path.join(__dirname, '../server/data/users.json');
  if (!fs.existsSync(path.dirname(dbPath))) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }

  let users = [];
  if (fs.existsSync(dbPath)) {
    users = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
  }

  // Remove existing dreamh if any
  users = users.filter(u => u.username !== 'dreamh');
  users.push(adminUser);

  fs.writeFileSync(dbPath, JSON.stringify(users, null, 2));
  console.log('Admin user created successfully: dreamh / dreaMmM003');
}

seedAdmin();
