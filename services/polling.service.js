// services/polling.service.js
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
    
    // Control initial sync delay (default to 0 for immediate sync)
    this.initialSyncDelay = options.initialSyncDelay || 0;
    
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
    
    console.log('📊 PollingService instance created');
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
    return null;
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
    console.log(`===============================================`);
    console.log(`⏱️ DELAY CONFIGURATION:`);
    console.log(`   • Between contacts: ${this.delayBetweenContacts/1000} seconds`);
    console.log(`   • After rate limit: ${this.delayAfterRateLimit/60000} minutes`);
    console.log(`   • Between polls: ${this.delayBetweenPolls/60000} minutes`);
    console.log(`   • After error: ${this.delayAfterError/60000} minutes`);
    console.log(`   • Poll interval: ${this.pollInterval}`);
    console.log(`   • Batch size: ${this.batchSize} contacts per poll`);
    console.log(`   • Sync interval: ${this.syncInterval}`);
    console.log(`   • Sync batch size: ${this.syncBatchSize} contacts per page`);
    console.log(`   • Initial sync delay: ${this.initialSyncDelay/60000} minutes`);
    console.log(`===============================================\n`);
    
    console.log(`📊 Rate limit monitoring enabled`);
    console.log(`🔄 Provider detection enabled (using contact tags)`);
    
    if (this.tracker && typeof this.tracker.initialize === 'function') {
      await this.tracker.initialize();
      console.log('✅ Tracker initialized');
    } else {
      console.log('⚠️ Tracker has no initialize method');
    }
    
    this.startPolling();
    console.log('✅ Polling scheduler started');
    
    this.startContactSync();
    console.log('✅ Contact sync scheduler started');
    
    // Run initial sync based on configured delay
    if (this.initialSyncDelay === 0) {
      console.log(`🔄 Running initial contact sync IMMEDIATELY...`);
      setImmediate(async () => {
        await this.syncContacts().catch(console.error);
      });
    } else {
      setTimeout(() => {
        console.log(`⏰ Delaying initial contact sync by ${this.initialSyncDelay/60000} minutes...`);
        setTimeout(() => {
          console.log(`🔄 Running initial contact sync...`);
          this.syncContacts().catch(console.error);
        }, this.initialSyncDelay);
      }, 1000);
    }
    
    setInterval(() => {
      const hourOfDay = new Date().getHours();
      const hoursRemaining = 24 - hourOfDay;
      const projectedTotal = this.apiCalls.total + (this.apiCalls.total / (hourOfDay + 1)) * hoursRemaining;
      this.logApiUsage(projectedTotal);
    }, 3600000);
    
    setInterval(() => {
      if (this.lastRateLimitHeaders.lastChecked) {
        console.log(`\n🕐 RATE LIMIT STATUS CHECK:`);
        console.log(`   • Daily remaining: ${this.lastRateLimitHeaders.dailyRemaining}/${this.lastRateLimitHeaders.dailyLimit}`);
        console.log(`   • Burst remaining: ${this.lastRateLimitHeaders.burstRemaining || 'N/A'}`);
        console.log(`   • Last updated: ${new Date(this.lastRateLimitHeaders.lastChecked).toLocaleTimeString()}`);
      }
    }, 300000);
    
    console.log(`\n✅ Polling service initialization complete!\n`);
  }

  startPolling() {
    console.log(`⏰ Starting poller (batch: ${this.batchSize}, interval: ${this.pollInterval})`);
    
    cron.schedule(this.pollInterval, async () => {
      console.log(`\n🔔🔔🔔 CRON TRIGGERED - Starting poll cycle at ${new Date().toLocaleTimeString()} 🔔🔔🔔`);
      
      if (this.lastErrorTime > 0) {
        const timeSinceError = Date.now() - this.lastErrorTime;
        if (timeSinceError < this.delayAfterError) {
          const waitRemaining = Math.ceil((this.delayAfterError - timeSinceError) / 60000);
          console.log(`🧊 In error cooldown: ${waitRemaining} minutes remaining - SKIPPING POLL`);
          return;
        } else {
          console.log(`🧊 Error cooldown expired, resuming polling`);
          this.lastErrorTime = 0;
          this.consecutiveErrors = 0;
        }
      }
      
      if (this.isRateLimited()) {
        console.log(`⏭️ Rate limited - SKIPPING POLL`);
        return;
      }
      
      if (this.isPolling) {
        console.log(`⚠️ Previous poll still running - SKIPPING`);
        return;
      }
      
      console.log(`✅ All checks passed, starting poll...`);
      await this.poll();
    });
  }

  startContactSync() {
    console.log(`⏰ Starting contact sync (interval: ${this.syncInterval})`);
    
    cron.schedule(this.syncInterval, async () => {
      if (this.isRateLimited()) {
        console.log(`⏭️ Skipping sync due to rate limit`);
        return;
      }
      if (this.isSyncing) {
        console.log(`⚠️ Previous sync still running`);
        return;
      }
      await this.syncContacts();
    });
  }

  async getProviderForReply(contactId, locationId, contactTags = []) {
    try {
      console.log(`🔍 [PROVIDER DETECTION] Contact: ${contactId}`);
      console.log(`   Contact tags: ${contactTags.join(', ') || 'none'}`);
      
      // STEP 1: Check tags first (no extra API call needed!)
      const hasiMessageTag = contactTags.includes('has_imessage') || 
                             contactTags.includes('imessage_capable');
      
      if (hasiMessageTag) {
        console.log(`   ✅ Contact has iMessage tag - using BlueBubbles`);
        return { provider: 'bluebubbles', reason: 'Contact has iMessage tag' };
      }
      
      // STEP 2: Get conversations (need this to check message history)
      const conversations = await this.ghlService.searchConversations({
        contactId: contactId,
        limit: 5,
        locationId: locationId
      });
      
      console.log(`   Found ${conversations?.length || 0} conversations`);
      
      if (!conversations || conversations.length === 0) {
        console.log(`   ⚠️ No conversations found, defaulting to SMS`);
        return { provider: 'tallbob', reason: 'No conversation history' };
      }
      
      // STEP 3: Look for message history
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
            const provider = latestMessage.provider || this.detectProviderFromMessage(latestMessage);
            
            if (!lastMessageDate || messageDate > lastMessageDate) {
              lastMessageDate = messageDate;
              lastProvider = provider;
            }
          }
        }
      }
      
      // STEP 4: Decision based on message history
      if (lastProvider === 'BlueBubbles' || lastProvider === 'iMessage') {
        console.log(`   ✅ Replying via BlueBubbles (iMessage) - based on message history`);
        return { provider: 'bluebubbles', reason: 'Last message was iMessage' };
      }
      
      if (lastProvider === 'Tall Bob' || lastProvider === 'SMS' || lastProvider === 'MMS') {
        console.log(`   ✅ Replying via Tall Bob (SMS/MMS) - based on message history`);
        return { provider: 'tallbob', reason: 'Last message was SMS/MMS' };
      }
      
      // STEP 5: Check conversation type
      for (const conv of conversations) {
        if (conv.type === 'iMessage' || conv.type?.toLowerCase().includes('imessage')) {
          console.log(`   ✅ Replying via BlueBubbles (iMessage) - conversation type is iMessage`);
          return { provider: 'bluebubbles', reason: 'Conversation type is iMessage' };
        }
      }
      
      // STEP 6: Final fallback to SMS
      console.log(`   ⚠️ Defaulting to Tall Bob (SMS) - no iMessage indicators found`);
      return { provider: 'tallbob', reason: 'Defaulting to SMS' };
      
    } catch (error) {
      console.error(`   ❌ Error determining provider:`, error.message);
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
  
  async sendReplyWithProvider(contact, replyText, imageUrl, locationId, contactTags = []) {
  try {
    console.log(`\n📤 ===== SENDING REPLY =====`);
    console.log(`   Contact ID: ${contact.contact_id}`);
    console.log(`   Phone: ${contact.phone_number}`);
    console.log(`   Message: "${replyText.substring(0, 100)}"`);
    
    const { provider, reason } = await this.getProviderForReply(contact.contact_id, locationId, contactTags);
    
    console.log(`   Routing: ${provider.toUpperCase()} - ${reason}`);
    
    let result;
    
    if (provider === 'bluebubbles') {
      if (!this.bluebubblesService) {
        console.error(`   ❌ BlueBubbles service not configured, falling back to SMS`);
        return await this.sendViaTallBob(contact, replyText, imageUrl);
      }
      
      this.trackApiCall('sendiMessage', 'sendiMessage');
      
      // Get the iMessage account to send from
      const fromAccount = process.env.BLUEBUBBLES_IMESSAGE_ACCOUNT || contact.phone_number;
      
      // Try to get the chat GUID for this contact
      let chatGuid = null;
      try {
        chatGuid = await this.bluebubblesService.getChatGuid(contact.phone_number);
        if (chatGuid) {
          console.log(`   Found chat GUID: ${chatGuid}`);
        }
      } catch (err) {
        console.log(`   Could not get chat GUID: ${err.message}`);
      }
      
      if (imageUrl) {
        result = await this.bluebubblesService.sendAttachment({
          to: contact.phone_number,
          from: fromAccount,
          message: replyText,
          mediaUrl: imageUrl,
          chatGuid: chatGuid
        });
        this.stats.totalMmsSent++;
      } else {
        result = await this.bluebubblesService.sendMessage({
          to: contact.phone_number,
          from: fromAccount,
          message: replyText,
          chatGuid: chatGuid
        });
        this.stats.totaliMessageSent++;
      }
      
      console.log(`   ✅ iMessage sent! GUID: ${result.guid}`);
      this.stats.totalSmsSent++;
      return { success: true, provider: 'bluebubbles', result };
      
    } else {
      return await this.sendViaTallBob(contact, replyText, imageUrl);
    }
    
  } catch (error) {
    console.error(`   ❌ Error sending reply:`, error.message);
    console.log(`   🔄 Falling back to SMS...`);
    return await this.sendViaTallBob(contact, replyText, imageUrl);
  }
}
  
  async sendViaTallBob(contact, replyText, imageUrl) {
    try {
      if (imageUrl) {
        this.trackApiCall('sendMMS', 'sendMMS');
        console.log(`   📸 Sending MMS via Tall Bob to ${contact.phone_number}`);
        
        const mmsResponse = await this.tallbobService.sendMMS({
          to: contact.phone_number,
          from: process.env.TALLBOB_NUMBER || '+61428616133',
          message: replyText,
          mediaUrl: imageUrl,
          reference: `mms_${contact.contact_id}_${Date.now()}`
        });
        
        console.log(`   ✅ MMS sent! ID: ${mmsResponse.messageId}`);
        this.stats.totalMmsSent++;
        this.stats.totalSmsSent++;
        return { success: true, provider: 'tallbob', result: mmsResponse };
      } else {
        this.trackApiCall('sendSMS', 'sendSMS');
        console.log(`   💬 Sending SMS via Tall Bob to ${contact.phone_number}`);
        
        const smsResponse = await this.tallbobService.sendSMS({
          to: contact.phone_number,
          from: process.env.TALLBOB_NUMBER || '+61428616133',
          message: replyText,
          reference: `sms_${contact.contact_id}_${Date.now()}`
        });
        
        console.log(`   ✅ SMS sent! ID: ${smsResponse.messageId}`);
        this.stats.totalSmsSent++;
        return { success: true, provider: 'tallbob', result: smsResponse };
      }
    } catch (error) {
      console.error(`   ❌ Tall Bob send failed:`, error.message);
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
    console.log(`\n🔍🔍🔍 POLL STARTED at ${new Date().toLocaleTimeString()} 🔍🔍🔍`);
    console.log(`📊 ${this.getApiUsageString()}`);
    
    if (this.lastErrorTime > 0) {
      const timeSinceError = Date.now() - this.lastErrorTime;
      if (timeSinceError < this.delayAfterError) {
        const waitRemaining = Math.ceil((this.delayAfterError - timeSinceError) / 60000);
        console.log(`🧊 In error cooldown: ${waitRemaining} minutes remaining - SKIPPING POLL`);
        this.isPolling = false;
        return;
      } else {
        console.log(`🧊 Error cooldown expired`);
        this.lastErrorTime = 0;
        this.consecutiveErrors = 0;
      }
    }

    if (this.isRateLimited()) {
      console.log(`⏭️ Rate limited - SKIPPING POLL`);
      this.isPolling = false;
      return;
    }

    this.isPolling = true;
    const startTime = Date.now();

    try {
      console.log(`📋 STEP 1: Getting contacts from tracker...`);
      const contacts = await this.tracker.getContactsToCheck(this.batchSize);
      console.log(`   Found ${contacts.length} contacts to check`);
      
      if (contacts.length === 0) {
        console.log(`📭 No contacts to check, waiting ${this.delayBetweenPolls/60000} minutes`);
        await new Promise(resolve => setTimeout(resolve, this.delayBetweenPolls));
        this.isPolling = false;
        return;
      }

      console.log(`📋 Contacts list:`);
      contacts.forEach((c, i) => {
        console.log(`   ${i+1}. ID: ${c.contact_id}, Phone: ${c.phone_number}`);
      });

      let processedCount = 0;
      let newReplies = 0;
      let skippedComments = 0;
      let noCommentsCount = 0;
      let errorCount = 0;

      for (const contact of contacts) {
        if (this.isRateLimited()) {
          console.log(`⏭️ Rate limit active, stopping poll early`);
          break;
        }

        try {
          console.log(`\n--- Contact ${processedCount + 1}/${contacts.length}: ${contact.phone_number} (ID: ${contact.contact_id}) ---`);
          
          // Get contact tags (one API call per contact - unavoidable but necessary)
          let contactTags = [];
          try {
            const ghlContact = await this.ghlService.getContact(contact.contact_id);
            contactTags = ghlContact.tags || [];
            console.log(`   Tags: ${contactTags.join(', ') || 'none'}`);
          } catch (err) {
            console.log(`   Could not fetch contact tags: ${err.message}`);
          }
          
          this.trackApiCall('searchConversations', 'searchConversations');
          
          console.log(`   STEP 2: Searching GHL conversations...`);
          const conversations = await this.ghlService.searchConversations({
            contactId: contact.contact_id,
            limit: 5
          });

          this.checkRateLimitHeaders(conversations?.headers, 'searchConversations');
          this.consecutiveErrors = 0;

          console.log(`   Found ${conversations?.length || 0} conversations`);
          
          if (conversations && conversations.length > 0) {
            conversations.forEach((conv, idx) => {
              console.log(`      Conv ${idx+1}: ID=${conv.id}, Type=${conv.type}, LastMsg=${conv.lastMessageAt}`);
              if (conv.lastInternalComment) {
                console.log(`         📝 Internal comment: "${conv.lastInternalComment.substring(0, 100)}"`);
              }
            });
          } else {
            console.log(`   ⚠️ No conversations found for this contact`);
            noCommentsCount++;
            processedCount++;
            continue;
          }

          console.log(`   STEP 3: Looking for internal comments...`);
          let latestComment = null;
          
          for (const conv of conversations) {
            if (conv.lastInternalComment) {
              console.log(`      Found comment in conv ${conv.id}: "${conv.lastInternalComment.substring(0, 50)}..."`);
              if (!latestComment || new Date(conv.lastMessageAt) > new Date(latestComment.date)) {
                latestComment = {
                  text: conv.lastInternalComment,
                  date: conv.lastMessageAt,
                  conversationId: conv.id
                };
                console.log(`      ✅ This is the latest comment (${conv.lastMessageAt})`);
              }
            }
          }
          
          if (latestComment) {
            console.log(`\n   📝 LATEST COMMENT FOUND:`);
            console.log(`      Text: "${latestComment.text}"`);
            console.log(`      Date: ${latestComment.date}`);
            console.log(`      Conv ID: ${latestComment.conversationId}`);
            
            const imageUrl = this.extractImageUrl(latestComment.text);
            if (imageUrl) {
              console.log(`      📸 Image detected: ${imageUrl}`);
            }
            
            const isReplyComment = latestComment.text.trim().toLowerCase().startsWith('@reply');
            
            if (isReplyComment) {
              console.log(`      ⏭️ Comment starts with @reply - SKIPPING (internal note)`);
              skippedComments++;
            } else {
              const replyText = latestComment.text.trim();
              console.log(`      💬 Will send: "${replyText.substring(0, 100)}"`);
              
              console.log(`   STEP 4: Checking if comment is new...`);
              const { isNew } = await this.tracker.checkComment(
                contact.contact_id,
                latestComment.text,
                replyText
              );

              console.log(`      isNew = ${isNew}`);
              
              if (isNew) {
                console.log(`   ✨ NEW COMMENT DETECTED! Sending reply...`);
                const sendResult = await this.sendReplyWithProvider(
                  contact,
                  replyText,
                  imageUrl,
                  process.env.GHL_LOCATION_ID,
                  contactTags
                );
                
                console.log(`   ✅ Reply sent successfully via ${sendResult.provider.toUpperCase()}`);
                newReplies++;
              } else {
                console.log(`   ⏭️ Comment already processed, skipping`);
              }
            }
          } else {
            console.log(`   📭 No internal comments found in any conversation`);
            noCommentsCount++;
          }

          processedCount++;
          
          if (processedCount < contacts.length) {
            console.log(`\n⏱️ Waiting ${this.delayBetweenContacts/1000} seconds before next contact...`);
            await new Promise(resolve => setTimeout(resolve, this.delayBetweenContacts));
          }

        } catch (err) {
          errorCount++;
          console.error(`\n❌ ERROR processing contact ${contact.contact_id}:`);
          console.error(`   Error: ${err.message}`);
          if (err.stack) console.error(`   Stack: ${err.stack}`);
          this.stats.errors++;
          this.consecutiveErrors++;
          
          if (err.statusCode === 429) {
            console.log(`   🚦 RATE LIMIT HIT!`);
            this.stats.rateLimitHits++;
            this.apiCalls.rateLimitHits++;
            this.setRateLimit(this.delayAfterRateLimit);
            break;
          }
          
          if (this.consecutiveErrors >= 2) {
            console.log(`   🔥 Multiple errors (${this.consecutiveErrors}), entering cooldown`);
            this.lastErrorTime = Date.now();
            break;
          }
        }
      }

      const duration = Date.now() - startTime;
      this.stats.totalChecks += contacts.length;
      this.stats.totalSkipped += skippedComments;
      this.stats.lastRun = new Date().toISOString();

      console.log(`\n✅✅✅ POLL COMPLETE ✅✅✅`);
      console.log(`   ⏱️ Duration: ${Math.round(duration/1000)} seconds`);
      console.log(`   📊 Statistics:`);
      console.log(`      • Contacts processed: ${processedCount}/${contacts.length}`);
      console.log(`      • New replies sent: ${newReplies}`);
      console.log(`      • Skipped (@reply): ${skippedComments}`);
      console.log(`      • No comments found: ${noCommentsCount}`);
      console.log(`      • Errors: ${errorCount}`);
      console.log(`   📈 Cumulative totals:`);
      console.log(`      • iMessages sent: ${this.stats.totaliMessageSent}`);
      console.log(`      • SMS/MMS sent: ${this.stats.totalMmsSent}`);
      console.log(`      • Total messages: ${this.stats.totalSmsSent + this.stats.totaliMessageSent}`);
      console.log(`   ${this.getApiUsageString()}`);
      
      console.log(`\n⏱️ Waiting ${this.delayBetweenPolls/60000} minutes before next poll`);
      await new Promise(resolve => setTimeout(resolve, this.delayBetweenPolls));

    } catch (error) {
      console.error(`\n💥💥💥 POLLING FATAL ERROR 💥💥💥`);
      console.error(`   Error: ${error.message}`);
      if (error.stack) console.error(`   Stack: ${error.stack}`);
      this.stats.errors++;
      this.lastErrorTime = Date.now();
    } finally {
      this.isPolling = false;
      console.log(`🔒 Poll lock released`);
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
      const currentContactIds = new Set();

      while (hasMore && !this.isRateLimited()) {
        console.log(`📦 Fetching page ${page}...`);
        
        this.trackApiCall('searchContacts', 'searchContacts');
        
        const response = await this.ghlService.client.contacts.searchContactsAdvanced({
          locationId: process.env.GHL_LOCATION_ID,
          pageLimit: this.syncBatchSize,
          page: page
        });

        const contacts = response.contacts || [];
        console.log(`   Received ${contacts.length} contacts`);
        
        for (const contact of contacts) {
          if (contact.phone) {
            await this.tracker.addContact(contact.id, contact.phone);
            currentContactIds.add(contact.id);
            totalAdded++;
          }
        }
        
        hasMore = contacts.length === this.syncBatchSize;
        page++;
        
        if (hasMore) {
          await new Promise(resolve => setTimeout(resolve, this.delayBetweenPages));
        }
      }
      
      // Remove stale contacts that no longer exist in GHL
      console.log(`\n🧹 Checking for stale contacts...`);
      const allTrackedContacts = await this.tracker.getContactsToCheck(10000);
      let staleRemoved = 0;
      
      for (const trackedContact of allTrackedContacts) {
        if (!currentContactIds.has(trackedContact.contact_id)) {
          console.log(`   🗑️ Removing stale contact: ${trackedContact.contact_id} (${trackedContact.phone_number})`);
          await this.tracker.removeContact(trackedContact.contact_id);
          staleRemoved++;
        }
      }
      
      const finalCount = await this.tracker.getCount();
      console.log(`\n✅ SYNC COMPLETE:`);
      console.log(`   • Contacts added: ${totalAdded}`);
      console.log(`   • Stale removed: ${staleRemoved}`);
      console.log(`   • Total in tracker: ${finalCount}`);
      
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