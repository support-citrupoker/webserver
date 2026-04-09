// routes/index.js
import { join } from 'path';

// Simple in-memory cache for deduplication
const processedEvents = new Set();
const processedExpiry = new Map();
const processingLock = new Set();

// Rate limiting for GHL API calls
let lastApiCallTime = 0;
const MIN_API_DELAY = 2000; // 2 seconds between API calls
const MAX_RETRIES = 3;

// Helper function for delay
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Rate-limited API call wrapper
async function makeAPICall(fn, retryCount = 0, callName = 'API Call') {
  const now = Date.now();
  const timeSinceLastCall = now - lastApiCallTime;
  
  if (timeSinceLastCall < MIN_API_DELAY) {
    const waitTime = MIN_API_DELAY - timeSinceLastCall;
    console.log(`⏸️ [${callName}] Rate limit protection: Waiting ${waitTime}ms`);
    await delay(waitTime);
  }
  
  try {
    lastApiCallTime = Date.now();
    const result = await fn();
    return result;
  } catch (error) {
    if (error.statusCode === 429 && retryCount < MAX_RETRIES) {
      const waitTime = (retryCount + 1) * 3000; // 3s, 6s, 9s
      console.log(`🚦 [${callName}] Rate limit hit! Retry ${retryCount + 1}/${MAX_RETRIES} after ${waitTime}ms`);
      await delay(waitTime);
      return makeAPICall(fn, retryCount + 1, callName);
    }
    throw error;
  }
}

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

export default (app, tallbobService, ghlService, bluebubblesService) => {

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
      // BlueBubbles - extract GUID from nested data
      const blueData = messageData.data || messageData;
      eventId = blueData.guid || messageData.guid || blueData.messageGuid || 
                `${blueData.handle?.address}_${blueData.dateCreated}`;
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
      const blueData = messageData.data || messageData;
      
      console.log('📱 BlueBubbles raw data:', JSON.stringify(blueData, null, 2));
      
      // Extract phone number from handle
      if (blueData.handle && blueData.handle.address) {
        customerPhone = blueData.handle.address;
      } else if (blueData.sender) {
        customerPhone = blueData.sender;
      } else if (blueData.from) {
        customerPhone = blueData.from;
      } else {
        console.error('❌ Could not extract phone number from BlueBubbles message');
        await unlockEvent(uniqueEventId);
        return;
      }
      
      // Extract message text
      messageText = blueData.text || blueData.body || '';
      
      // Extract timestamp (BlueBubbles uses milliseconds)
      timestamp = blueData.dateCreated ? Math.floor(blueData.dateCreated / 1000) : Math.floor(Date.now() / 1000);
      
      // Extract media attachments
      media = blueData.attachments || [];
      
      // Extract GUID as message ID
      reference = blueData.guid || messageData.guid;
      
      // Set provider number (the iMessage account)
      providerNumber = process.env.BLUEBUBBLES_IMESSAGE_ACCOUNT || 'iMessage';
      
      // Get contact ID if available
      contactID = blueData.contactId || messageData.contactId;
      campaignID = blueData.campaignId || messageData.campaignId;
      
      console.log(`📱 BlueBubbles message extracted:`);
      console.log(`   From: ${customerPhone}`);
      console.log(`   Text: "${messageText}"`);
      console.log(`   GUID: ${reference}`);
      console.log(`   Timestamp: ${timestamp}`);
      console.log(`   Attachments: ${media.length}`);
      
      // Format phone numbers if they look like phone numbers (not emails)
      if (customerPhone && customerPhone.match(/^\+\d+$/)) {
        // Already in + format, keep as is
      } else if (customerPhone && customerPhone.match(/^\d+$/)) {
        customerPhone = `+${customerPhone.replace(/\D/g, '')}`;
      }
      
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

    const locationId = ghlService.locationId || process.env.GHL_LOCATION_ID;

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
        firstName: messageData.firstName || 'Unknown',
        lastName: messageData.lastName || 'Contact',
        tags: [`${provider.toLowerCase()}_contact`, provider === 'BLUEBUBBLES' ? 'imessage_received' : `${messageType.toLowerCase()}_received`],
        source: provider === 'BLUEBUBBLES' ? 'BlueBubbles Integration' : 'Tall Bob Integration',
        customFields: [
          { key: 'last_incoming_message', value: messageText || '' },
          { key: 'last_message_date', value: receivedDate },
          { key: `${provider.toLowerCase()}_contact_id`, value: contactID || '' },
          { key: `${provider.toLowerCase()}_campaign_id`, value: campaignID || '' }
        ]
      };
      
      // Add email for BlueBubbles if it's an email address
      if (provider === 'BLUEBUBBLES' && customerPhone && customerPhone.includes('@')) {
        contactData.email = customerPhone;
      }
      
      // Rate-limited API call 1: Upsert contact
      const { contact, action } = await makeAPICall(
        () => ghlService.upsertContact(contactData, locationId),
        0,
        'upsertContact'
      );
      console.log(`✅ Contact ${action}: ${contact.id}`);

      // Delay between API calls
      await delay(1000);

      // Get or create conversation
      console.log(`💬 Getting/creating conversation for contact: ${contact.id}`);
      
      // Rate-limited API call 2: Get or create conversation
      const { conversation } = await makeAPICall(
        () => ghlService.getOrCreateConversation(contact.id, messageType, locationId),
        0,
        'getOrCreateConversation'
      );
      console.log(`✅ Conversation: ${conversation.id}`);

      // Delay between API calls
      await delay(1000);

      // Add message to conversation
      console.log(`📝 Adding ${messageType} message to conversation: ${conversation.id}`);
      
      const messagePayload = {
        contactId: contact.id,
        body: messageText || (provider === 'MMS' ? 'MMS message' : ''),
        messageType: messageType,
        mediaUrls: media ? (Array.isArray(media) ? media : [media]) : [],
        direction: 'inbound',
        date: receivedDate,
        fromNumber: providerNumber,
        toNumber: customerPhone,
        providerMessageId: reference || eventId,
        provider: provider === 'BLUEBUBBLES' ? 'BlueBubbles' : 'Tall Bob'
      };
      
      // Rate-limited API call 3: Add message to conversation
      await makeAPICall(
        () => ghlService.addMessageToConversation(conversation.id, messagePayload, locationId),
        0,
        'addMessageToConversation'
      );

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

  // ==================== INCOMING FROM TALL BOB ====================

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

  // ==================== INCOMING FROM BLUEBUBBLES ====================

  app.post('/bluebubbles/incoming', async (req, res) => {
    try {
      const messageData = req.body;
      console.log('📱 Received BlueBubbles iMessage webhook:', JSON.stringify(messageData, null, 2));
      
      // Verify BlueBubbles API password if configured
      const apiPassword = req.query.password || req.headers['x-bluebubbles-password'];
      if (process.env.BLUEBUBBLES_PASSWORD && apiPassword !== process.env.BLUEBUBBLES_PASSWORD) {
        console.error('❌ Invalid BlueBubbles webhook password');
        return res.status(401).json({ error: 'Unauthorized' });
      }
      
      res.status(200).json({ received: true, timestamp: new Date().toISOString() });
      
      setImmediate(async () => {
        await processIncomingMessage(messageData, 'BLUEBUBBLES');
      });
      
    } catch (error) {
      console.error('❌ Error in BlueBubbles webhook:', error);
      res.status(200).json({ received: true, error: error.message });
    }
  });

  // ==================== OUTGOING VIA TALL BOB ====================

  app.post('/tallbob/send-message', async (req, res) => {
    try {
      const { to, from, message, mediaUrl, contactId, locationId, conversationId } = req.body;
      console.log('📤 Send Tall Bob message request:', { to, from, message, mediaUrl, contactId });

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

      // Log to GHL with rate limiting
      if (contactId || conversationId) {
        try {
          const targetLocationId = locationId || ghlService.locationId;
          let conversation;
          
          if (conversationId) {
            conversation = { id: conversationId };
          } else if (contactId) {
            const convResult = await makeAPICall(
              () => ghlService.getOrCreateConversation(contactId, mediaUrl ? 'MMS' : 'SMS', targetLocationId),
              0,
              'getOrCreateConversation-outbound'
            );
            conversation = convResult.conversation;
          }

          if (conversation) {
            await makeAPICall(
              () => ghlService.addMessageToConversation(conversation.id, {
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
              }, targetLocationId),
              0,
              'addMessageToConversation-outbound'
            );
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

  // ==================== OUTGOING VIA BLUEBUBBLES ====================

  app.post('/bluebubbles/send-message', async (req, res) => {
    try {
      const { to, from, message, mediaUrl, contactId, locationId, conversationId, effectId } = req.body;
      console.log('📱 Send BlueBubbles iMessage request:', { to, from, message, mediaUrl, contactId });

      if (!to || !from || !message) {
        return res.status(400).json({ 
          success: false, 
          error: 'Missing required fields: to, from, and message are required' 
        });
      }

      let result;
      if (mediaUrl) {
        result = await bluebubblesService.sendAttachment({ to, from, message, mediaUrl, effectId });
      } else {
        result = await bluebubblesService.sendMessage({ to, from, message, effectId });
      }

      // Log to GHL with rate limiting
      if (contactId || conversationId) {
        try {
          const targetLocationId = locationId || ghlService.locationId;
          let conversation;
          
          if (conversationId) {
            conversation = { id: conversationId };
          } else if (contactId) {
            const convResult = await makeAPICall(
              () => ghlService.getOrCreateConversation(contactId, mediaUrl ? 'MMS' : 'SMS', targetLocationId),
              0,
              'getOrCreateConversation-outbound-blue'
            );
            conversation = convResult.conversation;
          }

          if (conversation) {
            await makeAPICall(
              () => ghlService.addMessageToConversation(conversation.id, {
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
              }, targetLocationId),
              0,
              'addMessageToConversation-outbound-blue'
            );
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

  // ==================== GHL WEBHOOK HANDLERS ====================

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
          
          const response = await fetch(`${process.env.APP_URL || 'https://cayked.store'}/bluebubbles/send-message`, {
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
          
          const response = await fetch(`${process.env.APP_URL || 'https://cayked.store'}/tallbob/send-message`, {
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
      const status = await bluebubblesService.getStatus();
      res.json({ success: true, status });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  app.get('/bluebubbles/chats', async (req, res) => {
    try {
      const limit = req.query.limit ? parseInt(req.query.limit) : 20;
      const chats = await bluebubblesService.getChats(limit);
      res.json({ success: true, chats });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  app.post('/bluebubbles/typing', async (req, res) => {
    try {
      const { chatGuid, isTyping } = req.body;
      if (!chatGuid) {
        return res.status(400).json({ success: false, error: 'chatGuid is required' });
      }
      const result = await bluebubblesService.sendTypingIndicator(chatGuid, isTyping !== false);
      res.json({ success: true, result });
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

  app.get('/test/bluebubbles-status', async (req, res) => {
  try {
    const status = await bluebubblesService.getStatus();
    res.json({
      success: true,
      status: status,
      config: {
        serverUrl: process.env.BLUEBUBBLES_SERVER_URL,
        hasPassword: !!process.env.BLUEBUBBLES_PASSWORD
      }
    });
  } catch (error) {
    res.json({
      success: false,
      error: error.message
    });
  }
});

  return app;
};