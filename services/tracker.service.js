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
    this.cache = new Map(); // In-memory cache for faster lookups
    this.cacheExpiry = 3600000; // 1 hour
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

    // Create tables with proper schema for deduplication
    await this.db.exec(`
      -- Table for tracking contacts
      CREATE TABLE IF NOT EXISTS monitored_contacts (
        contact_id TEXT PRIMARY KEY,
        phone_number TEXT NOT NULL,
        last_checked INTEGER,
        last_activity INTEGER DEFAULT 0,
        last_provider TEXT,
        created_at INTEGER DEFAULT (strftime('%s', 'now')),
        updated_at INTEGER DEFAULT (strftime('%s', 'now'))
      );
      
      -- CRITICAL: New table for tracking ALL processed comments
      -- This fixes the re-upload issue
      CREATE TABLE IF NOT EXISTS processed_comments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        contact_id TEXT NOT NULL,
        comment_hash TEXT NOT NULL,
        comment_text TEXT,
        conversation_id TEXT,
        processed_at INTEGER DEFAULT (strftime('%s', 'now')),
        FOREIGN KEY (contact_id) REFERENCES monitored_contacts(contact_id) ON DELETE CASCADE,
        UNIQUE(contact_id, comment_hash)
      );
      
      -- Indexes for performance
      CREATE INDEX IF NOT EXISTS idx_processed_comments_hash ON processed_comments(comment_hash);
      CREATE INDEX IF NOT EXISTS idx_processed_comments_contact ON processed_comments(contact_id);
      CREATE INDEX IF NOT EXISTS idx_processed_comments_date ON processed_comments(processed_at);
      CREATE INDEX IF NOT EXISTS idx_monitored_contacts_activity ON monitored_contacts(last_activity DESC);
    `);

    // Check and add missing columns to monitored_contacts
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
    
    if (!columns.includes('created_at')) {
      await this.db.exec(`ALTER TABLE monitored_contacts ADD COLUMN created_at INTEGER DEFAULT (strftime('%s', 'now'))`);
    }
    
    if (!columns.includes('updated_at')) {
      await this.db.exec(`ALTER TABLE monitored_contacts ADD COLUMN updated_at INTEGER DEFAULT (strftime('%s', 'now'))`);
    }

    // Load recent processed comments into cache (last 7 days)
    await this.refreshCache();

    console.log('✅ Comment tracker initialized');
    console.log(`   Database: ${this.dbPath}`);
    console.log(`   Cached comments: ${this.cache.size}`);
    return this.db;
  }

  async refreshCache() {
    if (!this.db) return;
    
    const sevenDaysAgo = Math.floor(Date.now() / 1000) - (7 * 24 * 3600);
    const rows = await this.db.all(`
      SELECT contact_id, comment_hash, processed_at 
      FROM processed_comments 
      WHERE processed_at > ?
    `, sevenDaysAgo);
    
    this.cache.clear();
    for (const row of rows) {
      const key = `${row.contact_id}:${row.comment_hash}`;
      this.cache.set(key, row.processed_at);
    }
  }

  generateHash(comment) {
    return crypto.createHash('sha256').update(comment).digest('hex').substring(0, 32);
  }

  /**
   * Generate a hash that includes the comment and optional conversation ID
   * This ensures uniqueness per conversation
   */
  generateUniqueHash(contactId, comment, conversationId = null) {
    const data = conversationId ? `${contactId}:${conversationId}:${comment}` : `${contactId}:${comment}`;
    return crypto.createHash('sha256').update(data).digest('hex').substring(0, 32);
  }

  async addContact(contactId, phoneNumber) {
    const now = Math.floor(Date.now() / 1000);
    await this.db.run(`
      INSERT INTO monitored_contacts (contact_id, phone_number, created_at, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(contact_id) DO UPDATE SET
        phone_number = excluded.phone_number,
        updated_at = excluded.updated_at
    `, [contactId, phoneNumber, now, now]);
  }

  async removeContact(contactId) {
    // Also remove all processed comments for this contact
    await this.db.run('DELETE FROM processed_comments WHERE contact_id = ?', contactId);
    await this.db.run('DELETE FROM monitored_contacts WHERE contact_id = ?', contactId);
    
    // Clear from cache
    for (const key of this.cache.keys()) {
      if (key.startsWith(`${contactId}:`)) {
        this.cache.delete(key);
      }
    }
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
    
    updates.push('updated_at = ?');
    params.push(Math.floor(Date.now() / 1000));
    params.push(contactId);
    
    await this.db.run(`
      UPDATE monitored_contacts 
      SET ${updates.join(', ')}
      WHERE contact_id = ?
    `, params);
    
    console.log(`📝 Updated contact ${contactId} activity`);
  }

  /**
   * FIXED: Check if a comment has been processed before
   * Now stores ALL processed comments, not just the last one
   */
  async checkComment(contactId, comment, conversationId = null) {
    if (!comment) return { isNew: false, hash: null };

    const hash = this.generateUniqueHash(contactId, comment, conversationId);
    const cacheKey = `${contactId}:${hash}`;
    
    // Check cache first (fast)
    if (this.cache.has(cacheKey)) {
      console.log(`   📌 Comment already processed (cached)`);
      return { isNew: false, hash };
    }
    
    // Check database
    const result = await this.db.get(
      'SELECT id, processed_at FROM processed_comments WHERE contact_id = ? AND comment_hash = ?',
      [contactId, hash]
    );

    const isNew = !result;
    
    if (!isNew) {
      // Add to cache for future fast lookups
      this.cache.set(cacheKey, result.processed_at);
      console.log(`   📌 Comment already processed (DB)`);
    } else {
      console.log(`   ✨ New comment detected`);
    }

    // Update last_checked timestamp
    await this.db.run(`
      UPDATE monitored_contacts 
      SET last_checked = strftime('%s', 'now')
      WHERE contact_id = ?
    `, [contactId]);

    return { isNew, hash, comment };
  }

  /**
   * FIXED: Mark a comment as processed after successful reply
   * Now stores the comment hash permanently
   */
  async markCommentProcessed(contactId, comment, hash = null, conversationId = null) {
    if (!comment) return false;
    
    const commentHash = hash || this.generateUniqueHash(contactId, comment, conversationId);
    const now = Math.floor(Date.now() / 1000);
    
    try {
      await this.db.run(`
        INSERT INTO processed_comments (contact_id, comment_hash, comment_text, conversation_id, processed_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(contact_id, comment_hash) DO NOTHING
      `, [contactId, commentHash, comment.substring(0, 500), conversationId, now]);
      
      // Update cache
      const cacheKey = `${contactId}:${commentHash}`;
      this.cache.set(cacheKey, now);
      
      console.log(`   ✅ Comment marked as processed`);
      return true;
    } catch (error) {
      console.error(`   ❌ Failed to mark comment as processed:`, error.message);
      return false;
    }
  }

  /**
   * Check if a specific comment has been processed (convenience method)
   */
  async isCommentProcessed(contactId, comment, conversationId = null) {
    const hash = this.generateUniqueHash(contactId, comment, conversationId);
    const cacheKey = `${contactId}:${hash}`;
    
    if (this.cache.has(cacheKey)) return true;
    
    const result = await this.db.get(
      'SELECT id FROM processed_comments WHERE contact_id = ? AND comment_hash = ?',
      [contactId, hash]
    );
    
    return !!result;
  }

  async getCount() {
    const result = await this.db.get('SELECT COUNT(*) as count FROM monitored_contacts');
    return result.count;
  }

  async getProcessedCommentsCount(contactId = null) {
    if (contactId) {
      const result = await this.db.get(
        'SELECT COUNT(*) as count FROM processed_comments WHERE contact_id = ?',
        [contactId]
      );
      return result.count;
    }
    const result = await this.db.get('SELECT COUNT(*) as count FROM processed_comments');
    return result.count;
  }

  /**
   * Clean up old processed comments (older than X days)
   * Run this periodically to keep database size manageable
   */
  async cleanupOldComments(daysToKeep = 30) {
    const cutoffTime = Math.floor(Date.now() / 1000) - (daysToKeep * 24 * 3600);
    const result = await this.db.run(
      'DELETE FROM processed_comments WHERE processed_at < ?',
      cutoffTime
    );
    
    if (result.changes > 0) {
      console.log(`🧹 Cleaned up ${result.changes} old processed comments`);
      await this.refreshCache();
    }
    
    return result.changes;
  }

  async close() {
    if (this.db) await this.db.close();
    this.cache.clear();
  }
}

export default CommentTracker;