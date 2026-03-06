import { join } from 'path'

// Simple in-memory cache for deduplication (use Redis/DB in production)
const processedEvents = new Set();
const processedExpiry = new Map();

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

// Shared processing function for both SMS and MMS
async function processIncomingMessage(messageData, type = 'SMS') {
  // Skip if not a message received event
  const validEvents = ['message_received', 'message_received_mms'];
  if (!validEvents.includes(messageData.eventType)) {
    console.log(`⏭️ Ignoring event type: ${messageData.eventType}`);
    return;
  }

  // DEDUPLICATION: Check if we've already processed this eventID
  const eventId = messageData.eventID || messageData.id;
  if (eventId) {
    const processed = await isEventProcessed(eventId);
    if (processed) {
      console.log(`⏭️ Event ${eventId} already processed, skipping`);
      return;
    }
  }

  console.log(`📨 Processing ${type} message...`);

  const {
    recipient,
    sentVia,
    messageText,
    timestamp,
    contactID,
    campaignID,
    eventID,
    reference,
    media
  } = messageData;

  // Validate required fields
  if (!recipient || !sentVia) {
    console.error('❌ Missing required fields: recipient or sentVia');
    return;
  }

  // Format phone numbers
  const customerPhone = `+${recipient.replace(/\D/g, '')}`;
  const tallbobNumber = `+${sentVia.replace(/\D/g, '')}`;
  const locationId = ghlService.locationId;

  if (!locationId) {
    console.error('❌ No locationId configured');
    return;
  }

  const receivedDate = timestamp ? new Date(timestamp * 1000).toISOString() : new Date().toISOString();

  try {
    // Find or create contact
    console.log(`👤 Upserting contact with phone: ${customerPhone}`);
    const { contact, action } = await ghlService.upsertContact({
      phone: customerPhone,
      firstName: 'Unknown',
      lastName: 'Contact',
      tags: ['tallbob_contact', type === 'MMS' ? 'mms_received' : 'sms_received'],
      source: 'Tall Bob Integration',
      customFields: [
        { key: 'last_incoming_message', value: messageText || '' },
        { key: 'last_message_date', value: receivedDate },
        { key: 'tallbob_contact_id', value: contactID || '' },
        { key: 'tallbob_campaign_id', value: campaignID || '' }
      ]
    }, locationId);

    console.log(`✅ Contact ${action}: ${contact.id}`);

    // Get or create conversation
    console.log(`💬 Getting/creating conversation for contact: ${contact.id}`);
    const { conversation } = await ghlService.getOrCreateConversation(
      contact.id, 
      type, 
      locationId
    );
    console.log(`✅ Conversation: ${conversation.id}`);

    // Add message to conversation
    console.log(`📝 Adding ${type} message to conversation: ${conversation.id}`);
    await ghlService.addMessageToConversation(conversation.id, {
      contactId: contact.id,
      body: messageText || (type === 'MMS' ? 'MMS message' : ''),
      messageType: type,
      mediaUrls: media ? (Array.isArray(media) ? media : [media]) : [],
      direction: 'inbound',
      date: receivedDate,
      fromNumber: tallbobNumber,
      toNumber: customerPhone,
      providerMessageId: eventID || reference || eventId
    }, locationId);

    // Mark as processed
    if (eventId) {
      await markEventProcessed(eventId);
    }

    console.log(`✅ ${type} message processed for contact ${contact.id} (${action})`);

  } catch (error) {
    console.error(`❌ Error processing ${type} message:`, error);
    // Don't mark as processed so it can be retried
  }
}

export default (app, tallbobService, ghlService) => {

  // Health check
  app.get('/health', (req, res) => {
    res.json({ status: 'OK', timestamp: new Date().toISOString() });
  })

  // ==================== INCOMING SMS FROM TALL BOB ====================
  app.post('/tallbob/incoming/sms', async (req, res) => {
    try {
      const messageData = req.body;
      console.log('📩 Received Tall Bob SMS webhook:', messageData);
      
      // IMMEDIATELY acknowledge receipt to stop retries
      res.status(200).json({ 
        received: true, 
        timestamp: new Date().toISOString() 
      });
      
      // Process asynchronously after acknowledging
      setImmediate(async () => {
        await processIncomingMessage(messageData, 'SMS');
      });
      
    } catch (error) {
      console.error('❌ Error in SMS webhook:', error);
      // Still return 200 to prevent Tall Bob from retrying
      res.status(200).json({ 
        received: true, 
        error: error.message,
        timestamp: new Date().toISOString() 
      });
    }
  })

  // ==================== INCOMING MMS FROM TALL BOB ====================
  app.post('/tallbob/incoming/mms', async (req, res) => {
    try {
      const messageData = req.body;
      console.log('📩 Received Tall Bob MMS webhook:', messageData);
      
      // IMMEDIATELY acknowledge receipt to stop retries
      res.status(200).json({ 
        received: true, 
        timestamp: new Date().toISOString() 
      });
      
      // Process asynchronously after acknowledging
      setImmediate(async () => {
        await processIncomingMessage(messageData, 'MMS');
      });
      
    } catch (error) {
      console.error('❌ Error in MMS webhook:', error);
      // Still return 200 to prevent Tall Bob from retrying
      res.status(200).json({ 
        received: true, 
        error: error.message,
        timestamp: new Date().toISOString() 
      });
    }
  })

  // ==================== SEND MESSAGE VIA TALL BOB ====================
  app.post('/tallbob/send-message', async (req, res) => {
    try {
      const messageData = req.body;
      console.log('📤 Send message request:', messageData);
      
      const {
        to,
        from,
        message,
        mediaUrl,
        contactId,
        locationId
      } = messageData;

      // Validate required fields
      if (!to || !from || !message) {
        return res.status(400).json({ 
          success: false, 
          error: 'Missing required fields: to, from, and message are required' 
        });
      }

      // Send via Tall Bob
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

      // If we have GHL contact info, log the outgoing message
      if (contactId) {
        try {
          const targetLocationId = locationId || ghlService.locationId;
          
          // Get or create conversation
          const { conversation } = await ghlService.getOrCreateConversation(
            contactId,
            mediaUrl ? 'MMS' : 'SMS',
            targetLocationId
          );

          // Log message in GHL
          await ghlService.addMessageToConversation(conversation.id, {
            contactId: contactId,
            body: message,
            messageType: mediaUrl ? 'MMS' : 'SMS',
            mediaUrls: mediaUrl ? [mediaUrl] : [],
            direction: 'outbound',
            date: new Date().toISOString(),
            providerMessageId: result.messageId,
            fromNumber: from,
            toNumber: to
          }, targetLocationId);

          console.log(`✅ Outbound message logged in GHL for contact ${contactId}`);
        } catch (ghlError) {
          console.error('⚠️ Failed to log message in GHL:', ghlError.message);
          // Don't fail the main request if GHL logging fails
        }
      }

      res.json({
        success: true,
        messageId: result.messageId,
        provider: 'Tall Bob',
        timestamp: new Date().toISOString()
      });

    } catch (error) {
      console.error('❌ Error sending message:', error);
      res.status(500).json({ 
        success: false, 
        error: error.message 
      });
    }
  })

  // ==================== TEST ENDPOINT TO CHECK DEDUPLICATION ====================
  app.get('/test/deduplication-stats', (req, res) => {
    res.json({
      success: true,
      cacheSize: processedEvents.size,
      events: Array.from(processedEvents).slice(-10) // Last 10 events
    });
  });

  // ==================== CATCH-ALL ROUTE ====================
  app.get('*', (req, res) => { 
    return res.sendFile(join(`${__basedir}/dist/index.html`)) 
  })

}