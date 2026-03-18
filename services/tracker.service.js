
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';

message.txt
3 KB

// services/polling.service.js
import cron from 'node-cron';

class PollingService {
  constructor(ghlService, tallbobService, tracker, options = {}) {
    this.ghlService = ghlService;

message.txt
6 KB

// scripts/sync-contacts.js
import 'dotenv/config';
import { HighLevel } from '@gohighlevel/api-client';
import CommentTracker from '../services/tracker.service.js';

async function syncContacts() {
  console.log('\n🔄 Syncing contacts from GHL...');
  
  const tracker = new CommentTracker();
  await tracker.initialize();

  const ghlClient = new HighLevel({
    privateIntegrationToken: process.env.GHL_PRIVATE_INTEGRATION_TOKEN,
    apiVersion: process.env.GHL_API_VERSION || '2021-07-28'
  });

  let page = 1;
  const pageSize = 100;
  let hasMore = true;
  let totalAdded = 0;

  while (hasMore) {
    const response = await ghlClient.contacts.searchContactsAdvanced({
      locationId: process.env.GHL_LOCATION_ID,
      pageLimit: pageSize,
      page: page
    });

    const contacts = response.contacts || [];
    
    for (const contact of contacts) {
      if (contact.phone) {  // Only track contacts with phone numbers
        await tracker.addContact(contact.id, contact.phone);
        totalAdded++;
      }
    }

    console.log(`📦 Page ${page}: Processed ${contacts.length} contacts`);
    
    hasMore = contacts.length === pageSize;
    page++;
    
    if (hasMore) await new Promise(r => setTimeout(r, 500));
  }

  const count = await tracker.getCount();
  console.log(`✅ Sync complete! Tracking ${count} contacts with phone numbers`);
  
  await tracker.close();
}

syncContacts().catch(console.error);

Evans
 — 
3/10/26, 3:58 PM

// services/polling.service.js
import cron from 'node-cron';

class PollingService {
  constructor(ghlService, tallbobService, tracker, options = {}) {
    this.ghlService = ghlService;

message.txt
10 KB
Evans
 — 
3/13/26, 1:08 AM

// services/polling.service.js
import cron from 'node-cron';

class PollingService {
  constructor(ghlService, tallbobService, tracker, options = {}) {
    this.ghlService = ghlService;

message.txt
20 KB
﻿

```// services/tracker.service.js
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

    await this.db.exec(`
      CREATE TABLE IF NOT EXISTS monitored_contacts (
        contact_id TEXT PRIMARY KEY,
        phone_number TEXT NOT NULL,
        last_comment_hash TEXT,
        last_checked INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_last_checked ON monitored_contacts(last_checked);
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
      SELECT contact_id, phone_number, last_comment_hash
      FROM monitored_contacts
      ORDER BY last_checked ASC NULLS FIRST
      LIMIT ?
    `, limit);
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
