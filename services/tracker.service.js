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
    this.cache = new Map();
    this.cacheExpiry = 3600000;
    this.consecutiveFailures = new Map(); // Track repeated failures per contact
    this.maxFailuresBeforeSkip = 3; // Skip after 3 consecutive failures
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

    // Create tables with proper schema
    await this.db.exec(`
      -- Table for tracking contacts
      CREATE TABLE IF NOT EXISTS monitored_contacts (
        contact_id TEXT PRIMARY KEY,
        phone_number TEXT NOT NULL,
        last_checked INTEGER,
        last_activity INTEGER DEFAULT 0,
        last_provider TEXT,
        created_at INTEGER DEFAULT (strftime('%s', 'now')),
        updated_at INTEGER DEFAULT (strftime('%s', 'now')),
        is_active INTEGER DEFAULT 1,
        failure_count INTEGER DEFAULT 0,
        last_failure_reason TEXT,
        last_failure_time INTEGER
      );
      
      -- Table for tracking ALL processed comments
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
      
      -- Table for tracking known conversations
      CREATE TABLE IF NOT EXISTS known_conversations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        contact_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        last_message_date INTEGER,
        is_active INTEGER DEFAULT 1,
        last_seen INTEGER DEFAULT (strftime('%s', 'now')),
        created_at INTEGER DEFAULT (strftime('%s', 'now')),
        FOREIGN KEY (contact_id) REFERENCES monitored_contacts(contact_id) ON DELETE CASCADE,
        UNIQUE(contact_id, conversation_id)
      );
      
      -- Indexes
      CREATE INDEX IF NOT EXISTS idx_processed_comments_hash ON processed_comments(comment_hash);
      CREATE INDEX IF NOT EXISTS idx_processed_comments_contact ON processed_comments(contact_id);
      CREATE INDEX IF NOT EXISTS idx_monitored_contacts_active ON monitored_contacts(is_active);
      CREATE INDEX IF NOT EXISTS idx_monitored_contacts_failures ON monitored_contacts(failure_count);
      CREATE INDEX IF NOT EXISTS idx_known_conversations_active ON known_conversations(is_active);
    `);

    // Add missing columns to monitored_contacts if needed
    const tableInfo = await this.db.all(`PRAGMA table_info(monitored_contacts)`);
    const columns = tableInfo.map(col => col.name);
    
    if (!columns.includes('is_active')) {
      await this.db.exec(`ALTER TABLE monitored_contacts ADD COLUMN is_active INTEGER DEFAULT 1`);
    }
    if (!columns.includes('failure_count')) {
      await this.db.exec(`ALTER TABLE monitored_contacts ADD COLUMN failure_count INTEGER DEFAULT 0`);
    }
    if (!columns.includes('last_failure_reason')) {
      await this.db.exec(`ALTER TABLE monitored_contacts ADD COLUMN last_failure_reason TEXT`);
    }
    if (!columns.includes('last_failure_time')) {
      await this.db.exec(`ALTER TABLE monitored_contacts ADD COLUMN last_failure_time INTEGER`);
    }

    await this.refreshCache();
    await this.cleanupInactiveContacts();

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

  generateUniqueHash(contactId, comment, conversationId = null) {
    const data = conversationId ? `${contactId}:${conversationId}:${comment}` : `${contactId}:${comment}`;
    return crypto.createHash('sha256').update(data).digest('hex').substring(0, 32);
  }

  async addContact(contactId, phoneNumber) {
    const now = Math.floor(Date.now() / 1000);
    
    // Check if contact exists and is inactive
    const existing = await this.db.get(
      'SELECT is_active, failure_count FROM monitored_contacts WHERE contact_id = ?',
      [contactId]
    );
    
    if (existing && existing.is_active === 0) {
      // Reactivate the contact
      await this.db.run(`
        UPDATE monitored_contacts 
        SET is_active = 1, 
            failure_count = 0,
            last_failure_reason = NULL,
            updated_at = ?
        WHERE contact_id = ?
      `, [now, contactId]);
      console.log(`   🔄 Reactivated contact ${contactId}`);
    } else {
      await this.db.run(`
        INSERT INTO monitored_contacts (contact_id, phone_number, created_at, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(contact_id) DO UPDATE SET
          phone_number = excluded.phone_number,
          updated_at = excluded.updated_at,
          is_active = 1
      `, [contactId, phoneNumber, now, now]);
    }
  }

  async recordFailure(contactId, reason) {
    const now = Math.floor(Date.now() / 1000);
    
    await this.db.run(`
      UPDATE monitored_contacts 
      SET failure_count = COALESCE(failure_count, 0) + 1,
          last_failure_reason = ?,
          last_failure_time = ?,
          updated_at = ?
      WHERE contact_id = ?
    `, [reason, now, now, contactId]);
    
    // Update in-memory tracking
    const current = this.consecutiveFailures.get(contactId) || 0;
    this.consecutiveFailures.set(contactId, current + 1);
    
    // Check if we should deactivate this contact
    const contact = await this.db.get(
      'SELECT failure_count FROM monitored_contacts WHERE contact_id = ?',
      [contactId]
    );
    
    if (contact && contact.failure_count >= this.maxFailuresBeforeSkip) {
      await this.deactivateContact(contactId, reason);
      return true; // Contact was deactivated
    }
    
    return false; // Contact still active
  }

  async deactivateContact(contactId, reason) {
    const now = Math.floor(Date.now() / 1000);
    
    await this.db.run(`
      UPDATE monitored_contacts 
      SET is_active = 0,
          last_failure_reason = ?,
          updated_at = ?
      WHERE contact_id = ?
    `, [reason, now, contactId]);
    
    console.log(`   🔴 Contact ${contactId} deactivated due to: ${reason}`);
    return true;
  }

  async reactivateContact(contactId) {
    const now = Math.floor(Date.now() / 1000);
    
    await this.db.run(`
      UPDATE monitored_contacts 
      SET is_active = 1,
          failure_count = 0,
          last_failure_reason = NULL,
          updated_at = ?
      WHERE contact_id = ?
    `, [now, contactId]);
    
    this.consecutiveFailures.delete(contactId);
    console.log(`   ✅ Contact ${contactId} reactivated`);
  }

  async markConversationNotFound(contactId, conversationId) {
    // Mark this conversation as inactive/deleted
    await this.db.run(`
      UPDATE known_conversations 
      SET is_active = 0,
          last_seen = ?
      WHERE contact_id = ? AND conversation_id = ?
    `, [Math.floor(Date.now() / 1000), contactId, conversationId]);
    
    // Also record a failure for this contact
    return this.recordFailure(contactId, `Conversation ${conversationId} not found in GHL (may have been deleted)`);
  }

  async isConversationActive(contactId, conversationId) {
    const result = await this.db.get(`
      SELECT is_active FROM known_conversations 
      WHERE contact_id = ? AND conversation_id = ?
    `, [contactId, conversationId]);
    
    return result ? result.is_active === 1 : true; // Assume active if not tracked
  }

  async trackConversation(contactId, conversationId, lastMessageDate = null) {
    const now = Math.floor(Date.now() / 1000);
    
    await this.db.run(`
      INSERT INTO known_conversations (contact_id, conversation_id, last_message_date, last_seen, created_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(contact_id, conversation_id) DO UPDATE SET
        last_seen = excluded.last_seen,
        is_active = 1,
        last_message_date = COALESCE(?, last_message_date)
    `, [contactId, conversationId, lastMessageDate, now, now, lastMessageDate]);
  }

  async removeContact(contactId) {
    // Mark as inactive instead of deleting (preserve history)
    await this.db.run(`
      UPDATE monitored_contacts 
      SET is_active = 0, 
          updated_at = ?
      WHERE contact_id = ?
    `, [Math.floor(Date.now() / 1000), contactId]);
    
    // Clear from cache
    for (const key of this.cache.keys()) {
      if (key.startsWith(`${contactId}:`)) {
        this.cache.delete(key);
      }
    }
    
    this.consecutiveFailures.delete(contactId);
  }

  async getContactsToCheck(limit = 50) {
    // Only get active contacts, sorted by priority
    return await this.db.all(`
      SELECT contact_id, phone_number, 
             COALESCE(last_activity, 0) as last_activity, 
             last_provider,
             failure_count
      FROM monitored_contacts
      WHERE is_active = 1
      ORDER BY 
        failure_count ASC,           -- Fewer failures first
        last_activity DESC,          -- Most active first
        last_checked ASC NULLS FIRST -- Least recently checked next
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
    
    // Reset failure count on successful activity
    updates.push('failure_count = 0');
    updates.push('last_failure_reason = NULL');
    
    await this.db.run(`
      UPDATE monitored_contacts 
      SET ${updates.join(', ')}
      WHERE contact_id = ?
    `, params);
    
    this.consecutiveFailures.delete(contactId);
    console.log(`📝 Updated contact ${contactId} activity`);
  }

  async checkComment(contactId, comment, conversationId = null) {
    if (!comment) return { isNew: false, hash: null };

    const hash = this.generateUniqueHash(contactId, comment, conversationId);
    const cacheKey = `${contactId}:${hash}`;
    
    if (this.cache.has(cacheKey)) {
      return { isNew: false, hash };
    }
    
    const result = await this.db.get(
      'SELECT id, processed_at FROM processed_comments WHERE contact_id = ? AND comment_hash = ?',
      [contactId, hash]
    );

    const isNew = !result;
    
    if (!isNew) {
      this.cache.set(cacheKey, result.processed_at);
    }

    await this.db.run(`
      UPDATE monitored_contacts 
      SET last_checked = strftime('%s', 'now')
      WHERE contact_id = ?
    `, [contactId]);

    return { isNew, hash, comment };
  }

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
      
      const cacheKey = `${contactId}:${commentHash}`;
      this.cache.set(cacheKey, now);
      
      return true;
    } catch (error) {
      console.error(`   ❌ Failed to mark comment as processed:`, error.message);
      return false;
    }
  }

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

  async cleanupInactiveContacts(daysToKeep = 7) {
    const cutoffTime = Math.floor(Date.now() / 1000) - (daysToKeep * 24 * 3600);
    
    // Delete inactive contacts older than cutoff
    const result = await this.db.run(`
      DELETE FROM monitored_contacts 
      WHERE is_active = 0 AND updated_at < ?
    `, cutoffTime);
    
    if (result.changes > 0) {
      console.log(`🧹 Cleaned up ${result.changes} inactive contacts`);
    }
    
    return result.changes;
  }

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

  async getCount() {
    const result = await this.db.get('SELECT COUNT(*) as count FROM monitored_contacts WHERE is_active = 1');
    return result.count;
  }

  async getStats() {
    const active = await this.db.get('SELECT COUNT(*) as count FROM monitored_contacts WHERE is_active = 1');
    const inactive = await this.db.get('SELECT COUNT(*) as count FROM monitored_contacts WHERE is_active = 0');
    const failed = await this.db.get('SELECT COUNT(*) as count FROM monitored_contacts WHERE failure_count >= 3');
    const processed = await this.db.get('SELECT COUNT(*) as count FROM processed_comments');
    
    return {
      activeContacts: active.count,
      inactiveContacts: inactive.count,
      failedContacts: failed.count,
      processedComments: processed.count
    };
  }

  async close() {
    if (this.db) await this.db.close();
    this.cache.clear();
    this.consecutiveFailures.clear();
  }
}

export default CommentTracker;