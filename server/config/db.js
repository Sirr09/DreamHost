const { initDatabase } = require('./database');

const connectDB = async () => {
  const { file } = await initDatabase();
  console.log(`SQLite database ready: ${file}`);
};

module.exports = connectDB;
