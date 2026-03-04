class GHLService {
  constructor(ghlClient) {
    this.client = ghlClient;
  }

  /**
   * Create or update a contact in GHL
   * @param {Object} contactData - Contact information
   * @param {string} locationId - GHL location ID
   */
  async upsertContact(contactData, locationId) {
    try {
      // First, try to find existing contact by phone
      const existingContacts = await this.client.contacts.getContacts({
        locationId: locationId,
        query: contactData.phone,
        limit: 1
      });

      if (existingContacts && existingContacts.contacts.length > 0) {
        // Update existing contact
        const contact = await this.client.contacts.updateContact({
          contactId: existingContacts.contacts[0].id,
          ...contactData
        }, {
          headers: { locationId }
        });
        return { contact, action: 'updated' };
      } else {
        // Create new contact
        const contact = await this.client.contacts.createContact({
          locationId: locationId,
          ...contactData
        });
        return { contact, action: 'created' };
      }
    } catch (error) {
      console.error('GHL Contact Error:', error.message);
      throw new Error(`Failed to upsert contact: ${error.message}`);
    }
  }

  /**
   * Add a contact to a campaign
   * @param {string} contactId - GHL contact ID
   * @param {string} campaignId - GHL campaign ID
   * @param {string} locationId - GHL location ID
   */
  async addToCampaign(contactId, campaignId, locationId) {
    try {
      const result = await this.client.campaigns.addContact({
        campaignId: campaignId,
        contactId: contactId
      }, {
        headers: { locationId }
      });
      return result;
    } catch (error) {
      console.error('GHL Campaign Error:', error.message);
      throw new Error(`Failed to add contact to campaign: ${error.message}`);
    }
  }

  /**
   * Create a conversation in GHL
   * @param {Object} conversationData - Conversation details
   */
  async createConversation(conversationData) {
    try {
      const conversation = await this.client.conversations.createConversation(conversationData);
      return conversation;
    } catch (error) {
      console.error('GHL Conversation Error:', error.message);
      throw new Error(`Failed to create conversation: ${error.message}`);
    }
  }

  /**
   * Add a message to an existing conversation
   * @param {string} conversationId - GHL conversation ID
   * @param {Object} messageData - Message content
   */
  async addMessageToConversation(conversationId, messageData) {
    try {
      const message = await this.client.conversations.addMessage(conversationId, messageData);
      return message;
    } catch (error) {
      console.error('GHL Message Error:', error.message);
      throw new Error(`Failed to add message: ${error.message}`);
    }
  }

  /**
   * Get all locations for the agency
   */
  async getLocations() {
    try {
      const locations = await this.client.locations.getLocations();
      return locations;
    } catch (error) {
      console.error('GHL Locations Error:', error.message);
      throw new Error(`Failed to get locations: ${error.message}`);
    }
  }

  /**
   * Search contacts by phone number
   * @param {string} phoneNumber - Phone number to search
   * @param {string} locationId - GHL location ID
   */
  async searchContactsByPhone(phoneNumber, locationId) {
    try {
      const contacts = await this.client.contacts.getContacts({
        locationId: locationId,
        query: phoneNumber,
        limit: 10
      });
      return contacts.contacts;
    } catch (error) {
      console.error('GHL Search Error:', error.message);
      throw new Error(`Failed to search contacts: ${error.message}`);
    }
  }
}

export default GHLService;