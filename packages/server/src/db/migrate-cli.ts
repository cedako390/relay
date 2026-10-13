import { loadConfig } from '../config/index.js';
import { openDb } from './index.js';
import { runMigrations } from './migrate.js';

const config = loadConfig();
const { sqlite, db } = openDb(config.dbPath);
runMigrations(db);
sqlite.close();
console.log(`Migrations applied to ${config.dbPath}`);
