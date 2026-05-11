const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, '../data');
if (!fs.existsSync(DB_PATH)) fs.mkdirSync(DB_PATH);

class LocalDB {
  constructor(modelName) {
    this.filePath = path.join(DB_PATH, `${modelName}.json`);
    if (!fs.existsSync(this.filePath)) {
      fs.writeFileSync(this.filePath, JSON.stringify([]));
    }
  }

  async find() {
    const data = fs.readFileSync(this.filePath, 'utf8');
    return JSON.parse(data);
  }

  async findOne(query) {
    const data = await this.find();
    return data.find(item => Object.keys(query).every(key => item[key] === query[key]));
  }

  async findById(id) {
    const data = await this.find();
    return data.find(item => item._id === id);
  }

  async create(item) {
    const data = await this.find();
    const newItem = { ...item, _id: Date.now().toString(), createdAt: new Date() };
    data.push(newItem);
    fs.writeFileSync(this.filePath, JSON.stringify(data, null, 2));
    return newItem;
  }
}

module.exports = LocalDB;
