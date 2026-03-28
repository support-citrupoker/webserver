import { join } from 'path';

// Simple in-memory cache for deduplication
const processedEvents = new Set();
const processedExpiry = new Map();
const processingLock = new Set();

// iMessage cache to avoid repeated API calls
const iMessageCache = new Map();
const CACHE_DURATION = 7 * 24 * 60 * 60 * 1000; // 7 days

// Clean up old entries every hour
setInterval(() => {
  const now = Date.now();
  for (const [id, timestamp] of processedExpiry.entries()) {
    if (now - timestamp > 3600000) { // 1 hour
      processedEvents.delete(id);
      processedExpiry.delete(id);
    }
  }

  // Clean up iMessage cache
  for (const [phone, data] of iMessageCache.entries()) {
    if (now - data.timestamp > CACHE_DURATION) {
      iMessageCache.delete(phone);
    }
  }

  console.log(`🧹 Cleaned up deduplication cache. Current size: ${processedEvents.size}`);
  console.log(`📱 iMessage cache size: ${iMessageCache.size}`);
}, 3600000);

async function isEventProcessed(eventId) {
  if (!eventId) return false;
  return processedEvents.has(eventId);
}

async function markEventProcessed(eventId) {
  if (!eventId) return;
  processedEvents.add(eventId);
  processedExpiry.set(eventId, Date.now());
}

async function isEventProcessing(eventId) {
  if (!eventId) return false;
  return processingLock.has(eventId);
}

async function lockEvent(eventId) {
  if (!eventId) return false;
  if (processingLock.has(eventId)) return false;
  processingLock.add(eventId);
  return true;
}

async function unlockEvent(eventId) {
  if (!eventId) return;
  processingLock.delete(eventId);
}

// Helper function to get cached iMessage status
async function getCachediMessageStatus(phone) {
  const cached = iMessageCache.get(phone);
  if (cached && Date.now() - cached.timestamp < CACHE_DURATION) {
    return cached;
  }
  return null;
}

// Helper function to set cached iMessage status
async function setCachediMessageStatus(phone, hasiMessage, service) {
  iMessageCache.set(phone, {
    hasiMessage,
    service,
    timestamp: Date.now()
  });
}

export default (app, tallbobService, ghlService, messageController, bluebubblesService) => {

  // Universal message processor for all providers
  async function processIncomingMessage(messageData, provider = 'SMS') {
    // Skip if not a message received event (for Tall Bob)
    if (provider === 'SMS' || provider === 'MMS') {
      const validEvents = ['message_received', 'message_received_mms'];
      if (!validEvents.includes(messageData.eventType)) {
        console.log(`⏭️ Ignoring event type: ${messageData.eventType}`);
        return;
      }
    }

    // Create unique event ID based on provider and message data
    let eventId;
    if (provider === 'BLUEBUBBLES') {
      eventId = messageData.guid || messageData.messageGuid ||
        `${messageData.sender}_${messageData.timestamp}`;
    } else {
      eventId = messageData.eventID || messageData.id ||
        `${messageData.recipient}_${messageData.timestamp}`;
    }

    if (!eventId) {
      console.log('⚠️ No event ID found, using fallback');
      eventId = `${provider}_${Date.now()}_${Math.random()}`;
    }

    // Add provider prefix to event ID to avoid conflicts between providers
    const uniqueEventId = `${provider}_${eventId}`;

    // Check if already processed
    const processed = await isEventProcessed(uniqueEventId);
    if (processed) {
      console.log(`⏭️ Event ${uniqueEventId} already processed, skipping`);
      return;
    }

    // Check if currently being processed by another request
    const isLocked = await isEventProcessing(uniqueEventId);
    if (isLocked) {
      console.log(`⏭️ Event ${uniqueEventId} is currently being processed, skipping`);
      return;
    }

    // Acquire processing lock
    const locked = await lockEvent(uniqueEventId);
    if (!locked) {
      console.log(`⏭️ Could not acquire lock for event ${uniqueEventId}, skipping`);
      return;
    }

    console.log(`📨 Processing ${provider} message... Event ID: ${uniqueEventId}`);

    // Extract data based on provider
    let customerPhone, providerNumber, messageText, timestamp, media, contactID, campaignID, reference;

    if (provider === 'BLUEBUBBLES') {
      // BlueBubbles webhook format
      customerPhone = messageData.sender || messageData.from;
      providerNumber = messageData.recipient || messageData.chatGuid || messageData.to;
      messageText = messageData.text || messageData.body || '';
      timestamp = messageData.timestamp || Math.floor(Date.now() / 1000);
      media = messageData.attachments || [];
      contactID = messageData.contactId;
      campaignID = messageData.campaignId;
      reference = messageData.guid || messageData.reference;

      // Format phone numbers if they look like phone numbers (not emails)
      if (customerPhone && !customerPhone.includes('@') && customerPhone.match(/\d/)) {
        customerPhone = `+${customerPhone.replace(/\D/g, '')}`;
      }
      if (providerNumber && !providerNumber.includes('@') && providerNumber.match(/\d/)) {
        providerNumber = `+${providerNumber.replace(/\D/g, '')}`;
      }

      console.log('📱 BlueBubbles extracted:', {
        customerPhone,
        providerNumber,
        messageText: messageText?.substring(0, 50),
        timestamp,
        eventId
      });
    } else {
      // Tall Bob format
      if (!messageData.recipient || !messageData.sentVia) {
        console.error('❌ Missing required fields: recipient or sentVia');
        await unlockEvent(uniqueEventId);
        return;
      }
      customerPhone = `+${messageData.recipient.replace(/\D/g, '')}`;
      providerNumber = `+${messageData.sentVia.replace(/\D/g, '')}`;
      messageText = messageData.messageText;
      timestamp = messageData.timestamp;
      media = messageData.media;
      contactID = messageData.contactID;
      campaignID = messageData.campaignID;
      reference = messageData.reference;
    }

    const locationId = ghlService.locationId;

    if (!locationId) {
      console.error('❌ No locationId configured');
      await unlockEvent(uniqueEventId);
      return;
    }

    const receivedDate = timestamp ? new Date(timestamp * 1000).toISOString() : new Date().toISOString();

    // Determine message type for GHL
    const messageType = provider === 'BLUEBUBBLES' ? 'iMessage' : (provider === 'MMS' ? 'MMS' : 'SMS');

    try {
      // ==================== iMESSAGE DETECTION ====================
      let hasiMessage = false;
      let imessageCheckFailed = false;
      let imessageService = null;

      // Only check iMessage if BlueBubbles service is configured
      if (bluebubblesService && customerPhone && !customerPhone.includes('@')) {
        if (provider === 'BLUEBUBBLES') {
          // BlueBubbles messages are already iMessages
          hasiMessage = true;
          imessageService = messageData.senderService || 'iMessage';
          console.log(`✅ ${customerPhone} has iMessage (confirmed by incoming iMessage)`);

          // Cache the result
          await setCachediMessageStatus(customerPhone, true, imessageService);
        } else {
          // Check if SMS contact has iMessage (check cache first)
          const cached = await getCachediMessageStatus(customerPhone);

          if (cached !== null) {
            hasiMessage = cached.hasiMessage;
            imessageService = cached.service;
            console.log(`📱 Using cached iMessage status for ${customerPhone}: ${hasiMessage ? 'YES ✅' : 'NO ❌'}`);
          } else {
            try {
              console.log(`🔍 Checking iMessage availability for ${customerPhone}...`);
              const availability = await bluebubblesService.checkiMessageAvailability(customerPhone);
              hasiMessage = availability.hasiMessage;
              imessageService = availability.service;
              console.log(`📱 iMessage status for ${customerPhone}: ${hasiMessage ? 'YES ✅' : 'NO ❌'}`);

              // Cache the result
              await setCachediMessageStatus(customerPhone, hasiMessage, imessageService);
            } catch (error) {
              console.error(`⚠️ iMessage check failed for ${customerPhone}:`, error.message);
              imessageCheckFailed = true;
            }
          }
        }
      } else if (customerPhone && customerPhone.includes('@')) {
        // Email addresses typically have iMessage
        hasiMessage = true;
        imessageService = 'iMessage (email)';
        console.log(`📧 ${customerPhone} is an email address, assuming iMessage capability`);
      }

      // Find or create contact with iMessage data
      console.log(`👤 Upserting contact with identifier: ${customerPhone}`);
      const contactData = {
        phone: customerPhone,
        firstName: messageData.senderName || messageData.firstName || (provider === 'BLUEBUBBLES' ? 'iMessage' : 'SMS'),
        lastName: messageData.lastName || 'User',
        tags: [
          `${provider.toLowerCase()}_contact`,
          provider === 'BLUEBUBBLES' ? 'imessage_received' : `${messageType.toLowerCase()}_received`,
          // Add iMessage capability tags
          ...(hasiMessage ? ['has_imessage', 'imessage_capable'] : ['sms_only']),
          ...(imessageCheckFailed ? ['imessage_check_failed'] : [])
        ],
        source: provider === 'BLUEBUBBLES' ? 'BlueBubbles Integration' : 'Tall Bob Integration',
        customFields: [
          { key: 'last_incoming_message', value: messageText || '' },
          { key: 'last_message_date', value: receivedDate },
          { key: `${provider.toLowerCase()}_contact_id`, value: contactID || '' },
          { key: `${provider.toLowerCase()}_campaign_id`, value: campaignID || '' },
          // iMessage custom fields
          { key: 'has_imessage', value: hasiMessage ? 'Yes' : 'No' },
          { key: 'imessage_service', value: imessageService || 'unknown' },
          { key: 'imessage_last_checked', value: new Date().toISOString() },
          { key: 'imessage_check_failed', value: imessageCheckFailed ? 'true' : 'false' },
          ...(provider === 'BLUEBUBBLES' ? [{ key: 'imessage_guid', value: reference || '' }] : [])
        ]
      };

      // Add email for BlueBubbles if it's an email address
      if (provider === 'BLUEBUBBLES' && customerPhone && customerPhone.includes('@')) {
        contactData.email = customerPhone;
      }

      const { contact, action } = await ghlService.upsertContact(contactData, locationId);
      console.log(`✅ Contact ${action}: ${contact.id}`);

      // Add note about iMessage capability
      if (hasiMessage || imessageCheckFailed) {
        try {
          const noteContent = hasiMessage
            ? `✅ iMessage capable detected on ${new Date().toISOString()}\nPhone: ${customerPhone}\nService: ${imessageService || 'iMessage'}`
            : `⚠️ iMessage check failed on ${new Date().toISOString()}\nPhone: ${customerPhone}\nWill retry on next message`;

          await ghlService.addNote(contact.id, noteContent, locationId);
          console.log(`📝 Added iMessage note to contact ${contact.id}`);
        } catch (noteError) {
          console.error('Failed to add iMessage note:', noteError.message);
        }
      }

      // Get or create conversation
      console.log(`💬 Getting/creating conversation for contact: ${contact.id}`);
      const { conversation } = await ghlService.getOrCreateConversation(
        contact.id,
        messageType,
        locationId
      );
      console.log(`✅ Conversation: ${conversation.id}`);

      // Process attachments if any
      let mediaUrls = [];
      if (media && media.length > 0) {
        console.log(`📎 Processing ${media.length} attachment(s)`);
        mediaUrls = media.map(attachment => {
          if (typeof attachment === 'string') return attachment;
          if (attachment.path) return attachment.path;
          if (attachment.url) return attachment.url;
          if (attachment.filename) return attachment.filename;
          return null;
        }).filter(Boolean);
      }

      // Add message to conversation
      console.log(`📝 Adding ${messageType} message to conversation: ${conversation.id}`);

      const messagePayload = {
        contactId: contact.id,
        body: messageText || (provider === 'MMS' ? 'MMS message' : ''),
        messageType: messageType,
        mediaUrls: mediaUrls,
        direction: 'inbound',
        date: receivedDate,
        fromNumber: providerNumber,
        toNumber: customerPhone,
        providerMessageId: reference || eventId,
        provider: provider === 'BLUEBUBBLES' ? 'BlueBubbles' : 'Tall Bob',
        metadata: provider === 'BLUEBUBBLES' ? {
          guid: reference,
          service: messageData.senderService || 'iMessage',
          isDelivered: messageData.isDelivered,
          partCount: messageData.partCount,
          hasiMessage: hasiMessage
        } : {
          hasiMessage: hasiMessage,
          imessageChecked: !imessageCheckFailed
        }
      };

      await ghlService.addMessageToConversation(conversation.id, messagePayload, locationId);

      // Mark as processed (only after successful processing)
      await markEventProcessed(uniqueEventId);
      console.log(`✅ ${messageType} message processed for contact ${contact.id} (${action})`);

    } catch (error) {
      console.error(`❌ Error processing ${provider} message:`, error);
      // Don't mark as processed so it can be retried
    } finally {
      // Always release the lock
      await unlockEvent(uniqueEventId);
    }
  }

  // ==================== BLUEBUBBLES WEBHOOK ROUTES ====================

  // Main incoming message webhook
  // ==================== BLUEBUBBLES WEBHOOK ROUTES ====================

  // Main incoming message webhook
  app.post('/bluebubbles/incoming', async (req, res) => {
    try {
      const webhookData = req.body;

      console.log('📱 Received BlueBubbles webhook');

      // Verify password
      const apiPassword = req.query.password || req.headers['x-bluebubbles-password'];
      if (process.env.BLUEBUBBLES_PASSWORD && apiPassword !== process.env.BLUEBUBBLES_PASSWORD) {
        console.error('❌ Invalid BlueBubbles webhook password');
        return res.status(401).json({ error: 'Unauthorized' });
      }

      // Acknowledge immediately
      res.status(200).json({ received: true, timestamp: new Date().toISOString() });

      // Process asynchronously
      setImmediate(async () => {
        try {
          let messageData;
          let isFromMe = false;

          // Handle BlueBubbles webhook format: { type: 'new-message', data: {...} }
          if (webhookData.type === 'new-message' && webhookData.data) {
            const msg = webhookData.data;

            // ⭐ CRITICAL: Skip messages sent by your own Mac
            isFromMe = msg.isFromMe === true;

            if (isFromMe) {
              console.log(`⏭️ Skipping outbound message (sent by me): ${msg.text?.substring(0, 50)}`);
              return;
            }

            console.log(`   From: ${msg.handle?.address}`);
            console.log(`   Message: ${msg.text?.substring(0, 100)}`);
            console.log(`   GUID: ${msg.guid}`);
            console.log(`   isFromMe: ${msg.isFromMe}`);

            messageData = {
              guid: msg.guid,
              text: msg.text || '',
              timestamp: Math.floor(msg.dateCreated / 1000),
              isFromMe: msg.isFromMe || false,
              sender: msg.handle?.address,
              senderName: msg.handle?.name,
              senderService: msg.handle?.service,
              recipient: msg.chats?.[0]?.recipient,
              chatGuid: msg.chats?.[0]?.guid,
              chatName: msg.chats?.[0]?.displayName,
              attachments: msg.attachments || [],
              isDelivered: msg.isDelivered,
              dateDelivered: msg.dateDelivered,
              dateRead: msg.dateRead,
              partCount: msg.partCount,
              originalROWID: msg.originalROWID
            };
          } else {
            // Fallback for test webhooks or direct format
            messageData = webhookData;
            isFromMe = messageData.isFromMe === true;

            if (isFromMe) {
              console.log(`⏭️ Skipping outbound message (sent by me) in fallback format`);
              return;
            }
          }

          // Only process if it's an incoming message (not sent by us)
          if (!isFromMe && messageData && messageData.sender) {
            console.log('✅ Processing incoming message:', {
              guid: messageData.guid,
              from: messageData.sender,
              text: messageData.text?.substring(0, 50)
            });

            await processIncomingMessage(messageData, 'BLUEBUBBLES');
          } else if (isFromMe) {
            console.log(`⏭️ Skipping outbound message (sent by system)`);
          } else {
            console.log(`⚠️ Unknown webhook format, skipping`);
          }

        } catch (error) {
          console.error('❌ Error processing BlueBubbles message:', error);
        }
      });

    } catch (error) {
      console.error('❌ Error in BlueBubbles webhook:', error);
      res.status(200).json({ received: true, error: error.message });
    }
  })


  // Add to index.js - Fixed test endpoint
app.get('/test/contact-activity/:phone', async (req, res) => {
  try {
    const { phone } = req.params;
    
    // Format phone
    const cleanPhone = phone.replace(/\D/g, '');
    const formattedPhone = `+${cleanPhone}`;
    
    console.log(`🔍 Testing contact activity for: ${formattedPhone}`);
    
    // Find contact
    const contacts = await ghlService.searchContactsByPhone(formattedPhone);
    
    if (!contacts || contacts.length === 0) {
      return res.json({ success: false, error: 'Contact not found' });
    }
    
    const contact = contacts[0];
    console.log(`✅ Found contact: ${contact.id}`);
    
    // Get conversations
    const conversations = await ghlService.searchConversations({
      contactId: contact.id,
      limit: 5
    });
    
    console.log(`✅ Found ${conversations?.length || 0} conversations`);
    
    // Get messages from the first conversation (handle different response formats)
    let messages = [];
    if (conversations && conversations.length > 0) {
      const convId = conversations[0].id;
      console.log(`📋 Fetching messages for conversation: ${convId}`);
      
      const messagesResponse = await ghlService.getConversationMessages(convId, ghlService.locationId, 10);
      
      // Handle different response formats
      if (Array.isArray(messagesResponse)) {
        messages = messagesResponse;
      } else if (messagesResponse && messagesResponse.messages) {
        messages = messagesResponse.messages;
      } else if (messagesResponse && messagesResponse.data) {
        messages = messagesResponse.data;
      } else if (messagesResponse) {
        messages = [messagesResponse];
      }
    }
    
    // Calculate activity
    let lastActivityDate = null;
    
    // Check contact.lastMessageDate
    if (contact.lastMessageDate) {
      lastActivityDate = new Date(contact.lastMessageDate);
      console.log(`📅 Contact lastMessageDate: ${lastActivityDate.toISOString()}`);
    }
    
    // Check conversation lastMessageAt
    if (conversations && conversations.length > 0) {
      const conv = conversations[0];
      if (conv.lastMessageAt) {
        const convDate = new Date(conv.lastMessageAt);
        if (!lastActivityDate || convDate > lastActivityDate) {
          lastActivityDate = convDate;
        }
        console.log(`📅 Conversation lastMessageAt: ${convDate.toISOString()}`);
      }
    }
    
    // Check message dates
    if (messages && messages.length > 0) {
      for (const msg of messages) {
        if (msg.date) {
          const msgDate = new Date(msg.date);
          if (!lastActivityDate || msgDate > lastActivityDate) {
            lastActivityDate = msgDate;
          }
          console.log(`📅 Message date: ${msgDate.toISOString()} (${msg.direction})`);
        }
      }
    }
    
    // Calculate days since last activity
    let daysSinceActivity = null;
    if (lastActivityDate) {
      const now = new Date();
      const diffTime = Math.abs(now - lastActivityDate);
      daysSinceActivity = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
    }
    
    res.json({
      success: true,
      contact: {
        id: contact.id,
        phone: contact.phone,
        lastMessageDate: contact.lastMessageDate,
        tags: contact.tags || []
      },
      lastActivity: lastActivityDate ? {
        date: lastActivityDate.toISOString(),
        daysAgo: daysSinceActivity
      } : null,
      conversations: conversations ? conversations.map(c => ({
        id: c.id,
        type: c.type,
        lastMessageAt: c.lastMessageAt,
        lastInternalComment: c.lastInternalComment?.substring(0, 100)
      })) : [],
      messagesCount: messages ? (Array.isArray(messages) ? messages.length : 1) : 0,
      isActive: lastActivityDate ? daysSinceActivity <= 30 : false
    });
    
  } catch (error) {
    console.error('❌ Error:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message,
      stack: error.stack 
    });
  }
});

  // Message status updates (delivered, read, etc.)
  app.post('/bluebubbles/message/status', async (req, res) => {
    try {
      const statusData = req.body;
      console.log('📊 BlueBubbles message status update:', statusData);

      const apiPassword = req.query.password || req.headers['x-bluebubbles-password'];
      if (process.env.BLUEBUBBLES_PASSWORD && apiPassword !== process.env.BLUEBUBBLES_PASSWORD) {
        return res.status(401).json({ error: 'Unauthorized' });
      }

      res.status(200).json({ received: true });

      setImmediate(async () => {
        const { messageGuid, status, timestamp } = statusData;
        console.log(`📊 Message ${messageGuid} status: ${status} at ${timestamp}`);
        // Optional: Update message status in GHL
      });

    } catch (error) {
      console.error('❌ Error in BlueBubbles status webhook:', error);
      res.status(200).json({ received: true });
    }
  });

  // Typing indicators
  app.post('/bluebubbles/typing', async (req, res) => {
    try {
      const typingData = req.body;
      console.log('⌨️ BlueBubbles typing indicator:', typingData);

      const apiPassword = req.query.password || req.headers['x-bluebubbles-password'];
      if (process.env.BLUEBUBBLES_PASSWORD && apiPassword !== process.env.BLUEBUBBLES_PASSWORD) {
        return res.status(401).json({ error: 'Unauthorized' });
      }

      res.status(200).json({ received: true });

      setImmediate(async () => {
        const { chatGuid, sender, isTyping } = typingData;
        if (isTyping) {
          console.log(`⌨️ ${sender} is typing in chat ${chatGuid}`);
        }
      });

    } catch (error) {
      console.error('❌ Error in BlueBubbles typing webhook:', error);
      res.status(200).json({ received: true });
    }
  });

  // Reactions (tapbacks)
  app.post('/bluebubbles/reaction', async (req, res) => {
    try {
      const reactionData = req.body;
      console.log('💬 BlueBubbles reaction:', reactionData);

      const apiPassword = req.query.password || req.headers['x-bluebubbles-password'];
      if (process.env.BLUEBUBBLES_PASSWORD && apiPassword !== process.env.BLUEBUBBLES_PASSWORD) {
        return res.status(401).json({ error: 'Unauthorized' });
      }

      res.status(200).json({ received: true });

      setImmediate(async () => {
        const { messageGuid, reaction, sender } = reactionData;
        console.log(`💬 Reaction ${reaction} on message ${messageGuid} from ${sender}`);
      });

    } catch (error) {
      console.error('❌ Error in BlueBubbles reaction webhook:', error);
      res.status(200).json({ received: true });
    }
  });

  // ==================== iMESSAGE CHECK ENDPOINT ====================

  // Check iMessage availability for a phone number
  app.get('/api/check-imessage/:phone', async (req, res) => {
    try {
      const { phone } = req.params;

      if (!phone) {
        return res.status(400).json({ success: false, error: 'Phone number required' });
      }

      if (!bluebubblesService) {
        return res.status(400).json({
          success: false,
          error: 'BlueBubbles service not configured'
        });
      }

      const formattedPhone = phone.startsWith('+') ? phone : `+${phone.replace(/\D/g, '')}`;

      // Check cache first
      const cached = await getCachediMessageStatus(formattedPhone);
      if (cached) {
        return res.json({
          success: true,
          phone: formattedPhone,
          hasiMessage: cached.hasiMessage,
          service: cached.service,
          source: 'cache',
          cachedAt: new Date(cached.timestamp).toISOString()
        });
      }

      // Check via BlueBubbles
      const result = await bluebubblesService.checkiMessageAvailability(formattedPhone);

      // Cache the result
      await setCachediMessageStatus(formattedPhone, result.hasiMessage, result.service);

      res.json({
        success: true,
        phone: formattedPhone,
        hasiMessage: result.hasiMessage,
        service: result.service,
        source: 'api',
        timestamp: new Date().toISOString()
      });

    } catch (error) {
      console.error('Error checking iMessage:', error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Batch check multiple phone numbers
  app.post('/api/check-imessage/batch', async (req, res) => {
    try {
      const { phones } = req.body;

      if (!phones || !Array.isArray(phones)) {
        return res.status(400).json({
          success: false,
          error: 'Please provide an array of phone numbers'
        });
      }

      if (!bluebubblesService) {
        return res.status(400).json({
          success: false,
          error: 'BlueBubbles service not configured'
        });
      }

      const results = [];

      for (const phone of phones) {
        const formattedPhone = phone.startsWith('+') ? phone : `+${phone.replace(/\D/g, '')}`;

        // Check cache first
        const cached = await getCachediMessageStatus(formattedPhone);
        if (cached) {
          results.push({
            phone: formattedPhone,
            hasiMessage: cached.hasiMessage,
            service: cached.service,
            source: 'cache'
          });
          continue;
        }

        // Check via BlueBubbles
        try {
          const result = await bluebubblesService.checkiMessageAvailability(formattedPhone);
          await setCachediMessageStatus(formattedPhone, result.hasiMessage, result.service);
          results.push({
            phone: formattedPhone,
            hasiMessage: result.hasiMessage,
            service: result.service,
            source: 'api'
          });
        } catch (error) {
          results.push({
            phone: formattedPhone,
            hasiMessage: false,
            service: 'unknown',
            source: 'error',
            error: error.message
          });
        }

        // Small delay to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 200));
      }

      res.json({
        success: true,
        results: results,
        summary: {
          total: results.length,
          withiMessage: results.filter(r => r.hasiMessage).length,
          withoutiMessage: results.filter(r => !r.hasiMessage && r.source !== 'error').length,
          errors: results.filter(r => r.source === 'error').length
        }
      });

    } catch (error) {
      console.error('Error batch checking iMessage:', error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Get iMessage cache stats
  app.get('/api/imessage-cache-stats', async (req, res) => {
    const stats = {
      size: iMessageCache.size,
      entries: Array.from(iMessageCache.entries()).map(([phone, data]) => ({
        phone,
        hasiMessage: data.hasiMessage,
        service: data.service,
        cachedAt: new Date(data.timestamp).toISOString(),
        expiresAt: new Date(data.timestamp + CACHE_DURATION).toISOString()
      }))
    };

    res.json({
      success: true,
      stats
    });
  });

  // ==================== TALL BOB WEBHOOK ROUTES ====================

  app.post('/tallbob/incoming/sms', async (req, res) => {
    try {
      const messageData = req.body;
      console.log('📩 Received Tall Bob SMS webhook:', messageData);

      res.status(200).json({ received: true, timestamp: new Date().toISOString() });

      setImmediate(async () => {
        await processIncomingMessage(messageData, 'SMS');
      });

    } catch (error) {
      console.error('❌ Error in SMS webhook:', error);
      res.status(200).json({ received: true, error: error.message });
    }
  });

  app.post('/tallbob/incoming/mms', async (req, res) => {
    try {
      const messageData = req.body;
      console.log('📩 Received Tall Bob MMS webhook:', messageData);

      res.status(200).json({ received: true, timestamp: new Date().toISOString() });

      setImmediate(async () => {
        await processIncomingMessage(messageData, 'MMS');
      });

    } catch (error) {
      console.error('❌ Error in MMS webhook:', error);
      res.status(200).json({ received: true, error: error.message });
    }
  });

  // ==================== OUTGOING MESSAGE ENDPOINTS ====================

  app.post('/bluebubbles/send-message', async (req, res) => {
    try {
      const { to, from, message, mediaUrl, contactId, locationId, conversationId, effectId, forceSMS } = req.body;
      console.log('📱 Send BlueBubbles iMessage request:', { to, from, message: message?.substring(0, 50), mediaUrl, contactId });

      if (!to || !from || !message) {
        return res.status(400).json({
          success: false,
          error: 'Missing required fields: to, from, and message are required'
        });
      }

      if (!bluebubblesService) {
        return res.status(500).json({
          success: false,
          error: 'BlueBubbles service not configured'
        });
      }

      // Check iMessage availability if not forced to SMS
      let useiMessage = false;
      let routingReason = '';

      if (forceSMS) {
        useiMessage = false;
        routingReason = 'Forced SMS by request';
      } else {
        // Check if recipient has iMessage
        const formattedTo = to.startsWith('+') ? to : `+${to.replace(/\D/g, '')}`;
        const cached = await getCachediMessageStatus(formattedTo);

        if (cached) {
          useiMessage = cached.hasiMessage;
          routingReason = useiMessage ? 'Cached: Recipient has iMessage' : 'Cached: Recipient does not have iMessage';
          console.log(`📱 Using cached iMessage status: ${useiMessage}`);
        } else {
          try {
            const availability = await bluebubblesService.checkiMessageAvailability(formattedTo);
            useiMessage = availability.hasiMessage;
            routingReason = useiMessage ? 'API check: Recipient has iMessage' : 'API check: Recipient does not have iMessage';
            await setCachediMessageStatus(formattedTo, useiMessage, availability.service);
            console.log(`📱 API iMessage check: ${useiMessage}`);
          } catch (error) {
            console.error('iMessage check failed, falling back to SMS:', error.message);
            useiMessage = false;
            routingReason = 'iMessage check failed, falling back to SMS';
          }
        }
      }

      console.log(`📱 Routing decision: ${useiMessage ? 'iMessage' : 'SMS'} - ${routingReason}`);

      let result;
      if (useiMessage) {
        // Send via iMessage (BlueBubbles)
        if (mediaUrl) {
          result = await bluebubblesService.sendAttachment({ to, from, message, mediaUrl, effectId });
        } else {
          result = await bluebubblesService.sendMessage({ to, from, message, effectId });
        }
        result.provider = 'BlueBubbles (iMessage)';
      } else {
        // Fallback to SMS via Tall Bob
        const cleanFrom = from.replace(/[^0-9+]/g, '');
        if (mediaUrl) {
          result = await tallbobService.sendMMS({
            to,
            from: cleanFrom,
            message,
            mediaUrl,
            reference: `ghl_${contactId || 'unknown'}_${Date.now()}`
          });
        } else {
          result = await tallbobService.sendSMS({
            to,
            from: cleanFrom,
            message,
            reference: `ghl_${contactId || 'unknown'}_${Date.now()}`
          });
        }
        result.provider = 'Tall Bob (SMS)';
      }

      // Log to GHL if we have contact info
      if (contactId || conversationId) {
        try {
          const targetLocationId = locationId || ghlService.locationId;
          let conversation;

          if (conversationId) {
            conversation = { id: conversationId };
          } else if (contactId) {
            const convResult = await ghlService.getOrCreateConversation(
              contactId,
              mediaUrl ? 'MMS' : 'SMS',
              targetLocationId
            );
            conversation = convResult.conversation;
          }

          if (conversation) {
            await ghlService.addMessageToConversation(conversation.id, {
              contactId: contactId,
              body: message,
              messageType: mediaUrl ? 'MMS' : 'SMS',
              mediaUrls: mediaUrl ? [mediaUrl] : [],
              direction: 'outbound',
              date: new Date().toISOString(),
              providerMessageId: result.messageId || result.guid,
              fromNumber: from,
              toNumber: to,
              provider: useiMessage ? 'BlueBubbles' : 'Tall Bob',
              metadata: {
                routing: routingReason,
                imessageChecked: !forceSMS
              }
            }, targetLocationId);
            console.log(`✅ Outbound message logged in GHL via ${useiMessage ? 'iMessage' : 'SMS'}`);
          }
        } catch (ghlError) {
          console.error('⚠️ Failed to log message in GHL:', ghlError.message);
        }
      }

      res.json({
        success: true,
        messageId: result.messageId || result.guid,
        provider: result.provider,
        routing: {
          used: useiMessage ? 'iMessage' : 'SMS',
          reason: routingReason,
          timestamp: new Date().toISOString()
        }
      });

    } catch (error) {
      console.error('❌ Error sending message:', error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  app.post('/tallbob/send-message', async (req, res) => {
    try {
      const { to, from, message, mediaUrl, contactId, locationId, conversationId } = req.body;
      console.log('📤 Send Tall Bob message request:', { to, from, message: message?.substring(0, 50), mediaUrl, contactId });

      if (!to || !from || !message) {
        return res.status(400).json({
          success: false,
          error: 'Missing required fields: to, from, and message are required'
        });
      }

      let result;
      if (mediaUrl) {
        result = await tallbobService.sendMMS({
          to,
          from,
          message,
          mediaUrl,
          reference: `ghl_${contactId || 'unknown'}_${Date.now()}`
        });
      } else {
        result = await tallbobService.sendSMS({
          to,
          from,
          message,
          reference: `ghl_${contactId || 'unknown'}_${Date.now()}`
        });
      }

      // Log to GHL
      if (contactId || conversationId) {
        try {
          const targetLocationId = locationId || ghlService.locationId;
          let conversation;

          if (conversationId) {
            conversation = { id: conversationId };
          } else if (contactId) {
            const convResult = await ghlService.getOrCreateConversation(
              contactId,
              mediaUrl ? 'MMS' : 'SMS',
              targetLocationId
            );
            conversation = convResult.conversation;
          }

          if (conversation) {
            await ghlService.addMessageToConversation(conversation.id, {
              contactId: contactId,
              body: message,
              messageType: mediaUrl ? 'MMS' : 'SMS',
              mediaUrls: mediaUrl ? [mediaUrl] : [],
              direction: 'outbound',
              date: new Date().toISOString(),
              providerMessageId: result.messageId,
              fromNumber: from,
              toNumber: to,
              provider: 'Tall Bob'
            }, targetLocationId);
            console.log(`✅ Outbound Tall Bob message logged in GHL`);
          }
        } catch (ghlError) {
          console.error('⚠️ Failed to log message in GHL:', ghlError.message);
        }
      }

      res.json({
        success: true,
        messageId: result.messageId,
        provider: 'Tall Bob',
        timestamp: new Date().toISOString()
      });

    } catch (error) {
      console.error('❌ Error sending Tall Bob message:', error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // ==================== GHL WEBHOOK ROUTES (Outgoing Triggers) ====================

  app.post('/ghl/bluebubbles-webhook', async (req, res) => {
    try {
      const webhookData = req.body;
      console.log('📨 Received GHL webhook for BlueBubbles:', webhookData);

      res.status(200).json({ received: true });

      setImmediate(async () => {
        try {
          const { contactId, locationId, message, to, from, mediaUrl, conversationId, forceSMS } = webhookData;

          if (!to || !from || !message) {
            console.error('❌ Missing required fields in GHL webhook');
            return;
          }

          const response = await fetch(`${process.env.APP_URL || 'http://localhost:3000'}/bluebubbles/send-message`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ to, from, message, mediaUrl, contactId, locationId, conversationId, forceSMS })
          });

          const result = await response.json();
          console.log('✅ Message sent via BlueBubbles:', result);

        } catch (error) {
          console.error('❌ Error processing GHL webhook:', error);
        }
      });

    } catch (error) {
      console.error('❌ Error in GHL webhook handler:', error);
      res.status(200).json({ received: true, error: error.message });
    }
  });

  app.post('/ghl/tallbob-webhook', async (req, res) => {
    try {
      const webhookData = req.body;
      console.log('📨 Received GHL webhook for Tall Bob:', webhookData);

      res.status(200).json({ received: true });

      setImmediate(async () => {
        try {
          const { contactId, locationId, message, to, from, mediaUrl, conversationId } = webhookData;

          if (!to || !from || !message) {
            console.error('❌ Missing required fields in GHL webhook');
            return;
          }

          const response = await fetch(`${process.env.APP_URL || 'http://localhost:3000'}/tallbob/send-message`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ to, from, message, mediaUrl, contactId, locationId, conversationId })
          });

          const result = await response.json();
          console.log('✅ Message sent via Tall Bob:', result);

        } catch (error) {
          console.error('❌ Error processing GHL webhook:', error);
        }
      });

    } catch (error) {
      console.error('❌ Error in GHL webhook handler:', error);
      res.status(200).json({ received: true, error: error.message });
    }
  });

  // ==================== UTILITY ENDPOINTS ====================

  app.get('/bluebubbles/status', async (req, res) => {
    try {
      if (!bluebubblesService) {
        return res.json({
          success: false,
          error: 'BlueBubbles service not configured',
          configured: false
        });
      }
      const status = await bluebubblesService.getStatus();
      res.json({ success: true, status });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  app.get('/bluebubbles/chats', async (req, res) => {
    try {
      if (!bluebubblesService) {
        return res.status(400).json({
          success: false,
          error: 'BlueBubbles service not configured'
        });
      }
      const limit = req.query.limit ? parseInt(req.query.limit) : 20;
      const chats = await bluebubblesService.getChats(limit);
      res.json({ success: true, chats });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  app.get('/test/deduplication-stats', (req, res) => {
    res.json({
      success: true,
      cacheSize: processedEvents.size,
      locksSize: processingLock.size,
      events: Array.from(processedEvents).slice(-10)
    });
  });

  return app;
};