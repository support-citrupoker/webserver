import { join } from 'path'

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
      
      // Process based on event type - FIXED: eventType is just 'message_received'
      if (messageData.eventType === 'message_received') {
      
        // Extract message details - FIXED: Use correct field names from actual payload
        const {
          recipient,           // Customer's phone number (who received the message)
          sentVia,             // Your Tall Bob number (who sent it)
          messageText,         // The message content
          timestamp,           // Unix timestamp
          contactID,           // Tall Bob's contact ID (optional)
          campaignID,          // Campaign ID (optional)
          eventID,             // Unique event ID
          reference            // Your reference (optional)
        } = messageData;

        // Format phone numbers for GHL (add + prefix)
        // FIXED: Use recipient for customer, sentVia for your number
        const customerPhone = `+${recipient.replace(/\D/g, '')}`;
        const tallbobNumber = `+${sentVia.replace(/\D/g, '')}`;

        // Use stored locationId
        const locationId = ghlService.locationId;

        if (!locationId) {
          console.error('❌ No locationId configured. Set GHL_LOCATION_ID in .env');
          return res.status(200).json({ received: true, error: 'Location not configured' });
        }

        // Convert Unix timestamp to ISO string
        const receivedDate = timestamp ? new Date(timestamp * 1000).toISOString() : new Date().toISOString();

        // Find or create contact in GHL using the customer's number
        // FIXED: Use customerPhone, not sendVia
        const { contact, action } = await ghlService.upsertContact({
          phone: customerPhone,
          firstName: 'Unknown',  // Tall Bob doesn't send name
          lastName: 'Contact',
          tags: ['tallbob_contact', 'sms_received'],
          source: 'Tall Bob Integration',
          customFields: [
            { key: 'last_incoming_message', value: messageText },
            { key: 'last_message_date', value: receivedDate },
            { key: 'tallbob_contact_id', value: contactID || '' },
            { key: 'tallbob_campaign_id', value: campaignID || '' }
          ]
        }, locationId);

        // Get or create conversation
        const { conversation } = await ghlService.getOrCreateConversation(
          contact.id, 
          'SMS', 
          locationId
        );

        // Add message to conversation - FIXED: Use correct field names
        await ghlService.addMessageToConversation(conversation.id, {
          contactId: contact.id,
          body: messageText,
          messageType: 'SMS',
          mediaUrls: [], // No media in SMS
          direction: 'inbound',
          date: receivedDate,
          fromNumber: tallbobNumber,  // Your Tall Bob number
          toNumber: customerPhone,     // Customer's number
          providerMessageId: eventID || reference
        }, locationId);

        console.log(`✅ Message processed for contact ${contact.id} (${action})`);
      }

      // Always acknowledge receipt to Tall Bob
      res.status(200).json({ 
        received: true, 
        timestamp: new Date().toISOString() 
      });
      
    } catch (error) {
      console.error('❌ Error processing Tall Bob SMS webhook:', error);
      // Still return 200 to prevent Tall Bob from retrying
      res.status(200).json({ 
        received: true, 
        error: error.message 
      });
    }
  })

  // ==================== INCOMING MMS FROM TALL BOB ====================
  app.post('/tallbob/incoming/mms', async (req, res) => {
    try {
      const messageData = req.body;

      console.log('📩 Received Tall Bob MMS webhook:', messageData);
      
      // Process based on event type
      if (messageData.eventType === 'message_received_mms') {
      
        // Extract message details
        const {
          recipient,
          sentVia,
          messageText,
          media,               // MMS might have media URLs
          timestamp,
          contactID,
          campaignID,
          eventID
        } = messageData;

        const customerPhone = `+${recipient.replace(/\D/g, '')}`;
        const tallbobNumber = `+${sentVia.replace(/\D/g, '')}`;
        const locationId = ghlService.locationId;

        if (!locationId) {
          console.error('❌ No locationId configured');
          return res.status(200).json({ received: true });
        }

        const receivedDate = timestamp ? new Date(timestamp * 1000).toISOString() : new Date().toISOString();

        // Find or create contact
        const { contact, action } = await ghlService.upsertContact({
          phone: customerPhone,
          firstName: 'Unknown',
          lastName: 'Contact',
          tags: ['tallbob_contact', 'mms_received'],
          source: 'Tall Bob Integration',
          customFields: [
            { key: 'last_incoming_message', value: messageText },
            { key: 'last_message_date', value: receivedDate },
            { key: 'tallbob_contact_id', value: contactID || '' }
          ]
        }, locationId);

        // Get or create conversation
        const { conversation } = await ghlService.getOrCreateConversation(
          contact.id, 
          'MMS', 
          locationId
        );

        // Add message to conversation with media if available
        await ghlService.addMessageToConversation(conversation.id, {
          contactId: contact.id,
          body: messageText || 'MMS message',
          messageType: 'MMS',
          mediaUrls: media ? (Array.isArray(media) ? media : [media]) : [],
          direction: 'inbound',
          date: receivedDate,
          fromNumber: tallbobNumber,
          toNumber: customerPhone,
          providerMessageId: eventID
        }, locationId);

        console.log(`✅ MMS processed for contact ${contact.id} (${action})`);
      }

      res.status(200).json({ 
        received: true, 
        timestamp: new Date().toISOString() 
      });
      
    } catch (error) {
      console.error('❌ Error processing Tall Bob MMS webhook:', error);
      res.status(200).json({ 
        received: true, 
        error: error.message 
      });
    }
  })

  // ==================== SEND MESSAGE VIA TALL BOB ====================
  app.get('/tallbob/send-message', async (req, res) => {
    try {
      console.log(req.body)
      
      console.log('webhook works')

      res.json({
        success: true,
        provider: 'Tall Bob',
        timestamp: new Date().toISOString()
      });

    } catch (error) {
      console.error('Error sending message:', error);
      res.status(500).json({ 
        success: false, 
        error: error.message 
      });
    }
  })

  // ==================== CATCH-ALL ROUTE ====================
  app.get('*', (req, res) => { 
    return res.sendFile(join(`${__basedir}/dist/index.html`)) 
  })

}