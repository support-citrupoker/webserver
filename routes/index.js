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
          body: messageText,
          media: mediaUrls,
          receivedAt
        } = messageData;

        // Format phone number for GHL
        const formattedPhone = tallbobService.formatPhoneNumber(senderNumber);

        // Get GHL locations (you might want to cache this)
        const locations = await ghlService.getLocations();
        
        // For this example, we'll use the first location
        // In production, you'd map Tall Bob numbers to GHL locations
        const locationId = locations[0]?.id;

        if (locationId) {
          // Find or create contact in GHL
          const { contact, action } = await ghlService.upsertContact({
            phone: formattedPhone,
            // You might want to add custom fields for the message
            customFields: [
              { key: 'last_incoming_message', value: messageText },
              { key: 'last_message_date', value: new Date().toISOString() }
            ]
          }, locationId);

          // Create conversation or add to existing one
          const conversation = await ghlService.createConversation({
            contactId: contact.id,
            locationId: locationId,
            type: 'SMS'
          });

          // Add the incoming message to conversation
          await ghlService.addMessageToConversation(conversation.id, {
            body: messageText,
            messageType: mediaUrls && mediaUrls.length > 0 ? 'MMS' : 'SMS',
            mediaUrls: mediaUrls,
            direction: 'inbound',
            date: receivedAt
          });

          console.log(`Message processed for contact ${contact.id} (${action})`);
        }
      }

      // Acknowledge receipt to Tall Bob [citation:9]
      res.status(200).json({ 
        received: true, 
        timestamp: new Date().toISOString() 
      });
      
    } catch (error) {
      console.error('Error processing Tall Bob webhook:', error);
      // Still return 200 to prevent Tall Bob from retrying [citation:9]
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
          body: messageText,
          media: mediaUrls,
          receivedAt
        } = messageData;

        // Format phone number for GHL
        const formattedPhone = tallbobService.formatPhoneNumber(senderNumber);

        // Get GHL locations (you might want to cache this)
        const locations = await ghlService.getLocations();
        
        // For this example, we'll use the first location
        // In production, you'd map Tall Bob numbers to GHL locations
        const locationId = locations[0]?.id;

        if (locationId) {
          // Find or create contact in GHL
          const { contact, action } = await ghlService.upsertContact({
            phone: formattedPhone,
            // You might want to add custom fields for the message
            customFields: [
              { key: 'last_incoming_message', value: messageText },
              { key: 'last_message_date', value: new Date().toISOString() }
            ]
          }, locationId);

          // Create conversation or add to existing one
          const conversation = await ghlService.createConversation({
            contactId: contact.id,
            locationId: locationId,
            type: 'SMS'
          });

          // Add the incoming message to conversation
          await ghlService.addMessageToConversation(conversation.id, {
            body: messageText,
            messageType: mediaUrls && mediaUrls.length > 0 ? 'MMS' : 'SMS',
            mediaUrls: mediaUrls,
            direction: 'inbound',
            date: receivedAt
          });

          console.log(`Message processed for contact ${contact.id} (${action})`);
        }
      }

      // Acknowledge receipt to Tall Bob [citation:9]
      res.status(200).json({ 
        received: true, 
        timestamp: new Date().toISOString() 
      });
      
    } catch (error) {
      console.error('Error processing Tall Bob webhook:', error);
      // Still return 200 to prevent Tall Bob from retrying [citation:9]
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

      // Send via Tall Bob
      let result;
      if (mediaUrl) {
        // Send as MMS if media is included [citation:1]
        result = await tallbobService.sendMMS({
          to,
          from,
          body: message,
          mediaUrl,
          reference: `ghl_${contactId || 'unknown'}_${Date.now()}`
        });
      } else {
        // Send as SMS
        result = await tallbobService.sendSMS({
          to,
          from,
          body: message,
          reference: `ghl_${contactId || 'unknown'}_${Date.now()}`
        });
      }

      // If we have GHL contact info, log the outgoing message
      if (locationId && contactId) {
        try {
          await ghlService.addMessageToConversation(contactId, {
            body: message,
            messageType: mediaUrl ? 'MMS' : 'SMS',
            mediaUrls: mediaUrl ? [mediaUrl] : [],
            direction: 'outbound',
            providerMessageId: result.messageId
          });
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
