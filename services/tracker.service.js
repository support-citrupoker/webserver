// services/tracker.service.js
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

class CommentTracker {
  constructor() {
    this.db = null;
    this.dbPath = path.join(__dirname, '../data/comments.db');
  }

  async initialize() {
    const fs = await import('fs');
    const dataDir = path.join(__dirname, '../data');
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }

    this.db = await open({
      filename: this.dbPath,
      driver: sqlite3.Database
    });

    // Create table if it doesn't exist (with all columns)
    await this.db.exec(`
      CREATE TABLE IF NOT EXISTS monitored_contacts (
        contact_id TEXT PRIMARY KEY,
        phone_number TEXT NOT NULL,
        last_comment_hash TEXT,
        last_checked INTEGER,
        last_activity INTEGER DEFAULT 0,
        last_provider TEXT
      )
    `);

    // Check and add missing columns
    const tableInfo = await this.db.all(`PRAGMA table_info(monitored_contacts)`);
    const columns = tableInfo.map(col => col.name);
    
    if (!columns.includes('last_activity')) {
      await this.db.exec(`ALTER TABLE monitored_contacts ADD COLUMN last_activity INTEGER DEFAULT 0`);
      console.log('✅ Added last_activity column');
    }
    
    if (!columns.includes('last_provider')) {
      await this.db.exec(`ALTER TABLE monitored_contacts ADD COLUMN last_provider TEXT`);
      console.log('✅ Added last_provider column');
    }

    // Create indexes
    await this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_last_checked ON monitored_contacts(last_checked);
      CREATE INDEX IF NOT EXISTS idx_last_activity ON monitored_contacts(last_activity DESC);
    `);

    console.log('✅ Comment tracker initialized');
    return this.db;
  }

  generateHash(comment) {
    return crypto.createHash('sha256').update(comment).digest('hex');
  }

  async addContact(contactId, phoneNumber) {
    await this.db.run(`
      INSERT INTO monitored_contacts (contact_id, phone_number)
      VALUES (?, ?)
      ON CONFLICT(contact_id) DO UPDATE SET
        phone_number = excluded.phone_number
    `, [contactId, phoneNumber]);
  }

  async removeContact(contactId) {
    await this.db.run('DELETE FROM monitored_contacts WHERE contact_id = ?', contactId);
  }

  async getContactsToCheck(limit = 50) {
    return await this.db.all(`
      SELECT contact_id, phone_number, last_comment_hash, 
             COALESCE(last_activity, 0) as last_activity, last_provider
      FROM monitored_contacts
      ORDER BY 
        last_activity DESC,
        last_checked ASC NULLS FIRST
      LIMIT ?
    `, limit);
  }

  async updateContactActivity(contactId, { last_activity, last_provider }) {
    const updates = [];
    const params = [];
    
    if (last_activity !== undefined && last_activity !== null) {
      updates.push('last_activity = ?');
      params.push(last_activity);
    }
    
    if (last_provider !== undefined && last_provider !== null) {
      updates.push('last_provider = ?');
      params.push(last_provider);
    }
    
    if (updates.length === 0) return;
    
    params.push(contactId);
    
    await this.db.run(`
      UPDATE monitored_contacts 
      SET ${updates.join(', ')}
      WHERE contact_id = ?
    `, params);
    
    console.log(`📝 Updated contact ${contactId} activity`);
  }

  async checkComment(contactId, comment) {
    if (!comment) return { isNew: false };

    const hash = this.generateHash(comment);
    
    const result = await this.db.get(
      'SELECT last_comment_hash FROM monitored_contacts WHERE contact_id = ?',
      contactId
    );

    const isNew = !result || result.last_comment_hash !== hash;

    await this.db.run(`
      UPDATE monitored_contacts 
      SET last_checked = strftime('%s', 'now'),
          last_comment_hash = ?
      WHERE contact_id = ?
    `, [hash, contactId]);

    return { isNew, hash, comment };
  }

  async getCount() {
    const result = await this.db.get('SELECT COUNT(*) as count FROM monitored_contacts');
    return result.count;
  }

  async close() {
    if (this.db) await this.db.close();
  }
}

export default CommentTracker;