// services/ghl.service.js
class GHLService {
  constructor(ghlClient) {
    this.client = ghlClient;
    this.apiVersion = process.env.GHL_API_VERSION || '2021-07-28';
    console.log('🔧 GHL Client initialized with Private Integration');
  }

  /**
   * Helper to add headers to any request
   */
  _addHeaders(options = {}) {
    return {
      ...options,
      headers: {
        ...options.headers,
        Version: this.apiVersion
      }
    };
  }

  /**
   * Get all locations
   */
  async getLocations() {
    try {
      console.log('📍 Fetching locations...');
      
      // With Private Integration token, you might need to get locations differently
      // Option 1: If there's a locations.list() method
      const locations = await this.client.locations.list();
      
      // Option 2: If you need to make a raw request
      // const response = await this.client.get('/locations/', this._addHeaders());
      
      console.log(`✅ Found ${locations?.length || 0} locations`);
      return locations;
    } catch (error) {
      console.error('GHL Locations Error:', error.message);
      throw new Error(`Failed to get locations: ${error.message}`);
    }
  }

  /**
   * Search contacts by phone
   */
  async searchContactsByPhone(phoneNumber, locationId) {
    try {
      console.log(`🔍 Searching contacts with phone: ${phoneNumber}`);
      
      // Using the search endpoint as shown in docs pattern
      const response = await this.client.contacts.search({
        locationId: locationId,
        query: phoneNumber,
        limit: 10
      }, this._addHeaders());
      
      const contacts = response.contacts || [];
      console.log(`✅ Found ${contacts.length} contacts`);
      return contacts;
    } catch (error) {
      console.error('GHL Search Error:', error.message);
      throw new Error(`Failed to search contacts: ${error.message}`);
    }
  }

  /**
   * Create a contact - matches the curl example in docs
   */
  async createContact(contactData, locationId) {
    try {
      console.log(`👤 Creating contact...`);
      
      const contact = await this.client.contacts.create({
        firstName: contactData.firstName,
        lastName: contactData.lastName,
        email: contactData.email,
        phone: contactData.phone,
        locationId: locationId,
        ...contactData
      }, this._addHeaders());
      
      console.log(`✅ Contact created: ${contact.id}`);
      return contact;
    } catch (error) {
      console.error('GHL Create Contact Error:', error.message);
      throw new Error(`Failed to create contact: ${error.message}`);
    }
  }

  /**
   * Update a contact
   */
  async updateContact(contactId, contactData, locationId) {
    try {
      console.log(`✏️ Updating contact: ${contactId}`);
      
      const updated = await this.client.contacts.update(contactId, {
        ...contactData,
        locationId: locationId
      }, this._addHeaders());
      
      console.log(`✅ Contact updated`);
      return updated;
    } catch (error) {
      console.error('GHL Update Contact Error:', error.message);
      throw new Error(`Failed to update contact: ${error.message}`);
    }
  }

  /**
   * Create or update contact (upsert)
   */
  async upsertContact(contactData, locationId) {
    try {
      // First try to find existing
      const existing = await this.searchContactsByPhone(contactData.phone, locationId);
      
      if (existing && existing.length > 0) {
        // Update existing
        return {
          contact: await this.updateContact(existing[0].id, contactData, locationId),
          action: 'updated'
        };
      } else {
        // Create new
        return {
          contact: await this.createContact(contactData, locationId),
          action: 'created'
        };
      }
    } catch (error) {
      console.error('GHL Upsert Error:', error.message);
      throw error;
    }
  }

  /**
   * Add message to conversation
   */
  async addMessageToConversation(conversationId, messageData) {
    try {
      console.log(`📝 Adding message to conversation: ${conversationId}`);
      
      const message = await this.client.conversations.addMessage(conversationId, {
        body: messageData.body,
        messageType: messageData.messageType || 'SMS',
        direction: messageData.direction || 'inbound',
        attachments: messageData.mediaUrls || [],
        date: messageData.date || new Date().toISOString()
      }, this._addHeaders());
      
      console.log(`✅ Message added: ${message.id}`);
      return message;
    } catch (error) {
      console.error('GHL Message Error:', error.message);
      throw new Error(`Failed to add message: ${error.message}`);
    }
  }

  /**
   * Create a conversation
   */
  async createConversation({ contactId, locationId, type = 'SMS' }) {
    try {
      console.log(`💬 Creating conversation for contact: ${contactId}`);
      
      const conversation = await this.client.conversations.create({
        contactId: contactId,
        locationId: locationId,
        type: type
      }, this._addHeaders());
      
      console.log(`✅ Conversation created: ${conversation.id}`);
      return conversation;
    } catch (error) {
      console.error('GHL Conversation Error:', error.message);
      throw new Error(`Failed to create conversation: ${error.message}`);
    }
  }
}

export default GHLService;