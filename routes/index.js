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
    await delay(waitTime);
  }
  
  try {
    lastApiCallTime = Date.now();
    const result = await fn();
    return result;
  } catch (error) {
    if (error.statusCode === 429 && retryCount < MAX_RETRIES) {
      const waitTime = (retryCount + 1) * 3000;
      console.log(`🚦 Rate limit hit! Retry ${retryCount + 1}/${MAX_RETRIES} after ${waitTime}ms`);
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
    if (now - timestamp > 3600000) {
      processedEvents.delete(id);
      processedExpiry.delete(id);
    }
  }
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
        return;
      }
    }

    // Create unique event ID based on provider and message data
    let eventId;
    if (provider === 'BLUEBUBBLES') {
      const blueData = messageData.data || messageData;
      eventId = blueData.guid || messageData.guid || blueData.messageGuid || 
                `${blueData.handle?.address}_${blueData.dateCreated}`;
    } else {
      eventId = messageData.eventID || messageData.id || 
                `${messageData.recipient}_${messageData.timestamp}`;
    }
    
    if (!eventId) {
      eventId = `${provider}_${Date.now()}_${Math.random()}`;
    }
    
    const uniqueEventId = `${provider}_${eventId}`;

    // Check if already processed
    const processed = await isEventProcessed(uniqueEventId);
    if (processed) return;

    // Check if currently being processed by another request
    const isLocked = await isEventProcessing(uniqueEventId);
    if (isLocked) return;

    // Acquire processing lock
    const locked = await lockEvent(uniqueEventId);
    if (!locked) return;

    // Extract data based on provider
    let customerPhone, providerNumber, messageText, timestamp, media, contactID, campaignID, reference;
    
    if (provider === 'BLUEBUBBLES') {
      const blueData = messageData.data || messageData;
      
      if (blueData.handle && blueData.handle.address) {
        customerPhone = blueData.handle.address;
      } else if (blueData.sender) {
        customerPhone = blueData.sender;
      } else if (blueData.from) {
        customerPhone = blueData.from;
      } else {
        await unlockEvent(uniqueEventId);
        return;
      }
      
      messageText = blueData.text || blueData.body || '';
      timestamp = blueData.dateCreated ? Math.floor(blueData.dateCreated / 1000) : Math.floor(Date.now() / 1000);
      media = blueData.attachments || [];
      reference = blueData.guid || messageData.guid;
      providerNumber = process.env.BLUEBUBBLES_IMESSAGE_ACCOUNT || 'iMessage';
      contactID = blueData.contactId || messageData.contactId;
      campaignID = blueData.campaignId || messageData.campaignId;
      
      if (customerPhone && customerPhone.match(/^\d+$/)) {
        customerPhone = `+${customerPhone.replace(/\D/g, '')}`;
      }
      
    } else {
      if (!messageData.recipient || !messageData.sentVia) {
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
      await unlockEvent(uniqueEventId);
      return;
    }

    const receivedDate = timestamp ? new Date(timestamp * 1000).toISOString() : new Date().toISOString();
    const messageType = provider === 'BLUEBUBBLES' ? 'iMessage' : (provider === 'MMS' ? 'MMS' : 'SMS');

    try {
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
      
      if (provider === 'BLUEBUBBLES' && customerPhone && customerPhone.includes('@')) {
        contactData.email = customerPhone;
      }
      
      const { contact, action } = await makeAPICall(
        () => ghlService.upsertContact(contactData, locationId),
        0,
        'upsertContact'
      );

      await delay(1000);

      const { conversation } = await makeAPICall(
        () => ghlService.getOrCreateConversation(contact.id, messageType, locationId),
        0,
        'getOrCreateConversation'
      );

      await delay(1000);
      
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
      
      await makeAPICall(
        () => ghlService.addMessageToConversation(conversation.id, messagePayload, locationId),
        0,
        'addMessageToConversation'
      );

      await markEventProcessed(uniqueEventId);

    } catch (error) {
      console.error(`❌ Error processing ${provider} message:`, error.message);
    } finally {
      await unlockEvent(uniqueEventId);
    }
  }

  // ==================== INCOMING FROM TALL BOB ====================

  app.post('/tallbob/incoming/sms', async (req, res) => {
    try {
      const messageData = req.body;
      res.status(200).json({ received: true, timestamp: new Date().toISOString() });
      
      setImmediate(async () => {
        await processIncomingMessage(messageData, 'SMS');
      });
      
    } catch (error) {
      res.status(200).json({ received: true, error: error.message });
    }
  });

  app.post('/tallbob/incoming/mms', async (req, res) => {
    try {
      const messageData = req.body;
      res.status(200).json({ received: true, timestamp: new Date().toISOString() });
      
      setImmediate(async () => {
        await processIncomingMessage(messageData, 'MMS');
      });
      
    } catch (error) {
      res.status(200).json({ received: true, error: error.message });
    }
  });

  // ==================== INCOMING FROM BLUEBUBBLES ====================

  app.post('/bluebubbles/incoming', async (req, res) => {
    try {
      const messageData = req.body;
      
      const apiPassword = req.query.password || req.headers['x-bluebubbles-password'];
      if (process.env.BLUEBUBBLES_PASSWORD && apiPassword !== process.env.BLUEBUBBLES_PASSWORD) {
        return res.status(401).json({ error: 'Unauthorized' });
      }
      
      res.status(200).json({ received: true, timestamp: new Date().toISOString() });
      
      setImmediate(async () => {
        await processIncomingMessage(messageData, 'BLUEBUBBLES');
      });
      
    } catch (error) {
      res.status(200).json({ received: true, error: error.message });
    }
  });

  // ==================== OUTGOING VIA TALL BOB ====================

  app.post('/tallbob/send-message', async (req, res) => {
    try {
      const { to, from, message, mediaUrl, contactId, locationId, conversationId } = req.body;
      console.log(`\n📤 Sending SMS via Tall Bob to ${to}`);

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
          }
        } catch (ghlError) {
          console.error('⚠️ Failed to log in GHL:', ghlError.message);
        }
      }

      console.log(`   ✅ Sent! ID: ${result.messageId}\n`);
      res.json({
        success: true,
        messageId: result.messageId,
        provider: 'Tall Bob',
        timestamp: new Date().toISOString()
      });

    } catch (error) {
      console.error(`❌ Send failed: ${error.message}`);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // ==================== OUTGOING VIA BLUEBUBBLES ====================

  app.post('/bluebubbles/send-message', async (req, res) => {
    try {
      const { to, from, message, mediaUrl, contactId, locationId, conversationId, effectId } = req.body;
      console.log(`\n📱 Sending iMessage via BlueBubbles to ${to}`);

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
          }
        } catch (ghlError) {
          console.error('⚠️ Failed to log in GHL:', ghlError.message);
        }
      }

      console.log(`   ✅ Sent! ID: ${result.guid}\n`);
      res.json({
        success: true,
        messageId: result.guid,
        provider: 'BlueBubbles',
        timestamp: new Date().toISOString()
      });

    } catch (error) {
      console.error(`❌ Send failed: ${error.message}`);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // ==================== GHL WEBHOOK HANDLERS ====================

  app.post('/ghl/bluebubbles-webhook', async (req, res) => {
    try {
      const webhookData = req.body;
      res.status(200).json({ received: true });
      
      setImmediate(async () => {
        try {
          const { contactId, locationId, message, to, from, mediaUrl, conversationId } = webhookData;
          
          if (!to || !from || !message) {
            return;
          }
          
          const response = await fetch(`${process.env.APP_URL || 'https://cayked.store'}/bluebubbles/send-message`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ to, from, message, mediaUrl, contactId, locationId, conversationId })
          });
          
        } catch (error) {
          console.error('❌ GHL webhook error:', error.message);
        }
      });
      
    } catch (error) {
      res.status(200).json({ received: true, error: error.message });
    }
  });

  app.post('/ghl/tallbob-webhook', async (req, res) => {
    try {
      const webhookData = req.body;
      res.status(200).json({ received: true });
      
      setImmediate(async () => {
        try {
          const { contactId, locationId, message, to, from, mediaUrl, conversationId } = webhookData;
          
          if (!to || !from || !message) {
            return;
          }
          
          const response = await fetch(`${process.env.APP_URL || 'https://cayked.store'}/tallbob/send-message`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ to, from, message, mediaUrl, contactId, locationId, conversationId })
          });
          
        } catch (error) {
          console.error('❌ GHL webhook error:', error.message);
        }
      });
      
    } catch (error) {
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