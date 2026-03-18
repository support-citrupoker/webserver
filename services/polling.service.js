// services/polling.service.js
import cron from 'node-cron';

class PollingService {
  constructor(ghlService, tallbobService, tracker, options = {}) {
    this.ghlService = ghlService;
    this.tallbobService = tallbobService;
    this.tracker = tracker;
    
    // EXTREMELY CONSERVATIVE SETTINGS - MAXIMUM SAFETY
    this.batchSize = options.batchSize || 2;           // Only 2 contacts per poll
    this.syncBatchSize = options.syncBatchSize || 3;   // Only 3 contacts per sync page
    this.pollInterval = options.pollInterval || '*/15 * * * *'; // Every 15 MINUTES
    
    // YOUR REQUESTED DELAYS
    this.delayBetweenContacts = 60000; // 60 SECONDS (1 minute) between contacts
    this.delayAfterRateLimit = 1800000; // 30 MINUTES after rate limit
    this.delayBetweenPolls = 300000; // 5 MINUTES pause after each poll completes
    this.delayAfterError = 1800000; // 30 MINUTES after any error
    
    // Additional safety delays
    this.delayBetweenPages = 120000; // 2 MINUTES between sync pages
    
    // Sync every 24 hours (once per day)
    this.syncInterval = options.syncInterval || '0 0 * * *'; // Midnight every day
    
    // Status flags
    this.isPolling = false;
    this.isSyncing = false;
    this.rateLimitedUntil = 0;
    this.lastErrorTime = 0;
    
    // Track consecutive errors
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
    
    // Rate limit history for trend analysis
    this.rateLimitHistory = [];
    
    // API CALL MONITORING - Track every single request
    this.apiCalls = {
      total: 0,
      byEndpoint: {
        searchConversations: 0,
        searchContacts: 0,
        sendSMS: 0,
        sendMMS: 0,
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
      totalSkipped: 0,
      lastRun: null,
      errors: 0,
      rateLimitHits: 0,
      rateLimitWaits: 0
    };
  }

  /**
   * Get current API usage string for logs
   */
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

  /**
   * Log detailed rate limit information
   */
  logRateLimitDetails(headers, endpoint) {
    const dailyLimit = headers?.['x-ratelimit-daily-limit'] || '200000';
    const dailyRemaining = headers?.['x-ratelimit-daily-remaining'];
    const dailyReset = headers?.['x-ratelimit-daily-reset'];
    
    const burstLimit = headers?.['x-ratelimit-limit'] || headers?.['x-ratelimit-interval-limit'];
    const burstRemaining = headers?.['x-ratelimit-remaining'];
    const burstReset = headers?.['x-ratelimit-reset'];
    
    console.log(`\n📊 === RATE LIMIT HEADERS [${endpoint}] ===`);
    
    if (dailyRemaining !== undefined) {
      const dailyUsed = dailyLimit - dailyRemaining;
      const dailyPercentUsed = Math.round((dailyUsed / dailyLimit) * 100);
      const dailyPercentRemaining = Math.round((dailyRemaining / dailyLimit) * 100);
      
      console.log(`📈 DAILY QUOTA:`);
      console.log(`   • Used: ${dailyUsed}/${dailyLimit} (${dailyPercentUsed}%)`);
      console.log(`   • Remaining: ${dailyRemaining} (${dailyPercentRemaining}%)`);
      
      if (dailyReset) {
        const resetDate = new Date(parseInt(dailyReset) * 1000);
        console.log(`   • Resets: ${resetDate.toLocaleString()}`);
      }
      
      // Calculate projected usage
      const hourOfDay = new Date().getHours();
      const hoursRemaining = 24 - hourOfDay;
      const projectedTotal = this.apiCalls.total + (this.apiCalls.total / (hourOfDay + 1)) * hoursRemaining;
      const projectedPercent = Math.round((projectedTotal / dailyLimit) * 100);
      
      console.log(`   • Projected EOD: ${Math.round(projectedTotal)} (${projectedPercent}%)`);
    }
    
    if (burstRemaining !== undefined) {
      const burstUsed = burstLimit ? burstLimit - burstRemaining : '?';
      console.log(`\n⚡ BURST QUOTA:`);
      console.log(`   • Remaining: ${burstRemaining}${burstLimit ? `/${burstLimit}` : ''}`);
      
      if (burstReset) {
        const resetSeconds = parseInt(burstReset);
        console.log(`   • Resets in: ${resetSeconds} seconds`);
      }
    }
    
    // Warning levels
    if (dailyRemaining < 50000) {
      console.log(`\n⚠️⚠️⚠️ LOW DAILY QUOTA WARNING: Only ${dailyRemaining} calls remaining (${Math.round((dailyRemaining/200000)*100)}%)`);
    }
    
    if (burstRemaining < 20) {
      console.log(`\n⚠️⚠️⚠️ LOW BURST QUOTA WARNING: Only ${burstRemaining} burst calls remaining`);
    }
    
    console.log('=================================\n');
  }

  /**
   * Track rate limit history
   */
  trackRateLimitHistory(headers, endpoint) {
    const now = new Date();
    const dailyRemaining = headers?.['x-ratelimit-daily-remaining'];
    const burstRemaining = headers?.['x-ratelimit-remaining'];
    
    if (dailyRemaining || burstRemaining) {
      this.rateLimitHistory.push({
        timestamp: now.toISOString(),
        dailyRemaining: dailyRemaining ? parseInt(dailyRemaining) : null,
        burstRemaining: burstRemaining ? parseInt(burstRemaining) : null,
        endpoint,
        totalCalls: this.apiCalls.total
      });
      
      // Keep only last 50 entries
      if (this.rateLimitHistory.length > 50) {
        this.rateLimitHistory.shift();
      }
      
      // Update last known headers
      this.lastRateLimitHeaders = {
        dailyRemaining: dailyRemaining ? parseInt(dailyRemaining) : this.lastRateLimitHeaders.dailyRemaining,
        dailyLimit: parseInt(headers?.['x-ratelimit-daily-limit'] || '200000'),
        burstRemaining: burstRemaining ? parseInt(burstRemaining) : this.lastRateLimitHeaders.burstRemaining,
        burstLimit: parseInt(headers?.['x-ratelimit-limit'] || headers?.['x-ratelimit-interval-limit'] || '0'),
        lastChecked: now.toISOString(),
        endpoint
      };
    }
  }

  /**
   * Calculate rate limit consumption rate
   */
  calculateRateLimitTrend() {
    if (this.rateLimitHistory.length < 5) {
      return null;
    }
    
    const recent = this.rateLimitHistory.slice(-5);
    const first = recent[0];
    const last = recent[recent.length - 1];
    
    if (!first.dailyRemaining || !last.dailyRemaining) {
      return null;
    }
    
    const timeDiff = new Date(last.timestamp) - new Date(first.timestamp);
    const callsUsed = first.dailyRemaining - last.dailyRemaining;
    
    if (timeDiff <= 0 || callsUsed <= 0) {
      return null;
    }
    
    const callsPerHour = (callsUsed / timeDiff) * 3600000;
    const hoursUntilZero = last.dailyRemaining / callsPerHour;
    
    return {
      consumptionRate: Math.round(callsPerHour * 100) / 100, // calls per hour
      hoursUntilDepletion: Math.round(hoursUntilZero * 10) / 10,
      estimatedDepletionTime: hoursUntilZero > 0 ? 
        new Date(Date.now() + (hoursUntilZero * 3600000)).toLocaleTimeString() : 'Already depleted',
      averageCallsPerMinute: Math.round((callsPerHour / 60) * 100) / 100
    };
  }

  /**
   * Track every API call with endpoint monitoring
   */
  trackApiCall(endpoint, type = 'other', count = 1) {
    const now = Date.now();
    const today = new Date().setHours(0, 0, 0, 0);
    
    // Reset if day changed
    if (today > this.apiCalls.lastReset) {
      console.log(`\n📊 === DAY CHANGE: Resetting API counters === ${this.getApiUsageString()}`);
      console.log(`📊 Previous day total: ${this.apiCalls.total} calls`);
      console.log(`📊 By endpoint:`, this.apiCalls.byEndpoint);
      
      this.apiCalls = {
        total: 0,
        byEndpoint: {
          searchConversations: 0,
          searchContacts: 0,
          sendSMS: 0,
          sendMMS: 0,
          other: 0
        },
        byDate: {},
        rateLimitHits: 0,
        lastReset: today,
        warningIssued: false,
        criticalIssued: false
      };
      
      // Reset rate limit history at day change
      this.rateLimitHistory = [];
    }
    
    // Track by endpoint
    if (this.apiCalls.byEndpoint.hasOwnProperty(endpoint)) {
      this.apiCalls.byEndpoint[endpoint] += count;
    } else {
      this.apiCalls.byEndpoint.other += count;
    }
    
    // Track total
    this.apiCalls.total += count;
    
    // Track by date/hour
    const hourKey = new Date().toISOString().substring(0, 13);
    this.apiCalls.byDate[hourKey] = (this.apiCalls.byDate[hourKey] || 0) + count;
    
    return this.apiCalls.total;
  }

  /**
   * Log current API usage
   */
  logApiUsage(projectedTotal) {
    const percentUsed = Math.round((this.apiCalls.total / 200000) * 100);
    const percentProjected = Math.round((projectedTotal / 200000) * 100);
    
    console.log(`\n📊 === API USAGE REPORT === ${this.getApiUsageString()}`);
    console.log(`📊 Total calls today: ${this.apiCalls.total} (${percentUsed}% of 200k)`);
    console.log(`📊 Projected by day end: ${Math.round(projectedTotal)} (${percentProjected}%)`);
    console.log(`📊 By endpoint:`);
    console.log(`   🔍 searchConversations: ${this.apiCalls.byEndpoint.searchConversations}`);
    console.log(`   📋 searchContacts: ${this.apiCalls.byEndpoint.searchContacts}`);
    console.log(`   📤 sendSMS: ${this.apiCalls.byEndpoint.sendSMS}`);
    console.log(`   📸 sendMMS: ${this.apiCalls.byEndpoint.sendMMS}`);
    console.log(`   ❓ other: ${this.apiCalls.byEndpoint.other}`);
    console.log(`   🚫 rateLimitHits: ${this.apiCalls.rateLimitHits}`);
    
    // Add rate limit trend if available
    const trend = this.calculateRateLimitTrend();
    if (trend) {
      console.log(`\n📈 RATE LIMIT TREND:`);
      console.log(`   • Consumption rate: ${trend.consumptionRate} calls/hour (${trend.averageCallsPerMinute}/minute)`);
      console.log(`   • Time until depletion: ${trend.hoursUntilDepletion} hours`);
      console.log(`   • Estimated depletion: ${trend.estimatedDepletionTime}`);
    }
    
    // Show last rate limit headers
    if (this.lastRateLimitHeaders.lastChecked) {
      console.log(`\n🕐 Last rate limit check (${this.lastRateLimitHeaders.endpoint}):`);
      console.log(`   • Daily remaining: ${this.lastRateLimitHeaders.dailyRemaining}/${this.lastRateLimitHeaders.dailyLimit}`);
      console.log(`   • Burst remaining: ${this.lastRateLimitHeaders.burstRemaining || 'N/A'}`);
      console.log(`   • Checked at: ${new Date(this.lastRateLimitHeaders.lastChecked).toLocaleTimeString()}`);
    }
    
    console.log('===========================\n');
  }

  /**
   * Check rate limit headers from API responses
   */
  checkRateLimitHeaders(headers, endpoint) {
    if (!headers) {
      console.log(`⚠️ No rate limit headers received for ${endpoint}`);
      return;
    }
    
    const dailyRemaining = headers?.['x-ratelimit-daily-remaining'];
    const burstRemaining = headers?.['x-ratelimit-remaining'];
    
    // Log full rate limit details
    this.logRateLimitDetails(headers, endpoint);
    
    // Track history
    this.trackRateLimitHistory(headers, endpoint);
    
    if (dailyRemaining) {
      const dailyRemainingNum = parseInt(dailyRemaining);
      const used = 200000 - dailyRemainingNum;
      
      if (Math.abs(this.apiCalls.total - used) > 100) {
        console.warn(`⚠️ Counter mismatch: Our count=${this.apiCalls.total}, GHL says used=${used} ${this.getApiUsageString()}`);
      }
      
      // Progressive warnings
      if (dailyRemainingNum < 100000) {
        console.warn(`⚠️⚠️ Daily quota below 100k: ${dailyRemainingNum} remaining (${Math.round((dailyRemainingNum/200000)*100)}% left)`);
      }
      if (dailyRemainingNum < 50000) {
        console.warn(`🔴🔴 Daily quota below 50k: ${dailyRemainingNum} remaining (CRITICAL)`);
      }
      if (dailyRemainingNum < 10000) {
        console.error(`💀💀💀 DAILY QUOTA CRITICAL: Only ${dailyRemainingNum} calls remaining! 💀💀💀`);
      }
    }
    
    if (burstRemaining) {
      const burstRemainingNum = parseInt(burstRemaining);
      
      // Progressive burst warnings
      if (burstRemainingNum < 50) {
        console.warn(`⚠️ Burst quota below 50: ${burstRemainingNum} remaining`);
      }
      if (burstRemainingNum < 20) {
        console.warn(`🔴 Burst quota below 20: ${burstRemainingNum} remaining - SLOW DOWN!`);
      }
      if (burstRemainingNum < 10) {
        console.error(`💀 Burst quota CRITICAL: Only ${burstRemainingNum} remaining - PAUSING SOON!`);
      }
      
      // Calculate burst usage rate
      const burstLimit = parseInt(headers?.['x-ratelimit-limit'] || headers?.['x-ratelimit-interval-limit'] || '100');
      const burstUsed = burstLimit - burstRemainingNum;
      console.log(`⚡ Burst usage: ${burstUsed}/${burstLimit} used in current window`);
    }
    
    // Check for rate limit reset headers
    const rateLimitReset = headers?.['x-ratelimit-reset'];
    if (rateLimitReset) {
      const resetSeconds = parseInt(rateLimitReset);
      console.log(`⏰ Burst quota resets in ${resetSeconds} seconds`);
    }
    
    const dailyReset = headers?.['x-ratelimit-daily-reset'];
    if (dailyReset) {
      const resetDate = new Date(parseInt(dailyReset) * 1000);
      const hoursUntilReset = (resetDate - new Date()) / 3600000;
      console.log(`📅 Daily quota resets in ${Math.round(hoursUntilReset * 10) / 10} hours (at ${resetDate.toLocaleTimeString()})`);
    }
  }

  /**
   * Check if we're currently rate limited
   */
  isRateLimited() {
    if (this.rateLimitedUntil > Date.now()) {
      const waitTime = Math.ceil((this.rateLimitedUntil - Date.now()) / 60000);
      console.log(`⏳ RATE LIMITED: ${waitTime} more minutes remaining`);
      console.log(`   Resumes at: ${new Date(this.rateLimitedUntil).toLocaleTimeString()}`);
      console.log(`   ${this.getApiUsageString()}`);
      return true;
    }
    return false;
  }

  /**
   * Set rate limit with 30 minute cooldown
   */
  setRateLimit(additionalWait = null) {
    // Use the 30 minute delay if specified, otherwise use default
    const waitTime = additionalWait || this.delayAfterRateLimit;
    
    this.rateLimitedUntil = Date.now() + waitTime;
    this.stats.rateLimitWaits++;
    this.apiCalls.rateLimitHits++;
    
    const waitMinutes = Math.ceil(waitTime/60000);
    console.log(`\n🚦🚦🚦 RATE LIMIT ENGAGED - ${waitMinutes} MINUTE COOLDOWN 🚦🚦🚦`);
    console.log(`   • Started: ${new Date().toLocaleTimeString()}`);
    console.log(`   • Resumes: ${new Date(this.rateLimitedUntil).toLocaleTimeString()}`);
    console.log(`   • Total API calls today: ${this.apiCalls.total}`);
    console.log(`   • Last known daily remaining: ${this.lastRateLimitHeaders.dailyRemaining || 'unknown'}`);
    console.log(`   • Last known burst remaining: ${this.lastRateLimitHeaders.burstRemaining || 'unknown'}`);
    console.log(`   ${this.getApiUsageString()}`);
    
    // Log rate limit history summary
    if (this.rateLimitHistory.length > 0) {
      console.log(`\n📊 Rate limit history (last ${this.rateLimitHistory.length} checks):`);
      const lastFew = this.rateLimitHistory.slice(-3);
      lastFew.forEach(entry => {
        console.log(`   • ${new Date(entry.timestamp).toLocaleTimeString()}: Daily: ${entry.dailyRemaining}, Burst: ${entry.burstRemaining}`);
      });
    }
  }

  async initialize() {
    console.log(`\n🚀 INITIALIZING POLLING SERVICE (ULTRA CONSERVATIVE MODE)...`);
    console.log(`===============================================`);
    console.log(`⏱️ DELAY CONFIGURATION:`);
    console.log(`   • Between contacts: ${this.delayBetweenContacts/1000} seconds (1 minute)`);
    console.log(`   • After rate limit: ${this.delayAfterRateLimit/60000} minutes`);
    console.log(`   • Between polls: ${this.delayBetweenPolls/60000} minutes`);
    console.log(`   • After error: ${this.delayAfterError/60000} minutes`);
    console.log(`   • Poll interval: Every 15 minutes`);
    console.log(`   • Batch size: ${this.batchSize} contacts per poll`);
    console.log(`===============================================\n`);
    
    console.log(`📊 Rate limit monitoring enabled - will log X-RateLimit headers from all responses`);
    
    await this.tracker.initialize();
    
    this.startPolling();
    this.startContactSync();
    
    // Don't auto-run sync on startup - wait 2 hours
    setTimeout(() => {
      console.log(`⏰ Delaying initial contact sync by 2 hours...`);
      setTimeout(() => this.syncContacts(), 7200000); // 2 hours
    }, 1000);
    
    // Log API usage every hour
    setInterval(() => {
      const hourOfDay = new Date().getHours();
      const hoursRemaining = 24 - hourOfDay;
      const projectedTotal = this.apiCalls.total + (this.apiCalls.total / (hourOfDay + 1)) * hoursRemaining;
      this.logApiUsage(projectedTotal);
    }, 3600000); // 1 hour
    
    // Log rate limit status every 5 minutes
    setInterval(() => {
      if (this.lastRateLimitHeaders.lastChecked) {
        console.log(`\n🕐 RATE LIMIT STATUS CHECK:`);
        console.log(`   • Daily remaining: ${this.lastRateLimitHeaders.dailyRemaining}/${this.lastRateLimitHeaders.dailyLimit}`);
        console.log(`   • Burst remaining: ${this.lastRateLimitHeaders.burstRemaining || 'N/A'}`);
        console.log(`   • Last updated: ${new Date(this.lastRateLimitHeaders.lastChecked).toLocaleTimeString()}`);
        
        const trend = this.calculateRateLimitTrend();
        if (trend) {
          console.log(`   • Consumption rate: ${trend.consumptionRate} calls/hour`);
          console.log(`   • Time until depletion: ${trend.hoursUntilDepletion} hours`);
        }
      }
    }, 300000); // 5 minutes
  }

  startPolling() {
    console.log(`⏰ Starting poller (batch: ${this.batchSize}, interval: 15 MINUTES) ${this.getApiUsageString()}`);
    
    cron.schedule(this.pollInterval, async () => {
      // Check error cooldown
      if (this.lastErrorTime > 0) {
        const timeSinceError = Date.now() - this.lastErrorTime;
        if (timeSinceError < this.delayAfterError) {
          const waitRemaining = Math.ceil((this.delayAfterError - timeSinceError) / 60000);
          console.log(`🧊 In error cooldown: ${waitRemaining} minutes remaining until next poll`);
          return;
        } else {
          this.lastErrorTime = 0;
          this.consecutiveErrors = 0;
        }
      }
      
      if (this.isRateLimited()) {
        return;
      }
      
      if (this.isPolling) {
        console.log(`⚠️ Previous poll still running, skipping... ${this.getApiUsageString()}`);
        return;
      }
      await this.poll();
    });
  }

  startContactSync() {
    console.log(`⏰ Starting contact sync (interval: ONCE PER DAY) ${this.getApiUsageString()}`);
    
    cron.schedule(this.syncInterval, async () => {
      if (this.isRateLimited()) {
        console.log(`⏭️ Skipping sync due to rate limit ${this.getApiUsageString()}`);
        return;
      }
      
      if (this.isSyncing) {
        console.log(`⚠️ Previous sync still running, skipping... ${this.getApiUsageString()}`);
        return;
      }
      await this.syncContacts();
    });
  }

  async poll() {
    // Double-check error cooldown
    if (this.lastErrorTime > 0) {
      const timeSinceError = Date.now() - this.lastErrorTime;
      if (timeSinceError < this.delayAfterError) {
        const waitRemaining = Math.ceil((this.delayAfterError - timeSinceError) / 60000);
        console.log(`🧊 In error cooldown: ${waitRemaining} minutes remaining until next poll`);
        this.isPolling = false;
        return;
      } else {
        this.lastErrorTime = 0;
        this.consecutiveErrors = 0;
      }
    }

    if (this.isRateLimited()) {
      this.isPolling = false;
      return;
    }

    this.isPolling = true;
    const startTime = Date.now();

    try {
      console.log(`\n🔍 POLLING STARTED (ULTRA SLOW MODE - 1 minute between contacts)...`);
      console.log(`📊 Pre-poll status: ${this.getApiUsageString()}`);
      
      const contacts = await this.tracker.getContactsToCheck(this.batchSize);
      
      if (contacts.length === 0) {
        console.log(`📭 No contacts to check`);
        
        // Still wait the 5 minute delay between polls even when no contacts
        console.log(`⏱️ No contacts found, but still waiting ${this.delayBetweenPolls/60000} minutes before next poll`);
        await new Promise(resolve => setTimeout(resolve, this.delayBetweenPolls));
        
        this.isPolling = false;
        return;
      }

      console.log(`📋 Checking ${contacts.length} contacts with 60 SECOND delay between each...`);
      let processedCount = 0;
      let newReplies = 0;
      let skippedComments = 0;

      for (const contact of contacts) {
        if (this.isRateLimited()) {
          console.log(`⏭️ Rate limit active, stopping poll early`);
          break;
        }

        try {
          console.log(`\n--- Processing contact ${processedCount + 1}/${contacts.length}: ${contact.phone_number} ---`);
          
          // Track this API call
          this.trackApiCall('searchConversations', 'searchConversations');
          
          console.log(`🔍 Calling GHL searchConversations for contact ${contact.contact_id}...`);
          
          const response = await this.ghlService.searchConversations({
            contactId: contact.contact_id,
            limit: 5
          });

          // Check rate limit headers (this will log all the X-RateLimit details)
          this.checkRateLimitHeaders(response?.headers, 'searchConversations');
          
          // Reset consecutive errors on success
          this.consecutiveErrors = 0;

          const latestComment = response[0]?.lastInternalComment;
          
          if (latestComment) {
            const imageUrl = this.extractImageUrl(latestComment);
            
            if (latestComment.trim().toLowerCase().startsWith('@reply')) {
              console.log(`📝 Internal team comment (not sent): ${latestComment.substring(0, 50)}...`);
              skippedComments++;
            } else {
              const replyText = latestComment.trim();
              
              if (replyText) {
                const { isNew } = await this.tracker.checkComment(
                  contact.contact_id,
                  latestComment,
                  replyText
                );

                if (isNew) {
                  if (imageUrl) {
                    // Track MMS send
                    this.trackApiCall('sendMMS', 'sendMMS');
                    
                    console.log(`📸 Sending MMS to ${contact.phone_number}`);
                    
                    const mmsResponse = await this.tallbobService.sendMMS({
                      to: contact.phone_number,
                      from: process.env.TALLBOB_NUMBER || '+61428616133',
                      message: replyText,
                      mediaUrl: imageUrl,
                      reference: `mms_${contact.contact_id}_${Date.now()}`
                    });
                    
                    console.log(`✅ MMS sent successfully`);
                    this.stats.totalMmsSent++;
                  } else {
                    // Track SMS send
                    this.trackApiCall('sendSMS', 'sendSMS');
                    
                    console.log(`💬 Sending SMS to ${contact.phone_number}`);
                    
                    const smsResponse = await this.tallbobService.sendSMS({
                      to: contact.phone_number,
                      from: process.env.TALLBOB_NUMBER || '+61428616133',
                      message: replyText,
                      reference: `sms_${contact.contact_id}_${Date.now()}`
                    });
                    
                    console.log(`✅ SMS sent successfully`);
                  }

                  newReplies++;
                  this.stats.totalSmsSent++;
                } else {
                  console.log(`⏭️ Comment already processed, skipping`);
                }
              }
            }
          } else {
            console.log(`📭 No internal comments found for this contact`);
          }

          processedCount++;
          
          // 1 MINUTE DELAY between contacts (your request)
          if (processedCount < contacts.length) { // Don't wait after the last contact
            console.log(`\n⏱️ Waiting 60 seconds before next contact (${contacts.length - processedCount} remaining)`);
            console.log(`   Current status: ${this.getApiUsageString()}`);
            
            // Show countdown
            for (let i = 60; i > 0; i -= 15) {
              await new Promise(resolve => setTimeout(resolve, 15000));
              console.log(`   ${i} seconds remaining...`);
            }
          }

        } catch (err) {
          if (err.statusCode === 429) {
            console.error(`\n🚦🚦🚦 RATE LIMIT HIT for contact ${contact.contact_id} 🚦🚦🚦`);
            console.error(`   Error: ${err.message}`);
            this.stats.rateLimitHits++;
            this.apiCalls.rateLimitHits++;
            this.consecutiveErrors++;
            
            // 30 MINUTE RATE LIMIT DELAY (your request)
            console.log(`⛔ Rate limit engaged. Waiting ${this.delayAfterRateLimit/60000} minutes before any further API calls`);
            this.setRateLimit(this.delayAfterRateLimit);
            break;
          } else {
            console.error(`❌ Error processing contact ${contact.contact_id}:`, err.message);
            this.stats.errors++;
            this.consecutiveErrors++;
            
            // If we hit multiple errors, trigger the 30 minute cooldown
            if (this.consecutiveErrors >= 2) {
              console.log(`🔥 Multiple consecutive errors (${this.consecutiveErrors}). Entering 30 minute cooldown.`);
              this.lastErrorTime = Date.now();
              break;
            }
          }
        }
      }

      const duration = Date.now() - startTime;
      this.stats.totalChecks += contacts.length;
      this.stats.totalSkipped += skippedComments;
      this.stats.lastRun = new Date().toISOString();

      console.log(`\n✅ POLL COMPLETE:`);
      console.log(`   • Processed: ${processedCount}/${contacts.length} contacts`);
      console.log(`   • New replies: ${newReplies}`);
      console.log(`   • Skipped: ${skippedComments}`);
      console.log(`   • Duration: ${Math.round(duration/1000)} seconds`);
      console.log(`   • Final status: ${this.getApiUsageString()}`);
      
      // 5 MINUTE DELAY BETWEEN POLLS (your request)
      console.log(`\n⏱️ Poll cycle complete. Waiting ${this.delayBetweenPolls/60000} minutes before next poll`);
      console.log(`   Next poll at: ${new Date(Date.now() + this.delayBetweenPolls).toLocaleTimeString()}`);
      
      // Show countdown for the 5 minute wait
      for (let i = 5; i > 0; i--) {
        console.log(`   ${i} minutes remaining...`);
        await new Promise(resolve => setTimeout(resolve, 60000));
      }

    } catch (error) {
      console.error(`❌ POLLING ERROR:`, error);
      this.stats.errors++;
      this.consecutiveErrors++;
      
      // 30 MINUTE ERROR COOLDOWN (your request)
      console.log(`💥 Major error occurred. Entering 30 minute cooldown.`);
      console.log(`   Error: ${error.message}`);
      console.log(`   Stack: ${error.stack}`);
      this.lastErrorTime = Date.now();
    } finally {
      this.isPolling = false;
    }
  }

  async syncContacts() {
    if (this.isRateLimited()) {
      this.isSyncing = false;
      return;
    }

    if (this.isSyncing) {
      console.log(`⚠️ Sync already in progress, skipping... ${this.getApiUsageString()}`);
      return;
    }

    this.isSyncing = true;
    console.log(`\n🔄 CONTACT SYNC STARTED (ONCE PER DAY)...`);
    console.log(`📊 Pre-sync status: ${this.getApiUsageString()}`);
    const startTime = Date.now();

    try {
      let page = 1;
      let hasMore = true;
      let totalAdded = 0;

      while (hasMore) {
        if (this.isRateLimited()) {
          console.log(`⏭️ Rate limit active, stopping sync ${this.getApiUsageString()}`);
          break;
        }

        // Add progressive delay based on page number
        const pageDelay = Math.min(10000 * page, 60000); // Increases with page, max 60 seconds
        console.log(`\n📦 Preparing to fetch page ${page} (waiting ${pageDelay/1000}s before)...`);
        await new Promise(resolve => setTimeout(resolve, pageDelay));
        
        console.log(`📦 Fetching page ${page} (${this.syncBatchSize} contacts)...`);
        
        // Track this API call
        this.trackApiCall('searchContacts', 'searchContacts');
        
        console.log(`🔍 Calling GHL searchContactsAdvanced (page ${page})...`);
        
        const response = await this.ghlService.client.contacts.searchContactsAdvanced({
          locationId: process.env.GHL_LOCATION_ID,
          pageLimit: this.syncBatchSize,
          page: page
        });

        // Check rate limit headers (this will log all the X-RateLimit details)
        this.checkRateLimitHeaders(response?.headers, 'searchContacts');

        const contacts = response.contacts || [];
        console.log(`   Received ${contacts.length} contacts from API`);
        
        let pageAdded = 0;
        for (const contact of contacts) {
          if (contact.phone) {
            await this.tracker.addContact(contact.id, contact.phone);
            totalAdded++;
            pageAdded++;
          }
        }

        console.log(`   Processed ${contacts.length} contacts (${pageAdded} with phones added to tracker)`);
        console.log(`   Running total: ${totalAdded} contacts added so far`);
        console.log(`   ${this.getApiUsageString()}`);
        
        hasMore = contacts.length === this.syncBatchSize;
        page++;
        
        if (hasMore) {
          // Longer delay between pages - 2 MINUTES
          console.log(`\n⏱️ Waiting ${this.delayBetweenPages/60000} minutes before next page...`);
          console.log(`   Next page: ${page}`);
          
          // Show countdown for the 2 minute wait
          for (let i = 2; i > 0; i--) {
            console.log(`   ${i} minute${i > 1 ? 's' : ''} remaining...`);
            await new Promise(resolve => setTimeout(resolve, 60000));
          }
        }
      }

      const count = await this.tracker.getCount();
      const duration = Date.now() - startTime;
      
      console.log(`\n✅ SYNC COMPLETE:`);
      console.log(`   • Contacts added: ${totalAdded}`);
      console.log(`   • Total in database: ${count}`);
      console.log(`   • Duration: ${Math.round(duration/1000)} seconds`);
      console.log(`   • Final status: ${this.getApiUsageString()}`);

    } catch (error) {
      console.error(`❌ CONTACT SYNC FAILED:`, error);
      
      if (error.statusCode === 429) {
        this.stats.rateLimitHits++;
        this.apiCalls.rateLimitHits++;
        
        // 30 MINUTE RATE LIMIT DELAY
        this.setRateLimit(this.delayAfterRateLimit);
        console.log(`⏰ Rate limited! 30 minute cooldown started.`);
      } else {
        // Non-rate-limit error - still use 30 minute cooldown
        console.log(`💥 Sync error - entering 30 minute cooldown`);
        console.log(`   Error: ${error.message}`);
        this.lastErrorTime = Date.now();
      }
    } finally {
      this.isSyncing = false;
    }
  }

  /**
   * Extract image URL from comment text
   */
  extractImageUrl(text) {
    if (!text) return null;
    
    const imageExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.svg'];
    const urlRegex = /(https?:\/\/[^\s]+)/g;
    const urls = text.match(urlRegex) || [];
    
    for (const url of urls) {
      const lowerUrl = url.toLowerCase();
      
      for (const ext of imageExtensions) {
        if (lowerUrl.includes(ext)) {
          return url;
        }
      }
      
      if (lowerUrl.includes('imgur.com') || 
          lowerUrl.includes('i.imgur.com') || 
          lowerUrl.includes('flic.kr') ||
          lowerUrl.includes('photos.app.goo.gl') ||
          lowerUrl.includes('/image/') ||
          lowerUrl.includes('/img/')) {
        return url;
      }
    }
    
    return null;
  }

  /**
   * Get comprehensive stats including API usage
   */
  getStats() {
    const hourOfDay = new Date().getHours();
    const hoursRemaining = 24 - hourOfDay;
    const projectedTotal = this.apiCalls.total + (this.apiCalls.total / (hourOfDay + 1)) * hoursRemaining;
    
    const trend = this.calculateRateLimitTrend();
    
    return {
      polling: {
        ...this.stats,
        trackedContacts: this.tracker.getCount(),
      },
      apiUsage: {
        total: this.apiCalls.total,
        percentUsed: Math.round((this.apiCalls.total / 200000) * 100),
        projectedTotal: Math.round(projectedTotal),
        percentProjected: Math.round((projectedTotal / 200000) * 100),
        byEndpoint: { ...this.apiCalls.byEndpoint },
        rateLimitHits: this.apiCalls.rateLimitHits,
        recentHours: Object.fromEntries(
          Object.entries(this.apiCalls.byDate).slice(-6)
        )
      },
      rateLimits: {
        current: { ...this.lastRateLimitHeaders },
        trend: trend,
        history: this.rateLimitHistory.slice(-10) // Last 10 checks
      },
      rateLimited: this.isRateLimited(),
      rateLimitedUntil: this.rateLimitedUntil ? new Date(this.rateLimitedUntil).toISOString() : null,
      errorCooldown: this.lastErrorTime > 0,
      errorCooldownUntil: this.lastErrorTime ? new Date(this.lastErrorTime + this.delayAfterError).toISOString() : null,
      timestamp: new Date().toISOString()
    };
  }
}

export default PollingService;