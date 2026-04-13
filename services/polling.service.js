// services/polling.service.js
import cron from 'node-cron';

class PollingService {
  constructor(ghlService, tallbobService, tracker, bluebubblesService, options = {}) {
    this.ghlService = ghlService;
    this.tallbobService = tallbobService;
    this.bluebubblesService = bluebubblesService;
    this.tracker = tracker;
    
    // DETERMINE PROVIDER FROM ENVIRONMENT VARIABLE
    const useIMessage = process.env.IMESSAGEORSMS === 'true';
    this.provider = useIMessage ? 'bluebubbles' : 'tallbob';
    
    console.log(`📱 Provider configured: ${this.provider.toUpperCase()} (IMESSAGEORSMS=${process.env.IMESSAGEORSMS})`);
    
    // 30 CONTACTS/HOUR CONFIGURATION
    this.batchSize = options.batchSize || 5;                    // 5 contacts per poll
    this.syncBatchSize = options.syncBatchSize || 10;
    this.pollInterval = options.pollInterval || '*/12 * * * *'; // Every 12 minutes (5 polls/hour)
    
    // TIMING CONFIGURATION FOR 30 CONTACTS/HOUR
    this.delayBetweenContacts = options.delayBetweenContacts || 36000;  // 36 seconds between contacts
    this.delayAfterRateLimit = options.delayAfterRateLimit || 600000;  // 10 minutes
    this.delayBetweenPolls = options.delayBetweenPolls || 120000;      // 2 minutes between polls
    this.delayAfterError = options.delayAfterError || 300000;          // 5 minutes
    this.delayBetweenPages = options.delayBetweenPages || 2000;        // 2 seconds
    this.syncInterval = options.syncInterval || '0 */4 * * *';         // Every 4 hours
    
    // Active contact sync settings
    this.syncOnlyActive = options.syncOnlyActive !== false;
    this.activeDaysThreshold = options.activeDaysThreshold || 60;
    
    // Control initial sync delay
    this.initialSyncDelay = options.initialSyncDelay || 0;
    
    // Status flags
    this.isPolling = false;
    this.isSyncing = false;
    this.rateLimitedUntil = 0;
    this.lastErrorTime = 0;
    this.consecutiveErrors = 0;
    
    // Rate limiting - API call tracking (optimized for 30 contacts/hour)
    this.lastApiCallTime = 0;
    this.minDelayBetweenCalls = 1500;      // 1.5 seconds minimum between API calls
    this.apiCallTimestamps = [];
    this.maxCallsPerMinute = 40;           // 40 calls per minute (well below GHL's 100 limit)
    
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
      staleContactsRemoved: 0,
      lastRun: null,
      errors: 0,
      rateLimitHits: 0,
      rateLimitWaits: 0
    };
    
    console.log('📊 PollingService instance created');
    console.log(`   Provider: ${this.provider.toUpperCase()} (from IMESSAGEORSMS env var)`);
    console.log(`   Target: 30 contacts/hour`);
    console.log(`   Batch size: ${this.batchSize} contacts/poll`);
    console.log(`   Poll interval: ${this.pollInterval} (5 polls/hour)`);
    console.log(`   Delay between contacts: ${this.delayBetweenContacts/1000} seconds`);
    console.log(`   Expected throughput: ~${this.batchSize * 5} contacts/hour`);
    console.log(`   Active contact sync: ${this.syncOnlyActive ? 'ON' : 'OFF'}`);
    if (this.syncOnlyActive) {
      console.log(`   Active days threshold: ${this.activeDaysThreshold} days`);
    }
    console.log(`   ⚡ Rate limit protection: ${this.minDelayBetweenCalls/1000}s between API calls`);
    console.log(`   🚫 NO @ COMMANDS - Provider fixed by environment variable`);
  }

  // Helper delay function
  delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // Track API call rate and enforce delays
  async trackApiCallRate() {
    const now = Date.now();
    
    // Ensure minimum delay between calls
    if (this.lastApiCallTime) {
      const timeSinceLastCall = now - this.lastApiCallTime;
      if (timeSinceLastCall < this.minDelayBetweenCalls) {
        const waitTime = this.minDelayBetweenCalls - timeSinceLastCall;
        console.log(`⏸️ Rate limit protection: Waiting ${waitTime}ms before next API call`);
        await this.delay(waitTime);
      }
    }
    
    // Track timestamps for per-minute rate limiting
    this.apiCallTimestamps.push(now);
    this.apiCallTimestamps = this.apiCallTimestamps.filter(ts => now - ts < 60000);
    
    const callsInLastMinute = this.apiCallTimestamps.length;
    
    if (callsInLastMinute > this.maxCallsPerMinute - 10) {
      console.warn(`⚠️ High API call rate: ${callsInLastMinute} calls in last minute (limit: ${this.maxCallsPerMinute})`);
    }
    
    if (callsInLastMinute >= this.maxCallsPerMinute) {
      const oldestCall = this.apiCallTimestamps[0];
      const timeToWait = 60000 - (now - oldestCall) + 1000;
      console.warn(`🚦 Rate limit approaching! Waiting ${Math.ceil(timeToWait/1000)} seconds`);
      await this.delay(timeToWait);
      return this.trackApiCallRate();
    }
    
    this.lastApiCallTime = Date.now();
    return callsInLastMinute;
  }

  // Rate-limited API call wrapper
  async makeAPICall(fn, callName = 'API Call', retryCount = 0) {
    await this.trackApiCallRate();
    
    try {
      return await fn();
    } catch (error) {
      if ((error.statusCode === 429 || error.message?.includes('Too Many Requests')) && retryCount < 3) {
        const waitTime = (retryCount + 1) * 5000;
        console.log(`🚦 [${callName}] Rate limit hit! Retry ${retryCount + 1}/3 after ${waitTime/1000}s`);
        await this.delay(waitTime);
        return this.makeAPICall(fn, callName, retryCount + 1);
      }
      throw error;
    }
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
      
      if (dailyRemaining && parseInt(dailyRemaining) < 100) {
        console.warn(`⚠️ Daily rate limit low: only ${dailyRemaining} calls remaining!`);
      }
      if (burstRemaining && parseInt(burstRemaining) < 10) {
        console.warn(`⚠️ Burst rate limit low: only ${burstRemaining} calls remaining!`);
      }
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
    console.log(`📱 PROVIDER CONFIGURATION:`);
    console.log(`   IMESSAGEORSMS = ${process.env.IMESSAGEORSMS || 'not set'}`);
    console.log(`   Using provider: ${this.provider.toUpperCase()}`);
    console.log(`   ${this.provider === 'bluebubbles' ? '📱 Sending via iMessage (BlueBubbles)' : '📱 Sending via SMS (Tall Bob)'}`);
    console.log(`⏱️ 30 CONTACTS/HOUR CONFIGURATION:`);
    console.log(`   • Batch size: ${this.batchSize} contacts/poll`);
    console.log(`   • Poll interval: ${this.pollInterval} (5 polls/hour)`);
    console.log(`   • Between contacts: ${this.delayBetweenContacts/1000} seconds`);
    console.log(`   • Between polls: ${this.delayBetweenPolls/60000} minutes`);
    console.log(`   • Expected throughput: ~${this.batchSize * 5} contacts/hour`);
    console.log(`   • After rate limit: ${this.delayAfterRateLimit/60000} minutes`);
    console.log(`   • Min API delay: ${this.minDelayBetweenCalls/1000} seconds`);
    console.log(`   • Max API calls/minute: ${this.maxCallsPerMinute}`);
    console.log(`   • Sync interval: ${this.syncInterval}`);
    console.log(`   • Sync batch size: ${this.syncBatchSize} contacts/page`);
    console.log(`   • Active contact sync: ${this.syncOnlyActive ? 'ON' : 'OFF'}`);
    if (this.syncOnlyActive) {
      console.log(`   • Active days threshold: ${this.activeDaysThreshold} days`);
    }
    console.log(`===============================================\n`);
    
    console.log(`📊 Rate limit monitoring enabled`);
    
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

  extractDateFromMessage(message) {
    const possibleFields = [
      'dateAdded', 'dateUpdated', 'date', 'createdAt', 
      'created_at', 'timestamp', 'sentDate', 'messageDate', 
      'dateCreated', 'dateSent', 'time', 'lastMessageDate'
    ];
    
    for (const field of possibleFields) {
      if (message[field]) {
        const date = new Date(message[field]);
        if (!isNaN(date.getTime())) {
          return date;
        }
      }
    }
    
    return new Date(0);
  }
  
  async sendReply(contact, replyText, imageUrl, locationId) {
    try {
      console.log(`\n📤 ===== SENDING REPLY =====`);
      console.log(`   Contact ID: ${contact.contact_id}`);
      console.log(`   Phone: ${contact.phone_number}`);
      console.log(`   Provider: ${this.provider.toUpperCase()}`);
      console.log(`   Message: "${replyText.substring(0, 100)}"`);
      console.log(`   Image: ${imageUrl ? 'Yes (' + imageUrl + ')' : 'No'}`);
      
      let result;
      
      if (this.provider === 'bluebubbles') {
        if (!this.bluebubblesService) {
          const error = 'BlueBubbles service not configured';
          console.error(`   ❌ ${error}`);
          throw new Error(error);
        }
        
        this.trackApiCall('sendiMessage', 'sendiMessage');
        const fromAccount = process.env.BLUEBUBBLES_IMESSAGE_ACCOUNT || null;
        
        console.log(`   Sending via BlueBubbles (iMessage)...`);
        
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
        
        console.log(`   ✅ iMessage sent! GUID: ${result.guid}`);
        this.stats.totalSmsSent++;
        return { success: true, provider: 'bluebubbles', result };
        
      } else if (this.provider === 'tallbob') {
        console.log(`   Sending via Tall Bob (SMS/MMS)...`);
        
        if (imageUrl) {
          this.trackApiCall('sendMMS', 'sendMMS');
          console.log(`   📸 Sending MMS via Tall Bob to ${contact.phone_number}`);
          
          result = await this.tallbobService.sendMMS({
            to: contact.phone_number,
            from: process.env.TALLBOB_NUMBER || '+61428616133',
            message: replyText,
            mediaUrl: imageUrl,
            reference: `mms_${contact.contact_id}_${Date.now()}`
          });
          
          console.log(`   ✅ MMS sent! ID: ${result.messageId}`);
          this.stats.totalMmsSent++;
          this.stats.totalSmsSent++;
          return { success: true, provider: 'tallbob', result };
        } else {
          this.trackApiCall('sendSMS', 'sendSMS');
          console.log(`   💬 Sending SMS via Tall Bob to ${contact.phone_number}`);
          
          result = await this.tallbobService.sendSMS({
            to: contact.phone_number,
            from: process.env.TALLBOB_NUMBER || '+61428616133',
            message: replyText,
            reference: `sms_${contact.contact_id}_${Date.now()}`
          });
          
          console.log(`   ✅ SMS sent! ID: ${result.messageId}`);
          this.stats.totalSmsSent++;
          return { success: true, provider: 'tallbob', result };
        }
      } else {
        throw new Error(`Unknown provider: ${this.provider}`);
      }
      
    } catch (error) {
      console.error(`   ❌ Error sending reply:`, error.message);
      return { success: false, error: error.message, provider: this.provider };
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
    console.log(`📱 Using provider: ${this.provider.toUpperCase()}`);
    
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
    let staleRemovedThisPoll = 0;

    try {
      console.log(`📋 STEP 1: Getting contacts from tracker (prioritizing active)...`);
      const contacts = await this.tracker.getContactsToCheck(this.batchSize);
      console.log(`   Found ${contacts.length} contacts to check`);
      
      if (contacts.length === 0) {
        console.log(`📭 No contacts to check, waiting ${this.delayBetweenPolls/60000} minutes`);
        await this.delay(this.delayBetweenPolls);
        this.isPolling = false;
        return;
      }

      console.log(`📋 Contacts list (most active first):`);
      contacts.forEach((c, i) => {
        const lastActivity = c.last_activity ? new Date(c.last_activity).toLocaleDateString() : 'never';
        console.log(`   ${i+1}. ID: ${c.contact_id}, Phone: ${c.phone_number}, Last active: ${lastActivity}`);
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
          
          let contactTags = [];
          let lastActivityDate = null;
          let lastProvider = null;
          let contactExists = true;
          
          try {
            const ghlContact = await this.makeAPICall(
              () => this.ghlService.getContact(contact.contact_id),
              'getContact'
            );
            contactTags = ghlContact.tags || [];
            console.log(`   Tags: ${contactTags.join(', ') || 'none'}`);
          } catch (err) {
            if (err.statusCode === 400 && err.response?.message?.includes('Contact not found')) {
              console.log(`   🗑️ Contact ${contact.contact_id} no longer exists in GHL - marking as stale`);
              contactExists = false;
              
              if (staleRemovedThisPoll < 5) {
                await this.tracker.removeContact(contact.contact_id);
                staleRemovedThisPoll++;
                this.stats.staleContactsRemoved++;
                console.log(`   ✅ Stale contact removed from tracker`);
              }
              processedCount++;
              continue;
            } else {
              console.log(`   Could not fetch contact tags: ${err.message}`);
            }
          }
          
          if (!contactExists) {
            processedCount++;
            continue;
          }
          
          this.trackApiCall('searchConversations', 'searchConversations');
          
          console.log(`   STEP 2: Searching GHL conversations...`);
          const conversations = await this.makeAPICall(
            () => this.ghlService.searchConversations({
              contactId: contact.contact_id,
              limit: 5
            }),
            'searchConversations'
          );

          this.checkRateLimitHeaders(conversations?.headers, 'searchConversations');
          this.consecutiveErrors = 0;

          console.log(`   Found ${conversations?.length || 0} conversations`);
          
          if (conversations && conversations.length > 0) {
            for (const conv of conversations) {
              if (conv.lastMessageDate) {
                const convDate = new Date(conv.lastMessageDate);
                if (!lastActivityDate || convDate > lastActivityDate) {
                  lastActivityDate = convDate;
                }
              }
              if (conv.type === 'iMessage') {
                lastProvider = 'BlueBubbles';
              } else if (conv.type === 'SMS') {
                lastProvider = 'Tall Bob';
              }
            }
            
            if (lastActivityDate) {
              await this.tracker.updateContactActivity(contact.contact_id, {
                last_activity: lastActivityDate.getTime(),
                last_provider: lastProvider
              });
            }
            
            conversations.forEach((conv, idx) => {
              console.log(`      Conv ${idx+1}: ID=${conv.id}, Type=${conv.type}, LastMsgDate=${conv.lastMessageDate}`);
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
              if (!latestComment || new Date(conv.lastMessageDate) > new Date(latestComment.date)) {
                latestComment = {
                  text: conv.lastInternalComment,
                  date: conv.lastMessageDate,
                  conversationId: conv.id
                };
                console.log(`      ✅ This is the latest comment (${conv.lastMessageDate})`);
              }
            }
          }
          
          if (latestComment) {
            console.log(`\n   📝 LATEST COMMENT FOUND:`);
            console.log(`      Original: "${latestComment.text}"`);
            console.log(`      Date: ${latestComment.date}`);
            console.log(`      Conv ID: ${latestComment.conversationId}`);
            
            const cleanMessage = latestComment.text.trim();
            const imageUrl = this.extractImageUrl(cleanMessage);
            
            if (imageUrl) {
              console.log(`      📸 Image detected: ${imageUrl}`);
            }
            
            if (cleanMessage.toLowerCase().startsWith('@reply')) {
              console.log(`      ⏭️ Comment starts with @reply - SKIPPING (internal note)`);
              skippedComments++;
            } else if (cleanMessage.trim()) {
              console.log(`   STEP 4: Checking if comment is new...`);
              const { isNew, hash } = await this.tracker.checkComment(
                contact.contact_id,
                latestComment.text,
                latestComment.conversationId
              );

              console.log(`      isNew = ${isNew}`);
              
              if (isNew) {
                console.log(`   ✨ NEW COMMENT DETECTED! Sending reply...`);
                const sendResult = await this.sendReply(
                  contact,
                  cleanMessage,
                  imageUrl,
                  process.env.GHL_LOCATION_ID
                );
                
                if (sendResult.success) {
                  console.log(`   ✅ Reply sent successfully via ${sendResult.provider.toUpperCase()}`);
                  await this.tracker.markCommentProcessed(
                    contact.contact_id,
                    latestComment.text,
                    hash,
                    latestComment.conversationId
                  );
                  newReplies++;
                } else {
                  console.log(`   ❌ Failed to send via ${sendResult.provider || 'selected provider'}`);
                }
              } else {
                console.log(`   ⏭️ Comment already processed, skipping`);
              }
            } else {
              console.log(`   ⚠️ Empty comment after processing, skipping`);
            }
          } else {
            console.log(`   📭 No internal comments found in any conversation`);
            noCommentsCount++;
          }

          processedCount++;
          
          if (processedCount < contacts.length) {
            console.log(`\n⏱️ Waiting ${this.delayBetweenContacts/1000} seconds before next contact...`);
            await this.delay(this.delayBetweenContacts);
          }

        } catch (err) {
          errorCount++;
          console.error(`\n❌ ERROR processing contact ${contact.contact_id}:`);
          console.error(`   Error: ${err.message}`);
          if (err.stack) console.error(`   Stack: ${err.stack}`);
          this.stats.errors++;
          this.consecutiveErrors++;
          
          if (err.statusCode === 429 || err.message?.includes('Too Many Requests')) {
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
      console.log(`      • Stale contacts removed: ${staleRemovedThisPoll}`);
      console.log(`      • Errors: ${errorCount}`);
      console.log(`   📈 Cumulative totals:`);
      console.log(`      • iMessages sent: ${this.stats.totaliMessageSent}`);
      console.log(`      • SMS/MMS sent: ${this.stats.totalMmsSent}`);
      console.log(`      • Total messages: ${this.stats.totalSmsSent + this.stats.totaliMessageSent}`);
      console.log(`      • Total stale removed: ${this.stats.staleContactsRemoved}`);
      console.log(`   📊 Rate limit status: ${this.getApiUsageString()}`);
      console.log(`   ⚡ Throughput: ~${Math.round(processedCount / (duration / 3600000))} contacts/hour`);
      
      console.log(`\n⏱️ Waiting ${this.delayBetweenPolls/60000} minutes before next poll`);
      await this.delay(this.delayBetweenPolls);

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
    
    if (this.syncOnlyActive) {
      await this.syncActiveContactsOnly();
    } else {
      await this.syncAllContacts();
    }
    
    this.isSyncing = false;
  }

  async syncActiveContactsOnly() {
    console.log(`\n🔄 ACTIVE CONTACT SYNC STARTED (last ${this.activeDaysThreshold} days)...`);
    
    try {
      let page = 1;
      let hasMore = true;
      let totalAdded = 0;
      let activeCount = 0;
      let inactiveCount = 0;
      let noPhoneCount = 0;
      let errorCount = 0;
      const currentContactIds = new Set();
      
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - this.activeDaysThreshold);
      const cutoffTimestamp = cutoffDate.getTime();
      
      console.log(`📅 Cutoff date: ${cutoffDate.toLocaleDateString()}`);
      console.log(`📅 Current date: ${new Date().toLocaleDateString()}`);
      
      while (hasMore && !this.isRateLimited()) {
        console.log(`\n📦 Fetching page ${page}...`);
        
        this.trackApiCall('searchContacts', 'searchContacts');
        
        const response = await this.makeAPICall(
          () => this.ghlService.client.contacts.searchContactsAdvanced({
            locationId: process.env.GHL_LOCATION_ID,
            pageLimit: this.syncBatchSize,
            page: page
          }),
          'searchContactsAdvanced'
        );

        const contacts = response.contacts || [];
        console.log(`   Received ${contacts.length} total contacts`);
        
        for (const contact of contacts) {
          if (!contact.phone) {
            noPhoneCount++;
            continue;
          }
          
          console.log(`\n   📍 Processing contact: ${contact.id} (${contact.phone})`);
          
          let isActive = false;
          let lastActivity = null;
          
          if (contact.dateUpdated) {
            const updateDate = new Date(contact.dateUpdated);
            if (!isNaN(updateDate.getTime())) {
              console.log(`      Contact last updated: ${updateDate.toISOString()}`);
              if (updateDate.getTime() >= cutoffTimestamp) {
                isActive = true;
                lastActivity = updateDate;
                console.log(`      ✅ ACTIVE via contact.dateUpdated`);
              }
            }
          }
          
          if (!isActive && contact.dateAdded) {
            const addedDate = new Date(contact.dateAdded);
            if (!isNaN(addedDate.getTime())) {
              console.log(`      Contact added: ${addedDate.toISOString()}`);
              if (addedDate.getTime() >= cutoffTimestamp) {
                isActive = true;
                lastActivity = addedDate;
                console.log(`      ✅ ACTIVE via contact.dateAdded`);
              }
            }
          }
          
          if (!isActive) {
            try {
              const conversations = await this.makeAPICall(
                () => this.ghlService.searchConversations({
                  contactId: contact.id,
                  limit: 5,
                  locationId: process.env.GHL_LOCATION_ID
                }),
                'searchConversations-sync'
              );
              
              if (conversations && conversations.length > 0) {
                let latestMessageDate = null;
                
                for (const conv of conversations) {
                  if (conv.lastMessageDate) {
                    const convDate = new Date(conv.lastMessageDate);
                    if (!isNaN(convDate.getTime())) {
                      console.log(`      Conversation lastMessageDate: ${convDate.toISOString()}`);
                      if (!latestMessageDate || convDate > latestMessageDate) {
                        latestMessageDate = convDate;
                      }
                    }
                  }
                  
                  const messagesResponse = await this.makeAPICall(
                    () => this.ghlService.getConversationMessages(conv.id, process.env.GHL_LOCATION_ID, 5),
                    'getConversationMessages-sync'
                  );
                  
                  let messagesArray = [];
                  if (Array.isArray(messagesResponse)) {
                    messagesArray = messagesResponse;
                  } else if (messagesResponse && messagesResponse.messages) {
                    messagesArray = messagesResponse.messages;
                  } else if (messagesResponse && messagesResponse.data) {
                    messagesArray = messagesResponse.data;
                  }
                  
                  if (messagesArray && messagesArray.length > 0) {
                    for (const msg of messagesArray) {
                      if (msg.dateAdded) {
                        const msgDate = new Date(msg.dateAdded);
                        if (!isNaN(msgDate.getTime())) {
                          console.log(`      Message dateAdded: ${msgDate.toISOString()}`);
                          if (!latestMessageDate || msgDate > latestMessageDate) {
                            latestMessageDate = msgDate;
                          }
                        }
                      }
                    }
                  }
                }
                
                if (latestMessageDate) {
                  console.log(`      📅 Latest activity: ${latestMessageDate.toISOString()}`);
                  if (latestMessageDate.getTime() >= cutoffTimestamp) {
                    isActive = true;
                    lastActivity = latestMessageDate;
                    console.log(`      ✅ ACTIVE via messages/conversations`);
                  } else {
                    console.log(`      ❌ INACTIVE - last activity too old (${latestMessageDate.toLocaleDateString()})`);
                  }
                }
              }
            } catch (convError) {
              errorCount++;
              console.log(`      ⚠️ Error checking conversations: ${convError.message}`);
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
            totalAdded++;
            activeCount++;
            console.log(`   ✅ ADDED ACTIVE: ${contact.id} (${contact.phone})`);
          } else {
            inactiveCount++;
            console.log(`   ❌ SKIPPED INACTIVE: ${contact.id} (${contact.phone})`);
          }
        }
        
        hasMore = contacts.length === this.syncBatchSize;
        page++;
        
        if (hasMore) {
          await this.delay(this.delayBetweenPages);
        }
      }
      
      const allTrackedContacts = await this.tracker.getContactsToCheck(10000);
      let keptCount = 0;
      
      for (const trackedContact of allTrackedContacts) {
        if (currentContactIds.has(trackedContact.contact_id)) {
          keptCount++;
        }
      }
      
      const finalCount = await this.tracker.getCount();
      console.log(`\n✅ ACTIVE CONTACT SYNC COMPLETE:`);
      console.log(`   • Active contacts added: ${activeCount}`);
      console.log(`   • Inactive contacts skipped: ${inactiveCount}`);
      console.log(`   • Contacts without phone: ${noPhoneCount}`);
      console.log(`   • Errors: ${errorCount}`);
      console.log(`   • Total in tracker: ${finalCount}`);
      console.log(`   • Active in tracker: ${keptCount}`);
      
    } catch (error) {
      console.error(`❌ ACTIVE CONTACT SYNC ERROR:`, error.message);
      console.error(error.stack);
    }
  }

  async syncAllContacts() {
    console.log(`\n🔄 FULL CONTACT SYNC STARTED...`);
    
    try {
      let page = 1;
      let hasMore = true;
      let totalAdded = 0;
      const currentContactIds = new Set();

      while (hasMore && !this.isRateLimited()) {
        console.log(`📦 Fetching page ${page}...`);
        
        this.trackApiCall('searchContacts', 'searchContacts');
        
        const response = await this.makeAPICall(
          () => this.ghlService.client.contacts.searchContactsAdvanced({
            locationId: process.env.GHL_LOCATION_ID,
            pageLimit: this.syncBatchSize,
            page: page
          }),
          'searchContactsAdvanced-full'
        );

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
          await this.delay(this.delayBetweenPages);
        }
      }
      
      const allTrackedContacts = await this.tracker.getContactsToCheck(10000);
      let staleRemoved = 0;
      
      for (const trackedContact of allTrackedContacts) {
        if (!currentContactIds.has(trackedContact.contact_id)) {
          await this.tracker.removeContact(trackedContact.contact_id);
          staleRemoved++;
        }
      }
      
      const finalCount = await this.tracker.getCount();
      console.log(`\n✅ FULL SYNC COMPLETE:`);
      console.log(`   • Contacts added: ${totalAdded}`);
      console.log(`   • Stale removed: ${staleRemoved}`);
      console.log(`   • Total in tracker: ${finalCount}`);
      
    } catch (error) {
      console.error(`❌ SYNC ERROR:`, error.message);
    }
  }

  getStats() {
    return {
      polling: {
        ...this.stats,
        trackedContacts: this.tracker.getCount ? this.tracker.getCount() : 0,
        provider: this.provider,
        providerConfigured: process.env.IMESSAGEORSMS === 'true' ? 'iMessage' : 'SMS',
        targetThroughput: '30 contacts/hour',
        actualThroughput: this.stats.totalChecks / ((Date.now() - this.stats.lastRun) / 3600000) || 0,
        providerBreakdown: {
          iMessage: this.stats.totaliMessageSent,
          sms: this.stats.totalSmsSent - this.stats.totalMmsSent,
          mms: this.stats.totalMmsSent,
          total: this.stats.totalSmsSent + this.stats.totaliMessageSent
        },
        syncSettings: {
          activeOnly: this.syncOnlyActive,
          activeDaysThreshold: this.activeDaysThreshold
        }
      },
      apiUsage: {
        total: this.apiCalls.total,
        byEndpoint: { ...this.apiCalls.byEndpoint },
        rateLimitHits: this.apiCalls.rateLimitHits
      },
      timestamp: new Date().toISOString()
    };
  }
}

export default PollingService;