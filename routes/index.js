import { join } from 'path';

// Simple in-memory cache for deduplication
const processedEvents = new Set();
const processedExpiry = new Map();
const processingLock = new Set();

// Clean up old entries every hour
setInterval(() => {
  const now = Date.now();
  for (const [id, timestamp] of processedExpiry.entries()) {
    if (now - timestamp > 3600000) { // 1 hour
      processedEvents.delete(id);
      processedExpiry.delete(id);
    }
  }
  console.log(`🧹 Cleaned up deduplication cache. Current size: ${processedEvents.size}`);
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
      // Find or create contact
      console.log(`👤 Upserting contact with identifier: ${customerPhone}`);
      const contactData = {
        phone: customerPhone,
        firstName: messageData.senderName || messageData.firstName || 'iMessage',
        lastName: messageData.lastName || 'User',
        tags: [`${provider.toLowerCase()}_contact`, provider === 'BLUEBUBBLES' ? 'imessage_received' : `${messageType.toLowerCase()}_received`],
        source: provider === 'BLUEBUBBLES' ? 'BlueBubbles Integration' : 'Tall Bob Integration',
        customFields: [
          { key: 'last_incoming_message', value: messageText || '' },
          { key: 'last_message_date', value: receivedDate },
          { key: `${provider.toLowerCase()}_contact_id`, value: contactID || '' },
          { key: `${provider.toLowerCase()}_campaign_id`, value: campaignID || '' },
          ...(provider === 'BLUEBUBBLES' ? [{ key: 'imessage_guid', value: reference || '' }] : [])
        ]
      };
      
      // Add email for BlueBubbles if it's an email address
      if (provider === 'BLUEBUBBLES' && customerPhone && customerPhone.includes('@')) {
        contactData.email = customerPhone;
      }
      
      const { contact, action } = await ghlService.upsertContact(contactData, locationId);

      console.log(`✅ Contact ${action}: ${contact.id}`);

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
          partCount: messageData.partCount
        } : null
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
  app.post('/bluebubbles/incoming', async (req, res) => {
    try {
      const webhookData = req.body;
      
      // Enhanced logging
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
          
          // Handle BlueBubbles webhook format: { type: 'new-message', data: {...} }
          if (webhookData.type === 'new-message' && webhookData.data) {
            const msg = webhookData.data;
            
            console.log(`   From: ${msg.handle?.address}`);
            console.log(`   Message: ${msg.text?.substring(0, 100)}`);
            console.log(`   GUID: ${msg.guid}`);
            console.log(`   Timestamp: ${new Date(msg.dateCreated).toISOString()}`);
            
            messageData = {
              // Core message data
              guid: msg.guid,
              text: msg.text || '',
              timestamp: Math.floor(msg.dateCreated / 1000),
              isFromMe: msg.isFromMe || false,
              
              // Sender info
              sender: msg.handle?.address,
              senderName: msg.handle?.name,
              senderService: msg.handle?.service,
              
              // Recipient info (from chat)
              recipient: msg.chats?.[0]?.recipient,
              chatGuid: msg.chats?.[0]?.guid,
              chatName: msg.chats?.[0]?.displayName,
              
              // Attachments
              attachments: msg.attachments || [],
              
              // Status
              isDelivered: msg.isDelivered,
              dateDelivered: msg.dateDelivered,
              dateRead: msg.dateRead,
              
              // Metadata
              partCount: msg.partCount,
              originalROWID: msg.originalROWID
            };
          } else {
            // Fallback for test webhooks or direct format
            messageData = webhookData;
            console.log('⚠️ Unknown webhook format:', JSON.stringify(webhookData, null, 2));
          }
          
          console.log('✅ Processing message:', {
            guid: messageData.guid,
            from: messageData.sender,
            text: messageData.text?.substring(0, 50)
          });
          
          await processIncomingMessage(messageData, 'BLUEBUBBLES');
          
        } catch (error) {
          console.error('❌ Error processing BlueBubbles message:', error);
        }
      });
      
    } catch (error) {
      console.error('❌ Error in BlueBubbles webhook:', error);
      res.status(200).json({ received: true, error: error.message });
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
      const { to, from, message, mediaUrl, contactId, locationId, conversationId, effectId } = req.body;
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

      let result;
      if (mediaUrl) {
        result = await bluebubblesService.sendAttachment({ to, from, message, mediaUrl, effectId });
      } else {
        result = await bluebubblesService.sendMessage({ to, from, message, effectId });
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
              providerMessageId: result.guid,
              fromNumber: from,
              toNumber: to,
              provider: 'BlueBubbles'
            }, targetLocationId);
            console.log(`✅ Outbound iMessage logged in GHL`);
          }
        } catch (ghlError) {
          console.error('⚠️ Failed to log iMessage in GHL:', ghlError.message);
        }
      }

      res.json({
        success: true,
        messageId: result.guid,
        provider: 'BlueBubbles',
        timestamp: new Date().toISOString()
      });

    } catch (error) {
      console.error('❌ Error sending iMessage:', error);
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
          const { contactId, locationId, message, to, from, mediaUrl, conversationId } = webhookData;
          
          if (!to || !from || !message) {
            console.error('❌ Missing required fields in GHL webhook');
            return;
          }
          
          const response = await fetch(`${process.env.APP_URL || 'http://localhost:3000'}/bluebubbles/send-message`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ to, from, message, mediaUrl, contactId, locationId, conversationId })
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