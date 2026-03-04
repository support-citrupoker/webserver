// services/ghl.service.js
import { HighLevel } from '@gohighlevel/api-client';

class GHLService {
  constructor() {
    // Initialize the SDK client with Private Integration Token
    this.client = new HighLevel({
      privateIntegrationToken: process.env.GHL_PRIVATE_INTEGRATION_TOKEN,
      apiVersion: process.env.GHL_API_VERSION || '2021-07-28'
    });
    
    // Store locationId from environment
    this.locationId = process.env.GHL_LOCATION_ID;
    
    console.log('🔧 GHL SDK Client initialized');
    console.log(`📍 Default locationId: ${this.locationId ? 'Set' : 'Not set'}`);
  }

  /**
   * Set or update the location ID
   */
  setLocationId(locationId) {
    this.locationId = locationId;
    console.log(`📍 Location ID set to: ${locationId}`);
  }

  // ==================== CONTACT METHODS ====================

  /**
   * Search contacts by phone number
   */
  async searchContactsByPhone(phoneNumber, locationId = this.locationId) {
    try {
      if (!locationId) {
        throw new Error('locationId is required');
      }

      console.log(`🔍 Searching contact with phone: ${phoneNumber}`);

      const cleanPhone = phoneNumber.replace(/\D/g, '');

      const response = await this.client.contacts.searchContactsAdvanced({
        locationId: locationId,
        query: cleanPhone,
        pageLimit: 10,
        filters: [{
          field: "phone",
          operator: "contains",
          value: cleanPhone
        }]
      });

      const contacts = response.contacts || [];
      console.log(`✅ Found ${contacts.length} contacts`);
      return contacts;
    } catch (error) {
      console.error('❌ Search failed:', error.message);
      return [];
    }
  }

  /**
   * Create a new contact
   */
  async createContact(contactData, locationId = this.locationId) {
    try {
      if (!locationId) throw new Error('locationId required');

      console.log(`👤 Creating new contact: ${contactData.phone}`);

      const formattedPhone = this.formatPhoneForGHL(contactData.phone);

      const payload = {
        locationId: locationId,
        firstName: contactData.firstName || '',
        lastName: contactData.lastName || '',
        name: contactData.name || `${contactData.firstName || ''} ${contactData.lastName || ''}`.trim(),
        email: contactData.email || '',
        phone: formattedPhone,
        address1: contactData.address1 || '',
        city: contactData.city || '',
        state: contactData.state || '',
        postalCode: contactData.postalCode || '',
        country: contactData.country || 'US',
        website: contactData.website || '',
        timezone: contactData.timezone || 'America/New_York',
        tags: contactData.tags || ['tallbob_contact'],
        source: contactData.source || 'Tall Bob Integration',
        customFields: contactData.customFields || []
      };

      // Remove undefined fields
      Object.keys(payload).forEach(key => 
        payload[key] === undefined && delete payload[key]
      );

      const response = await this.client.contacts.createContact(payload);
      
      const contact = response.contact || response;
      console.log(`✅ Contact created: ${contact.id}`);
      return contact;
    } catch (error) {
      console.error('❌ Create contact failed:', error.message);
      throw error;
    }
  }

  /**
   * Update an existing contact
   */
  async updateContact(contactId, contactData, locationId = this.locationId) {
    try {
      if (!locationId) throw new Error('locationId required');

      console.log(`✏️ Updating contact: ${contactId}`);

      const response = await this.client.contacts.updateContact(
        { contactId, ...contactData },
        { headers: { locationId } }
      );

      console.log(`✅ Contact updated: ${contactId}`);
      return response.contact || response;
    } catch (error) {
      console.error('❌ Update contact failed:', error.message);
      throw error;
    }
  }

  /**
   * Create or update contact (upsert by phone)
   */
  async upsertContact(contactData, locationId = this.locationId) {
    try {
      if (!locationId) throw new Error('locationId required');

      const existingContacts = await this.searchContactsByPhone(contactData.phone, locationId);
      
      if (existingContacts && existingContacts.length > 0) {
        const existingContact = existingContacts[0];
        console.log(`Found existing contact: ${existingContact.id}`);
        
        const mergedTags = [
          ...(existingContact.tags || []),
          ...(contactData.tags || [])
        ].filter((v, i, a) => a.indexOf(v) === i);

        const updateData = {
          ...contactData,
          tags: mergedTags
        };

        const updated = await this.updateContact(existingContact.id, updateData, locationId);
        return { contact: updated, action: 'updated' };
      } else {
        const created = await this.createContact(contactData, locationId);
        return { contact: created, action: 'created' };
      }
    } catch (error) {
      console.error('❌ Upsert failed:', error.message);
      throw error;
    }
  }

  // ==================== CONVERSATION METHODS ====================

  /**
   * Create a conversation
   */
  async createConversation(contactId, type = 'SMS', locationId = this.locationId) {
    try {
      if (!locationId) throw new Error('locationId required');

      console.log(`💬 Creating conversation for contact: ${contactId}`);

      const response = await this.client.conversations.createConversation({
        contactId,
        locationId,
        type
      });

      const conversation = response.conversation || response;
      console.log(`✅ Conversation created: ${conversation.id}`);
      return conversation;
    } catch (error) {
      console.error('❌ Create conversation failed:', error.message);
      throw error;
    }
  }

  /**
   * Add message to conversation
   * FIXED: Using the correct SDK method name
   */
  async addMessageToConversation(conversationId, messageData, locationId = this.locationId) {
    try {
      if (!locationId) throw new Error('locationId required');

      console.log(`📝 Adding message to conversation: ${conversationId}`);

      const payload = {
        body: messageData.body,
        messageType: messageData.messageType || 'SMS',
        direction: messageData.direction || 'inbound',
        attachments: messageData.mediaUrls || [],
        date: messageData.date || new Date().toISOString()
      };

      // FIX: Use createMessage instead of addMessage
      const response = await this.client.conversations.createMessage(
        conversationId,
        payload,
        { headers: { locationId } }
      );

      const message = response.message || response;
      console.log(`✅ Message added: ${message.id}`);
      return message;
    } catch (error) {
      console.error('❌ Add message failed:', error.message);
      throw error;
    }
  }

  /**
   * Get conversation messages
   */
  async getConversationMessages(conversationId, locationId = this.locationId, limit = 50) {
    try {
      if (!locationId) throw new Error('locationId required');

      console.log(`📋 Fetching messages for conversation: ${conversationId}`);

      const response = await this.client.conversations.getMessages(
        conversationId,
        { limit },
        { headers: { locationId } }
      );

      return response.messages || [];
    } catch (error) {
      console.error('❌ Get messages failed:', error.message);
      return [];
    }
  }

  // ==================== TAG METHODS ====================

  /**
   * Add tag to contact
   */
  async addTagToContact(contactId, tag, locationId = this.locationId) {
    try {
      if (!locationId) throw new Error('locationId required');

      console.log(`🏷️ Adding tag "${tag}" to contact: ${contactId}`);

      const response = await this.client.contacts.addTag(
        { contactId, tag },
        { headers: { locationId } }
      );

      console.log(`✅ Tag added: ${tag}`);
      return response;
    } catch (error) {
      console.error('❌ Add tag failed:', error.message);
      return { success: false, error: error.message };
    }
  }

  /**
   * Remove tag from contact
   */
  async removeTagFromContact(contactId, tag, locationId = this.locationId) {
    try {
      if (!locationId) throw new Error('locationId required');

      console.log(`🏷️ Removing tag "${tag}" from contact: ${contactId}`);

      const response = await this.client.contacts.removeTag(
        { contactId, tag },
        { headers: { locationId } }
      );

      console.log(`✅ Tag removed: ${tag}`);
      return response;
    } catch (error) {
      console.error('❌ Remove tag failed:', error.message);
      return { success: false, error: error.message };
    }
  }

  // ==================== NOTE METHODS ====================

  /**
   * Add note to contact
   */
  async addNote(contactId, note, locationId = this.locationId) {
    try {
      if (!locationId) throw new Error('locationId required');

      console.log(`📝 Adding note to contact: ${contactId}`);

      const response = await this.client.contacts.addNote(
        { contactId, body: note },
        { headers: { locationId } }
      );

      console.log(`✅ Note added`);
      return response;
    } catch (error) {
      console.error('❌ Add note failed:', error.message);
      return { success: false, error: error.message };
    }
  }

  /**
   * Get notes for contact
   */
  async getNotes(contactId, locationId = this.locationId) {
    try {
      if (!locationId) throw new Error('locationId required');

      console.log(`📋 Fetching notes for contact: ${contactId}`);

      const response = await this.client.contacts.getNotes(
        { contactId },
        { headers: { locationId } }
      );

      return response.notes || [];
    } catch (error) {
      console.error('❌ Get notes failed:', error.message);
      return [];
    }
  }

  // ==================== HELPER METHODS ====================

  /**
   * Format phone number for GHL (E.164 format with +)
   */
  formatPhoneForGHL(phone) {
    if (!phone) return phone;
    const cleaned = phone.replace(/\D/g, '');
    return `+${cleaned}`;
  }

  /**
   * Test connection
   */
  async testConnection(locationId = this.locationId) {
    try {
      if (!locationId) {
        return {
          success: false,
          error: 'No locationId provided. Set GHL_LOCATION_ID in .env'
        };
      }

      // Try to get a contact as a test
      const response = await this.client.contacts.searchContactsAdvanced({
        locationId: locationId,
        pageLimit: 1
      });

      return {
        success: true,
        message: 'GHL connection successful',
        hasContacts: (response.contacts?.length || 0) > 0
      };
    } catch (error) {
      return {
        success: false,
        error: error.message
      };
    }
  }
}

export default GHLService;