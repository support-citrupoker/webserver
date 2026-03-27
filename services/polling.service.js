// services/polling.service.js (Updated with debug logging)
import cron from 'node-cron';

class PollingService {
  constructor(ghlService, tallbobService, tracker, bluebubblesService, options = {}) {
    this.ghlService = ghlService;
    this.tallbobService = tallbobService;
    this.bluebubblesService = bluebubblesService;
    this.tracker = tracker;
    
    // EXTREMELY CONSERVATIVE SETTINGS - MAXIMUM SAFETY
    this.batchSize = options.batchSize || 2;
    this.syncBatchSize = options.syncBatchSize || 3;
    this.pollInterval = options.pollInterval || '*/15 * * * *';
    
    // YOUR REQUESTED DELAYS
    this.delayBetweenContacts = options.delayBetweenContacts || 60000;
    this.delayAfterRateLimit = options.delayAfterRateLimit || 1800000;
    this.delayBetweenPolls = options.delayBetweenPolls || 300000;
    this.delayAfterError = options.delayAfterError || 1800000;
    this.delayBetweenPages = options.delayBetweenPages || 120000;
    this.syncInterval = options.syncInterval || '0 0 * * *';
    
    // Status flags
    this.isPolling = false;
    this.isSyncing = false;
    this.rateLimitedUntil = 0;
    this.lastErrorTime = 0;
    this.consecutiveErrors = 0;
    
    // Store last known rate limit headers
    this.lastRateLimitHeaders = {
      dailyRemaining: null,
      dailyLimit: null,
      burstRemaining: null,
      burstLimit: null,
      lastChecked: null,
      endpoint: null
    };
    
    // Rate limit history
    this.rateLimitHistory = [];
    
    // API CALL MONITORING
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
    
    // Stats tracking
    this.stats = {
      totalChecks: 0,
      totalSmsSent: 0,
      totalMmsSent: 0,
      totaliMessageSent: 0,
      totalSkipped: 0,
      lastRun: null,
      errors: 0,
      rateLimitHits: 0,
      rateLimitWaits: 0
    };
  }

  getApiUsageString() {
    const percentUsed = Math.round((this.apiCalls.total / 200000) * 100);
    let rateLimitInfo = '';
    if (this.lastRateLimitHeaders.dailyRemaining !== null) {
      rateLimitInfo = ` | Daily: ${this.lastRateLimitHeaders.dailyRemaining}/${this.lastRateLimitHeaders.dailyLimit || 200000} remaining`;
    }
    if (this.lastRateLimitHeaders.burstRemaining !== null) {
      rateLimitInfo += ` | Burst: ${this.lastRateLimitHeaders.burstRemaining}/${this.lastRateLimitHeaders.burstLimit || '?'} remaining`;
    }
    return `[API: ${this.apiCalls.total} calls (${percentUsed}%)${rateLimitInfo}]`;
  }

  logRateLimitDetails(headers, endpoint) {
    // Skip logging if no headers
    if (!headers) return;
    
    const dailyRemaining = headers?.['x-ratelimit-daily-remaining'];
    const burstRemaining = headers?.['x-ratelimit-remaining'];
    
    if (dailyRemaining !== undefined || burstRemaining !== undefined) {
      console.log(`📊 Rate limit for ${endpoint}: Daily: ${dailyRemaining || 'N/A'}, Burst: ${burstRemaining || 'N/A'}`);
    }
  }

  trackRateLimitHistory(headers, endpoint) {
    if (!headers) return;
    
    const dailyRemaining = headers?.['x-ratelimit-daily-remaining'];
    const burstRemaining = headers?.['x-ratelimit-remaining'];
    
    if (dailyRemaining) {
      this.lastRateLimitHeaders = {
        dailyRemaining: parseInt(dailyRemaining),
        dailyLimit: parseInt(headers?.['x-ratelimit-daily-limit'] || '200000'),
        burstRemaining: burstRemaining ? parseInt(burstRemaining) : this.lastRateLimitHeaders.burstRemaining,
        burstLimit: parseInt(headers?.['x-ratelimit-limit'] || headers?.['x-ratelimit-interval-limit'] || '0'),
        lastChecked: new Date().toISOString(),
        endpoint
      };
    }
  }

  calculateRateLimitTrend() {
    return null; // Simplified for now
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
    const hourKey = new Date().toISOString().substring(0, 13);
    this.apiCalls.byDate[hourKey] = (this.apiCalls.byDate[hourKey] || 0) + count;
    
    return this.apiCalls.total;
  }

  logApiUsage(projectedTotal) {
    // Skip detailed logging to reduce noise
    console.log(`📊 API calls today: ${this.apiCalls.total}`);
  }

  checkRateLimitHeaders(headers, endpoint) {
    if (!headers) return;
    this.logRateLimitDetails(headers, endpoint);
    this.trackRateLimitHistory(headers, endpoint);
  }

  isRateLimited() {
    if (this.rateLimitedUntil > Date.now()) {
      const waitTime = Math.ceil((this.rateLimitedUntil - Date.now()) / 60000);
      console.log(`⏳ RATE LIMITED: ${waitTime} more minutes remaining`);
      return true;
    }
    return false;
  }

  setRateLimit(additionalWait = null) {
    const waitTime = additionalWait || this.delayAfterRateLimit;
    this.rateLimitedUntil = Date.now() + waitTime;
    this.stats.rateLimitWaits++;
    this.apiCalls.rateLimitHits++;
    console.log(`🚦 RATE LIMIT ENGAGED - ${Math.ceil(waitTime/60000)} minute cooldown`);
  }

  async initialize() {
    console.log(`\n🚀 INITIALIZING POLLING SERVICE...`);
    console.log(`   Batch size: ${this.batchSize} contacts/poll`);
    console.log(`   Delay between contacts: ${this.delayBetweenContacts/1000} seconds`);
    console.log(`   Poll interval: ${this.pollInterval}`);
    
    if (this.tracker && typeof this.tracker.initialize === 'function') {
      await this.tracker.initialize();
      console.log('✅ Tracker initialized');
    }
    
    this.startPolling();
    this.startContactSync();
    
    console.log(`✅ Polling service initialization complete!\n`);
  }

  startPolling() {
    console.log(`⏰ Starting poller (batch: ${this.batchSize}, interval: ${this.pollInterval})`);
    
    cron.schedule(this.pollInterval, async () => {
      console.log(`\n🔔 CRON TRIGGERED - Starting poll cycle at ${new Date().toLocaleTimeString()}`);
      
      if (this.lastErrorTime > 0) {
        const timeSinceError = Date.now() - this.lastErrorTime;
        if (timeSinceError < this.delayAfterError) {
          console.log(`🧊 In error cooldown, skipping poll`);
          return;
        }
      }
      
      if (this.isRateLimited()) {
        console.log(`⏭️ Rate limited, skipping poll`);
        return;
      }
      
      if (this.isPolling) {
        console.log(`⚠️ Previous poll still running, skipping`);
        return;
      }
      
      await this.poll();
    });
  }

  startContactSync() {
    console.log(`⏰ Starting contact sync (interval: ${this.syncInterval})`);
    
    cron.schedule(this.syncInterval, async () => {
      if (this.isRateLimited()) {
        return;
      }
      if (this.isSyncing) {
        return;
      }
      await this.syncContacts();
    });
  }

  async getProviderForReply(contactId, locationId) {
    try {
      console.log(`🔍 Determining provider for contact ${contactId}...`);
      
      const conversations = await this.ghlService.searchConversations({
        contactId: contactId,
        limit: 5,
        locationId: locationId
      });
      
      if (!conversations || conversations.length === 0) {
        console.log(`⚠️ No conversations found, defaulting to SMS`);
        return { provider: 'tallbob', reason: 'No conversation history' };
      }
      
      let lastProvider = null;
      let lastMessageDate = null;
      
      for (const conv of conversations) {
        const messages = await this.ghlService.getConversationMessages(conv.id, locationId, 10);
        
        if (messages && messages.length > 0) {
          const inboundMessages = messages
            .filter(m => m.direction === 'inbound')
            .sort((a, b) => new Date(b.date) - new Date(a.date));
          
          if (inboundMessages.length > 0) {
            const latestMessage = inboundMessages[0];
            const messageDate = new Date(latestMessage.date);
            
            if (!lastMessageDate || messageDate > lastMessageDate) {
              lastMessageDate = messageDate;
              lastProvider = latestMessage.provider || this.detectProviderFromMessage(latestMessage);
              console.log(`📱 Last message from ${latestMessage.date} via: ${lastProvider}`);
            }
          }
        }
      }
      
      if (lastProvider === 'BlueBubbles' || lastProvider === 'iMessage') {
        console.log(`✅ Replying via BlueBubbles (iMessage)`);
        return { provider: 'bluebubbles', reason: 'Last message was iMessage' };
      } else {
        console.log(`✅ Replying via Tall Bob (SMS/MMS)`);
        return { provider: 'tallbob', reason: 'Last message was SMS/MMS' };
      }
      
    } catch (error) {
      console.error(`❌ Error determining provider:`, error.message);
      return { provider: 'tallbob', reason: 'Error, defaulting to SMS' };
    }
  }
  
  detectProviderFromMessage(message) {
    if (message.metadata?.provider) return message.metadata.provider;
    if (message.messageType === 'iMessage') return 'BlueBubbles';
    if (message.messageType === 'SMS' || message.messageType === 'MMS') return 'Tall Bob';
    if (message.toNumber?.includes('@')) return 'BlueBubbles';
    return 'unknown';
  }
  
  async sendReplyWithProvider(contact, replyText, imageUrl, locationId) {
    try {
      console.log(`\n📤 ===== SENDING REPLY =====`);
      console.log(`   Contact: ${contact.contact_id} (${contact.phone_number})`);
      console.log(`   Message: "${replyText.substring(0, 100)}"`);
      console.log(`   Image: ${imageUrl ? 'Yes' : 'No'}`);
      
      const { provider, reason } = await this.getProviderForReply(contact.contact_id, locationId);
      
      console.log(`   Routing: ${provider.toUpperCase()} - ${reason}`);
      
      let result;
      
      if (provider === 'bluebubbles') {
        if (!this.bluebubblesService) {
          console.error(`❌ BlueBubbles not configured, falling back to SMS`);
          return await this.sendViaTallBob(contact, replyText, imageUrl);
        }
        
        this.trackApiCall('sendiMessage', 'sendiMessage');
        const fromAccount = process.env.BLUEBUBBLES_IMESSAGE_ACCOUNT || contact.phone_number;
        
        if (imageUrl) {
          console.log(`📸 Sending iMessage with attachment via BlueBubbles`);
          result = await this.bluebubblesService.sendAttachment({
            to: contact.phone_number,
            from: fromAccount,
            message: replyText,
            mediaUrl: imageUrl
          });
          this.stats.totalMmsSent++;
        } else {
          console.log(`💬 Sending iMessage via BlueBubbles`);
          result = await this.bluebubblesService.sendMessage({
            to: contact.phone_number,
            from: fromAccount,
            message: replyText
          });
          this.stats.totaliMessageSent++;
        }
        
        console.log(`✅ iMessage sent! GUID: ${result.guid}`);
        this.stats.totalSmsSent++;
        return { success: true, provider: 'bluebubbles', result };
        
      } else {
        return await this.sendViaTallBob(contact, replyText, imageUrl);
      }
      
    } catch (error) {
      console.error(`❌ Error sending reply:`, error.message);
      console.log(`🔄 Falling back to SMS...`);
      return await this.sendViaTallBob(contact, replyText, imageUrl);
    }
  }
  
  async sendViaTallBob(contact, replyText, imageUrl) {
    try {
      if (imageUrl) {
        this.trackApiCall('sendMMS', 'sendMMS');
        console.log(`📸 Sending MMS via Tall Bob to ${contact.phone_number}`);
        
        const mmsResponse = await this.tallbobService.sendMMS({
          to: contact.phone_number,
          from: process.env.TALLBOB_NUMBER || '+61428616133',
          message: replyText,
          mediaUrl: imageUrl,
          reference: `mms_${contact.contact_id}_${Date.now()}`
        });
        
        console.log(`✅ MMS sent! ID: ${mmsResponse.messageId}`);
        this.stats.totalMmsSent++;
        this.stats.totalSmsSent++;
        return { success: true, provider: 'tallbob', result: mmsResponse };
      } else {
        this.trackApiCall('sendSMS', 'sendSMS');
        console.log(`💬 Sending SMS via Tall Bob to ${contact.phone_number}`);
        
        const smsResponse = await this.tallbobService.sendSMS({
          to: contact.phone_number,
          from: process.env.TALLBOB_NUMBER || '+61428616133',
          message: replyText,
          reference: `sms_${contact.contact_id}_${Date.now()}`
        });
        
        console.log(`✅ SMS sent! ID: ${smsResponse.messageId}`);
        this.stats.totalSmsSent++;
        return { success: true, provider: 'tallbob', result: smsResponse };
      }
    } catch (error) {
      console.error(`❌ Tall Bob send failed:`, error.message);
      throw error;
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
          lowerUrl.includes('imgur.com') || lowerUrl.includes('i.imgur.com')) {
        return url;
      }
    }
    return null;
  }

  async poll() {
    if (this.lastErrorTime > 0) {
      const timeSinceError = Date.now() - this.lastErrorTime;
      if (timeSinceError < this.delayAfterError) {
        console.log(`🧊 In error cooldown, skipping poll`);
        this.isPolling = false;
        return;
      }
    }

    if (this.isRateLimited()) {
      this.isPolling = false;
      return;
    }

    this.isPolling = true;
    const startTime = Date.now();

    try {
      console.log(`\n🔍 POLLING STARTED at ${new Date().toLocaleTimeString()}`);
      console.log(`📊 ${this.getApiUsageString()}`);
      
      const contacts = await this.tracker.getContactsToCheck(this.batchSize);
      console.log(`📋 Found ${contacts.length} contacts to check`);
      
      if (contacts.length === 0) {
        console.log(`📭 No contacts to check`);
        await new Promise(resolve => setTimeout(resolve, this.delayBetweenPolls));
        this.isPolling = false;
        return;
      }

      let processedCount = 0;
      let newReplies = 0;
      let skippedComments = 0;

      for (const contact of contacts) {
        if (this.isRateLimited()) break;

        try {
          console.log(`\n--- Contact ${processedCount + 1}/${contacts.length}: ${contact.phone_number} (ID: ${contact.contact_id}) ---`);
          
          this.trackApiCall('searchConversations', 'searchConversations');
          
          const conversations = await this.ghlService.searchConversations({
            contactId: contact.contact_id,
            limit: 5
          });

          this.checkRateLimitHeaders(conversations?.headers, 'searchConversations');
          this.consecutiveErrors = 0;

          let latestComment = null;
          
          if (conversations && conversations.length > 0) {
            console.log(`   Found ${conversations.length} conversations`);
            
            for (const conv of conversations) {
              if (conv.lastInternalComment) {
                console.log(`   Conversation ${conv.id}: lastInternalComment = "${conv.lastInternalComment?.substring(0, 50)}..."`);
                
                if (!latestComment || new Date(conv.lastMessageAt) > new Date(latestComment.date)) {
                  latestComment = {
                    text: conv.lastInternalComment,
                    date: conv.lastMessageAt,
                    conversationId: conv.id
                  };
                }
              }
            }
          } else {
            console.log(`   No conversations found`);
          }
          
          if (latestComment) {
            console.log(`\n📝 Found internal comment: "${latestComment.text.substring(0, 100)}"`);
            const imageUrl = this.extractImageUrl(latestComment.text);
            
            if (latestComment.text.trim().toLowerCase().startsWith('@reply')) {
              console.log(`⏭️ Skipping @reply comment (internal team note)`);
              skippedComments++;
            } else {
              const replyText = latestComment.text.trim();
              
              if (replyText) {
                console.log(`🔍 Checking if comment is new...`);
                const { isNew } = await this.tracker.checkComment(
                  contact.contact_id,
                  latestComment.text,
                  replyText
                );

                if (isNew) {
                  console.log(`✨ New comment detected! Sending reply...`);
                  const sendResult = await this.sendReplyWithProvider(
                    contact,
                    replyText,
                    imageUrl,
                    process.env.GHL_LOCATION_ID
                  );
                  
                  console.log(`✅ Reply sent successfully via ${sendResult.provider.toUpperCase()}`);
                  newReplies++;
                  
                } else {
                  console.log(`⏭️ Comment already processed, skipping`);
                }
              } else {
                console.log(`⚠️ Empty comment, skipping`);
              }
            }
          } else {
            console.log(`📭 No internal comments found for this contact`);
          }

          processedCount++;
          
          if (processedCount < contacts.length) {
            console.log(`⏱️ Waiting ${this.delayBetweenContacts/1000} seconds before next contact...`);
            await new Promise(resolve => setTimeout(resolve, this.delayBetweenContacts));
          }

        } catch (err) {
          console.error(`❌ Error processing contact ${contact.contact_id}:`, err.message);
          this.stats.errors++;
          this.consecutiveErrors++;
          
          if (this.consecutiveErrors >= 2) {
            console.log(`🔥 Multiple errors, entering cooldown`);
            this.lastErrorTime = Date.now();
            break;
          }
        }
      }

      const duration = Date.now() - startTime;
      this.stats.totalChecks += contacts.length;
      this.stats.totalSkipped += skippedComments;
      this.stats.lastRun = new Date().toISOString();

      console.log(`\n✅ POLL COMPLETE:`);
      console.log(`   • Processed: ${processedCount}/${contacts.length} contacts`);
      console.log(`   • New replies sent: ${newReplies}`);
      console.log(`   • Skipped: ${skippedComments}`);
      console.log(`   • iMessages sent total: ${this.stats.totaliMessageSent}`);
      console.log(`   • SMS/MMS sent total: ${this.stats.totalMmsSent}`);
      console.log(`   • Duration: ${Math.round(duration/1000)} seconds`);
      
      console.log(`\n⏱️ Waiting ${this.delayBetweenPolls/60000} minutes before next poll`);
      await new Promise(resolve => setTimeout(resolve, this.delayBetweenPolls));

    } catch (error) {
      console.error(`❌ POLLING ERROR:`, error);
      this.stats.errors++;
      this.lastErrorTime = Date.now();
    } finally {
      this.isPolling = false;
    }
  }

  async syncContacts() {
    if (this.isRateLimited() || this.isSyncing) return;
    
    this.isSyncing = true;
    console.log(`\n🔄 CONTACT SYNC STARTED...`);
    
    try {
      let page = 1;
      let hasMore = true;
      let totalAdded = 0;

      while (hasMore && !this.isRateLimited()) {
        console.log(`📦 Fetching page ${page}...`);
        
        this.trackApiCall('searchContacts', 'searchContacts');
        
        const response = await this.ghlService.client.contacts.searchContactsAdvanced({
          locationId: process.env.GHL_LOCATION_ID,
          pageLimit: this.syncBatchSize,
          page: page
        });

        const contacts = response.contacts || [];
        
        for (const contact of contacts) {
          if (contact.phone) {
            await this.tracker.addContact(contact.id, contact.phone);
            totalAdded++;
          }
        }
        
        hasMore = contacts.length === this.syncBatchSize;
        page++;
        
        if (hasMore) {
          await new Promise(resolve => setTimeout(resolve, this.delayBetweenPages));
        }
      }
      
      console.log(`✅ SYNC COMPLETE: Added ${totalAdded} contacts`);
      
    } catch (error) {
      console.error(`❌ SYNC ERROR:`, error.message);
    } finally {
      this.isSyncing = false;
    }
  }

  getStats() {
    return {
      polling: {
        ...this.stats,
        trackedContacts: this.tracker.getCount ? this.tracker.getCount() : 0,
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