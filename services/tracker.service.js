// services/tracker.service.js
import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

class CommentTracker {
  constructor(dbPath = null) {
    this.dbPath = dbPath || path.join(process.cwd(), 'data', 'tracker.db');
    this.db = null;
    
    // Ensure data directory exists
    const dataDir = path.dirname(this.dbPath);
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
    
    console.log('📁 Tracker database path:', this.dbPath);
  }

  async getDb() {
    if (!this.db) {
      this.db = new Database(this.dbPath);
      await this.initialize();
    }
    return this.db;
  }

  async initialize() {
    const db = await this.getDb();
    
    // Create contacts table with all fields
    db.exec(`
      CREATE TABLE IF NOT EXISTS contacts (
        contact_id TEXT PRIMARY KEY,
        phone_number TEXT NOT NULL,
        last_checked INTEGER DEFAULT 0,
        last_comment_hash TEXT,
        last_activity INTEGER DEFAULT 0,
        last_provider TEXT,
        created_at INTEGER DEFAULT (strftime('%s', 'now')),
        updated_at INTEGER DEFAULT (strftime('%s', 'now'))
      )
    `);
    
    // Create processed_comments table for deduplication
    db.exec(`
      CREATE TABLE IF NOT EXISTS processed_comments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        contact_id TEXT NOT NULL,
        comment_hash TEXT NOT NULL,
        comment_text TEXT,
        processed_at INTEGER DEFAULT (strftime('%s', 'now')),
        FOREIGN KEY (contact_id) REFERENCES contacts(contact_id),
        UNIQUE(contact_id, comment_hash)
      )
    `);
    
    // Add indexes for performance
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_contacts_last_activity ON contacts(last_activity DESC);
      CREATE INDEX IF NOT EXISTS idx_contacts_last_checked ON contacts(last_checked ASC);
      CREATE INDEX IF NOT EXISTS idx_processed_comments_contact ON processed_comments(contact_id);
    `);
    
    console.log('✅ Comment tracker initialized');
  }

  /**
   * Add or update a contact in the tracker
   */
  async addContact(contactId, phoneNumber) {
    const db = await this.getDb();
    const now = Math.floor(Date.now() / 1000);
    
    const stmt = db.prepare(`
      INSERT INTO contacts (contact_id, phone_number, created_at, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(contact_id) DO UPDATE SET
        phone_number = excluded.phone_number,
        updated_at = excluded.updated_at
    `);
    
    stmt.run(contactId, phoneNumber, now, now);
    console.log(`📞 Contact added/updated: ${contactId} (${phoneNumber})`);
  }

  /**
   * Get contacts to check, prioritized by last_activity (most recent first)
   */
  async getContactsToCheck(batchSize) {
    const db = await this.getDb();
    
    const contacts = db.prepare(`
      SELECT 
        contact_id,
        phone_number,
        last_checked,
        last_comment_hash,
        COALESCE(last_activity, 0) as last_activity,
        last_provider
      FROM contacts 
      WHERE phone_number IS NOT NULL 
      ORDER BY 
        last_activity DESC,
        COALESCE(last_checked, 0) ASC
      LIMIT ?
    `).all(batchSize);
    
    console.log(`📋 Retrieved ${contacts.length} contacts to check`);
    return contacts;
  }

  /**
   * Update contact activity information
   */
  async updateContactActivity(contactId, { last_activity, last_provider }) {
    const db = await this.getDb();
    const now = Math.floor(Date.now() / 1000);
    
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
    params.push(now);
    params.push(contactId);
    
    const query = `UPDATE contacts SET ${updates.join(', ')} WHERE contact_id = ?`;
    db.prepare(query).run(...params);
    console.log(`📝 Updated contact ${contactId} activity: last_activity=${last_activity}, last_provider=${last_provider}`);
  }

  /**
   * Update last_checked timestamp for a contact
   */
  async updateLastChecked(contactId) {
    const db = await this.getDb();
    const now = Math.floor(Date.now() / 1000);
    
    db.prepare(`
      UPDATE contacts 
      SET last_checked = ?, updated_at = ?
      WHERE contact_id = ?
    `).run(now, now, contactId);
  }

  /**
   * Check if a comment has been processed before
   * Returns { isNew: boolean, existingComment: object|null }
   */
  async checkComment(contactId, commentText, replyText) {
    const db = await this.getDb();
    const commentHash = this.hashComment(commentText);
    const now = Math.floor(Date.now() / 1000);
    
    // Check if comment already processed
    const existing = db.prepare(`
      SELECT * FROM processed_comments 
      WHERE contact_id = ? AND comment_hash = ?
    `).get(contactId, commentHash);
    
    if (existing) {
      return { isNew: false, existingComment: existing };
    }
    
    // Mark as processed
    db.prepare(`
      INSERT INTO processed_comments (contact_id, comment_hash, comment_text, processed_at)
      VALUES (?, ?, ?, ?)
    `).run(contactId, commentHash, replyText, now);
    
    // Update last_checked for the contact
    await this.updateLastChecked(contactId);
    
    return { isNew: true, existingComment: null };
  }

  /**
   * Generate a hash for a comment to detect duplicates
   */
  hashComment(comment) {
    // Simple hash for deduplication
    let hash = 0;
    const str = comment.trim();
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }
    return Math.abs(hash).toString(36);
  }

  /**
   * Get count of contacts in tracker
   */
  async getCount() {
    const db = await this.getDb();
    const result = db.prepare('SELECT COUNT(*) as count FROM contacts').get();
    return result.count;
  }

  /**
   * Remove a contact from tracker
   */
  async removeContact(contactId) {
    const db = await this.getDb();
    
    // First delete associated processed comments
    db.prepare('DELETE FROM processed_comments WHERE contact_id = ?').run(contactId);
    
    // Then delete the contact
    const result = db.prepare('DELETE FROM contacts WHERE contact_id = ?').run(contactId);
    
    if (result.changes > 0) {
      console.log(`🗑️ Removed contact: ${contactId}`);
    }
    
    return result.changes > 0;
  }

  /**
   * Clear all contacts (for testing/reset)
   */
  async clearAllContacts() {
    const db = await this.getDb();
    db.prepare('DELETE FROM processed_comments').run();
    const result = db.prepare('DELETE FROM contacts').run();
    console.log(`🗑️ Cleared ${result.changes} contacts from tracker`);
    return result.changes;
  }

  /**
   * Get all contacts (for debugging)
   */
  async getAllContacts(limit = 100) {
    const db = await this.getDb();
    const contacts = db.prepare(`
      SELECT 
        contact_id,
        phone_number,
        last_checked,
        last_comment_hash,
        last_activity,
        last_provider,
        datetime(last_activity, 'unixepoch') as last_activity_date,
        datetime(last_checked, 'unixepoch') as last_checked_date,
        datetime(created_at, 'unixepoch') as created_at_date
      FROM contacts 
      ORDER BY last_activity DESC
      LIMIT ?
    `).all(limit);
    
    return contacts;
  }

  /**
   * Get processed comments for a contact
   */
  async getProcessedComments(contactId, limit = 50) {
    const db = await this.getDb();
    const comments = db.prepare(`
      SELECT 
        comment_text,
        datetime(processed_at, 'unixepoch') as processed_at_date
      FROM processed_comments 
      WHERE contact_id = ?
      ORDER BY processed_at DESC
      LIMIT ?
    `).all(contactId, limit);
    
    return comments;
  }

  /**
   * Clean up old processed comments (older than X days)
   */
  async cleanupOldComments(daysToKeep = 30) {
    const db = await this.getDb();
    const cutoffTime = Math.floor(Date.now() / 1000) - (daysToKeep * 24 * 60 * 60);
    
    const result = db.prepare(`
      DELETE FROM processed_comments 
      WHERE processed_at < ?
    `).run(cutoffTime);
    
    console.log(`🧹 Cleaned up ${result.changes} old comments`);
    return result.changes;
  }
}

export default CommentTracker;