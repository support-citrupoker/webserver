// services/ghl.service.js
import { HighLevel } from '@gohighlevel/api-client';

class GHLService {
  constructor() {
    // Initialize the SDK client with Private Integration Token
    this.client = new HighLevel({
      privateIntegrationToken: process.env.GHL_PRIVATE_INTEGRATION_TOKEN,
      apiVersion: process.env.GHL_API_VERSION || '2021-07-28'
    });
    
    // Store locationId from environment (can be overridden later)
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
   * Uses: contacts.searchContactsAdvanced()
   * Docs: https://marketplace.gohighlevel.com/docs/ghl/contacts/search-contacts-advanced
   */
  async searchContactsByPhone(phoneNumber, locationId = this.locationId) {
    try {
      if (!locationId) {
        throw new Error('locationId is required. Set GHL_LOCATION_ID in .env or pass it explicitly.');
      }

      console.log(`🔍 Searching contact with phone: ${phoneNumber}`);

      // Clean the phone number - remove formatting for search
      const cleanPhone = phoneNumber.replace(/\D/g, '');

      const response = await this.client.contacts.searchContactsAdvanced({
        locationId: locationId,
        query: cleanPhone, // The search query can be phone number
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
      if (error.response?.data) {
        console.error('Error details:', error.response.data);
      }
      return [];
    }
  }

  /**
   * Get contact by ID
   * Uses: contacts.getContact()
   */
  async getContact(contactId, locationId = this.locationId) {
    try {
      if (!locationId) throw new Error('locationId required');
      
      console.log(`👤 Fetching contact: ${contactId}`);
      
      const response = await this.client.contacts.getContact(
        { contactId },
        { headers: { locationId } }
      );
      
      return response.contact || response;
    } catch (error) {
      console.error('❌ Get contact failed:', error.message);
      throw error;
    }
  }

  /**
   * Create a new contact
   * Uses: contacts.createContact()
   * Docs: https://marketplace.gohighlevel.com/docs/ghl/contacts/create-contact
   */
  async createContact(contactData, locationId = this.locationId) {
    try {
      if (!locationId) throw new Error('locationId required');

      console.log(`👤 Creating new contact: ${contactData.phone || contactData.email || 'unknown'}`);

      // Format phone number for GHL (E.164 format with +)
      const formattedPhone = this.formatPhoneForGHL(contactData.phone);

      // Build the contact payload
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

      console.log('Creating contact with payload:', JSON.stringify(payload, null, 2));

      const response = await this.client.contacts.createContact(payload);
      
      const contact = response.contact || response;
      console.log(`✅ Contact created: ${contact.id}`);
      return contact;
    } catch (error) {
      console.error('❌ Create contact failed:', error.message);
      if (error.response?.data) {
        console.error('Error details:', error.response.data);
      }
      throw error;
    }
  }

  /**
   * Update an existing contact
   * Uses: contacts.updateContact()
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

      // First try to find existing contact by phone
      const existingContacts = await this.searchContactsByPhone(contactData.phone, locationId);
      
      if (existingContacts && existingContacts.length > 0) {
        // Update existing contact
        const existingContact = existingContacts[0];
        console.log(`Found existing contact: ${existingContact.id}`);
        
        // Merge tags (avoid duplicates)
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
        // Create new contact
        const created = await this.createContact(contactData, locationId);
        return { contact: created, action: 'created' };
      }
    } catch (error) {
      console.error('❌ Upsert failed:', error.message);
      throw error;
    }
  }

  /**
   * Delete a contact
   * Uses: contacts.deleteContact()
   */
  async deleteContact(contactId, locationId = this.locationId) {
    try {
      if (!locationId) throw new Error('locationId required');

      console.log(`🗑️ Deleting contact: ${contactId}`);

      const response = await this.client.contacts.deleteContact(
        { contactId },
        { headers: { locationId } }
      );

      console.log(`✅ Contact deleted: ${contactId}`);
      return response;
    } catch (error) {
      console.error('❌ Delete contact failed:', error.message);
      throw error;
    }
  }

  // ==================== TAG METHODS ====================

  /**
   * Add tag to contact
   * Uses: contacts.addTag()
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
   * Uses: contacts.removeTag()
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

  // ==================== CUSTOM FIELD METHODS ====================

  /**
   * Update custom field for contact
   * Uses: contacts.updateCustomFields()
   */
  async updateCustomField(contactId, fieldKey, fieldValue, locationId = this.locationId) {
    try {
      if (!locationId) throw new Error('locationId required');

      console.log(`📋 Updating custom field ${fieldKey} for contact: ${contactId}`);

      const response = await this.client.contacts.updateCustomFields(
        { 
          contactId,
          customFields: [{ key: fieldKey, value: fieldValue }]
        },
        { headers: { locationId } }
      );

      console.log(`✅ Custom field updated`);
      return response;
    } catch (error) {
      console.error('❌ Update custom field failed:', error.message);
      return { success: false, error: error.message };
    }
  }

  // ==================== NOTE METHODS ====================

  /**
   * Add note to contact
   * Uses: contacts.addNote()
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
   * Uses: contacts.getNotes()
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

  // ==================== CONVERSATION METHODS ====================

  /**
   * Create a conversation
   * Uses: conversations.createConversation()
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
   * Uses: conversations.addMessage()
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

      const response = await this.client.conversations.addMessage(
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
   * Uses: conversations.getMessages()
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

  // ==================== LOCATION METHODS ====================

  /**
   * Get location details
   * Uses: locations.getLocation()
   */
  async getLocation(locationId = this.locationId) {
    try {
      if (!locationId) throw new Error('locationId required');

      console.log(`📍 Fetching location: ${locationId}`);

      const response = await this.client.locations.getLocation(
        { locationId },
        { preferredTokenType: 'location' }
      );

      return response.location || response;
    } catch (error) {
      console.error('❌ Get location failed:', error.message);
      throw error;
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
   * Test connection by fetching location details
   */
  async testConnection(locationId = this.locationId) {
    try {
      if (!locationId) {
        return {
          success: false,
          error: 'No locationId provided. Set GHL_LOCATION_ID in .env'
        };
      }

      const location = await this.getLocation(locationId);
      return {
        success: true,
        message: 'GHL connection successful',
        location: location
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