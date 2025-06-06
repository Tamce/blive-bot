import fs from 'fs'
import log4js from 'log4js';

export class Database {
  constructor(config) {
    if (!config)
      config = {};
    if (!config.logger)
      config.logger = log4js.getLogger('db');

    this.logger = config.logger;
    this.file = config.file || 'db.json';
    this.db = new Map();

    this.load();
  }

  get(key) {
    return this.db.get(key);
  }

  set(key, value) {
    this.db.set(key, value);
  }

  delete(key) {
    this.db.delete(key);
  }

  clear() {
    this.db.clear();
  }

  has(key) {
    return this.db.has(key);
  }

  save() {
    this.dumpToFile(this.file);
  }

  load() {
    if (fs.existsSync(this.file)) {
      this.loadFromFile(this.file);
    } else {
      this.logger.warn(`Database file ${this.file} does not exist, starting with an empty database.`);
    }
  }

  dumpToFile(filename) {
    const data = JSON.stringify(Array.from(this.db.entries()));
    fs.writeFileSync(filename, data, (err) => {
      if (err) {
        this.logger.error(`Error writing to file ${filename}:`, err);
      } else {
        this.logger.info(`Database dumped to ${filename}`);
      }
    });
  }

  loadFromFile(filename) {
    const data = fs.readFileSync(filename, 'utf8');
    const entries = JSON.parse(data);
    this.db = new Map(entries);
    this.logger.info(`Database loaded from ${filename}`, this.db);
  }
}
