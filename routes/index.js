// routes/index.js
import { join } from 'path';
import crypto from 'crypto';
import CommentTracker from '../services/tracker.service.js';

// Initialize tracker
let commentTracker;

const processedEvents = new Set();
const processedExpiry = new Map();
const processingLock = new Set();

// Track messages sent by us to prevent loops
const sentMessages = new Set();
const sentMessagesExpiry = new Map();

let lastApiCallTime = 0;
const MIN_API_DELAY = 2000;
const MAX_RETRIES = 3;

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function makeAPICall(fn, retryCount = 0, callName = 'API Call') {
  const now = Date.now();
  const timeSinceLastCall = now - lastApiCallTime;
  
  if (timeSinceLastCall < MIN_API_DELAY) {
    const waitTime = MIN_API_DELAY - timeSinceLastCall;
    console.log(`⏸️ [${callName}] Waiting ${waitTime}ms before next API call`);
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

// Clean up processed events every hour
setInterval(() => {
  const now = Date.now();
  for (const [id, timestamp] of processedExpiry.entries()) {
    if (now - timestamp > 3600000) {
      processedEvents.delete(id);
      processedExpiry.delete(id);
    }
  }
}, 3600000);

// Clean up sent messages every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [id, timestamp] of sentMessagesExpiry.entries()) {
    if (now - timestamp > 300000) { // Clear after 5 minutes
      sentMessages.delete(id);
      sentMessagesExpiry.delete(id);
    }
  }
  console.log(`🧹 Cleanup: ${sentMessages.size} sent messages tracked, ${processedEvents.size} processed events tracked`);
}, 300000);

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

// Track sent messages
async function markMessageAsSent(messageId, provider) {
  if (!messageId) return;
  const key = `${provider}_${messageId}`;
  sentMessages.add(key);
  sentMessagesExpiry.set(key, Date.now());
  console.log(`📝 Tracked sent message: ${key}`);
}

async function wasMessageSentByUs(messageId, provider) {
  if (!messageId) return false;
  const key = `${provider}_${messageId}`;
  const wasSent = sentMessages.has(key);
  if (wasSent) {
    console.log(`🔄 Loop detected: Message ${messageId} was sent by us, skipping`);
  }
  return wasSent;
}

// Helper to check if we've already processed this comment recently
async function isCommentDuplicate(contactId, comment, provider) {
  if (!comment || !contactId || !commentTracker) return false;
  
  try {
    // Use the tracker to check if this is a new comment
    const { isNew } = await commentTracker.checkComment(contactId, comment);
    
    if (!isNew) {
      console.log(`🔄 Duplicate comment detected for contact ${contactId}: "${comment.substring(0, 50)}"`);
      
      // Update activity to show we saw this duplicate
      await commentTracker.updateContactActivity(contactId, {
        last_activity: Math.floor(Date.now() / 1000),
        last_provider: provider
      });
      
      return true;
    }
  } catch (error) {
    console.error(`Error checking duplicate: ${error.message}`);
  }
  
  return false;
}

// Webhook processor for internal comments
let webhookProcessingQueue = [];
let isProcessingWebhookQueue = false;

async function processWebhookQueue() {
  if (isProcessingWebhookQueue) return;
  if (webhookProcessingQueue.length === 0) return;
  
  isProcessingWebhookQueue = true;
  
  while (webhookProcessingQueue.length > 0) {
    const payload = webhookProcessingQueue.shift();
    try {
      await processInternalCommentWebhook(payload);
    } catch (error) {
      console.error('❌ Error processing queued webhook:', error.message);
    }
    await delay(500);
  }
  
  isProcessingWebhookQueue = false;
}

async function processInternalCommentWebhook(payload) {
  const startTime = Date.now();
  
  try {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`💬 INTERNAL COMMENT WEBHOOK RECEIVED`);
    console.log(`   🕐 Time: ${new Date().toLocaleString()}`);
    console.log(`   📍 Location: ${payload.locationId}`);
    console.log(`   💬 Message: "${payload.message?.substring(0, 100)}${payload.message?.length > 100 ? '...' : ''}"`);
    console.log(`   📞 Phone: ${payload.phone}`);
    console.log(`   🆔 Message ID: ${payload.messageId}`);
    console.log(`   🆔 Conversation ID: ${payload.conversationId}`);
    console.log(`   🆔 Contact ID: ${payload.contactId}`);
    console.log(`   📝 Type: ${payload.type}`);
    console.log(`   🔍 Direction: ${payload.direction || 'unknown'}`);
    console.log(`${'='.repeat(60)}`);
    
    // CRITICAL: Skip if this is an OUTBOUND message (sent by us)
    if (payload.direction === 'outbound' || payload.type === 'outbound') {
      console.log(`⏭️ Skipping outbound message - this was sent by us`);
      return { success: true, message: 'Outbound message', skipped: true };
    }
    
    // Check if this message was added by our system (look for our provider markers)
    if (payload.provider === 'Tall Bob' || payload.provider === 'BlueBubbles') {
      console.log(`⏭️ Skipping message from ${payload.provider} - already logged by us`);
      return { success: true, message: 'Already logged', skipped: true };
    }
    
    if (!payload.message || payload.message.trim() === '') {
      console.log(`⏭️ Empty message, skipping`);
      return { success: true, message: 'Empty message', skipped: true };
    }
    
    if (payload.message.trim().toLowerCase().startsWith('@reply')) {
      console.log(`⏭️ Internal note (@reply), skipping`);
      return { success: true, message: 'Internal note', skipped: true };
    }
    
    // Check for duplicate using tracker
    const isDuplicate = await isCommentDuplicate(
      payload.contactId, 
      payload.message, 
      'internal-comment'
    );
    
    if (isDuplicate) {
      console.log(`⏭️ Duplicate comment detected, skipping to prevent loop`);
      return { success: true, message: 'Duplicate comment', skipped: true };
    }
    
    const useIMessage = process.env.IMESSAGEORSMS === 'true';
    const provider = useIMessage ? 'bluebubbles' : 'tallbob';
    
    const imageUrl = extractImageUrl(payload.message);
    const cleanMessage = imageUrl ? payload.message.replace(imageUrl, '').trim() : payload.message.trim();
    
    console.log(`   📤 Sending reply via ${provider.toUpperCase()}`);
    
    const sendResult = await sendReplyViaProvider(
      payload.contactId,
      payload.phone,
      cleanMessage,
      imageUrl,
      payload.locationId,
      payload.conversationId,
      provider
    );
    
    const duration = Date.now() - startTime;
    
    if (sendResult.success) {
      console.log(`\n✅ Webhook processed successfully in ${duration}ms`);
      console.log(`   📤 Reply sent via ${sendResult.provider.toUpperCase()}`);
      console.log(`   🆔 Message ID: ${sendResult.messageId}`);
      
      // Update tracker with successful send
      if (commentTracker) {
        await commentTracker.updateContactActivity(payload.contactId, {
          last_activity: Math.floor(Date.now() / 1000),
          last_provider: sendResult.provider
        });
      }
    } else {
      console.log(`\n❌ Webhook processing failed in ${duration}ms`);
      console.log(`   Error: ${sendResult.error}`);
    }
    
    return sendResult;
    
  } catch (error) {
    console.error(`❌ Webhook handler error:`, error.message);
    return { success: false, error: error.message };
  }
}

function extractImageUrl(text) {
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

async function sendReplyViaProvider(contactId, phoneNumber, messageText, imageUrl, locationId, conversationId, provider) {
  try {
    console.log(`\n📤 ===== SENDING ${provider.toUpperCase()} REPLY =====`);
    console.log(`   📞 To: ${phoneNumber}`);
    console.log(`   💬 Message: "${messageText.substring(0, 100)}${messageText.length > 100 ? '...' : ''}"`);
    console.log(`   🖼️ Image: ${imageUrl ? 'Yes' : 'No'}`);
    
    let result;
    
    if (provider === 'bluebubbles') {
      if (!global.bluebubblesService) {
        throw new Error('BlueBubbles service not configured');
      }
      
      // BlueBubbles only needs 'to' and 'message' - 'from' is not used
      if (imageUrl) {
        result = await global.bluebubblesService.sendMessage({
          to: phoneNumber,
          message: `${messageText} ${imageUrl}`,
          effectId: null
        });
      } else {
        result = await global.bluebubblesService.sendMessage({
          to: phoneNumber,
          message: messageText,
          effectId: null
        });
      }
      
      console.log(`   ✅ iMessage sent! GUID: ${result.guid}`);
      
      // Track this message to prevent loop
      if (result.guid) {
        await markMessageAsSent(result.guid, 'bluebubbles');
      }
      
      if (conversationId && global.ghlService) {
        try {
          await makeAPICall(
            () => global.ghlService.addMessageToConversation(conversationId, {
              contactId: contactId,
              body: messageText,
              messageType: imageUrl ? 'MMS' : 'SMS',
              mediaUrls: imageUrl ? [imageUrl] : [],
              direction: 'outbound',
              date: new Date().toISOString(),
              providerMessageId: result.guid,
              provider: 'BlueBubbles'
            }, locationId),
            0,
            'addMessageToConversation'
          );
          console.log(`   📝 Logged to GHL conversation`);
        } catch (ghlError) {
          console.log(`   ⚠️ Could not log to GHL: ${ghlError.message}`);
        }
      }
      
      return { success: true, provider: 'bluebubbles', messageId: result.guid };
      
    } else {
      if (!global.tallbobService) {
        throw new Error('TallBob service not configured');
      }
      
      if (imageUrl) {
        result = await global.tallbobService.sendMMS({
          to: phoneNumber,
          from: process.env.TALLBOB_NUMBER || '+61428616133',
          message: messageText,
          mediaUrl: imageUrl,
          reference: `webhook_${contactId}_${Date.now()}`
        });
        console.log(`   ✅ MMS sent! ID: ${result.sms_id || result.message_id || result.id}`);
      } else {
        result = await global.tallbobService.sendSMS({
          to: phoneNumber,
          from: process.env.TALLBOB_NUMBER || '+61428616133',
          message: messageText,
          reference: `webhook_${contactId}_${Date.now()}`
        });
        console.log(`   ✅ SMS sent! ID: ${result.sms_id || result.message_id || result.id}`);
      }
      
      // Track this message to prevent loop - FIXED for Tall Bob
      const tallBobMsgId = result.sms_id || result.message_id || result.id;
      if (tallBobMsgId) {
        await markMessageAsSent(tallBobMsgId, 'tallbob');
        console.log(`   ✅ Tracked message ID: ${tallBobMsgId}`);
      } else {
        console.log(`   ⚠️ Warning: No message ID in Tall Bob response`);
      }
      
      if (conversationId && global.ghlService) {
        try {
          await makeAPICall(
            () => global.ghlService.addMessageToConversation(conversationId, {
              contactId: contactId,
              body: messageText,
              messageType: imageUrl ? 'MMS' : 'SMS',
              mediaUrls: imageUrl ? [imageUrl] : [],
              direction: 'outbound',
              date: new Date().toISOString(),
              providerMessageId: tallBobMsgId,
              provider: 'Tall Bob'
            }, locationId),
            0,
            'addMessageToConversation'
          );
          console.log(`   📝 Logged to GHL conversation`);
        } catch (ghlError) {
          console.log(`   ⚠️ Could not log to GHL: ${ghlError.message}`);
        }
      }
      
      return { success: true, provider: 'tallbob', messageId: tallBobMsgId };
    }
    
  } catch (error) {
    console.error(`   ❌ Send failed: ${error.message}`);
    return { success: false, error: error.message };
  }
}

export default async (app, tallbobService, ghlService, bluebubblesService) => {
  
  // Initialize tracker
  commentTracker = new CommentTracker();
  await commentTracker.initialize();
  
  global.tallbobService = tallbobService;
  global.ghlService = ghlService;
  global.bluebubblesService = bluebubblesService;

  app.post('/webhook/ghl/internal-comment', async (req, res) => {
    try {
      const payload = req.body;
      console.log(`📨 Received GHL webhook: ${payload.type || 'internal-comment'} from ${payload.phone || 'unknown'}`);
      res.status(200).json({ received: true, timestamp: new Date().toISOString(), messageId: payload.messageId });
      webhookProcessingQueue.push(payload);
      processWebhookQueue().catch(console.error);
    } catch (error) {
      console.error('❌ Error in GHL webhook:', error.message);
      res.status(200).json({ received: true, error: error.message });
    }
  });

  app.get('/webhook/status', async (req, res) => {
    const trackedCount = commentTracker ? await commentTracker.getCount() : 0;
    res.json({
      status: 'healthy',
      queueSize: webhookProcessingQueue.length,
      isProcessing: isProcessingWebhookQueue,
      trackedSentMessages: sentMessages.size,
      trackedProcessedEvents: processedEvents.size,
      trackedContacts: trackedCount,
      timestamp: new Date().toISOString()
    });
  });

  async function processIncomingMessage(messageData, provider = 'SMS') {
    console.log(`\n🔍 PROCESSING INCOMING MESSAGE from ${provider}`);
    
    if (provider === 'SMS' || provider === 'MMS') {
      const validEvents = ['message_received', 'message_received_mms'];
      if (!validEvents.includes(messageData.eventType)) {
        console.log(`⏭️ Not a valid event type: ${messageData.eventType}`);
        return;
      }
    }

    let eventId;
    let messageIdToCheck;
    let providerName;
    
    if (provider === 'BLUEBUBBLES') {
      const blueData = messageData.data || messageData;
      
      // CRITICAL: Skip if this message is from me (sent by us)
      if (blueData.isFromMe === true) {
        console.log(`⏭️ Skipping BlueBubbles message - isFromMe flag is true (this is our own message)`);
        return;
      }
      
      // Check if this message was sent by us via our tracking system
      messageIdToCheck = blueData.guid || messageData.guid;
      providerName = 'bluebubbles';
      
      if (messageIdToCheck && await wasMessageSentByUs(messageIdToCheck, providerName)) {
        console.log(`⏭️ Skipping BlueBubbles message ${messageIdToCheck} - was sent by us (tracked)`);
        return;
      }
      
      eventId = blueData.guid || messageData.guid || blueData.messageGuid || 
                `${blueData.handle?.address}_${blueData.dateCreated}`;
                
      console.log(`📱 BlueBubbles message received from: ${blueData.handle?.address}, isFromMe: ${blueData.isFromMe}, GUID: ${messageIdToCheck}`);
    } else {
      // Check TallBob message
      messageIdToCheck = messageData.eventID || messageData.id;
      providerName = 'tallbob';
      
      if (messageIdToCheck && await wasMessageSentByUs(messageIdToCheck, providerName)) {
        console.log(`⏭️ Skipping TallBob message ${messageIdToCheck} - was sent by us (tracked)`);
        return;
      }
      
      eventId = messageData.eventID || messageData.id || 
                `${messageData.recipient}_${messageData.timestamp}`;
                
      console.log(`📱 TallBob message received from: ${messageData.recipient}, EventID: ${messageIdToCheck}`);
    }
    
    if (!eventId) {
      eventId = `${provider}_${Date.now()}_${Math.random()}`;
    }
    
    const uniqueEventId = `${provider}_${eventId}`;

    const processed = await isEventProcessed(uniqueEventId);
    if (processed) {
      console.log(`⏭️ Event already processed: ${uniqueEventId}`);
      return;
    }

    const isLocked = await isEventProcessing(uniqueEventId);
    if (isLocked) {
      console.log(`⏭️ Event already being processed: ${uniqueEventId}`);
      return;
    }

    const locked = await lockEvent(uniqueEventId);
    if (!locked) {
      console.log(`⏭️ Could not lock event: ${uniqueEventId}`);
      return;
    }

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
        console.log(`❌ No phone number found in BlueBubbles message`);
        await unlockEvent(uniqueEventId);
        return;
      }
      
      messageText = blueData.text || blueData.body || '';
      timestamp = blueData.dateCreated ? Math.floor(blueData.dateCreated / 1000) : Math.floor(Date.now() / 1000);
      
      if (blueData.attachments && blueData.attachments.length > 0) {
        media = blueData.attachments.map(att => att.url || att.guid).filter(url => url);
      } else {
        media = [];
      }
      
      reference = blueData.guid || messageData.guid;
      providerNumber = process.env.BLUEBUBBLES_IMESSAGE_ACCOUNT || 'iMessage';
      contactID = blueData.contactId || messageData.contactId;
      campaignID = blueData.campaignId || messageData.campaignId;
      
      if (customerPhone && customerPhone.match(/^\d+$/)) {
        customerPhone = `+${customerPhone.replace(/\D/g, '')}`;
      }
      
      console.log(`   📞 Customer phone: ${customerPhone}`);
      console.log(`   💬 Message: "${messageText?.substring(0, 50)}"`);
      
    } else {
      if (!messageData.recipient || !messageData.sentVia) {
        console.log(`❌ Missing recipient or sentVia in TallBob message`);
        await unlockEvent(uniqueEventId);
        return;
      }
      customerPhone = `+${messageData.recipient.replace(/\D/g, '')}`;
      providerNumber = `+${messageData.sentVia.replace(/\D/g, '')}`;
      messageText = messageData.messageText;
      timestamp = messageData.timestamp;
      media = messageData.media || [];
      contactID = messageData.contactID;
      campaignID = messageData.campaignID;
      reference = messageData.reference;
      
      console.log(`   📞 Customer phone: ${customerPhone}`);
      console.log(`   💬 Message: "${messageText?.substring(0, 50)}"`);
    }

    const locationId = ghlService.locationId || process.env.GHL_LOCATION_ID;

    if (!locationId) {
      console.log(`❌ No location ID found`);
      await unlockEvent(uniqueEventId);
      return;
    }

    const receivedDate = timestamp ? new Date(timestamp * 1000).toISOString() : new Date().toISOString();
    const messageType = provider === 'BLUEBUBBLES' ? 'iMessage' : (provider === 'MMS' ? 'MMS' : 'SMS');

    try {
      console.log(`📝 Creating/updating contact in GHL...`);
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
      
      const { contact } = await makeAPICall(
        () => ghlService.upsertContact(contactData, locationId),
        0,
        'upsertContact'
      );

      console.log(`✅ Contact created/updated: ${contact.id}`);
      
      // Add to tracker for future duplicate detection
      if (commentTracker) {
        await commentTracker.addContact(contact.id, customerPhone);
      }

      await delay(1000);

      console.log(`💬 Getting/creating conversation...`);
      const { conversation } = await makeAPICall(
        () => ghlService.getOrCreateConversation(contact.id, messageType, locationId),
        0,
        'getOrCreateConversation'
      );

      console.log(`✅ Conversation: ${conversation.id}`);

      await delay(1000);
      
      const messagePayload = {
        contactId: contact.id,
        body: messageText || (provider === 'MMS' ? 'MMS message' : ''),
        messageType: messageType,
        mediaUrls: media || [],
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
      console.log(`✅ Message successfully logged to GHL`);

    } catch (error) {
      console.error(`❌ Error processing incoming message:`, error.message);
    } finally {
      await unlockEvent(uniqueEventId);
    }
  }

  app.post('/tallbob/incoming/sms', async (req, res) => {
    console.log(`📨 TallBob incoming SMS webhook received`);
    console.log(`   EventID: ${req.body.eventID}`);
    console.log(`   From: ${req.body.recipient}`);
    console.log(`   Message: ${req.body.messageText?.substring(0, 50)}`);
    res.status(200).json({ received: true });
    setImmediate(() => processIncomingMessage(req.body, 'SMS'));
  });

  app.post('/tallbob/incoming/mms', async (req, res) => {
    console.log(`📨 TallBob incoming MMS webhook received`);
    console.log(`   EventID: ${req.body.eventID}`);
    console.log(`   From: ${req.body.recipient}`);
    console.log(`   Message: ${req.body.messageText?.substring(0, 50)}`);
    res.status(200).json({ received: true });
    setImmediate(() => processIncomingMessage(req.body, 'MMS'));
  });

  app.post('/bluebubbles/incoming', async (req, res) => {
    try {
      const apiPassword = req.query.password || req.headers['x-bluebubbles-password'];
      if (process.env.BLUEBUBBLES_PASSWORD && apiPassword !== process.env.BLUEBUBBLES_PASSWORD) {
        console.log(`❌ Unauthorized BlueBubbles webhook attempt`);
        return res.status(401).json({ error: 'Unauthorized' });
      }
      
      const blueData = req.body.data || req.body;
      console.log(`📨 BlueBubbles incoming webhook received`);
      console.log(`   GUID: ${blueData.guid}`);
      console.log(`   From: ${blueData.handle?.address}`);
      console.log(`   isFromMe: ${blueData.isFromMe}`);
      console.log(`   Message: ${blueData.text?.substring(0, 50)}`);
      
      res.status(200).json({ received: true });
      setImmediate(() => processIncomingMessage(req.body, 'BLUEBUBBLES'));
    } catch (error) {
      console.error(`❌ Error in BlueBubbles webhook:`, error.message);
      res.status(200).json({ received: true });
    }
  });

  // ==================== OUTGOING MESSAGES ====================

  // TALL BOB SEND MESSAGE - FIXED
  app.post('/tallbob/send-message', async (req, res) => {
    try {
      console.log(`\n${'='.repeat(60)}`);
      console.log(`📤 TALL BOB SEND MESSAGE REQUEST RECEIVED`);
      console.log(`   🕐 Time: ${new Date().toLocaleString()}`);
      console.log(`   📦 Full Payload:`, JSON.stringify(req.body, null, 2));
      console.log(`${'='.repeat(60)}`);
      
      let { to, from, message, mediaUrl, contactId, locationId, conversationId } = req.body;
      
      // SUPPORT GHL WEBHOOK FORMAT
      if (!to && req.body.phone) {
        to = req.body.phone;
        console.log(`   🔄 Using 'phone' field as 'to': ${to}`);
      }
      
      if (!from) {
        from = process.env.TALLBOB_NUMBER || '+61428616133';
        console.log(`   🔄 Using default 'from': ${from}`);
      }
      
      if (!message && req.body.message) {
        message = req.body.message;
        console.log(`   🔄 Using 'message' field: ${message}`);
      }
      
      if (!contactId && req.body.contactId) {
        contactId = req.body.contactId;
        console.log(`   🔄 Using 'contactId' field: ${contactId}`);
      }
      
      if (!conversationId && req.body.conversationId) {
        conversationId = req.body.conversationId;
        console.log(`   🔄 Using 'conversationId' field: ${conversationId}`);
      }
      
      if (!locationId && req.body.locationId) {
        locationId = req.body.locationId;
        console.log(`   🔄 Using 'locationId' field: ${locationId}`);
      }
      
      console.log(`\n📋 Extracted fields after mapping:`);
      console.log(`   📞 To: ${to}`);
      console.log(`   📞 From: ${from}`);
      console.log(`   💬 Message: "${message?.substring(0, 100)}${message?.length > 100 ? '...' : ''}"`);
      console.log(`   🖼️ Media URL: ${mediaUrl || 'None'}`);
      console.log(`   🆔 Contact ID: ${contactId || 'Not provided'}`);
      console.log(`   🆔 Conversation ID: ${conversationId || 'Not provided'}`);
      console.log(`   📍 Location ID: ${locationId || 'Using default'}`);

      if (!to || !from || !message) {
        console.log(`\n❌ Missing required fields after mapping:`);
        if (!to) console.log(`   - to is missing`);
        if (!from) console.log(`   - from is missing`);
        if (!message) console.log(`   - message is missing`);
        return res.status(400).json({ 
          success: false, 
          error: 'Missing required fields: to, from, and message are required',
          received: { to, from, message }
        });
      }

      console.log(`\n📤 Attempting to send via Tall Bob...`);
      let result;
      
      if (mediaUrl) {
        console.log(`   📸 Sending as MMS with media URL: ${mediaUrl}`);
        result = await tallbobService.sendMMS({ 
          to, 
          from, 
          message, 
          mediaUrl, 
          reference: `ghl_${Date.now()}` 
        });
        console.log(`   ✅ MMS send response:`, JSON.stringify(result, null, 2));
      } else {
        console.log(`   💬 Sending as SMS`);
        result = await tallbobService.sendSMS({ 
          to, 
          from, 
          message, 
          reference: `ghl_${Date.now()}` 
        });
        console.log(`   ✅ SMS send response:`, JSON.stringify(result, null, 2));
      }

      // FIXED: Get the correct message ID from Tall Bob response
      const tallBobMessageId = result.sms_id || result.message_id || result.id;
      
      // Track this message to prevent loop
      if (tallBobMessageId) {
        await markMessageAsSent(tallBobMessageId, 'tallbob');
        console.log(`   ✅ Tracked message ID: ${tallBobMessageId}`);
      } else {
        console.log(`   ⚠️ Warning: No message ID found in Tall Bob response`);
        console.log(`   Response keys: ${Object.keys(result).join(', ')}`);
      }

      // Log to GHL
      if (contactId || conversationId) {
        console.log(`\n📝 Logging message to GHL...`);
        try {
          const targetLocationId = locationId || ghlService.locationId;
          let conversation;
          
          if (conversationId) {
            console.log(`   Using existing conversation: ${conversationId}`);
            conversation = { id: conversationId };
          } else if (contactId) {
            console.log(`   Creating/getting conversation for contact: ${contactId}`);
            const convResult = await makeAPICall(
              () => ghlService.getOrCreateConversation(contactId, mediaUrl ? 'MMS' : 'SMS', targetLocationId),
              0,
              'getOrCreateConversation'
            );
            conversation = convResult.conversation;
            console.log(`   ✅ Conversation: ${conversation.id}`);
          }

          if (conversation) {
            await makeAPICall(
              () => ghlService.addMessageToConversation(conversation.id, {
                contactId, 
                body: message, 
                messageType: mediaUrl ? 'MMS' : 'SMS',
                mediaUrls: mediaUrl ? [mediaUrl] : [], 
                direction: 'outbound',
                date: new Date().toISOString(), 
                providerMessageId: tallBobMessageId,
                fromNumber: from, 
                toNumber: to, 
                provider: 'Tall Bob'
              }, targetLocationId),
              0,
              'addMessageToConversation'
            );
            console.log(`   ✅ Message logged to GHL conversation`);
          }
        } catch (ghlError) {
          console.error(`   ⚠️ Failed to log to GHL: ${ghlError.message}`);
        }
      }

      console.log(`\n✅✅✅ TALL BOB MESSAGE SENT SUCCESSFULLY ✅✅✅`);
      console.log(`   🆔 Message ID: ${tallBobMessageId}\n`);
      res.json({ success: true, messageId: tallBobMessageId });

    } catch (error) {
      console.error(`\n❌❌❌ TALL BOB SEND FAILED ❌❌❌`);
      console.error(`   Error message: ${error.message}`);
      console.error(`   Error stack: ${error.stack}`);
      if (error.response) {
        console.error(`   Response status: ${error.response.status}`);
        console.error(`   Response data:`, error.response.data);
      }
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // BLUEBUBBLES SEND MESSAGE
  app.post('/bluebubbles/send-message', async (req, res) => {
    try {
      console.log(`\n${'='.repeat(60)}`);
      console.log(`📱 BLUEBUBBLES SEND MESSAGE REQUEST RECEIVED`);
      console.log(`   🕐 Time: ${new Date().toLocaleString()}`);
      console.log(`   📦 Full Payload:`, JSON.stringify(req.body, null, 2));
      console.log(`${'='.repeat(60)}`);
      
      let { to, from, message, mediaUrl, contactId, locationId, conversationId, effectId } = req.body;
      
      // SUPPORT GHL WEBHOOK FORMAT
      if (!to && req.body.phone) {
        to = req.body.phone;
        console.log(`   🔄 Using 'phone' field as 'to': ${to}`);
      }
      
      if (!message && req.body.message) {
        message = req.body.message;
        console.log(`   🔄 Using 'message' field: ${message}`);
      }
      
      if (!contactId && req.body.contactId) {
        contactId = req.body.contactId;
        console.log(`   🔄 Using 'contactId' field: ${contactId}`);
      }
      
      if (!conversationId && req.body.conversationId) {
        conversationId = req.body.conversationId;
        console.log(`   🔄 Using 'conversationId' field: ${conversationId}`);
      }
      
      if (!locationId && req.body.locationId) {
        locationId = req.body.locationId;
        console.log(`   🔄 Using 'locationId' field: ${locationId}`);
      }
      
      console.log(`\n📋 Extracted fields after mapping:`);
      console.log(`   📞 To: ${to}`);
      console.log(`   💬 Message: "${message?.substring(0, 100)}${message?.length > 100 ? '...' : ''}"`);
      console.log(`   🖼️ Media URL: ${mediaUrl || 'None'}`);
      console.log(`   🆔 Contact ID: ${contactId || 'Not provided'}`);
      console.log(`   🆔 Conversation ID: ${conversationId || 'Not provided'}`);
      console.log(`   📍 Location ID: ${locationId || 'Using default'}`);
      console.log(`   ✨ Effect ID: ${effectId || 'None'}`);

      if (!to || !message) {
        console.log(`\n❌ Missing required fields after mapping:`);
        if (!to) console.log(`   - to is missing`);
        if (!message) console.log(`   - message is missing`);
        return res.status(400).json({ 
          success: false, 
          error: 'Missing required fields: to and message are required',
          received: { to, message }
        });
      }

      // Clean the phone number
      const cleanTo = to.replace(/[^\d+]/g, '');
      console.log(`\n📱 Cleaned phone number: ${cleanTo}`);

      console.log(`\n📤 Attempting to send via BlueBubbles...`);
      
      // BlueBubbles service only needs 'to' and 'message'
      let result;
      if (mediaUrl) {
        console.log(`   📸 Sending as attachment (including URL in message)`);
        result = await bluebubblesService.sendMessage({
          to: cleanTo,
          message: `${message} ${mediaUrl}`,
          effectId: effectId || null
        });
      } else {
        console.log(`   💬 Sending as text message`);
        result = await bluebubblesService.sendMessage({
          to: cleanTo,
          message: message,
          effectId: effectId || null
        });
      }
      
      console.log(`   ✅ Send response:`, JSON.stringify(result, null, 2));

      // Track this message to prevent loop
      if (result.guid) {
        await markMessageAsSent(result.guid, 'bluebubbles');
        console.log(`   ✅ Tracked message GUID: ${result.guid}`);
      }

      // Log to GHL
      if (contactId || conversationId) {
        console.log(`\n📝 Logging message to GHL...`);
        try {
          const targetLocationId = locationId || ghlService.locationId;
          let conversation;
          
          if (conversationId) {
            console.log(`   Using existing conversation: ${conversationId}`);
            conversation = { id: conversationId };
          } else if (contactId) {
            console.log(`   Creating/getting conversation for contact: ${contactId}`);
            const convResult = await makeAPICall(
              () => ghlService.getOrCreateConversation(contactId, mediaUrl ? 'MMS' : 'SMS', targetLocationId),
              0,
              'getOrCreateConversation'
            );
            conversation = convResult.conversation;
            console.log(`   ✅ Conversation: ${conversation.id}`);
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
                fromNumber: process.env.BLUEBUBBLES_IMESSAGE_ACCOUNT || 'iMessage',
                toNumber: cleanTo,
                provider: 'BlueBubbles'
              }, targetLocationId),
              0,
              'addMessageToConversation'
            );
            console.log(`   ✅ Message logged to GHL conversation`);
          }
        } catch (ghlError) {
          console.error(`   ⚠️ Failed to log to GHL: ${ghlError.message}`);
        }
      }

      console.log(`\n✅✅✅ BLUEBUBBLES MESSAGE SENT SUCCESSFULLY ✅✅✅`);
      console.log(`   🆔 Message ID: ${result.guid}\n`);
      res.json({ success: true, messageId: result.guid });

    } catch (error) {
      console.error(`\n❌❌❌ BLUEBUBBLES SEND FAILED ❌❌❌`);
      console.error(`   Error message: ${error.message}`);
      console.error(`   Error stack: ${error.stack}`);
      if (error.response) {
        console.error(`   Response status: ${error.response.status}`);
        console.error(`   Response data:`, error.response.data);
      }
      if (error.request) {
        console.error(`   Request was made but no response received`);
      }
      res.status(500).json({ success: false, error: error.message });
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

  app.get('/test/deduplication-stats', async (req, res) => {
    const trackedCount = commentTracker ? await commentTracker.getCount() : 0;
    res.json({
      success: true,
      cacheSize: processedEvents.size,
      locksSize: processingLock.size,
      sentMessagesSize: sentMessages.size,
      trackedContacts: trackedCount,
      events: Array.from(processedEvents).slice(-10),
      sentMessages: Array.from(sentMessages).slice(-10)
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
      res.json({ success: false, error: error.message });
    }
  });

  app.get('/test/tracker-contents', async (req, res) => {
    if (!commentTracker) {
      return res.json({ success: false, error: 'Tracker not initialized' });
    }
    const contacts = await commentTracker.getContactsToCheck(100);
    res.json({
      success: true,
      totalTracked: await commentTracker.getCount(),
      recentContacts: contacts.map(c => ({
        contact_id: c.contact_id,
        phone_number: c.phone_number,
        last_activity: c.last_activity ? new Date(c.last_activity * 1000).toISOString() : null,
        last_comment_hash: c.last_comment_hash?.substring(0, 16) + '...'
      }))
    });
  });

  // Add endpoint to clear duplicate cache if needed
  app.post('/test/clear-duplicate-cache', async (req, res) => {
    try {
      // Clear in-memory caches
      processedEvents.clear();
      processedExpiry.clear();
      sentMessages.clear();
      sentMessagesExpiry.clear();
      
      res.json({ 
        success: true, 
        message: 'Duplicate detection caches cleared',
        cleared: {
          processedEvents: processedEvents.size,
          sentMessages: sentMessages.size
        }
      });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  return app;
};