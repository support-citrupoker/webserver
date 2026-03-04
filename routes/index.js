import { join } from 'path'

export default (app, tallbobService, ghlService) => {

  // Health check
  app.get('/health', (req, res) => {
    res.json({ status: 'OK', timestamp: new Date().toISOString() });
  })

  app.post('/tallbob/incoming/sms', async (req, res) => {
    try {
      const messageData = req.body;

      console.log(messageData)
      
      // Log incoming message for debugging
      console.log('Received Tall Bob webhook:', messageData);

      // Process based on message type
      if (messageData.type === 'message_received_sms' || messageData.type === 'message_received_mms') {
        // Extract message details
        const {
          from: senderNumber,
          to: recipientNumber,
          message: messageText,  // FIXED: Tall Bob uses "message" not "body"
          media: mediaUrls,
          receivedAt
        } = messageData;

        // Format phone number for GHL (add + prefix)
        const formattedPhone = `+${senderNumber.replace(/\D/g, '')}`;

        // FIXED: Use stored locationId instead of calling getLocations()
        const locationId = ghlService.locationId;

        if (!locationId) {
          console.error('❌ No locationId configured. Set GHL_LOCATION_ID in .env');
          return res.status(200).json({ received: true, error: 'Location not configured' });
        }

        // FIXED: Updated to match GHLService method signatures
        // Find or create contact in GHL
        const { contact, action } = await ghlService.upsertContact({
          phone: formattedPhone,
          tags: ['tallbob_contact', messageData.type === 'message_received_mms' ? 'mms_received' : 'sms_received'],
          source: 'Tall Bob Integration',
          customFields: [
            { key: 'last_incoming_message', value: messageText },
            { key: 'last_message_date', value: new Date().toISOString() }
          ]
        }, locationId);

        // Create conversation - FIXED: Correct parameter order
        const conversation = await ghlService.createConversation(
          contact.id, 
          messageData.type === 'message_received_mms' ? 'MMS' : 'SMS', 
          locationId
        );

        // Add the incoming message to conversation - FIXED: Pass locationId
        await ghlService.addMessageToConversation(conversation.id, {
          body: messageText,
          messageType: mediaUrls && mediaUrls.length > 0 ? 'MMS' : 'SMS',
          mediaUrls: mediaUrls,
          direction: 'inbound',
          date: receivedAt || new Date().toISOString()
        }, locationId);

        console.log(`Message processed for contact ${contact.id} (${action})`);
      }

      // Acknowledge receipt to Tall Bob
      res.status(200).json({ 
        received: true, 
        timestamp: new Date().toISOString() 
      });
      
    } catch (error) {
      console.error('Error processing Tall Bob webhook:', error);
      // Still return 200 to prevent Tall Bob from retrying
      res.status(200).json({ 
        received: true, 
        error: error.message 
      });
    }
  })

  app.post('/tallbob/incoming/mms', async (req, res) => {
    try {
      const messageData = req.body;

      console.log(messageData)
      
      // Log incoming message for debugging
      console.log('Received Tall Bob webhook:', messageData);

      // Process based on message type
      if (messageData.type === 'message_received_sms' || messageData.type === 'message_received_mms') {
        // Extract message details
        const {
          from: senderNumber,
          to: recipientNumber,
          message: messageText,  // FIXED: Tall Bob uses "message" not "body"
          media: mediaUrls,
          receivedAt
        } = messageData;

        // Format phone number for GHL (add + prefix)
        const formattedPhone = `+${senderNumber.replace(/\D/g, '')}`;

        // FIXED: Use stored locationId instead of calling getLocations()
        const locationId = ghlService.locationId;

        if (!locationId) {
          console.error('❌ No locationId configured. Set GHL_LOCATION_ID in .env');
          return res.status(200).json({ received: true, error: 'Location not configured' });
        }

        // FIXED: Updated to match GHLService method signatures
        // Find or create contact in GHL
        const { contact, action } = await ghlService.upsertContact({
          phone: formattedPhone,
          tags: ['tallbob_contact', messageData.type === 'message_received_mms' ? 'mms_received' : 'sms_received'],
          source: 'Tall Bob Integration',
          customFields: [
            { key: 'last_incoming_message', value: messageText },
            { key: 'last_message_date', value: new Date().toISOString() }
          ]
        }, locationId);

        // Create conversation - FIXED: Correct parameter order
        const conversation = await ghlService.createConversation(
          contact.id, 
          messageData.type === 'message_received_mms' ? 'MMS' : 'SMS', 
          locationId
        );

        // Add the incoming message to conversation - FIXED: Pass locationId
        await ghlService.addMessageToConversation(conversation.id, {
          body: messageText,
          messageType: mediaUrls && mediaUrls.length > 0 ? 'MMS' : 'SMS',
          mediaUrls: mediaUrls,
          direction: 'inbound',
          date: receivedAt || new Date().toISOString()
        }, locationId);

        console.log(`Message processed for contact ${contact.id} (${action})`);
      }

      // Acknowledge receipt to Tall Bob
      res.status(200).json({ 
        received: true, 
        timestamp: new Date().toISOString() 
      });
      
    } catch (error) {
      console.error('Error processing Tall Bob webhook:', error);
      // Still return 200 to prevent Tall Bob from retrying
      res.status(200).json({ 
        received: true, 
        error: error.message 
      });
    }
  })

  app.post('/tallbob/send-message', async (req, res) => {
    try {
      const {
        to,
        from,
        message,
        mediaUrl,
        locationId,
        contactId
      } = req.body;

      // Validate required fields
      if (!to || !from || !message) {
        return res.status(400).json({ 
          error: 'Missing required fields: to, from, and message are required' 
        });
      }

      // Use provided locationId or fall back to configured one
      const targetLocationId = locationId || ghlService.locationId;

      // Send via Tall Bob - FIXED: Use "message" not "body"
      let result;
      if (mediaUrl) {
        // Send as MMS if media is included
        result = await tallbobService.sendMMS({
          to,
          from,
          message: message,  // FIXED: Tall Bob uses "message"
          mediaUrl,
          reference: `ghl_${contactId || 'unknown'}_${Date.now()}`
        });
      } else {
        // Send as SMS
        result = await tallbobService.sendSMS({
          to,
          from,
          message: message,  // FIXED: Tall Bob uses "message"
          reference: `ghl_${contactId || 'unknown'}_${Date.now()}`
        });
      }

      // If we have GHL contact info, log the outgoing message
      if (targetLocationId && contactId) {
        try {
          // First, ensure conversation exists
          const conversation = await ghlService.createConversation(
            contactId,
            mediaUrl ? 'MMS' : 'SMS',
            targetLocationId
          );

          // FIXED: Pass locationId as third parameter
          await ghlService.addMessageToConversation(conversation.id, {
            body: message,
            messageType: mediaUrl ? 'MMS' : 'SMS',
            mediaUrls: mediaUrl ? [mediaUrl] : [],
            direction: 'outbound',
            date: new Date().toISOString(),
            providerMessageId: result.messageId
          }, targetLocationId);
        } catch (ghlError) {
          console.error('Failed to log message in GHL:', ghlError);
          // Don't fail the main request if GHL logging fails
        }
      }

      res.json({
        success: true,
        messageId: result.messageId,
        provider: 'Tall Bob'
      });

    } catch (error) {
      console.error('Error sending message:', error);
      res.status(500).json({ 
        success: false, 
        error: error.message 
      });
    }
  })

  app.get('*', (req, res) => { return res.sendFile(join(`${__basedir}/dist/index.html`)) })

}