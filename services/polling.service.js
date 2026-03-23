// services/polling.service.js
import cron from 'node-cron';

class PollingService {
  constructor(ghlService, tallbobService, tracker, bluebubblesService, options = {}) {
    this.ghlService = ghlService;
    this.tallbobService = tallbobService;
    this.bluebubblesService = bluebubblesService;
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

  // ... [keep all your existing helper methods: getApiUsageString, logRateLimitDetails, trackRateLimitHistory, etc.] ...

  /**
   * Determine which provider to use for a reply based on the last message
   */
  async getProviderForReply(contactId, locationId) {
    try {
      console.log(`🔍 Determining provider for contact ${contactId}...`);
      
      // Get the last 5 conversations to analyze
      const conversations = await this.ghlService.searchConversations({
        contactId: contactId,
        limit: 5,
        locationId: locationId
      });
      
      if (!conversations || conversations.length === 0) {
        console.log(`⚠️ No conversations found, defaulting to SMS (Tall Bob)`);
        return { provider: 'tallbob', reason: 'No conversation history' };
      }
      
      // Look for the most recent message with provider info
      let lastProvider = null;
      let lastMessageDate = null;
      
      for (const conv of conversations) {
        // Get messages for this conversation
        const messages = await this.ghlService.getConversationMessages(conv.id, locationId, 10);
        
        if (messages && messages.length > 0) {
          // Find the most recent inbound message (from customer)
          const inboundMessages = messages
            .filter(m => m.direction === 'inbound')
            .sort((a, b) => new Date(b.date) - new Date(a.date));
          
          if (inboundMessages.length > 0) {
            const latestMessage = inboundMessages[0];
            const messageDate = new Date(latestMessage.date);
            
            if (!lastMessageDate || messageDate > lastMessageDate) {
              lastMessageDate = messageDate;
              lastProvider = latestMessage.provider || this.detectProviderFromMessage(latestMessage);
              console.log(`📱 Found message from ${latestMessage.date} with provider: ${lastProvider}`);
            }
          }
        }
      }
      
      // Determine which provider to use
      if (lastProvider === 'BlueBubbles' || lastProvider === 'iMessage') {
        console.log(`✅ Replying via BlueBubbles (iMessage) - last message was iMessage`);
        return { provider: 'bluebubbles', reason: 'Last message was iMessage' };
      } else if (lastProvider === 'Tall Bob' || lastProvider === 'SMS' || lastProvider === 'MMS') {
        console.log(`✅ Replying via Tall Bob (SMS/MMS) - last message was SMS/MMS`);
        return { provider: 'tallbob', reason: 'Last message was SMS/MMS' };
      } else {
        // Default to SMS if unknown
        console.log(`⚠️ Unknown provider (${lastProvider}), defaulting to Tall Bob SMS`);
        return { provider: 'tallbob', reason: 'Unknown provider, defaulting to SMS' };
      }
      
    } catch (error) {
      console.error(`❌ Error determining provider:`, error.message);
      return { provider: 'tallbob', reason: 'Error in detection, defaulting to SMS' };
    }
  }
  
  /**
   * Detect provider from message metadata
   */
  detectProviderFromMessage(message) {
    // Check metadata first
    if (message.metadata?.provider) {
      return message.metadata.provider;
    }
    
    // Check message body for provider tags
    if (message.body && message.body.includes('[BlueBubbles]')) {
      return 'BlueBubbles';
    }
    
    if (message.body && message.body.includes('[Tall Bob]')) {
      return 'Tall Bob';
    }
    
    // Check message type
    if (message.messageType === 'iMessage') {
      return 'BlueBubbles';
    }
    
    if (message.messageType === 'SMS' || message.messageType === 'MMS') {
      return 'Tall Bob';
    }
    
    // Check if it's an email (iMessage uses emails)
    if (message.toNumber && message.toNumber.includes('@')) {
      return 'BlueBubbles';
    }
    
    return 'unknown';
  }
  
  /**
   * Send reply using the appropriate provider
   */
  async sendReplyWithProvider(contact, replyText, imageUrl, locationId) {
    try {
      // Get the provider to use for this reply
      const { provider, reason } = await this.getProviderForReply(contact.contact_id, locationId);
      
      console.log(`📤 Sending reply via ${provider.toUpperCase()} - Reason: ${reason}`);
      console.log(`   To: ${contact.phone_number}`);
      console.log(`   Message: ${replyText.substring(0, 100)}`);
      
      let result;
      
      if (provider === 'bluebubbles') {
        // Send via BlueBubbles (iMessage)
        if (!this.bluebubblesService) {
          console.error(`❌ BlueBubbles service not configured, falling back to SMS`);
          return await this.sendViaTallBob(contact, replyText, imageUrl);
        }
        
        // Track iMessage send
        this.trackApiCall('sendiMessage', 'sendiMessage');
        
        // Get the iMessage account to send from
        const fromAccount = process.env.BLUEBUBBLES_IMESSAGE_ACCOUNT || contact.phone_number;
        
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
        
        console.log(`✅ iMessage sent successfully via BlueBubbles`);
        this.stats.totalSmsSent++; // Count as sent message
        return { success: true, provider: 'bluebubbles', result };
        
      } else {
        // Send via Tall Bob (SMS/MMS)
        return await this.sendViaTallBob(contact, replyText, imageUrl);
      }
      
    } catch (error) {
      console.error(`❌ Error sending reply:`, error.message);
      
      // Fallback to SMS if iMessage fails
      if (provider === 'bluebubbles' && error.message.includes('iMessage')) {
        console.log(`🔄 iMessage failed, falling back to SMS...`);
        return await this.sendViaTallBob(contact, replyText, imageUrl);
      }
      
      throw error;
    }
  }
  
  /**
   * Send via Tall Bob (SMS/MMS)
   */
  async sendViaTallBob(contact, replyText, imageUrl) {
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
      this.stats.totalSmsSent++;
      
      return { success: true, provider: 'tallbob', result: mmsResponse };
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
      this.stats.totalSmsSent++;
      
      return { success: true, provider: 'tallbob', result: smsResponse };
    }
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
          
          const conversations = await this.ghlService.searchConversations({
            contactId: contact.contact_id,
            limit: 5
          });

          // Check rate limit headers (this will log all the X-RateLimit details)
          this.checkRateLimitHeaders(conversations?.headers, 'searchConversations');
          
          // Reset consecutive errors on success
          this.consecutiveErrors = 0;

          let latestComment = null;
          
          // Check conversations for internal comments
          if (conversations && conversations.length > 0) {
            // Look for the most recent internal comment across conversations
            for (const conv of conversations) {
              if (conv.lastInternalComment) {
                if (!latestComment || new Date(conv.lastMessageAt) > new Date(latestComment.date)) {
                  latestComment = {
                    text: conv.lastInternalComment,
                    date: conv.lastMessageAt,
                    conversationId: conv.id
                  };
                }
              }
            }
          }
          
          if (latestComment) {
            const imageUrl = this.extractImageUrl(latestComment.text);
            
            if (latestComment.text.trim().toLowerCase().startsWith('@reply')) {
              console.log(`📝 Internal team comment (not sent): ${latestComment.text.substring(0, 50)}...`);
              skippedComments++;
            } else {
              const replyText = latestComment.text.trim();
              
              if (replyText) {
                const { isNew } = await this.tracker.checkComment(
                  contact.contact_id,
                  latestComment.text,
                  replyText
                );

                if (isNew) {
                  // Send reply using the appropriate provider (iMessage or SMS)
                  const sendResult = await this.sendReplyWithProvider(
                    contact,
                    replyText,
                    imageUrl,
                    process.env.GHL_LOCATION_ID
                  );
                  
                  console.log(`✅ Reply sent via ${sendResult.provider.toUpperCase()}`);
                  newReplies++;
                  
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
      console.log(`   • iMessages sent: ${this.stats.totaliMessageSent}`);
      console.log(`   • SMS/MMS sent: ${this.stats.totalMmsSent}`);
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

  // ... [keep your existing syncContacts, extractImageUrl, getStats methods] ...

  /**
   * Get comprehensive stats including API usage and provider stats
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
        providerBreakdown: {
          iMessage: this.stats.totaliMessageSent,
          sms: this.stats.totalSmsSent - this.stats.totalMmsSent,
          mms: this.stats.totalMmsSent,
          total: this.stats.totalSmsSent + this.stats.totaliMessageSent
        }
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