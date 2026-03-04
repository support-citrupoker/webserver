// services/ghl.service.js
class GHLService {
  constructor(ghlClient) {
    this.client = ghlClient;
    console.log('🔧 GHL Client initialized with sections:', 
      Object.keys(ghlClient).filter(k => 
        ['locations', 'contacts', 'conversations', 'campaigns'].includes(k)
      ));
  }

  /**
   * Get all locations for the agency
   */
  async getLocations() {
    try {
      // The locations section has its own methods
      // Based on the debug output, we need to see what methods are available
      console.log('📍 Fetching locations...');
      
      // Try different possible method names
      const locations = await this.client.locations.list();
      // or maybe it's this.client.locations.getAll()
      // or this.client.locations.search()
      
      console.log(`✅ Found ${locations?.length || 0} locations`);
      return locations;
    } catch (error) {
      console.error('GHL Locations Error:', error.message);
      // Let's see what methods are actually available
      if (this.client.locations) {
        console.log('Available locations methods:', 
          Object.getOwnPropertyNames(this.client.locations)
            .filter(m => typeof this.client.locations[m] === 'function')
        );
      }
      throw new Error(`Failed to get locations: ${error.message}`);
    }
  }

  /**
   * Create or update a contact in GHL
   */
  async upsertContact(contactData, locationId) {
    try {
      console.log(`👤 Upserting contact with phone: ${contactData.phone}`);
      
      // First, search for existing contact
      const searchResult = await this.client.contacts.search({
        locationId: locationId,
        query: contactData.phone
      });

      if (searchResult && searchResult.contacts && searchResult.contacts.length > 0) {
        // Update existing contact
        const contactId = searchResult.contacts[0].id;
        const updated = await this.client.contacts.update(contactId, {
          ...contactData,
          locationId: locationId
        });
        console.log(`✅ Updated existing contact: ${contactId}`);
        return { contact: updated, action: 'updated' };
      } else {
        // Create new contact
        const newContact = await this.client.contacts.create({
          ...contactData,
          locationId: locationId
        });
        console.log(`✅ Created new contact: ${newContact.id}`);
        return { contact: newContact, action: 'created' };
      }
    } catch (error) {
      console.error('GHL Contact Error:', error.message);
      throw new Error(`Failed to upsert contact: ${error.message}`);
    }
  }

  /**
   * Add a contact to a campaign
   */
  async addToCampaign(contactId, campaignId, locationId) {
    try {
      console.log(`📢 Adding contact ${contactId} to campaign ${campaignId}`);
      
      const result = await this.client.campaigns.addContact({
        campaignId: campaignId,
        contactId: contactId
      }, {
        locationId: locationId
      });
      
      console.log(`✅ Contact added to campaign`);
      return result;
    } catch (error) {
      console.error('GHL Campaign Error:', error.message);
      throw new Error(`Failed to add contact to campaign: ${error.message}`);
    }
  }

  /**
   * Create a conversation in GHL
   */
  async createConversation(conversationData) {
    try {
      console.log(`💬 Creating conversation for contact: ${conversationData.contactId}`);
      
      const conversation = await this.client.conversations.create({
        contactId: conversationData.contactId,
        locationId: conversationData.locationId,
        type: conversationData.type || 'SMS'
      });
      
      console.log(`✅ Conversation created: ${conversation.id}`);
      return conversation;
    } catch (error) {
      console.error('GHL Conversation Error:', error.message);
      throw new Error(`Failed to create conversation: ${error.message}`);
    }
  }

  /**
   * Add a message to an existing conversation
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
      });
      
      console.log(`✅ Message added: ${message.id}`);
      return message;
    } catch (error) {
      console.error('GHL Message Error:', error.message);
      throw new Error(`Failed to add message: ${error.message}`);
    }
  }

  /**
   * Search contacts by phone number
   */
  async searchContactsByPhone(phoneNumber, locationId) {
    try {
      console.log(`🔍 Searching contacts with phone: ${phoneNumber}`);
      
      const result = await this.client.contacts.search({
        locationId: locationId,
        query: phoneNumber,
        limit: 10
      });
      
      const contacts = result.contacts || [];
      console.log(`✅ Found ${contacts.length} contacts`);
      return contacts;
    } catch (error) {
      console.error('GHL Search Error:', error.message);
      throw new Error(`Failed to search contacts: ${error.message}`);
    }
  }

  /**
   * Get contact by ID
   */
  async getContact(contactId, locationId) {
    try {
      const contact = await this.client.contacts.get(contactId, {
        locationId: locationId
      });
      return contact;
    } catch (error) {
      console.error('GHL Get Contact Error:', error.message);
      throw new Error(`Failed to get contact: ${error.message}`);
    }
  }

  /**
   * Update a contact
   */
  async updateContact(contactId, contactData, locationId) {
    try {
      const updated = await this.client.contacts.update(contactId, {
        ...contactData,
        locationId: locationId
      });
      return updated;
    } catch (error) {
      console.error('GHL Update Contact Error:', error.message);
      throw new Error(`Failed to update contact: ${error.message}`);
    }
  }

  /**
   * Delete a contact (or archive)
   */
  async deleteContact(contactId, locationId) {
    try {
      // Some GHL implementations use archive instead of delete
      const result = await this.client.contacts.delete(contactId, {
        locationId: locationId
      });
      return result;
    } catch (error) {
      console.error('GHL Delete Contact Error:', error.message);
      throw new Error(`Failed to delete contact: ${error.message}`);
    }
  }
}

export default GHLService;