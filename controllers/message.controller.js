class MessageController {
  constructor(tallbobService, ghlService) {
    this.tallbob = tallbobService;
    this.ghl = ghlService;
  }

  /**
   * Send a message and sync with GHL
   */
  async sendAndSync(req, res) {
    try {
      const {
        to,
        from,
        message,
        mediaUrl,
        locationId,
        contactId,
        addToCampaign,
        campaignId
      } = req.body;

      // Send via Tall Bob
      const tallbobResult = await this.tallbob.sendMMS({
        to,
        from,
        body: message,
        mediaUrl
      });

      // Update GHL if we have contact info
      if (locationId && contactId) {
        // Add message to conversation
        await this.ghl.addMessageToConversation(contactId, {
          body: message,
          messageType: mediaUrl ? 'MMS' : 'SMS',
          mediaUrls: mediaUrl ? [mediaUrl] : [],
          direction: 'outbound',
          providerMessageId: tallbobResult.messageId
        });

        // Add to campaign if requested
        if (addToCampaign && campaignId) {
          await this.ghl.addToCampaign(contactId, campaignId, locationId);
        }
      }

      res.json({
        success: true,
        messageId: tallbobResult.messageId,
        provider: 'Tall Bob',
        synced: !!(locationId && contactId)
      });

    } catch (error) {
      console.error('Error in sendAndSync:', error);
      res.status(500).json({ success: false, error: error.message });
    }
  }

  /**
   * Get message status from Tall Bob
   */
  async getStatus(req, res) {
    try {
      const { messageId } = req.params;
      
      if (!messageId) {
        return res.status(400).json({ error: 'Message ID is required' });
      }

      const status = await this.tallbob.getMessageStatus(messageId);
      
      res.json({
        messageId,
        status: status.status,
        deliveredAt: status.deliveredAt,
        details: status
      });

    } catch (error) {
      console.error('Error getting message status:', error);
      res.status(500).json({ error: error.message });
    }
  }
}

export default MessageController;