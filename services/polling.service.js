// services/polling.service.js
import cron from 'node-cron';

class PollingService {
  constructor(ghlService, tallbobService, tracker, bluebubblesService, options = {}) {
    this.ghlService = ghlService;
    this.tallbobService = tallbobService;
    this.bluebubblesService = bluebubblesService;
    this.tracker = tracker;
    
    const useIMessage = process.env.IMESSAGEORSMS === 'true';
    this.provider = useIMessage ? 'bluebubbles' : 'tallbob';
    
    console.log(`📱 Provider: ${this.provider.toUpperCase()}`);
    
    this.batchSize = options.batchSize || 5;
    this.syncBatchSize = options.syncBatchSize || 10;
    this.pollInterval = options.pollInterval || '*/12 * * * *';
    
    this.delayBetweenContacts = options.delayBetweenContacts || 36000;
    this.delayAfterRateLimit = options.delayAfterRateLimit || 600000;
    this.delayBetweenPolls = options.delayBetweenPolls || 120000;
    this.delayAfterError = options.delayAfterError || 300000;
    this.delayBetweenPages = options.delayBetweenPages || 2000;
    this.syncInterval = options.syncInterval || '0 */4 * * *';
    
    this.syncOnlyActive = options.syncOnlyActive !== false;
    this.activeDaysThreshold = options.activeDaysThreshold || 60;
    this.initialSyncDelay = options.initialSyncDelay || 0;
    
    this.isPolling = false;
    this.isSyncing = false;
    this.rateLimitedUntil = 0;
    this.lastErrorTime = 0;
    this.consecutiveErrors = 0;
    
    this.lastApiCallTime = 0;
    this.minDelayBetweenCalls = 1500;
    this.apiCallTimestamps = [];
    this.maxCallsPerMinute = 40;
    
    this.lastRateLimitHeaders = {
      dailyRemaining: null,
      dailyLimit: null,
      burstRemaining: null,
      burstLimit: null,
      lastChecked: null,
      endpoint: null
    };
    
    this.rateLimitHistory = [];
    
    this.apiCalls = {
      total: 0,
      byEndpoint: {
        searchConversations: 0,
        searchContacts: 0,
        sendSMS: 0,
        sendMMS: 0,
        sendiMessage: 0,
        other: 0
      },
      byDate: {},
      rateLimitHits: 0,
      lastReset: new Date().setHours(0, 0, 0, 0),
      warningIssued: false,
      criticalIssued: false
    };
    
    this.stats = {
      totalChecks: 0,
      totalSmsSent: 0,
      totalMmsSent: 0,
      totaliMessageSent: 0,
      totalSkipped: 0,
      staleContactsRemoved: 0,
      lastRun: null,
      errors: 0,
      rateLimitHits: 0,
      rateLimitWaits: 0
    };
    
    console.log(`   ⚡ ${this.batchSize} contacts/poll | ${this.provider.toUpperCase()}\n`);
  }

  delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async trackApiCallRate() {
    const now = Date.now();
    
    if (this.lastApiCallTime) {
      const timeSinceLastCall = now - this.lastApiCallTime;
      if (timeSinceLastCall < this.minDelayBetweenCalls) {
        const waitTime = this.minDelayBetweenCalls - timeSinceLastCall;
        await this.delay(waitTime);
      }
    }
    
    this.apiCallTimestamps.push(now);
    this.apiCallTimestamps = this.apiCallTimestamps.filter(ts => now - ts < 60000);
    
    const callsInLastMinute = this.apiCallTimestamps.length;
    
    if (callsInLastMinute >= this.maxCallsPerMinute) {
      const oldestCall = this.apiCallTimestamps[0];
      const timeToWait = 60000 - (now - oldestCall) + 1000;
      console.warn(`🚦 Rate limit waiting ${Math.ceil(timeToWait/1000)}s`);
      await this.delay(timeToWait);
      return this.trackApiCallRate();
    }
    
    this.lastApiCallTime = Date.now();
    return callsInLastMinute;
  }

  async makeAPICall(fn, callName = 'API Call', retryCount = 0) {
    await this.trackApiCallRate();
    
    try {
      return await fn();
    } catch (error) {
      if ((error.statusCode === 429 || error.message?.includes('Too Many Requests')) && retryCount < 3) {
        const waitTime = (retryCount + 1) * 5000;
        console.log(`🚦 Rate limit hit, retry ${retryCount + 1}/3`);
        await this.delay(waitTime);
        return this.makeAPICall(fn, callName, retryCount + 1);
      }
      throw error;
    }
  }

  isRateLimited() {
    if (this.rateLimitedUntil > Date.now()) {
      const waitTime = Math.ceil((this.rateLimitedUntil - Date.now()) / 60000);
      console.log(`⏳ Rate limited: ${waitTime} min remaining`);
      return true;
    }
    return false;
  }

  setRateLimit(additionalWait = null) {
    const waitTime = additionalWait || this.delayAfterRateLimit;
    this.rateLimitedUntil = Date.now() + waitTime;
    this.stats.rateLimitWaits++;
    this.apiCalls.rateLimitHits++;
    console.log(`🚦 Rate limit engaged - ${Math.ceil(waitTime/60000)} min cooldown`);
  }

  trackApiCall(endpoint, type = 'other', count = 1) {
    const today = new Date().setHours(0, 0, 0, 0);
    if (today > this.apiCalls.lastReset) {
      this.apiCalls = {
        total: 0,
        byEndpoint: {
          searchConversations: 0,
          searchContacts: 0,
          sendSMS: 0,
          sendMMS: 0,
          sendiMessage: 0,
          other: 0
        },
        byDate: {},
        rateLimitHits: 0,
        lastReset: today,
        warningIssued: false,
        criticalIssued: false
      };
    }
    if (this.apiCalls.byEndpoint.hasOwnProperty(endpoint)) {
      this.apiCalls.byEndpoint[endpoint] += count;
    } else {
      this.apiCalls.byEndpoint.other += count;
    }
    this.apiCalls.total += count;
    return this.apiCalls.total;
  }

  async initialize() {
    console.log(`🚀 Polling Service Ready`);
    console.log(`   Provider: ${this.provider.toUpperCase()}\n`);
    
    if (this.tracker && typeof this.tracker.initialize === 'function') {
      await this.tracker.initialize();
    }
    
    this.startPolling();
    this.startContactSync();
    
    if (this.initialSyncDelay === 0) {
      setImmediate(async () => {
        await this.syncContacts().catch(console.error);
      });
    }
  }

  startPolling() {
    cron.schedule(this.pollInterval, async () => {
      if (this.lastErrorTime > 0) {
        const timeSinceError = Date.now() - this.lastErrorTime;
        if (timeSinceError < this.delayAfterError) {
          return;
        } else {
          this.lastErrorTime = 0;
          this.consecutiveErrors = 0;
        }
      }
      
      if (this.isRateLimited() || this.isPolling) return;
      await this.poll();
    });
  }

  startContactSync() {
    cron.schedule(this.syncInterval, async () => {
      if (this.isRateLimited() || this.isSyncing) return;
      await this.syncContacts();
    });
  }
  
  async sendReply(contact, replyText, imageUrl, locationId) {
    try {
      console.log(`📤 SENDING ${this.provider.toUpperCase()} REPLY`);
      console.log(`   To: ${contact.phone_number}`);
      console.log(`   Msg: "${replyText.substring(0, 80)}${replyText.length > 80 ? '...' : ''}"`);
      
      let result;
      
      if (this.provider === 'bluebubbles') {
        if (!this.bluebubblesService) {
          throw new Error('BlueBubbles service not configured');
        }
        
        this.trackApiCall('sendiMessage', 'sendiMessage');
        const fromAccount = process.env.BLUEBUBBLES_IMESSAGE_ACCOUNT || null;
        
        if (imageUrl) {
          result = await this.bluebubblesService.sendAttachment({
            to: contact.phone_number,
            from: fromAccount,
            message: replyText,
            mediaUrl: imageUrl
          });
          this.stats.totalMmsSent++;
        } else {
          result = await this.bluebubblesService.sendMessage({
            to: contact.phone_number,
            from: fromAccount,
            message: replyText
          });
          this.stats.totaliMessageSent++;
        }
        
        console.log(`   ✅ Sent! ID: ${result.guid || result.messageId}\n`);
        this.stats.totalSmsSent++;
        return { success: true, provider: 'bluebubbles', result };
        
      } else {
        if (imageUrl) {
          this.trackApiCall('sendMMS', 'sendMMS');
          result = await this.tallbobService.sendMMS({
            to: contact.phone_number,
            from: process.env.TALLBOB_NUMBER || '+61428616133',
            message: replyText,
            mediaUrl: imageUrl,
            reference: `mms_${contact.contact_id}_${Date.now()}`
          });
          this.stats.totalMmsSent++;
          this.stats.totalSmsSent++;
        } else {
          this.trackApiCall('sendSMS', 'sendSMS');
          result = await this.tallbobService.sendSMS({
            to: contact.phone_number,
            from: process.env.TALLBOB_NUMBER || '+61428616133',
            message: replyText,
            reference: `sms_${contact.contact_id}_${Date.now()}`
          });
          this.stats.totalSmsSent++;
        }
        
        console.log(`   ✅ Sent! ID: ${result.messageId}\n`);
        return { success: true, provider: 'tallbob', result };
      }
      
    } catch (error) {
      console.error(`   ❌ Send failed: ${error.message}\n`);
      return { success: false, error: error.message };
    }
  }

  extractImageUrl(text) {
    if (!text) return null;
    const urlRegex = /(https?:\/\/[^\s]+)/g;
    const urls = text.match(urlRegex) || [];
    for (const url of urls) {
      const lowerUrl = url.toLowerCase();
      if (lowerUrl.includes('.jpg') || lowerUrl.includes('.png') || 
          lowerUrl.includes('.jpeg') || lowerUrl.includes('.gif') ||
          lowerUrl.includes('imgur.com')) {
        return url;
      }
    }
    return null;
  }

  async poll() {
    this.isPolling = true;
    const startTime = Date.now();

    try {
      const contacts = await this.tracker.getContactsToCheck(this.batchSize);
      
      if (contacts.length === 0) {
        await this.delay(this.delayBetweenPolls);
        this.isPolling = false;
        return;
      }

      let newReplies = 0;
      let staleRemovedThisPoll = 0;

      for (const contact of contacts) {
        if (this.isRateLimited()) break;

        try {
          // Silent contact fetch
          let contactExists = true;
          try {
            await this.makeAPICall(
              () => this.ghlService.getContact(contact.contact_id),
              'getContact'
            );
          } catch (err) {
            if (err.statusCode === 400 && err.response?.message?.includes('Contact not found')) {
              if (staleRemovedThisPoll < 5) {
                await this.tracker.removeContact(contact.contact_id);
                staleRemovedThisPoll++;
                this.stats.staleContactsRemoved++;
              }
              contactExists = false;
            }
          }
          
          if (!contactExists) continue;
          
          // Silent conversation search
          const conversations = await this.makeAPICall(
            () => this.ghlService.searchConversations({
              contactId: contact.contact_id,
              limit: 5
            }),
            'searchConversations'
          );

          if (!conversations || conversations.length === 0) continue;

          // Find latest internal comment
          let latestComment = null;
          for (const conv of conversations) {
            if (conv.lastInternalComment) {
              if (!latestComment || new Date(conv.lastMessageDate) > new Date(latestComment.date)) {
                latestComment = {
                  text: conv.lastInternalComment,
                  date: conv.lastMessageDate,
                  conversationId: conv.id
                };
              }
            }
          }
          
          if (latestComment) {
            const cleanMessage = latestComment.text.trim();
            const imageUrl = this.extractImageUrl(cleanMessage);
            
            // Skip @reply internal notes
            if (cleanMessage.toLowerCase().startsWith('@reply')) {
              continue;
            }
            
            if (cleanMessage.trim()) {
              const { isNew, hash } = await this.tracker.checkComment(
                contact.contact_id,
                latestComment.text,
                latestComment.conversationId
              );
              
              if (isNew) {
                // ONLY SHOW THIS LINE FOR INTERNAL COMMENTS
                console.log(`\n💬 New internal comment from ${contact.phone_number}:`);
                console.log(`   "${cleanMessage.substring(0, 100)}${cleanMessage.length > 100 ? '...' : ''}"`);
                
                const sendResult = await this.sendReply(
                  contact,
                  cleanMessage,
                  imageUrl,
                  process.env.GHL_LOCATION_ID
                );
                
                if (sendResult.success) {
                  await this.tracker.markCommentProcessed(
                    contact.contact_id,
                    latestComment.text,
                    hash,
                    latestComment.conversationId
                  );
                  newReplies++;
                }
              }
            }
          }

          await this.delay(this.delayBetweenContacts);

        } catch (err) {
          this.stats.errors++;
          this.consecutiveErrors++;
          
          if (err.statusCode === 429 || err.message?.includes('Too Many Requests')) {
            this.stats.rateLimitHits++;
            this.apiCalls.rateLimitHits++;
            this.setRateLimit(this.delayAfterRateLimit);
            break;
          }
          
          if (this.consecutiveErrors >= 2) {
            this.lastErrorTime = Date.now();
            break;
          }
        }
      }

      const duration = Date.now() - startTime;
      this.stats.totalChecks += contacts.length;
      this.stats.lastRun = new Date().toISOString();

      if (newReplies > 0) {
        console.log(`📊 Poll complete: ${newReplies} replies sent (${Math.round(duration/1000)}s)\n`);
      }
      
      await this.delay(this.delayBetweenPolls);

    } catch (error) {
      console.error(`💥 Poll error: ${error.message}`);
      this.stats.errors++;
      this.lastErrorTime = Date.now();
    } finally {
      this.isPolling = false;
    }
  }

  async syncContacts() {
    if (this.isRateLimited() || this.isSyncing) return;
    
    this.isSyncing = true;
    
    if (this.syncOnlyActive) {
      await this.syncActiveContactsOnly();
    } else {
      await this.syncAllContacts();
    }
    
    this.isSyncing = false;
  }

  async syncActiveContactsOnly() {
    try {
      let page = 1;
      let hasMore = true;
      let activeCount = 0;
      const currentContactIds = new Set();
      
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - this.activeDaysThreshold);
      const cutoffTimestamp = cutoffDate.getTime();
      
      while (hasMore && !this.isRateLimited()) {
        const response = await this.makeAPICall(
          () => this.ghlService.client.contacts.searchContactsAdvanced({
            locationId: process.env.GHL_LOCATION_ID,
            pageLimit: this.syncBatchSize,
            page: page
          }),
          'searchContactsAdvanced'
        );

        const contacts = response.contacts || [];
        
        for (const contact of contacts) {
          if (!contact.phone) continue;
          
          let isActive = false;
          let lastActivity = null;
          
          if (contact.dateUpdated) {
            const updateDate = new Date(contact.dateUpdated);
            if (!isNaN(updateDate.getTime()) && updateDate.getTime() >= cutoffTimestamp) {
              isActive = true;
              lastActivity = updateDate;
            }
          }
          
          if (!isActive && contact.dateAdded) {
            const addedDate = new Date(contact.dateAdded);
            if (!isNaN(addedDate.getTime()) && addedDate.getTime() >= cutoffTimestamp) {
              isActive = true;
              lastActivity = addedDate;
            }
          }
          
          if (isActive) {
            await this.tracker.addContact(contact.id, contact.phone);
            if (lastActivity) {
              await this.tracker.updateContactActivity(contact.id, {
                last_activity: lastActivity.getTime()
              });
            }
            currentContactIds.add(contact.id);
            activeCount++;
          }
        }
        
        hasMore = contacts.length === this.syncBatchSize;
        page++;
        
        if (hasMore && !this.isRateLimited()) {
          await this.delay(500);
        }
      }
      
      if (activeCount > 0) {
        const finalCount = await this.tracker.getCount();
        console.log(`📋 Synced ${activeCount} active contacts (${finalCount} total tracked)\n`);
      }
      
    } catch (error) {
      console.error(`❌ Sync error: ${error.message}`);
    }
  }

  async syncAllContacts() {
    try {
      let page = 1;
      let hasMore = true;
      let totalAdded = 0;
      const currentContactIds = new Set();

      while (hasMore && !this.isRateLimited()) {
        const response = await this.makeAPICall(
          () => this.ghlService.client.contacts.searchContactsAdvanced({
            locationId: process.env.GHL_LOCATION_ID,
            pageLimit: this.syncBatchSize,
            page: page
          }),
          'searchContactsAdvanced'
        );

        const contacts = response.contacts || [];
        
        for (const contact of contacts) {
          if (contact.phone) {
            await this.tracker.addContact(contact.id, contact.phone);
            currentContactIds.add(contact.id);
            totalAdded++;
          }
        }
        
        hasMore = contacts.length === this.syncBatchSize;
        page++;
        
        if (hasMore && !this.isRateLimited()) {
          await this.delay(500);
        }
      }
      
      if (totalAdded > 0) {
        const finalCount = await this.tracker.getCount();
        console.log(`📋 Synced ${totalAdded} contacts (${finalCount} total tracked)\n`);
      }
      
    } catch (error) {
      console.error(`❌ Sync error: ${error.message}`);
    }
  }

  getStats() {
    return {
      polling: {
        ...this.stats,
        trackedContacts: this.tracker.getCount ? this.tracker.getCount() : 0,
        provider: this.provider,
        providerBreakdown: {
          iMessage: this.stats.totaliMessageSent,
          sms: this.stats.totalSmsSent - this.stats.totalMmsSent,
          mms: this.stats.totalMmsSent,
          total: this.stats.totalSmsSent + this.stats.totaliMessageSent
        }
      },
      apiUsage: {
        total: this.apiCalls.total,
        byEndpoint: { ...this.apiCalls.byEndpoint }
      },
      timestamp: new Date().toISOString()
    };
  }
}

export default PollingService;