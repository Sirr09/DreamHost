require('dotenv').config();

const connectDB = require('./config/db');
const app = require('./app');
const { closeDatabase } = require('./config/database');

const PORT = Number(process.env.PORT) || 5000;
let server;

const start = async () => {
  await connectDB();

  server = app.listen(PORT, () => {
    console.log(`DreamHost server running in ${process.env.NODE_ENV || 'development'} mode on port ${PORT}`);
    console.log(`URL: http://localhost:${PORT}`);
  });
};

const shutdown = async (code = 0) => {
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
  await closeDatabase();
  process.exit(code);
};

process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection. Shutting down.');
  console.error(err);
  shutdown(1);
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught exception. Shutting down.');
  console.error(err);
  shutdown(1);
});

process.on('SIGTERM', () => shutdown(0));
process.on('SIGINT', () => shutdown(0));

start().catch((err) => {
  console.error('Startup failed.');
  console.error(err);
  closeDatabase().finally(() => process.exit(1));
});
