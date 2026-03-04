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
      console.debug('🔍 Search returned no results (expected for new numbers)');
      return [];
    }
  }

  /**
   * Get contact by ID
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
   * Create a new contact - WITH SILENT DUPLICATE HANDLING
   */
  async createContact(contactData, locationId = this.locationId) {
    try {
      if (!locationId) throw new Error('locationId required');

      console.log(`👤 Creating new contact: ${contactData.phone || 'unknown'}`);

      const formattedPhone = this.formatPhoneForGHL(contactData.phone);

      const payload = {
        locationId: locationId,
        firstName: contactData.firstName || '',
        lastName: contactData.lastName || '',
        name: contactData.name || `${contactData.firstName || ''} ${contactData.lastName || ''}`.trim(),
        phone: formattedPhone,
        ...(contactData.email && contactData.email.trim() !== '' ? { email: contactData.email } : {}),
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

      Object.keys(payload).forEach(key => 
        payload[key] === undefined && delete payload[key]
      );

      const response = await this.client.contacts.createContact(payload);
      
      const contact = response.contact || response;
      console.log(`✅ Contact created: ${contact.id}`);
      return contact;
    } catch (error) {
      // SILENT HANDLING: Check if this is a duplicate contact error (expected behavior)
      if (error.statusCode === 400 && 
          error.response?.message === 'This location does not allow duplicated contacts.' &&
          error.response?.meta?.contactId) {
        
        // This is NOT an error - it's how we detect existing contacts
        // Return the existing contact info without logging as error
        console.log(`📌 Contact already exists with ID: ${error.response.meta.contactId}`);
        return {
          id: error.response.meta.contactId,
          name: error.response.meta.contactName,
          _exists: true,
          _matchingField: error.response.meta.matchingField
        };
      }
      
      // Only log and throw for real errors
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

      const cleanData = { ...contactData };
      
      if (cleanData.email === '') {
        delete cleanData.email;
      }

      const response = await this.client.contacts.updateContact(
        { contactId, ...cleanData },
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
   * Create or update contact (upsert by phone) - WITH SILENT DUPLICATE HANDLING
   */
  async upsertContact(contactData, locationId = this.locationId) {
    try {
      if (!locationId) throw new Error('locationId required');

      console.log(`🔄 Upserting contact with phone: ${contactData.phone}`);

      // Try to create the contact - will silently return existing if duplicate
      const result = await this.createContact(contactData, locationId);
      
      // Check if this was an existing contact
      if (result._exists) {
        console.log(`📌 Updating existing contact: ${result.id}`);
        
        // Get the full contact details
        const existingContact = await this.getContact(result.id, locationId);
        
        // Prepare update data - merge new data with existing
        const updateData = {
          firstName: contactData.firstName || existingContact.firstName,
          lastName: contactData.lastName || existingContact.lastName,
          ...(contactData.email && contactData.email.trim() !== '' ? { email: contactData.email } : {}),
          tags: [
            ...(existingContact.tags || []),
            ...(contactData.tags || [])
          ].filter((v, i, a) => a.indexOf(v) === i),
          ...(contactData.source ? { source: contactData.source } : {}),
          customFields: [
            ...(existingContact.customFields || []),
            ...(contactData.customFields || [])
          ]
        };

        const updated = await this.updateContact(result.id, updateData, locationId);
        return { contact: updated, action: 'updated' };
      }
      
      // New contact created
      return { contact: result, action: 'created' };
      
    } catch (error) {
      console.error('❌ Upsert failed:', error.message);
      throw error;
    }
  }

  /**
   * Delete a contact
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

  /**
   * Check if a phone number exists - SILENT AND CLEAN
   */
  async phoneExists(phoneNumber, locationId = this.locationId) {
    try {
      if (!locationId) throw new Error('locationId required');

      console.log(`📞 Checking if phone exists: ${phoneNumber}`);

      // Try to create a minimal contact with just the phone number
      const testContact = {
        phone: phoneNumber,
        firstName: 'Temp',
        lastName: 'Temp',
        tags: ['temp_check']
      };

      const result = await this.createContact(testContact, locationId);
      
      // If we get an existing contact back
      if (result._exists) {
        console.log(`📌 Phone ${phoneNumber} exists (Contact ID: ${result.id})`);
        return {
          exists: true,
          contactId: result.id,
          contactName: result.name,
          matchingField: result._matchingField
        };
      }
      
      // Phone doesn't exist and we created a temp contact
      console.log(`✅ Phone ${phoneNumber} does not exist`);
      
      // Optionally delete the temp contact (uncomment if needed)
      // await this.deleteContact(result.id, locationId);
      
      return { exists: false };
      
    } catch (error) {
      console.debug('📞 Phone check completed');
      return { exists: false, error: error.message };
    }
  }

  /**
   * Get contact by phone number
   */
  async getContactByPhone(phoneNumber, locationId = this.locationId) {
    try {
      const result = await this.phoneExists(phoneNumber, locationId);
      
      if (result.exists && result.contactId) {
        const contact = await this.getContact(result.contactId, locationId);
        return contact;
      }
      
      return null;
    } catch (error) {
      console.debug('📞 Could not find contact by phone');
      return null;
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

  // ==================== CUSTOM FIELD METHODS ====================

  /**
   * Update custom field for contact
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

  // ==================== CONVERSATION METHODS ====================

  /**
   * Create a conversation - WITH SILENT DUPLICATE HANDLING
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
      // SILENT HANDLING: Conversation already exists (expected)
      if (error.statusCode === 400 && 
          error.response?.message === 'Conversation already exists' &&
          error.response?.conversationId) {
        
        console.log(`📌 Using existing conversation: ${error.response.conversationId}`);
        return {
          id: error.response.conversationId,
          _exists: true
        };
      }
      
      console.error('❌ Create conversation failed:', error.message);
      throw error;
    }
  }

  /**
   * Get or create conversation (now using silent createConversation)
   */
  async getOrCreateConversation(contactId, type = 'SMS', locationId = this.locationId) {
    try {
      const conversation = await this.createConversation(contactId, type, locationId);
      
      return {
        conversation,
        action: conversation._exists ? 'existing' : 'created'
      };
    } catch (error) {
      console.error('❌ Get or create conversation failed:', error.message);
      throw error;
    }
  }

  /**
   * Add message to conversation
   */
  async addMessageToConversation(conversationId, messageData, locationId = this.locationId) {
    try {
      if (!locationId) throw new Error('locationId required');
      if (!messageData.contactId) throw new Error('contactId is required for sending messages');

      console.log(`📝 Adding message to conversation: ${conversationId}`);

      const messageType = messageData.messageType || 'SMS';
      
      const payload = {
        type: messageType,
        contactId: messageData.contactId,
        message: messageData.body,
        attachments: messageData.mediaUrls || [],
        status: messageData.direction === 'outbound' ? 'delivered' : 'pending',
        ...(messageType === 'SMS' && {
          fromNumber: messageData.fromNumber,
          toNumber: messageData.toNumber
        }),
        ...(messageType === 'Email' && {
          subject: messageData.subject,
          html: messageData.html,
          emailFrom: messageData.emailFrom,
          emailTo: messageData.emailTo,
          emailCc: messageData.emailCc,
          emailBcc: messageData.emailBcc
        })
      };

      Object.keys(payload).forEach(key => 
        payload[key] === undefined && delete payload[key]
      );

      const response = await this.client.conversations.sendANewMessage(payload);

      console.log(`✅ Message added: ${response.messageId}`);
      return {
        id: response.messageId,
        conversationId: response.conversationId,
        emailMessageId: response.emailMessageId,
        messageIds: response.messageIds,
        msg: response.msg
      };
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

  // ==================== LOCATION METHODS ====================

  /**
   * Get location details
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